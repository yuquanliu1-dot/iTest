/**
 * P5 unit tests: A3 independent review (judge) + D2 fault injection (fault).
 *
 * A3 acceptance criteria:
 *  - Verdict shape tolerance: Chinese/English aliases, percentage confidence, unparseable shape → unclear;
 *  - **Never touches findings.status** (human review is the authority) — the judge only writes findings.judge;
 *  - Judge call failure → that finding becomes unclear (not "dismissed"), session judge_status=failed;
 *  - Idempotency: re-judging a session with judge_status=done does not call the model again;
 *  - No findings → judge_status=skipped;
 *  - Only feeds material (description + platform action trail + evidence frame metadata), never the explorer's reasoning.
 *
 * D2 acceptance criteria:
 *  - Mode name normalization (Chinese/English aliases);
 *  - Apply/switch/reset: switching modes resets the previous one first (no stacking); reset clears offline/slow-network route/CPU throttling;
 *  - Slow network only delays GET (write requests pass through as usual);
 *  - Tools never throw (invalid mode → isError + actionable message).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
import type { LLMClient, LLMRequest } from '../src/agent/llm-client.js';

let pool: Pool;
let projectId: string;
let versionId: string;
let userId: string;
let sessionCounter = 0;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  versionId = seed.versionId;
  userId = seed.userId;
}, 60000);

afterAll(async () => {
  const { pool: p } = await import('../src/db/client.js');
  await p.end().catch(() => undefined);
  await pool.end();
});

/** Insert one session row. */
async function insertSession(opts: { judgeStatus?: string } = {}): Promise<string> {
  sessionCounter += 1;
  const r = await pool.query(
    `INSERT INTO exploration_sessions(project_id, version_id, title, charter, persona, status, judge_status, created_by_user_id)
     VALUES ($1,$2,$3,'探索用户管理页','qa','completed',$4,$5) RETURNING id`,
    [projectId, versionId, `P5 单测 ${sessionCounter}`, opts.judgeStatus ?? 'pending', userId],
  );
  return r.rows[0]!.id as string;
}

/** Insert one finding (optional platform action trail). Returns id and order (order determines the decision frame file name). */
async function insertFinding(
  sessionId: string,
  opts: { title?: string; trail?: unknown; status?: string; evidenceFrame?: unknown } = {},
): Promise<{ id: string; order: number }> {
  sessionCounter += 1;
  const r = await pool.query(
    `INSERT INTO exploration_findings(session_id, "order", title, description, severity, actions_trail, status, evidence_frame)
     VALUES ($1,$2,$3,'预期：删除后列表少一行；实际：仍显示旧数据','P1',$4,$5,$6) RETURNING id`,
    [
      sessionId,
      sessionCounter,
      opts.title ?? '删除后列表未刷新',
      JSON.stringify(
        opts.trail ?? [
          { type: 'navigate', target: 'http://sut.example.com/app', ok: true },
          { type: 'click', target: '#del', ok: true },
        ],
      ),
      opts.status ?? 'pending',
      opts.evidenceFrame ? JSON.stringify(opts.evidenceFrame) : null,
    ],
  );
  return { id: r.rows[0]!.id as string, order: sessionCounter };
}

/** Write a real PNG to the decision frame disk path (the judge reads frames from disk by <order>).
 *  screenshotDiskPath must be dynamically imported: it pulls in db/client (which reads DATABASE_URL at module load),
 *  and a static import would bind the pool to the default database before beforeAll sets the env — every judge case goes falsely red. */
async function writeFrame(sessionId: string, order: number): Promise<{ base64: string; file: string }> {
  const { screenshotDiskPath } = await import('../src/execute/explorationShared.js');
  const file = screenshotDiskPath(sessionId, order);
  await mkdir(dirname(file), { recursive: true });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await writeFile(file, png);
  return { base64: png.toString('base64'), file };
}

