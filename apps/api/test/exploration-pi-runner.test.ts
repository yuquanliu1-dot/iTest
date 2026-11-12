/**
 * DB persistence and budget semantics of the exploration runner pi path (pi/exploration/runner.ts) — regression test.
 *
 * P2 acceptance items (plan fancy-discovering-wilkes):
 *  ① Tool events → session-level actions_trail persisted incrementally, visible mid-run;
 *  ② The trail must be complete at the moment the terminal state is set (PG trigger records write ordering, same technique as exploration-runner-trail.test.ts);
 *  ③ message_end → turns/usage/summary accounted correctly (one pi turn can chain multiple tools; only assistant message_end counts as a turn);
 *  ④ Tool-calling probe fails → immediate failed + actionable error, no browser launch, no idle run;
 *  ⑤ Vision probe fails → downgrade to text-only mode (prompt carries "no vision channel"), session still completes;
 *  ⑥ Turn budget exhausted → session.abort() called, terminal completed + "budget exhausted" note (teardown waits for the last beat to settle);
 *  ⑦ Model call hangs (no events for a long time) → idle watchdog aborts, terminal completed + "no response for a long time" noted (not failed);
 *  ⑧ Terminal summary carries a coverage digest (pages/interactions/subgoal completion) — depth evidence beyond turn count.
 *
 * pi session/model probes are all stubbed — this test only verifies "the platform's own orchestration semantics", no real model calls.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

const BASE = 'http://127.0.0.1:56100/';
const CHARTER = '探索用户管理页面的增删改查，报告所有异常行为与校验缺失。';

const {
  launchCalls,
  sessionSubscribers,
  promptCalls,
  sessionArgs,
  abortCalls,
  newContextCalls,
  promptDriver,
  abortRelease,
  toolProbeMock,
  visionProbeMock,
  envCfg,
  scopeCfg,
  decomposeCfg,
  judgeMock,
} = vi.hoisted(() => {
  const sessionSubscribers: Array<(ev: unknown) => void> = [];
  const promptCalls: string[] = [];
  const sessionArgs: Array<Record<string, unknown>> = [];
  const newContextCalls: Array<Record<string, unknown>> = [];
  return {
    launchCalls: [] as number[],
    sessionSubscribers,
    promptCalls,
    sessionArgs,
    abortCalls: { n: 0 },
    newContextCalls,
    /** Prompt driver set per test (simulates the event stream of the pi tool loop). */
    promptDriver: { fn: null as null | ((text: string) => Promise<void>), hang: false },
    /** While promptDriver.hang is set, hold the prompt until abort releases it (simulates a hung model call). */
    abortRelease: { fn: null as null | (() => void) },
    toolProbeMock: vi.fn(),
    visionProbeMock: vi.fn(),
    /** Environment supply config (set per test; reset in beforeEach): web services/credentials/db list. */
    envCfg: {
      webServices: [] as Array<{ name: string; isDefault: boolean }>,
      cred: null as null | { user: string; password: string },
      dbs: [] as Array<{ label: string; dialect: string }>,
    },
    /** Code commit scope resolution result (null = none/failed soft failure). */
    scopeCfg: { scope: null as unknown },
    /** Charter decomposition output (C2): no subgoals by default (decomposition soft-failure policy); set per test. */
    decomposeCfg: { goals: [] as Array<{ id: string; text: string }> },
    /** A3 review stub: records reviewed session ids (review is fire-and-forget; the runner does not wait for it). */
    judgeMock: vi.fn(async () => undefined),
  };
});

// Browser stub: the runner really launches chromium; here we only provide a minimal page shape and record launch/newContext calls.
vi.mock('playwright-core', () => ({
  chromium: {
    launch: async () => {
      launchCalls.push(1);
      return {
        newContext: async (opts?: Record<string, unknown>) => {
          newContextCalls.push(opts ?? {});
          return {
            newPage: async () => ({
              url: () => BASE,
              viewportSize: () => ({ width: 1280, height: 800 }),
              // The error-signal collector attaches console/pageerror/response listeners on page (stub only needs no-ops).
              on: () => undefined,
              off: () => undefined,
            }),
            storageState: async () => ({}),
            // Context capabilities used by the fault-injection controller (D2) (apply/restore go through these).
            setOffline: async () => undefined,
            route: async () => undefined,
            unroute: async () => undefined,
            newCDPSession: async () => ({ send: async () => undefined, detach: async () => undefined }),
          };
        },
        close: async () => undefined,
      };
    },
  },
}));

