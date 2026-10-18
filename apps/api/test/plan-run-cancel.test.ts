import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
import type { isCancelRequested as IsCancelRequestedFn } from '../src/execute/runPlan.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

/** isCancelRequested 依赖 db client（模块加载时读 DATABASE_URL），须先起容器再动态 import。 */
let isCancelRequested: typeof IsCancelRequestedFn;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const runPlan = await import('../src/execute/runPlan.js');
  isCancelRequested = runPlan.isCancelRequested;
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
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

    // cancel_requested 默认 false → 未取消
    expect(await isCancelRequested(runId)).toBe(false);

    // 模拟另一副本/direct 写入 cancel_requested=true → 本函数须读到
    await pool.query(`UPDATE plan_runs SET cancel_requested = true WHERE id = $1`, [runId]);
    expect(await isCancelRequested(runId)).toBe(true);

    // 复位 false → 重新读到未取消
    await pool.query(`UPDATE plan_runs SET cancel_requested = false WHERE id = $1`, [runId]);
    expect(await isCancelRequested(runId)).toBe(false);
  });

  it('falls back to DB false for unknown runId (no in-memory state)', async () => {
    // 未在内存 runState 注册的行：不抛、返回 false
    await expect(isCancelRequested('00000000-0000-0000-0000-000000000001')).resolves.toBe(false);
  });
});