/** Fake LLM client: replies with scripted JSON or throws. Records received requests (to verify "only material is fed"). */
function makeLlm(
  reply: (req: LLMRequest, call: number) => Record<string, unknown>,
): { client: LLMClient; calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  const client: LLMClient = {
    provider: 'openai',
    complete: async (req) => {
      calls.push(req);
      return { kind: 'json', value: reply(req, calls.length), provider: 'openai', vision: false, model: 'judge-model' };
    },
  };
  return { client, calls };
}

describe('A3 独立评审（judge）', () => {
  it('判定解析：中英别名 + 百分数置信度 + 形状不可解析 → null', async () => {
    const { parseVerdict } = await import('../src/pi/exploration/judge.js');
    expect(parseVerdict({ verdict: 'confirmed', reason: '材料支撑', confidence: 0.8 })).toEqual({
      verdict: 'confirmed',
      reason: '材料支撑',
      confidence: 0.8,
    });
    // Chinese aliases.
    expect(parseVerdict({ verdict: '不成立', reason: '预期行为', confidence: 0.2 })?.verdict).toBe('dismissed');
    expect(parseVerdict({ verdict: '存疑', reason: '看不清', confidence: 0.2 })?.verdict).toBe('unclear');
    // Percentage conversion from the 0~100 scale.
    expect(parseVerdict({ verdict: 'confirmed', reason: 'x', confidence: 80 })?.confidence).toBeCloseTo(0.8);
    // Unparseable shapes / values > 1 are always converted as percentages (code semantics: 0~100 folds to 0~1, out of range clamps to 1).
    expect(parseVerdict({ verdict: 'whatever' })).toBeNull();
    expect(parseVerdict(null)).toBeNull();
    expect(parseVerdict({ verdict: 'confirmed', reason: 'x', confidence: 5 })?.confidence).toBeCloseTo(0.05);
    expect(parseVerdict({ verdict: 'confirmed', reason: 'x', confidence: 250 })?.confidence).toBe(1);
    expect(parseVerdict({ verdict: 'confirmed', reason: 'x', confidence: -3 })?.confidence).toBe(0);
  }, 20000);

  it('评审成立 → 写 findings.judge，**不改 findings.status**（人工才是权威）', async () => {
    const sessionId = await insertSession();
    const { id: findingId } = await insertFinding(sessionId);
    const { client, calls } = makeLlm(() => ({
      verdict: 'confirmed',
      reason: '留痕显示点击删除后列表未刷新',
      confidence: 0.9,
    }));

    const { judgeExplorationSession } = await import('../src/pi/exploration/judge.js');
    await judgeExplorationSession(sessionId, { llm: client, vision: false });

    const f = await pool.query(`SELECT status, judge FROM exploration_findings WHERE id=$1`, [findingId]);
    // Human review status stays pending — the judge only annotates, never oversteps.
    expect(f.rows[0]!.status).toBe('pending');
    const judge = f.rows[0]!.judge as { verdict: string; reason: string; confidence: number; model: string };
    expect(judge.verdict).toBe('confirmed');
    expect(judge.reason).toContain('未刷新');
    expect(judge.confidence).toBeCloseTo(0.9);
    expect(judge.model).toBe('judge-model');

    const s = await pool.query(`SELECT judge_status, judge_result FROM exploration_sessions WHERE id=$1`, [sessionId]);
    expect(s.rows[0]!.judge_status).toBe('done');
    const result = s.rows[0]!.judge_result as { summary: string; findings: Array<{ id: string }> };
    expect(result.summary).toContain('评审 1 条');
    expect(result.summary).toContain('成立 1');
    expect(result.findings[0]!.id).toBe(findingId);

    // Only material is fed: description + platform action trail + page URL, no explorer reasoning.
    const body = calls[0]!.userMessage;
    expect(body).toContain('删除后列表未刷新');
    expect(body).toContain('平台动作留痕');
    expect(body).toContain('#del');
    expect(calls[0]!.image).toBeUndefined();
  }, 30000);

  it('评审调用失败 → 该条判 unclear（不是「不成立」），会话 judge_status=failed', async () => {
    const sessionId = await insertSession();
    const { id: findingId } = await insertFinding(sessionId);
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => {
        throw new Error('网关 502');
      },
    };

    const { judgeExplorationSession } = await import('../src/pi/exploration/judge.js');
    await judgeExplorationSession(sessionId, { llm: client, vision: false });

    const f = await pool.query(`SELECT status, judge FROM exploration_findings WHERE id=$1`, [findingId]);
    expect(f.rows[0]!.status).toBe('pending');
    const judge = f.rows[0]!.judge as { verdict: string; reason: string };
    expect(judge.verdict).toBe('unclear');
    expect(judge.reason).toContain('网关 502');

    const s = await pool.query(`SELECT judge_status FROM exploration_sessions WHERE id=$1`, [sessionId]);
    expect(s.rows[0]!.judge_status).toBe('failed');
  }, 30000);

  it('幂等：judge_status=done 再评审不重复调模型；无 findings → skipped', async () => {
    const doneSession = await insertSession({ judgeStatus: 'done' });
    await insertFinding(doneSession);
    const { client, calls } = makeLlm(() => ({ verdict: 'confirmed', reason: 'x', confidence: 1 }));

    const { judgeExplorationSession } = await import('../src/pi/exploration/judge.js');
    await judgeExplorationSession(doneSession, { llm: client, vision: false });
    expect(calls).toHaveLength(0);

    const emptySession = await insertSession();
    await judgeExplorationSession(emptySession, { llm: client, vision: false });
    const s = await pool.query(`SELECT judge_status FROM exploration_sessions WHERE id=$1`, [emptySession]);
    expect(s.rows[0]!.judge_status).toBe('skipped');
    expect(calls).toHaveLength(0);
  }, 30000);

  it('决策帧在盘上 → 评审请求带真图（评审看得见画面），材料里说明已附图', async () => {
    const sessionId = await insertSession();
    const order = sessionCounter + 1; // insertFinding increments internally — compute it up front for evidenceFrame
    const inserted = await insertFinding(sessionId, {
      evidenceFrame: { screenshotPath: `/screenshots/${sessionId}/finding-${order}.png`, capturedAt: new Date().toISOString() },
    });
    expect(inserted.order).toBe(order);
    const frame = await writeFrame(sessionId, inserted.order);
    const { client, calls } = makeLlm(() => ({ verdict: 'confirmed', reason: '截图可见列表未刷新', confidence: 0.8 }));

    const { judgeExplorationSession } = await import('../src/pi/exploration/judge.js');
    try {
      await judgeExplorationSession(sessionId, { llm: client }); // vision defaults to true = attaching frames allowed

      expect(calls).toHaveLength(1);
      // The request carries the real image of the frame on disk (not the path text).
      expect(calls[0]!.image?.base64).toBe(frame.base64);
      expect(calls[0]!.image?.mime).toBe('image/png');
      // The image block is also present in the multi-turn form (first block of the user message = decision frame).
      const first = calls[0]!.messages?.[0]!.content[0]!;
      expect(first.type).toBe('image');
      // The material explicitly states that the frame is attached (the model cross-checks the image against the description).
      expect(calls[0]!.userMessage).toContain('决策帧截图已附在本消息的图片块里');
    } finally {
      await rm(dirname(frame.file), { recursive: true, force: true });
    }
  }, 30000);

  it('附图那条路失败（网关拒图）→ 退纯文本再判一次，评审不因一张图整场挂掉', async () => {
    const sessionId = await insertSession();
    const inserted = await insertFinding(sessionId);
    await writeFrame(sessionId, inserted.order); // frame is on disk → attaching it is preferred
    const withImage: LLMRequest[] = [];
    const withoutImage: LLMRequest[] = [];
    const client: LLMClient = {
      provider: 'openai',
      complete: async (req) => {
        if (req.image || req.messages?.some((m) => m.content.some((b) => b.type === 'image'))) {
          withImage.push(req);
          throw new Error('网关拒图 400');
        }
        withoutImage.push(req);
        return { kind: 'json', value: { verdict: 'dismissed', reason: '留痕显示为预期行为', provider: 'openai', vision: false, model: 'judge-model' } };
      },
    };

    const { judgeExplorationSession } = await import('../src/pi/exploration/judge.js');
    try {
      await judgeExplorationSession(sessionId, { llm: client });

      expect(withImage).toHaveLength(1);
      expect(withoutImage).toHaveLength(1);
      const f = await pool.query(`SELECT judge FROM exploration_findings WHERE id=$1`, [inserted.id]);
      const judge = f.rows[0]!.judge as { verdict: string };
      // The second (text-only) attempt succeeds → the verdict lands normally, not unclear.
      expect(judge.verdict).toBe('dismissed');
      const s = await pool.query(`SELECT judge_status FROM exploration_sessions WHERE id=$1`, [sessionId]);
      expect(s.rows[0]!.judge_status).toBe('done');
    } finally {
      const { screenshotDiskPath } = await import('../src/execute/explorationShared.js');
      await rm(dirname(screenshotDiskPath(sessionId, inserted.order)), { recursive: true, force: true });
    }
  }, 30000);
});

