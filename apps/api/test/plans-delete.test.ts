import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { plansRoute } = await import('../src/routes/plans.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/plans', plansRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

/** 造一个计划 + 一次运行 + N 个成员用例（每个成员带一份报告）。 */
async function seedPlan(opts: { status?: string; reportCount?: number; runCount?: number } = {}) {
  const { projectId, groupId } = await seedProject(pool);
  const plan = await pool.query(`INSERT INTO execution_plans(project_id, name) VALUES ($1, 'p') RETURNING id`, [projectId]);
  const planId = plan.rows[0]!.id as string;
  const runIds: string[] = [];
  const reportIds: string[] = [];
  for (let k = 0; k < (opts.runCount ?? 1); k++) {
    const run = await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1, $2, $3, 'run_all') RETURNING id`,
      [planId, projectId, opts.status ?? 'passed'],
    );
    const runId = run.rows[0]!.id as string;
    runIds.push(runId);
    for (let i = 0; i < (opts.reportCount ?? 2); i++) {
      const c = await pool.query(`INSERT INTO test_cases(group_id, title) VALUES ($1, $2) RETURNING id`, [groupId, `c${k}-${i}`]);
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
  }
  return { projectId, planId, runIds, reportIds };
}

async function planRowExists(table: 'execution_plans' | 'plan_runs', id: string) {
  const r = await pool.query(`SELECT id FROM ${table} WHERE id = $1`, [id]);
  return r.rowCount === 1;
}

describe('plans delete（连运行历史一起删）', () => {
  it('DELETE /:id 删掉计划、全部运行与成员报告', async () => {
    const { planId, runIds, reportIds } = await seedPlan({ runCount: 2 });

    const r = await request(app).delete(`/api/plans/${planId}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    expect(await planRowExists('execution_plans', planId)).toBe(false);
    for (const runId of runIds) expect(await planRowExists('plan_runs', runId)).toBe(false);
    // 成员报告也没了（否则会作为独立用例报告重新出现在执行历史里）
    const reps = await pool.query(`SELECT id FROM reports WHERE id = ANY($1::uuid[])`, [reportIds]);
    expect(reps.rowCount).toBe(0);
  });

  it('DELETE /:id 对从未运行过的计划也正常（无 runs 路径）', async () => {
    const { planId } = await seedPlan({ runCount: 0 });

    const r = await request(app).delete(`/api/plans/${planId}`);
    expect(r.status).toBe(200);
    expect(await planRowExists('execution_plans', planId)).toBe(false);
  });

  it('DELETE /:id 对不存在的 id 报 404', async () => {
    const missing = await request(app).delete('/api/plans/00000000-0000-0000-0000-000000000000');
    expect(missing.status).toBe(404);
  });

  it('计划下有运行中的运行时拒绝删除（409），数据保持不变', async () => {
    const { planId, runIds, reportIds } = await seedPlan({ status: 'running' });

    const r = await request(app).delete(`/api/plans/${planId}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('plan_run_running');

    expect(await planRowExists('execution_plans', planId)).toBe(true);
    for (const runId of runIds) expect(await planRowExists('plan_runs', runId)).toBe(true);
    const reps = await pool.query(`SELECT id FROM reports WHERE id = ANY($1::uuid[])`, [reportIds]);
    expect(reps.rowCount).toBe(reportIds.length);
  });

  it('batch-delete 连带删除多个计划的运行与成员报告', async () => {
    const a = await seedPlan();
    const b = await seedPlan();

    const r = await request(app).post('/api/plans/batch-delete').send({ planIds: [a.planId, b.planId] });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);

    const reps = await pool.query(`SELECT id FROM reports WHERE id = ANY($1::uuid[])`, [[...a.reportIds, ...b.reportIds]]);
    expect(reps.rowCount).toBe(0);
  });

  it('batch-delete 命中运行中的计划整体拒绝（409），不删任何东西', async () => {
    const ok = await seedPlan();
    const running = await seedPlan({ status: 'running' });

    const r = await request(app).post('/api/plans/batch-delete').send({ planIds: [ok.planId, running.planId] });
    expect(r.status).toBe(409);

    // 两条都还在：校验在删除之前，不存在「删一半」
    expect(await planRowExists('execution_plans', ok.planId)).toBe(true);
    expect(await planRowExists('execution_plans', running.planId)).toBe(true);
  });

  it('batch-delete 含不存在的 id 报 404', async () => {
    const a = await seedPlan();
    const r = await request(app)
      .post('/api/plans/batch-delete')
      .send({ planIds: [a.planId, '00000000-0000-0000-0000-000000000000'] });
    expect(r.status).toBe(404);
    expect(await planRowExists('execution_plans', a.planId)).toBe(true);
  });

  it('batch-delete 空数组报 400', async () => {
    const r = await request(app).post('/api/plans/batch-delete').send({ planIds: [] });
    expect(r.status).toBe(400);
  });
});
