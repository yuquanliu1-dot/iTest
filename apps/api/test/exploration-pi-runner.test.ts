/**
 * 探索 runner pi 链路（pi/exploration/runner.ts）的落库与预算语义——回归测试。
 *
 * P2 验收项（计划 fancy-discovering-wilkes）：
 *  ① 工具事件 → 会话级 actions_trail 增量落库，跑动中可见；
 *  ② 置终态那一刻留痕已完整（PG 触发器记录写入时序，同 exploration-runner-trail.test.ts 手法）；
 *  ③ message_end → turns/usage/summary 正确入账（pi 一轮可链多工具，轮次只认 assistant message_end）;
 *  ④ 工具调用探针不过 → 立即 failed + 可行动报错，不开浏览器不空跑；
 *  ⑤ 视觉探针不过 → 降级纯文本模式（提示词带「无视觉通道」），会话照常完成；
 *  ⑥ 轮次预算耗尽 → session.abort() 被调、终态 completed + 「预算耗尽」注记（收尾等最后一拍检查落定）。
 *
 * pi 会话/模型探针全部打桩——本测试只验「平台自己的编排语义」，不调真模型。
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
    /** 各测试自设的 prompt 驱动器（模拟 pi 工具循环的事件流）。 */
    promptDriver: { fn: null as null | ((text: string) => Promise<void>) },
    toolProbeMock: vi.fn(),
    visionProbeMock: vi.fn(),
    /** 环境供数配置（各测试自设；beforeEach 复位）：web 服务/凭据/db 清单。 */
    envCfg: {
      webServices: [] as Array<{ name: string; isDefault: boolean }>,
      cred: null as null | { user: string; password: string },
      dbs: [] as Array<{ label: string; dialect: string }>,
    },
    /** 代码提交范围解析结果（null = none/failed 软失败）。 */
    scopeCfg: { scope: null as unknown },
    /** 章程分解产物（C2）：默认无子目标（分解软失败口径），各测试自设。 */
    decomposeCfg: { goals: [] as Array<{ id: string; text: string }> },
    /** A3 评审打桩：记录被评审的会话 id（评审是 fire-and-forget，runner 不等它）。 */
    judgeMock: vi.fn(async () => undefined),
  };
});

// 浏览器打桩：runner 真实起 chromium，这里只给最小 page 形状；记录 launch/newContext 调用。
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
              // 错误信号采集器在 page 上挂 console/pageerror/response 监听（打桩只需 no-op）。
              on: () => undefined,
              off: () => undefined,
            }),
            storageState: async () => ({}),
            // 故障注入控制器（D2）用的 context 能力（施加/复原走这几条）。
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

// 模型/能力探针打桩：探针结果由各测试设定（null=通过；字符串=失败原因）。
vi.mock('../src/pi/exploration/model.js', () => ({
  resolveExplorationModel: async () => ({ model: { id: 'probe-model' }, channelName: 'probe-channel' }),
  toolCallingProbeFailure: toolProbeMock,
  visionProbeFailure: visionProbeMock,
}));

// 代码提交范围打桩：默认 none（软失败，不挂 repo_read）；需要时各测试设 scopeCfg.scope。
vi.mock('../src/execute/codeScope.js', () => ({
  resolveCodeScope: async () => ({ scope: scopeCfg.scope }),
}));

// pi 会话打桩：composeExplorationPrompt 保持真实现（要验纯文本降级的提示词接线），
// createExplorationSession 返回假 session——事件流由 promptDriver 驱动。
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
          if (promptDriver.fn) await promptDriver.fn(text);
        },
        abort: () => {
          abortCalls.n += 1;
        },
      };
    },
  };
});

// 章程分解打桩（C2）：默认无子目标；需要时各测试设 decomposeCfg.goals（不打真网络）。
vi.mock('../src/pi/exploration/decompose.js', () => ({
  decomposeCharter: async () => decomposeCfg.goals,
}));

// A3 评审打桩：真评审要打模型（网关上不了），这里只验「runner 收尾后触发了评审」。
vi.mock('../src/pi/exploration/judge.js', () => ({
  judgeExplorationSession: judgeMock,
}));

