/**
 * Timeout guard: when RCA_TIMEOUT_MS elapses, runWithTimeout first steers a wrap-up message; when the RCA_GRACE_MS
 * grace period elapses it calls cancelThread (abort); in processRcaJob's finally, fillTimeoutRows writes status=timeout
 * as a fallback for failed rows that never got an rca. A hung prompt simulates a long-running AI — neither the first
 * prompt nor the steer returns, everything is driven by runWithTimeout's two Promise.race timers — which also verifies
 * the timers have a cleanup path (vitest must exit cleanly, no dangling timers left behind).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let pool: Pool;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  delete process.env.REDIS_URL;
  // Must happen before the dynamic import of rcaWorker: the module reads env at top level to fix the timeout
  process.env.RCA_TIMEOUT_MS = '200';
  process.env.RCA_GRACE_MS = '200';
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

afterEach(async () => {
  const { resetSpaceSessions } = await import('../src/pi/space/session.js');
  resetSpaceSessions();
  await pool.query(`DELETE FROM ai_threads WHERE purpose='rca'`);
});

describe('rca 超时兜底', () => {
  it('prompt 挂死 → 超时 steer 收尾 → 宽限 abort,未分析行写 status=timeout', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    // FK completeness: plan_runs.plan_id NOT NULL → a real execution_plans row is required
    const p = await pool.query(
      `INSERT INTO execution_plans(project_id, name, version_id, rca_enabled) VALUES ($1, '超时计划', $2, true) RETURNING id`,
      [projectId, versionId],
    );
    const r = await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy, rca_enabled, failed_cases)
       VALUES ($1, $2, 'failed', 'run_all', true, 1) RETURNING id`,
      [p.rows[0]!.id as string, projectId],
    );
    const runId = r.rows[0]!.id as string;
    const c = await pool.query(
      `INSERT INTO test_cases(group_id, title, version_id) VALUES ($1, '超时用例', $2) RETURNING id`,
      [groupId, versionId],
    );
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind) VALUES ($1, $2, 1, 'failed', 'business')`,
      [runId, c.rows[0]!.id as string],
    );

    const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
    const prompts: string[] = [];
    let aborted = false;
    setSpaceSessionFactory(async () => ({
      subscribe: () => () => {},
      prompt: async (text: string) => {
        prompts.push(text);
        await new Promise<void>(() => { /* hang forever to simulate a long-running AI: neither the first prompt nor the steer returns */ });
      },
      abort: () => { aborted = true; },
      dispose: () => {},
      clearQueue: () => ({ steering: [], followUp: [] }),
      isStreaming: true,
      messages: [],
    }));
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    await processRcaJob({ kind: 'rca', planRunId: runId });

    // The steer wrap-up message really went out (second prompt), then cancelThread → abort
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!).toContain('超时');
    expect(aborted).toBe(true);
    // Failed rows with no rca were fallback-marked timeout by fillTimeoutRows
    const rows = await pool.query('SELECT rca FROM plan_run_cases WHERE plan_run_id=$1', [runId]);
    expect((rows.rows[0]!.rca as Record<string, unknown>).status).toBe('timeout');
  }, 30_000);
});
