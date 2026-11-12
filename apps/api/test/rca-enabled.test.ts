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
  delete process.env.REDIS_URL; // enqueue goes inline, no queue dependency
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { plansRoute } = await import('../src/routes/plans.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  // Inject the seeded org manager identity (skips real login; visibility checks depend on the managerOrgPaths subtree).
  // helpers/auth depends on the src service chain (which loads the db client), so it must be dynamically imported after DATABASE_URL points at the test container.
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/projects/:projectId/plans', plansRoute);
  app.use('/api/plans', plansRoute);
  app.use(errorHandler);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

describe('rcaEnabled 透传', () => {
  it('create 带 rcaEnabled=true → 详情可见;patch 置 false 生效', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const created = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({ name: 'RCA 计划', versionId, rcaEnabled: true });
    expect(created.status).toBe(200);
    expect(created.body.rcaEnabled).toBe(true);

    const patched = await request(app).patch(`/api/plans/${created.body.id}`).send({ rcaEnabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body.rcaEnabled).toBe(false);
  });

  it('enqueuePlanRun 把 rcaEnabled 快照进 plan_runs', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const created = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({ name: '快照计划', versionId, rcaEnabled: true });
    const run = await request(app).post(`/api/plans/${created.body.id}/run`);
    expect(run.status).toBe(200);
    // Wait for the background run to reach terminal state, avoiding a race with afterAll's pool.end (the snapshot row itself is already persisted synchronously)
    for (let i = 0; i < 50; i++) {
      const cur = await pool.query('SELECT status FROM plan_runs WHERE id = $1', [run.body.runId]);
      if (cur.rows[0]!.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const row = await pool.query('SELECT rca_enabled, status FROM plan_runs WHERE id = $1', [run.body.runId]);
    expect(row.rows[0]!.rca_enabled).toBe(true);
  });

  it('create 不带 rcaEnabled → 默认 false', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const created = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({ name: '默认 RCA 计划', versionId });
    expect(created.status).toBe(200);
    expect(created.body.rcaEnabled).toBe(false);
  });
});

describe('报告详情回带 rca', () => {
  it('属于 planRunCase 的报告带出 rca;独立报告无 rca 字段', async () => {
    const { reportsRoute } = await import('../src/routes/reports.js');
    const { projectId, groupId, versionId } = await seedProject(pool);
    const p = await pool.query(
      `INSERT INTO execution_plans(project_id, name, version_id) VALUES ($1, 'RCA 计划', $2) RETURNING id`,
      [projectId, versionId],
    );
    const planId = p.rows[0]!.id as string;
    const r = await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1, $2, 'failed', 'run_all') RETURNING id`,
      [planId, projectId],
    );
    const runId = r.rows[0]!.id as string;
    const c = await pool.query(
      `INSERT INTO test_cases(group_id, title, version_id) VALUES ($1, '带RCA用例', $2) RETURNING id`,
      [groupId, versionId],
    );
    const caseId = c.rows[0]!.id as string;
    const rep = await pool.query(
      `INSERT INTO reports(case_id, status, step_results) VALUES ($1, 'failed', '[]'::jsonb) RETURNING id`,
      [caseId],
    );
    const reportId = rep.rows[0]!.id as string;
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind, report_id, rca) VALUES ($1, $2, 1, 'failed', 'business', $3, $4::jsonb)`,
      [runId, caseId, reportId, JSON.stringify({ status: 'analyzed', category: 'system_defect', confidence: 'high', summary: '根因X' })],
    );
    // Mount routes (this file's app has no reports route; build one on the fly)
    const { default: express } = await import('express');
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { userId, username, orgId, orgPath } = await seedOrg(pool);
    const { managerUserOf } = await import('./helpers/auth.js');
    const app2 = express();
    app2.use(express.json());
    app2.use('/api', (req: import('express').Request & { user?: unknown }, _res, next) => {
      req.user = managerUserOf(userId, username, orgId, orgPath);
      next();
    });
    app2.use('/api/reports', reportsRoute);
    app2.use(errorHandler);
    const linked = await request(app2).get(`/api/reports/${reportId}`);
    expect(linked.status).toBe(200);
    expect(linked.body.planRunId).toBe(runId);
    expect(linked.body.rca.summary).toBe('根因X');

    // The same case's standalone report (no plan_run_cases link) → no rca/planRunId fields
    const solo = await pool.query(
      `INSERT INTO reports(case_id, status, step_results) VALUES ($1, 'passed', '[]'::jsonb) RETURNING id`,
      [caseId],
    );
    const soloRes = await request(app2).get(`/api/reports/${solo.rows[0]!.id as string}`);
    expect(soloRes.status).toBe(200);
    expect('rca' in soloRes.body).toBe(false);
    expect('planRunId' in soloRes.body).toBe(false);
  });
});
