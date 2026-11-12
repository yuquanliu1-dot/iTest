/**
 * Persistence cadence of the exploration runner's session activity (session-level actions_trail) — regression test.
 *
 * The detail page's "Session Activity" reads only the session-level actions_trail column, watching progress via 2s polling mid-run. Two invariants must hold:
 *  ① Actions are persisted incrementally — the detail page can see steps growing before the session ends (otherwise the whole process appears only at teardown);
 *  ② At the moment the terminal state is set, the step sequence in the DB must already be complete — the frontend stops polling as soon as it sees the terminal state,
 *     and if the order is reversed the "tail segment after the last finding" can never be fetched; a manual refresh would be required.
 *
 * ② can only be disproven via **write ordering** (backfilling after the terminal state fools a "result is correct after finish" result assertion),
 * so a PG trigger records (status, trail length) on every UPDATE of a session row:
 * any terminal record with an insufficient length means the trail was not fully written at that moment.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
// Type imports are erased at compile time (no module load triggered); aiTask is mocked — its runtime shape is provided by the mock below.
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

// Browser stub: the runner really launches chromium; here we give a minimal page shape and record newContext args to verify the viewport.
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

// LLM turn stub: the real implementation calls the model + drives the browser; this test only verifies how "the actions the platform records itself" are persisted.
vi.mock('../src/execute/aiTask.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/execute/aiTask.js')>();
  return { ...actual, runAiTask: runMock };
});

// Code scope resolution stub: the real implementation uses LLM+git (irrelevant to this test); short-circuit to no scope.
vi.mock('../src/execute/codeScope.js', () => ({
  resolveCodeScope: async () => ({ status: 'none' as const }),
}));

// Environment resolution stub: an environment with no credentials, no db (the exploration read-only scope gate only trusts the start origin).
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
/** Real runner implementation (heavy dependencies mocked; the behavior itself is real). */
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

  // Audit table: every UPDATE of a session row records one entry (status, trail length), used to disprove "trail incomplete at terminal moment".
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

/** Insert a pending session (the runner atomically claims it into running). Can carry custom viewport dimensions. */
async function insertSession(opts: { windowWidth?: number; windowHeight?: number } = {}): Promise<string> {
  const r = await pool.query(
    `INSERT INTO exploration_sessions(project_id, version_id, title, charter, persona, status, created_by_user_id, window_width, window_height)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8) RETURNING id`,
    [projectId, versionId, '轨迹回归用例', CHARTER, 'qa', userId, opts.windowWidth ?? null, opts.windowHeight ?? null],
  );
  return r.rows[0]!.id as string;
}

/** Poll until the trail grows to min steps; returns the last observed length on timeout (0 = nothing persisted mid-run at all). */
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
    /** Trail length read mid-run (should already be > 0 before the model reports any finding). */
    let midRunLen = 0;

    runMock.mockImplementation(
      async (_page: unknown, _instruction: string, _client: unknown, _mobile: unknown, opts?: RunAiTaskOpts) => {
        const onAction = opts?.onAction as ((a: AiAction, ok: boolean) => void) | undefined;
        const onFindings = opts?.onFindings as ((raw: unknown[]) => Promise<void>) | undefined;
        onAction?.({ type: 'navigate', url: 'http://127.0.0.1:56100/' } as AiAction, true);
        onAction?.({ type: 'click', selector: '#save' } as AiAction, true);
        // No finding reported yet: these two steps must already be in the DB, otherwise the detail page would be empty mid-run.
        midRunLen = await waitTrailLen(sessionId, 2);
        await onFindings?.([
          { title: '必填项留空可提交', description: '名称留空直接提交成功', severity: 'P2' },
        ]);
        // Tail segment: the action after the last finding — it must be persisted before the terminal state.
        onAction?.({ type: 'click', selector: '#tail' } as AiAction, true);
        return '探索完成';
      },
    );

    await runExplorationSession({ sessionId });

    // ① Visible mid-run: steps are already in the DB without waiting for the session to end.
    expect(midRunLen).toBeGreaterThanOrEqual(2);

    // ② Trail must be complete at terminal moment (tail not lost) — any terminal record with an insufficient length fails.
    const audit = await pool.query(`SELECT status, len FROM trail_audit ORDER BY id`);
    const terminalRows = audit.rows.filter((r) => r.status === 'completed');
    expect(terminalRows.length).toBeGreaterThan(0);
    for (const r of terminalRows) {
      expect(Number(r.len)).toBe(3);
    }

    // ③ After teardown the DB holds the complete sequence (including the tail), in order.
    const row = await pool.query(`SELECT status, actions_trail FROM exploration_sessions WHERE id=$1`, [sessionId]);
    expect(row.rows[0]!.status).toBe('completed');
    const trail = (row.rows[0]!.actions_trail ?? []) as Array<{ type: string; target: string; ok: boolean }>;
    expect(trail.map((s) => s.target)).toEqual(['http://127.0.0.1:56100/', '#save', '#tail']);
    expect(trail.every((s) => s.ok)).toBe(true);

    // ④ Default viewport = 1280×800 (consistent with the case's "default maximized" headless approximation).
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