// Model/capability probe stub: probe results are set per test (null = pass; string = failure reason).
vi.mock('../src/pi/exploration/model.js', () => ({
  resolveExplorationModel: async () => ({ model: { id: 'probe-model' }, channelName: 'probe-channel' }),
  toolCallingProbeFailure: toolProbeMock,
  visionProbeFailure: visionProbeMock,
}));

// Code commit scope stub: none by default (soft failure, repo_read not mounted); tests set scopeCfg.scope when needed.
vi.mock('../src/execute/codeScope.js', () => ({
  resolveCodeScope: async () => ({ scope: scopeCfg.scope }),
}));

// pi session stub: composeExplorationPrompt stays real (to verify the text-only downgrade prompt wiring),
// createExplorationSession returns a fake session — the event stream is driven by promptDriver.
vi.mock('../src/pi/exploration/session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pi/exploration/session.js')>();
  return {
    ...actual,
    createExplorationSession: async (args: Record<string, unknown>) => {
      sessionArgs.push(args);
      return {
        subscribe: (fn: (ev: unknown) => void) => {
          sessionSubscribers.push(fn);
        },
        prompt: async (text: string) => {
          promptCalls.push(text);
          // Hang mode: this turn never returns (model call hangs) until abort releases it.
          if (promptDriver.hang) {
            await new Promise<void>((res) => {
              abortRelease.fn = res;
            });
            return;
          }
          if (promptDriver.fn) await promptDriver.fn(text);
        },
        abort: () => {
          abortCalls.n += 1;
          abortRelease.fn?.();
          abortRelease.fn = null;
        },
      };
    },
  };
});

// Charter decomposition stub (C2): no subgoals by default; tests set decomposeCfg.goals when needed (no real network).
vi.mock('../src/pi/exploration/decompose.js', () => ({
  decomposeCharter: async () => decomposeCfg.goals,
}));

// A3 review stub: a real review would call the model (gateway unreachable); here we only verify "review is triggered after runner teardown".
vi.mock('../src/pi/exploration/judge.js', () => ({
  judgeExplorationSession: judgeMock,
}));

// Environment resolution stub: no credentials, no db by default (startUrl falls back to baseUrl); tests may modify envCfg.
vi.mock('../src/execute/envContext.js', () => ({
  resolveEnv: async () => ({
    envId: 'env-test',
    baseUrl: BASE,
    webServices: envCfg.webServices,
    dbs: envCfg.dbs,
    // No ref = default web service; a ref with a non-matching service name → null (strict ref matching = missing credentials → EnvMissing).
    resolveLogin: (ref?: string | null) => {
      if (ref === undefined || ref === null) return envCfg.cred;
      return ref === envCfg.webServices[0]?.name ? envCfg.cred : null;
    },
    resolveDb: () => null,
    resolveDbPool: async () => {
      throw new Error('本用例不查库');
    },
    close: async () => undefined,
  }),
}));

vi.mock('../src/execute/liveView.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/execute/liveView.js')>();
  return {
    ...actual,
    registerLiveView: () => ({ key: 'test', setPage: () => undefined, close: () => undefined }),
  };
});

