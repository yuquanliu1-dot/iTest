import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { planRunsRoute } = await import('../src/routes/planRuns.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/plan-runs', planRunsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

/** 造一个计划 + 一次运行 + N 个成员用例（每个成员带一份报告）。 */
async function seedRun(opts: { status?: string; reportCount?: number } = {}) {
  const { projectId, groupId } = await seedProject(pool);
  const plan = await pool.query(`INSERT INTO execution_plans(project_id, name) VALUES ($1, 'p') RETURNING id`, [projectId]);
  const planId = plan.rows[0]!.id as string;
  const run = await pool.query(
    `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1, $2, $3, 'run_all') RETURNING id`,
    [planId, projectId, opts.status ?? 'passed'],
  );
  const runId = run.rows[0]!.id as string;
  const reportIds: string[] = [];
  for (let i = 0; i < (opts.reportCount ?? 2); i++) {
    const c = await pool.query(`INSERT INTO test_cases(group_id, title) VALUES ($1, $2) RETURNING id`, [groupId, `c${i}`]);
    const caseId = c.rows[0]!.id as string;
    const r = await pool.query(
      `INSERT INTO reports(case_id, status, step_results) VALUES ($1, 'passed', '[]'::jsonb) RETURNING id`,
      [caseId],
    );
    const reportId = r.rows[0]!.id as string;
    reportIds.push(reportId);
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, report_id, "order", status, step_kind)
       VALUES ($1, $2, $3, $4, 'passed', 'business')`,
      [runId, caseId, reportId, i],
    );
  }
  return { projectId, planId, runId, reportIds };
}

describe('plan-runs delete', () => {
  it('DELETE /:id 删掉运行与成员报告，成员行随之级联消失', async () => {
    const { runId, reportIds } = await seedRun();

    const r = await request(app).delete(`/api/plan-runs/${runId}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // 运行没了
    const runs = await pool.query(`SELECT id FROM plan_runs WHERE id = $1`, [runId]);
    expect(runs.rowCount).toBe(0);
    // 成员报告也没了（否则会作为独立用例报告重新出现在执行历史里）
    const reps = await pool.query(`SELECT id FROM reports WHERE id = ANY($1::uuid[])`, [reportIds]);
    expect(reps.rowCount).toBe(0);
    // 成员行随 plan_runs 级联删除
    const members = await pool.query(`SELECT id FROM plan_run_cases WHERE plan_run_id = $1`, [runId]);
    expect(members.rowCount).toBe(0);
  });

  it('DELETE /:id 对不存在/不可见的 id 报 404', async () => {
    const missing = await request(app).delete('/api/plan-runs/00000000-0000-0000-0000-000000000000');
    expect(missing.status).toBe(404);
  });

  it('运行中的运行拒绝删除（409），其余数据保持不变', async () => {
    const { runId, reportIds } = await seedRun({ status: 'running' });

    const r = await request(app).delete(`/api/plan-runs/${runId}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('plan_run_running');

    // 运行与报告都还在
    const runs = await pool.query(`SELECT id FROM plan_runs WHERE id = $1`, [runId]);
    expect(runs.rowCount).toBe(1);
    const reps = await pool.query(`SELECT id FROM reports WHERE id = ANY($1::uuid[])`, [reportIds]);
    expect(reps.rowCount).toBe(reportIds.length);
  });

  it('batch-delete 同样连带删除成员报告', async () => {
    const a = await seedRun();
    const b = await seedRun();

    const r = await request(app).post('/api/plan-runs/batch-delete').send({ planRunIds: [a.runId, b.runId] });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);

    const reps = await pool.query(`SELECT id FROM reports WHERE id = ANY($1::uuid[])`, [[...a.reportIds, ...b.reportIds]]);
    expect(reps.rowCount).toBe(0);
  });

  it('batch-delete 命中运行中的运行整体拒绝（409），不删任何东西', async () => {
    const ok = await seedRun();
    const running = await seedRun({ status: 'running' });

    const r = await request(app).post('/api/plan-runs/batch-delete').send({ planRunIds: [ok.runId, running.runId] });
    expect(r.status).toBe(409);

    // 两条都还在：校验在删除之前，不存在「删一半」
    const runs = await pool.query(`SELECT id FROM plan_runs WHERE id = ANY($1::uuid[])`, [[ok.runId, running.runId]]);
    expect(runs.rowCount).toBe(2);
  });
});
