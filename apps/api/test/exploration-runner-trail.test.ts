/**
 * 探索 runner 的会话过程（会话级 actions_trail）落库节奏——回归测试。
 *
 * 详情页「会话过程」只读会话级 actions_trail 列，跑动中靠 2s 轮询看进度。两个必须成立的不变量：
 *  ① 动作要增量落库——会话结束前详情页就能看到步骤在长（否则整场过程拖到收尾才出现）；
 *  ② 置终态的那一刻，库里的步骤序列必须已完整——前端一看到终态就停轮询，
 *     顺序反了则「最后一条 finding 之后的尾段」永远拉不到，得手动刷新。
 *
 * ② 只有靠**写入时序**才能证伪（终态后补写骗得过「结束后结果正确」的结果断言），
 * 所以用 PG 触发器记录每次 UPDATE 会话行时的 (状态, 留痕长度)：
 * 任何一条终态记录的长度不足，就说明终态那一刻留痕还没写全。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
// 类型导入编译期擦除（不触发模块加载）；aiTask 被 mock，运行时形状由下面的 mock 提供。
import type { AiAction, RunAiTaskOpts } from '../src/execute/aiTask.js';

const { runMock, pageMock, newContextCalls } = vi.hoisted(() => {
  const page = {
    screenshot: async (): Promise<Buffer> => Buffer.from('fake-png'),
    url: () => 'http://127.0.0.1:56100/',
    viewportSize: () => ({ width: 1280, height: 800 }),
  };
  const newContextCalls: Array<Record<string, unknown>> = [];
  return { runMock: vi.fn(), pageMock: page, newContextCalls };
});

// 浏览器打桩：runner 真实起 chromium，这里只给一个最小 page 形状；记录 newContext 入参验视口。
vi.mock('playwright-core', () => ({
  chromium: {
    launch: async () => ({
      newContext: async (opts?: Record<string, unknown>) => {
        newContextCalls.push(opts ?? {});
        return {
          newPage: async () => pageMock,
          storageState: async () => ({}),
        };
      },
      close: async () => undefined,
    }),
  },
}));

// LLM 回合打桩：真实实现要调模型 + 驱动浏览器，本测试只验「平台自己记的动作」怎么落库。
vi.mock('../src/execute/aiTask.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/execute/aiTask.js')>();
  return { ...actual, runAiTask: runMock };
});

// 代码范围解析打桩：真实实现走 LLM+git（与本测试无关），短路返回无范围。
vi.mock('../src/execute/codeScope.js', () => ({
  resolveCodeScope: async () => ({ status: 'none' as const }),
}));

// 环境解析打桩：给一个无凭据、无 db 的环境（探索只读范围闸只认起点 origin）。
vi.mock('../src/execute/envContext.js', () => ({
  resolveEnv: async () => ({
    envId: 'env-test',
    baseUrl: 'http://127.0.0.1:56100/',
    webServices: [],
    dbs: [],
    resolveLogin: () => null,
    resolveDb: () => null,
    resolveDbPool: async () => {
      throw new Error('本用例不查库');
    },
    close: async () => undefined,
  }),
}));

vi.mock('../src/agent/llmSettings.js', () => ({
  resolveLlmClient: () => ({ client: {} }),
}));

vi.mock('../src/execute/liveView.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/execute/liveView.js')>();
  return {
    ...actual,
    registerLiveView: () => ({ key: 'test', setPage: () => undefined, close: () => undefined }),
  };
});

vi.mock('../src/execute/pageSettle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/execute/pageSettle.js')>();
  return { ...actual, waitForPageSettled: async () => undefined };
});

let pool: Pool;
let projectId: string;
let versionId: string;
let userId: string;
/** runner 真实实现（重依赖已 mock，行为本身是真的）。 */
let runExplorationSession: typeof import('../src/execute/exploration.js').runExplorationSession;

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
  const mod = await import('../src/execute/exploration.js');
  runExplorationSession = mod.runExplorationSession;

  // 审计表：每次 UPDATE 会话行都记一笔 (状态, 留痕长度)，用于证伪「终态那一刻留痕不完整」。
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