let pool: Pool;
let projectId: string;
let versionId: string;
let userId: string;
/** Dispatch entry (EXPLORATION_RUNTIME=pi → runExplorationSessionPi); runner behavior is real. */
let runExplorationSession: typeof import('../src/execute/exploration.js').runExplorationSession;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.EXPLORATION_RUNTIME = 'pi';
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  versionId = seed.versionId;
  userId = seed.userId;
  const mod = await import('../src/execute/exploration.js');
  runExplorationSession = mod.runExplorationSession;

  // Audit table: every UPDATE of a session row records one entry (status, trail length), disproving "trail incomplete at terminal moment".
  await pool.query(`CREATE TABLE trail_audit(id serial primary key, status varchar(20), len int)`);
  await pool.query(
    `CREATE FUNCTION trail_audit_fn() RETURNS trigger AS $$
       BEGIN
         INSERT INTO trail_audit(status, len) VALUES (NEW.status, COALESCE(jsonb_array_length(NEW.actions_trail), 0));
         RETURN NULL;
       END; $$ LANGUAGE plpgsql`,
  );
  await pool.query(
    `CREATE TRIGGER trail_audit_trg AFTER UPDATE ON exploration_sessions FOR EACH ROW EXECUTE FUNCTION trail_audit_fn()`,
  );
}, 60000);

afterAll(async () => {
  const { pool: p } = await import('../src/db/client.js');
  await p.end().catch(() => undefined);
  await pool.end();
});

beforeEach(() => {
  toolProbeMock.mockReset().mockResolvedValue(null);
  visionProbeMock.mockReset().mockResolvedValue(null);
  promptDriver.fn = null;
  promptDriver.hang = false;
  abortRelease.fn = null;
  envCfg.webServices = [];
  envCfg.cred = null;
  envCfg.dbs = [];
  scopeCfg.scope = null;
  decomposeCfg.goals = [];
  judgeMock.mockClear();
});

/** Insert a pending session. Can carry a turn budget (for the budget-exhausted path) and the fault-injection authorization bit. */
async function insertSession(opts: { budgetTurns?: number; allowFaultInjection?: boolean } = {}): Promise<string> {
  const r = await pool.query(
    `INSERT INTO exploration_sessions(project_id, version_id, title, charter, persona, status, created_by_user_id, budget_turns, allow_fault_injection)
     VALUES ($1,$2,$3,$4,'qa','pending',$5,$6,$7) RETURNING id`,
    [
      projectId,
      versionId,
      'pi 链路回归用例',
      CHARTER,
      userId,
      opts.budgetTurns ?? null,
      opts.allowFaultInjection ?? false,
    ],
  );
  return r.rows[0]!.id as string;
}

/** Poll until the trail grows to min steps (only persisted after the 1s debounce); returns the last observed length on timeout. */
async function waitTrailLen(sessionId: string, min: number, timeoutMs = 8000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let len = 0;
  while (Date.now() < deadline) {
    const r = await pool.query(
      `SELECT COALESCE(jsonb_array_length(actions_trail),0) AS len FROM exploration_sessions WHERE id=$1`,
      [sessionId],
    );
    len = Number(r.rows[0]?.len ?? 0);
    if (len >= min) return len;
    await new Promise((res) => setTimeout(res, 100));
  }
  return len;
}

/** Emit one event to the most recently subscribed pi session (the runner's subscribe callback). */
function emit(ev: unknown): void {
  sessionSubscribers.at(-1)?.(ev);
}

