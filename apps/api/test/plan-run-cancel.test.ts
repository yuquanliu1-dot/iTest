import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
import type { isCancelRequested as IsCancelRequestedFn } from '../src/execute/runPlan.js';

let pool: Pool;

/** isCancelRequested depends on the db client (reads DATABASE_URL at module load), so the container must be up before dynamic import. */
let isCancelRequested: typeof IsCancelRequestedFn;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  const runPlan = await import('../src/execute/runPlan.js');
  isCancelRequested = runPlan.isCancelRequested;
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

describe('plan-run cancel across containers', () => {
  it('reads cancel_requested from DB (source of truth for other replicas)', async () => {
    const { projectId } = await seedProject(pool);
    const plan = await pool.query(`INSERT INTO execution_plans(project_id, name) VALUES ($1, 'p') RETURNING id`, [projectId]);
    const planId = plan.rows[0].id as string;
    const run = await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1, $2, 'running', 'run_all') RETURNING id`,
      [planId, projectId],
    );
    const runId = run.rows[0].id as string;

    // cancel_requested defaults to false → not cancelled
    expect(await isCancelRequested(runId)).toBe(false);

    // Simulate another replica/direct write of cancel_requested=true → this function must read it
    await pool.query(`UPDATE plan_runs SET cancel_requested = true WHERE id = $1`, [runId]);
    expect(await isCancelRequested(runId)).toBe(true);

    // Reset to false → reads not-cancelled again
    await pool.query(`UPDATE plan_runs SET cancel_requested = false WHERE id = $1`, [runId]);
    expect(await isCancelRequested(runId)).toBe(false);
  });

  it('falls back to DB false for unknown runId (no in-memory state)', async () => {
    // Rows not registered in in-memory runState: no throw, returns false
    await expect(isCancelRequested('00000000-0000-0000-0000-000000000001')).resolves.toBe(false);
  });
});