const CHARTER = '探索用户管理页面的增删改查，报告所有异常行为与校验缺失。';

/** 建一条待执行会话（pending，runner 会原子认领成 running）。可带自定义视口宽高。 */
async function insertSession(opts: { windowWidth?: number; windowHeight?: number } = {}): Promise<string> {
  const r = await pool.query(
    `INSERT INTO exploration_sessions(project_id, version_id, title, charter, persona, status, created_by_user_id, window_width, window_height)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8) RETURNING id`,
    [projectId, versionId, '轨迹回归用例', CHARTER, 'qa', userId, opts.windowWidth ?? null, opts.windowHeight ?? null],
  );
  return r.rows[0]!.id as string;
}

/** 轮询等留痕长到 min 步；超时返回最后一次读到的长度（0 = 跑动中根本没落库）。 */
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

describe('探索 runner 会话过程落库节奏', () => {
  it('跑动中动作增量落库；置终态那一刻留痕已完整', async () => {
    const sessionId = await insertSession();
    /** 跑动中读到的留痕长度（模型还没报 finding 时就该 > 0）。 */
    let midRunLen = 0;

    runMock.mockImplementation(
      async (_page: unknown, _instruction: string, _client: unknown, _mobile: unknown, opts?: RunAiTaskOpts) => {
        const onAction = opts?.onAction as ((a: AiAction, ok: boolean) => void) | undefined;
        const onFindings = opts?.onFindings as ((raw: unknown[]) => Promise<void>) | undefined;
        onAction?.({ type: 'navigate', url: 'http://127.0.0.1:56100/' } as AiAction, true);
        onAction?.({ type: 'click', selector: '#save' } as AiAction, true);
        // 还没报任何 finding：这两步必须已经在库里，否则详情页跑动中空空如也。
        midRunLen = await waitTrailLen(sessionId, 2);
        await onFindings?.([
          { title: '必填项留空可提交', description: '名称留空直接提交成功', severity: 'P2' },
        ]);
        // 尾段：最后一条 finding 之后的动作——它必须在终态之前就落库。
        onAction?.({ type: 'click', selector: '#tail' } as AiAction, true);
        return '探索完成';
      },
    );

    await runExplorationSession({ sessionId });

    // ① 跑动中可见：不等会话结束，步骤已经在库里。
    expect(midRunLen).toBeGreaterThanOrEqual(2);

    // ② 终态那一刻留痕必须已完整（尾段不丢）——任何一条终态记录长度不足即失败。
    const audit = await pool.query(`SELECT status, len FROM trail_audit ORDER BY id`);
    const terminalRows = audit.rows.filter((r) => r.status === 'completed');
    expect(terminalRows.length).toBeGreaterThan(0);
    for (const r of terminalRows) {
      expect(Number(r.len)).toBe(3);
    }

    // ③ 收尾后库里是完整序列（含尾段），顺序不乱。
    const row = await pool.query(`SELECT status, actions_trail FROM exploration_sessions WHERE id=$1`, [sessionId]);
    expect(row.rows[0]!.status).toBe('completed');
    const trail = (row.rows[0]!.actions_trail ?? []) as Array<{ type: string; target: string; ok: boolean }>;
    expect(trail.map((s) => s.target)).toEqual(['http://127.0.0.1:56100/', '#save', '#tail']);
    expect(trail.every((s) => s.ok)).toBe(true);

    // ④ 缺省视口 = 1280×800（与用例「默认最大化」headless 近似值一致）。
    expect(newContextCalls[0]?.viewport).toEqual({ width: 1280, height: 800 });
  }, 30000);

  it('会话带成对 window_width/window_height → newContext 用自定义视口', async () => {
    const sessionId = await insertSession({ windowWidth: 1600, windowHeight: 900 });
    runMock.mockImplementation(async () => '探索完成');
    await runExplorationSession({ sessionId });
    expect(newContextCalls[newContextCalls.length - 1]?.viewport).toEqual({ width: 1600, height: 900 });
    const row = await pool.query(`SELECT status FROM exploration_sessions WHERE id=$1`, [sessionId]);
    expect(row.rows[0]!.status).toBe('completed');
  }, 30000);
});