describe('探索 runner pi 链路', () => {
  it('工具事件增量落库 + 终态留痕完整 + 轮次/用量/总结入账 + 只读工具集形状', async () => {
    const sessionId = await insertSession();
    let midRunLen = 0;

    promptDriver.fn = async () => {
      emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'navigate', args: { url: BASE } });
      emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'navigate', isError: false });
      emit({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'observe', args: {} });
      emit({ type: 'tool_execution_end', toolCallId: 't2', toolName: 'observe', isError: true });
      // Session not finished yet: these two steps must already be in the DB (visible on the mid-run detail page).
      midRunLen = await waitTrailLen(sessionId, 2);
      emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '探索完成：发现 1 个异常。' }],
          usage: { input: 120, output: 60, cacheRead: 40, cacheWrite: 8 },
          model: 'probe-model',
        },
      });
    };

    await runExplorationSession({ sessionId });

    // ① Persisted incrementally mid-run.
    expect(midRunLen).toBeGreaterThanOrEqual(2);

    // ② Trail complete at the moment of terminal state (any completed record with a shorter length fails the test).
    const audit = await pool.query(`SELECT status, len FROM trail_audit ORDER BY id`);
    const terminalRows = audit.rows.filter((r) => r.status === 'completed');
    expect(terminalRows.length).toBeGreaterThan(0);
    for (const r of terminalRows) expect(Number(r.len)).toBe(2);

    // ③ In-DB terminal state: trail content with ok backfill, turns count only message_end (once), usage maps pi usage fields.
    const row = await pool.query(
      `SELECT status, summary, turns_used, usage, actions_trail FROM exploration_sessions WHERE id=$1`,
      [sessionId],
    );
    expect(row.rows[0]!.status).toBe('completed');
    // Summary = model text + coverage digest (how much was covered / what's still missing — depth evidence beyond turn count).
    // No finish submission → the last assistant text must carry the "no formal summary submitted" marker (leftover debris must not masquerade as a conclusion).
    expect(String(row.rows[0]!.summary)).toContain('模型未提交正式总结');
    expect(String(row.rows[0]!.summary)).toContain('探索完成：发现 1 个异常。');
    expect(String(row.rows[0]!.summary)).toContain('（覆盖：页面 0 个、交互 1 次）');
    expect(Number(row.rows[0]!.turns_used)).toBe(1);
    const usage = row.rows[0]!.usage as Record<string, unknown>;
    expect(usage.calls).toBe(1);
    expect(usage.promptTokens).toBe(120);
    expect(usage.completionTokens).toBe(60);
    expect(usage.cacheReadTokens).toBe(40);
    expect(usage.cacheCreationTokens).toBe(8);
    expect(usage.model).toBe('probe-model');
    const trail = (row.rows[0]!.actions_trail ?? []) as Array<{ type: string; target: string; ok: boolean }>;
    expect(trail).toEqual([
      { type: 'navigate', target: BASE, ok: true },
      { type: 'observe', target: '-', ok: false },
    ]);

    // ④ Full P3 tool set: interaction/evidence/judgment tools all present; no db and no code scope → sql_probe/repo_read not mounted.
    const tools = sessionArgs[0]!.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual([
      'navigate',
      'observe',
      'screenshot',
      'read_text',
      'click',
      'fill',
      'press',
      'select',
      'scroll',
      'back',
      'wait',
      'evaluate',
      'report_finding',
      'note_excluded',
      'finish',
    ]);

    // ⑤ Starting instruction carries the start URL and charter; default viewport 1280×800.
    expect(promptCalls[0]).toContain(BASE);
    expect(sessionArgs[0]!.explorationPrompt).toContain(CHARTER);
    expect(newContextCalls[0]?.viewport).toEqual({ width: 1280, height: 800 });
  }, 30000);

  it('工具调用探针不过 → 立即 failed + 可行动报错，不开浏览器不进 pi 会话', async () => {
    const sessionId = await insertSession();
    const launchesBefore = launchCalls.length;
    const sessionArgsBefore = sessionArgs.length;
    toolProbeMock.mockResolvedValue('当前 LLM 渠道不支持原生工具调用，请换用支持工具调用的模型');

    await runExplorationSession({ sessionId });

    const row = await pool.query(`SELECT status, error FROM exploration_sessions WHERE id=$1`, [sessionId]);
    expect(row.rows[0]!.status).toBe('failed');
    expect(String(row.rows[0]!.error)).toContain('不支持原生工具调用');
    expect(launchCalls.length).toBe(launchesBefore);
    expect(sessionArgs.length).toBe(sessionArgsBefore);
  }, 30000);

  it('视觉探针不过 → 降级纯文本模式（提示词带「无视觉通道」），会话照常完成', async () => {
    const sessionId = await insertSession();
    visionProbeMock.mockResolvedValue('渠道读不出唯一码');
    promptDriver.fn = async () => {
      emit({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '纯文本模式探索完成。' }], usage: { input: 1, output: 1 } },
      });
    };

    await runExplorationSession({ sessionId });

    const row = await pool.query(`SELECT status FROM exploration_sessions WHERE id=$1`, [sessionId]);
    expect(row.rows[0]!.status).toBe('completed');
    const lastArgs = sessionArgs.at(-1)!;
    expect(lastArgs.explorationPrompt).toContain('无视觉通道');
  }, 30000);

  it('轮次预算耗尽 → abort 被调、终态 completed + 「预算耗尽」注记、turns_used 含最后一轮', async () => {
    const sessionId = await insertSession({ budgetTurns: 2 });
    promptDriver.fn = async () => {
      // Two assistant turns (no text content) → the 2nd turn hits the budget → abort.
      for (let i = 0; i < 2; i += 1) {
        emit({
          type: 'message_end',
          message: { role: 'assistant', content: [], usage: { input: 10, output: 5 } },
        });
      }
    };

    await runExplorationSession({ sessionId });

    const row = await pool.query(`SELECT status, summary, turns_used, usage FROM exploration_sessions WHERE id=$1`, [
      sessionId,
    ]);
    expect(abortCalls.n).toBeGreaterThanOrEqual(1);
    expect(row.rows[0]!.status).toBe('completed');
    expect(String(row.rows[0]!.summary)).toContain('预算耗尽');
    expect(String(row.rows[0]!.summary)).toContain('2 轮');
    expect(Number(row.rows[0]!.turns_used)).toBe(2);
    expect((row.rows[0]!.usage as Record<string, unknown>).calls).toBe(2);
  }, 30000);

  it('模型调用挂死（长时间无事件）→ 空闲看门狗中止会话，终态注明原因（不是 failed）', async () => {
    const sessionId = await insertSession();
    // The model never returns this turn (prompt held, waiting for abort to release).
    promptDriver.hang = true;

    await runExplorationSession({ sessionId, idleTimeoutMs: 100 });

    expect(abortCalls.n).toBeGreaterThanOrEqual(1);
    const row = await pool.query(`SELECT status, error, summary FROM exploration_sessions WHERE id=$1`, [sessionId]);
    // A hang is the platform stopping it on purpose, not a failure: terminal completed + reason noted (humans can see why it stopped).
    expect(row.rows[0]!.status).toBe('completed');
    expect(row.rows[0]!.error).toBeNull();
    expect(String(row.rows[0]!.summary)).toContain('模型调用长时间无响应');
  }, 30000);

  it('终态总结带覆盖摘要——盖住了多少、还差什么（轮次之外的深度证据）', async () => {
    decomposeCfg.goals = [{ id: 'g1', text: '打开新增对话框' }];
    const sessionId = await insertSession();
    promptDriver.fn = async () => {
      emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'navigate', args: { url: BASE } });
      emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'navigate', isError: false });
      emit({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '看完了首页。' }], usage: { input: 1, output: 1 } },
      });
    };

    await runExplorationSession({ sessionId });

    const row = await pool.query(`SELECT summary FROM exploration_sessions WHERE id=$1`, [sessionId]);
    const summary = String(row.rows[0]!.summary);
    expect(summary).toContain('覆盖：');
    expect(summary).toContain('交互 1 次');
    // Unfinished subgoals must be stated explicitly (the platform doesn't guess "done or not"; unfinished items are listed per the model's report).
    expect(summary).toContain('子目标 0/1');
    expect(summary).toContain('g1 打开新增对话框');
  }, 30000);

  it('finish 工具 → 终态总结取 finish 提交（不是末条 assistant 文本）+ 排除账本落库', async () => {
    const sessionId = await insertSession();
    promptDriver.fn = async () => {
      // Exclusion ledger entries (duplicates are recorded only once).
      const note = sessionArgs.at(-1)!.tools.find((t) => (t as { name: string }).name === 'note_excluded') as {
        execute: (id: string, p: unknown) => Promise<unknown>;
      };
      emit({ type: 'tool_execution_start', toolCallId: 'n1', toolName: 'note_excluded', args: {} });
      await note.execute('n1', {
        items: [
          { claim: '登录页缺少验证码', evidence: 'observe 确认无验证码元素' },
          { claim: '登录页缺少验证码', evidence: '重复申报' },
        ],
      });
      emit({ type: 'tool_execution_end', toolCallId: 'n1', toolName: 'note_excluded', isError: false });
      // finish submits the summary.
      const finish = sessionArgs.at(-1)!.tools.find((t) => (t as { name: string }).name === 'finish') as {
        execute: (id: string, p: unknown) => Promise<unknown>;
      };
      emit({ type: 'tool_execution_start', toolCallId: 'f1', toolName: 'finish', args: { summary: 'x' } });
      await finish.execute('f1', { summary: '覆盖了登录页与资产列表页，未发现越权缺陷。' });
      emit({ type: 'tool_execution_end', toolCallId: 'f1', toolName: 'finish', isError: false });
      // After finish the model says something else (the last assistant text must not override the summary submitted via finish).
      emit({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '（结束语）' }], usage: { input: 1, output: 1 } },
      });
    };

    await runExplorationSession({ sessionId });

    const row = await pool.query(`SELECT status, summary, excluded_ledger, actions_trail FROM exploration_sessions WHERE id=$1`, [
      sessionId,
    ]);
    expect(row.rows[0]!.status).toBe('completed');
    expect(String(row.rows[0]!.summary)).toContain('覆盖了登录页与资产列表页');
    expect(String(row.rows[0]!.summary)).not.toContain('（结束语）');
    const ledger = row.rows[0]!.excluded_ledger as Array<{ claim: string; evidence: string }>;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.claim).toBe('登录页缺少验证码');
    const trail = (row.rows[0]!.actions_trail ?? []) as Array<{ type: string; ok: boolean }>;
    expect(trail.map((t) => t.type)).toEqual(['note_excluded', 'finish']);
  }, 30000);

  it('章程分解（C2）→ 子目标进系统提示词 + 覆盖账本；finish 回告 goals → 账本标记完成', async () => {
    decomposeCfg.goals = [
      { id: 'g1', text: '打开新增对话框' },
      { id: 'g2', text: '空值提交看是否被拒' },
    ];
    const sessionId = await insertSession();
    promptDriver.fn = async () => {
      const finish = sessionArgs.at(-1)!.tools.find((t) => (t as { name: string }).name === 'finish') as {
        execute: (id: string, p: unknown) => Promise<unknown>;
      };
      emit({ type: 'tool_execution_start', toolCallId: 'f1', toolName: 'finish', args: {} });
      await finish.execute('f1', {
        summary: '覆盖了新增对话框与空值提交。',
        goals: [{ id: 'g1', done: true }, { id: 'g2', done: false }],
      });
      emit({ type: 'tool_execution_end', toolCallId: 'f1', toolName: 'finish', isError: false });
    };

    await runExplorationSession({ sessionId });

    // Subgoals go into the system prompt (compression-safe path: appendSystemPromptOverride).
    const prompt = String(sessionArgs.at(-1)!.explorationPrompt);
    expect(prompt).toContain('## 子目标（章程分解）');
    expect(prompt).toContain('g1: 打开新增对话框');
    expect(prompt).toContain('g2: 空值提交看是否被拒');

    // Coverage ledger: subgoals persisted; completion follows the model's report (the platform doesn't guess "done or not").
    const row = await pool.query(`SELECT coverage_ledger FROM exploration_sessions WHERE id=$1`, [sessionId]);
    const ledger = row.rows[0]!.coverage_ledger as {
      goals: Array<{ id: string; text: string; done: boolean }>;
    };
    expect(ledger.goals.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(ledger.goals[0]!.done).toBe(true);
    expect(ledger.goals[1]!.done).toBe(false);
  }, 30000);

  it('故障注入授权位：未授权 → inject_fault 工具不出现；授权 → 挂载并可施加', async () => {
    const denied = await insertSession();
    await runExplorationSession({ sessionId: denied });
    const deniedTools = (sessionArgs.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(deniedTools).not.toContain('inject_fault');

    const allowed = await insertSession({ allowFaultInjection: true });
    promptDriver.fn = async () => {
      const fault = sessionArgs.at(-1)!.tools.find((t) => (t as { name: string }).name === 'inject_fault') as {
        execute: (id: string, p: unknown) => Promise<{ isError?: boolean; content: unknown }>;
      };
      emit({ type: 'tool_execution_start', toolCallId: 'x1', toolName: 'inject_fault', args: { mode: 'offline' } });
      const r = await fault.execute('x1', { mode: 'offline' });
      expect(r.isError).toBeFalsy();
      emit({ type: 'tool_execution_end', toolCallId: 'x1', toolName: 'inject_fault', isError: false });
    };

    await runExplorationSession({ sessionId: allowed });
    const allowedTools = (sessionArgs.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(allowedTools).toContain('inject_fault');
    // Authorization bit persisted (the UI switch and the execution policy share the same source).
    const row = await pool.query(`SELECT allow_fault_injection FROM exploration_sessions WHERE id=$1`, [allowed]);
    expect(row.rows[0]!.allow_fault_injection).toBe(true);
  }, 30000);

  it('收尾触发 A3 独立评审（fire-and-forget，不改会话终态）', async () => {
    judgeMock.mockClear();
    const sessionId = await insertSession();
    promptDriver.fn = async () => {
      emit({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '探索完成。' }], usage: { input: 1, output: 1 } },
      });
    };

    await runExplorationSession({ sessionId });

    expect(judgeMock).toHaveBeenCalledWith(sessionId);
    const row = await pool.query(`SELECT status FROM exploration_sessions WHERE id=$1`, [sessionId]);
    expect(row.rows[0]!.status).toBe('completed');
  }, 30000);

  it('fill 凭据缺失 → 终止会话按 failed 收尾（可行动报错）+ 挂载 sql_probe（有 db）', async () => {
    const sessionId = await insertSession();
    envCfg.webServices = [{ name: 'web', isDefault: true }];
    envCfg.cred = { user: 'wy', password: 'pw' };
    envCfg.dbs = [{ label: '主库', dialect: 'postgresql' }];
    promptDriver.fn = async () => {
      const fill = sessionArgs.at(-1)!.tools.find((t) => (t as { name: string }).name === 'fill') as {
        execute: (id: string, p: unknown) => Promise<unknown>;
      };
      emit({
        type: 'tool_execution_start',
        toolCallId: 'x1',
        toolName: 'fill',
        args: { target: '#user', value: '__ITEST_USERNAME@ghost__' },
      });
      const r = (await fill.execute('x1', { target: '#user', value: '__ITEST_USERNAME@ghost__' })) as { isError?: boolean };
      expect(r.isError).toBe(true);
      emit({
        type: 'tool_execution_end',
        toolCallId: 'x1',
        toolName: 'fill',
        isError: true,
        result: { content: [{ type: 'text', text: 'fill #user: error env-missing' }] },
      });
    };

    await runExplorationSession({ sessionId });

    const row = await pool.query(`SELECT status, error, actions_trail FROM exploration_sessions WHERE id=$1`, [sessionId]);
    expect(row.rows[0]!.status).toBe('failed');
    expect(String(row.rows[0]!.error)).toContain('env-missing');
    expect(String(row.rows[0]!.error)).toContain('ghost');
    // Trail keeps the failed action, and value is the pre-replacement placeholder literal (never contains real credentials).
    // outcome is extracted from the error text by the fallback logic (fill is a fatal error; the tool layer gave no summary).
    const trail = (row.rows[0]!.actions_trail ?? []) as Array<{ type: string; ok: boolean; value?: string; outcome?: string }>;
    expect(trail).toEqual([
      { type: 'fill', target: '#user', value: '__ITEST_USERNAME@ghost__', ok: false, outcome: '失败：env-missing' },
    ]);
    // With db → sql_probe mounted; no code scope → repo_read not mounted.
    const toolNames = (sessionArgs.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain('sql_probe');
    expect(toolNames).not.toContain('repo_read');
  }, 30000);
});