describe('D2 故障注入（fault）', () => {
  it('模式名归一：中英别名 + 不认识 → null', async () => {
    const { normalizeFaultMode } = await import('../src/pi/exploration/tools/fault.js');
    expect(normalizeFaultMode('offline')).toBe('offline');
    expect(normalizeFaultMode('断网')).toBe('offline');
    expect(normalizeFaultMode('slow_network')).toBe('slow_network');
    expect(normalizeFaultMode('慢网')).toBe('slow_network');
    expect(normalizeFaultMode('cpu_throttle')).toBe('cpu_throttle');
    expect(normalizeFaultMode('节流')).toBe('cpu_throttle');
    expect(normalizeFaultMode('none')).toBe('none');
    expect(normalizeFaultMode('复原')).toBe('none');
    expect(normalizeFaultMode('banana')).toBeNull();
    expect(normalizeFaultMode(undefined)).toBeNull();
  }, 20000);

  it('控制器：断网施加/复原；切换模式先复原上一个（不叠加）', async () => {
    const { createFaultController } = await import('../src/pi/exploration/tools/fault.js');
    const offline: boolean[] = [];
    const unrouted: string[] = [];
    const context = {
      setOffline: async (v: boolean) => {
        offline.push(v);
      },
      route: async () => undefined,
      unroute: async (pattern: string) => {
        unrouted.push(pattern);
      },
      newCDPSession: async () => ({
        send: async () => undefined,
        detach: async () => undefined,
      }),
    };
    const fault = createFaultController(context as never, {} as never);

    await fault.apply('offline');
    expect(fault.current()).toBe('offline');
    expect(offline.at(-1)).toBe(true);

    // Switching to slow network: resets offline first (setOffline(false)), then mounts the route — no stacking.
    await fault.apply('slow_network');
    expect(fault.current()).toBe('slow_network');
    expect(offline.at(-1)).toBe(false);
    expect(unrouted).toContain('**/*');

    await fault.reset();
    expect(fault.current()).toBe('none');
    expect(offline.at(-1)).toBe(false);
  }, 20000);

  it('CPU 节流：CDP 设倍率；复原时倍率回 1 且 detach', async () => {
    const { createFaultController } = await import('../src/pi/exploration/tools/fault.js');
    const sent: Array<{ method: string; params: unknown }> = [];
    let detached = 0;
    const context = {
      setOffline: async () => undefined,
      route: async () => undefined,
      unroute: async () => undefined,
      newCDPSession: async () => ({
        send: async (method: string, params?: unknown) => {
          sent.push({ method, params });
        },
        detach: async () => {
          detached += 1;
        },
      }),
    };
    const fault = createFaultController(context as never, {} as never);

    await fault.apply('cpu_throttle', { rate: 8 });
    expect(fault.current()).toBe('cpu_throttle');
    expect(sent[0]).toEqual({ method: 'Emulation.setCPUThrottlingRate', params: { rate: 8 } });

    await fault.reset();
    expect(sent.at(-1)).toEqual({ method: 'Emulation.setCPUThrottlingRate', params: { rate: 1 } });
    expect(detached).toBe(1);
    expect(fault.current()).toBe('none');
  }, 20000);

  it('慢网只拖 GET：写请求照常放行', async () => {
    const { createFaultController } = await import('../src/pi/exploration/tools/fault.js');
    let handler: ((route: unknown) => Promise<void>) | null = null;
    const context = {
      setOffline: async () => undefined,
      route: async (_pattern: string, h: (route: unknown) => Promise<void>) => {
        handler = h;
      },
      unroute: async () => {
        handler = null;
      },
      newCDPSession: async () => ({ send: async () => undefined, detach: async () => undefined }),
    };
    const fault = createFaultController(context as never, {} as never);
    await fault.apply('slow_network', { delayMs: 1 });

    const continued: string[] = [];
    const makeRoute = (method: string) => ({
      request: () => ({ method: () => method }),
      continue: async () => {
        continued.push(method);
      },
    });
    await handler?.(makeRoute('GET'));
    await handler?.(makeRoute('POST'));

    // Both pass through (GET is only delayed, not blocked).
    expect(continued).toEqual(['GET', 'POST']);
  }, 20000);

  it('inject_fault 工具：非法 mode → isError（工具不 throw）；合法 mode → 施加并回报', async () => {
    const { createInjectFaultTool } = await import('../src/pi/exploration/tools/fault.js');
    const applied: string[] = [];
    const tool = createInjectFaultTool({
      fault: {
        apply: async (mode) => {
          applied.push(mode);
        },
        reset: async () => undefined,
        current: () => 'none',
      },
    });

    const bad = await tool.execute('f1', { mode: 'banana' });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain('offline');
    expect(applied).toHaveLength(0);

    const ok = await tool.execute('f2', { mode: 'offline' });
    expect(ok.isError).toBeFalsy();
    expect(applied).toEqual(['offline']);
    expect(JSON.stringify(ok.content)).toContain('observe');
  }, 20000);

  it('工具装配：未授权故障注入 → 工具不出现；授权 → 挂载 inject_fault', async () => {
    const { createExplorationTools } = await import('../src/pi/exploration/tools/index.js');
    const base = {
      page: {} as never,
      vision: true,
      scopeOrigins: ['http://sut.example.com'],
      findings: {} as never,
      noteExcluded: () => 0,
      onFinish: () => undefined,
    };
    const withoutAuth = createExplorationTools(base).map((t) => t.name);
    expect(withoutAuth).not.toContain('inject_fault');

    const withAuth = createExplorationTools({
      ...base,
      fault: {
        apply: async () => undefined,
        reset: async () => undefined,
        current: () => 'none',
      },
    }).map((t) => t.name);
    expect(withAuth).toContain('inject_fault');
  }, 20000);

  it('评审与故障注入的会话列存在（schema 锁步）', async () => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='exploration_sessions' AND column_name IN ('allow_fault_injection','judge_status','judge_result')`,
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(['allow_fault_injection', 'judge_result', 'judge_status']);
    const fcols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='exploration_findings' AND column_name='judge'`,
    );
    expect(fcols.rows).toHaveLength(1);
  }, 20000);
});