// 环境解析打桩：默认无凭据、无 db（startUrl 回落到 baseUrl）；各测试可改 envCfg。
vi.mock('../src/execute/envContext.js', () => ({
  resolveEnv: async () => ({
    envId: 'env-test',
    baseUrl: BASE,
    webServices: envCfg.webServices,
    dbs: envCfg.dbs,
    // 无 ref = 默认 web 服务；带 ref 的服务名不匹配 → null（严格 ref 判定 = 缺凭据 → EnvMissing）。
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
/** 分派入口（EXPLORATION_RUNTIME=pi → runExplorationSessionPi），runner 行为是真的。 */
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

  // 审计表：每次 UPDATE 会话行记一笔 (状态, 留痕长度)，证伪「终态那一刻留痕不完整」。
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
  envCfg.webServices = [];
  envCfg.cred = null;
  envCfg.dbs = [];
  scopeCfg.scope = null;
  decomposeCfg.goals = [];
  judgeMock.mockClear();
});

/** 建一条待执行会话。可带轮次预算（预算耗尽路径用）与故障注入授权位。 */
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

/** 轮询等留痕长到 min 步（防抖 1s 后才落库）；超时返回最后读到的长度。 */
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

/** 向最新订阅的 pi 会话发一个事件（runner 的 subscribe 回调）。 */
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
      // 还没结束会话：这两步必须已经在库里（跑动中详情页可见）。
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

    // ① 跑动中增量落库。
    expect(midRunLen).toBeGreaterThanOrEqual(2);

    // ② 终态那一刻留痕已完整（任何一条 completed 记录长度不足即失败）。
    const audit = await pool.query(`SELECT status, len FROM trail_audit ORDER BY id`);
    const terminalRows = audit.rows.filter((r) => r.status === 'completed');
    expect(terminalRows.length).toBeGreaterThan(0);
    for (const r of terminalRows) expect(Number(r.len)).toBe(2);

    // ③ 库内终态：留痕内容与 ok 回填、轮次只认 message_end（一次）、用量映射 pi usage 字段。
    const row = await pool.query(
      `SELECT status, summary, turns_used, usage, actions_trail FROM exploration_sessions WHERE id=$1`,
      [sessionId],
    );
    expect(row.rows[0]!.status).toBe('completed');
    expect(row.rows[0]!.summary).toBe('探索完成：发现 1 个异常。');
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

    // ④ P3 工具全集：交互/取证/判定类工具齐备；无 db 与代码范围 → sql_probe/repo_read 不挂载。
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

    // ⑤ 起始指令带起点 URL 与章程；缺省视口 1280×800。
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
      // 两个 assistant 轮（无文本内容）→ 第 2 轮命中预算 → abort。
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

  it('finish 工具 → 终态总结取 finish 提交（不是末条 assistant 文本）+ 排除账本落库', async () => {
    const sessionId = await insertSession();
    promptDriver.fn = async () => {
      // 排除项申报（重复项只入账一条）。
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
      // finish 提交总结。
      const finish = sessionArgs.at(-1)!.tools.find((t) => (t as { name: string }).name === 'finish') as {
        execute: (id: string, p: unknown) => Promise<unknown>;
      };
      emit({ type: 'tool_execution_start', toolCallId: 'f1', toolName: 'finish', args: { summary: 'x' } });
      await finish.execute('f1', { summary: '覆盖了登录页与资产列表页，未发现越权缺陷。' });
      emit({ type: 'tool_execution_end', toolCallId: 'f1', toolName: 'finish', isError: false });
      // finish 之后模型又说了别的（末条 assistant 文本不得覆盖 finish 提交的总结）。
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

    // 子目标进 system prompt（压缩安全路径：appendSystemPromptOverride）。
    const prompt = String(sessionArgs.at(-1)!.explorationPrompt);
    expect(prompt).toContain('## 子目标（章程分解）');
    expect(prompt).toContain('g1: 打开新增对话框');
    expect(prompt).toContain('g2: 空值提交看是否被拒');

    // 覆盖账本：子目标落库，完成情况按模型回告（平台不猜「做没做到」）。
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
    // 授权位落库（UI 开关与执行口径同源）。
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
    // 留痕保留失败动作，且 value 是替换前的占位符字面量（绝不含真实凭据）。
    // outcome 由兜底逻辑从错误文本摘出原因（fill 是终止性错误，工具层没给 summary）。
    const trail = (row.rows[0]!.actions_trail ?? []) as Array<{ type: string; ok: boolean; value?: string; outcome?: string }>;
    expect(trail).toEqual([
      { type: 'fill', target: '#user', value: '__ITEST_USERNAME@ghost__', ok: false, outcome: '失败：env-missing' },
    ]);
    // 有 db → sql_probe 挂载；无代码范围 → repo_read 不挂载。
    const toolNames = (sessionArgs.at(-1)!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain('sql_probe');
    expect(toolNames).not.toContain('repo_read');
  }, 30000);
});
