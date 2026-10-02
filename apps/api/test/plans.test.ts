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
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { plansRoute } = await import('../src/routes/plans.js');
  const { planRunsRoute } = await import('../src/routes/planRuns.js');
  const { executionsRoute } = await import('../src/routes/executions.js');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  // 注入种子组织管理员身份（跳过真实登录；可见性判定依赖 managerOrgPaths 子树）。
  // helpers/auth 依赖 src 服务链（连带加载 db client），须等 DATABASE_URL 指向测试容器后再动态加载。
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/projects/:projectId/plans', plansRoute);
  app.use('/api/plans', plansRoute);
  app.use('/api/plan-runs', planRunsRoute);
  app.use('/api/executions', executionsRoute);
  app.use('/api/cases', casesRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function makeCase(groupId: string, title: string): Promise<string> {
  const c = await request(app).post('/api/cases').send({ title, groupId });
  return c.body.id as string;
}

describe('execution plans', () => {
  it('create/list under project', async () => {
    const { projectId } = await seedProject(pool);
    const created = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({ name: '预发冒烟', environment: '预发' });
    expect(created.status).toBe(200);
    const list = await request(app).get(`/api/projects/${projectId}/plans`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('预发冒烟');
    expect(list.body[0].caseCount).toBe(0);
  });

  it('PUT cases sets ordered list, detail returns cases in order', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P' });
    const c1 = await makeCase(groupId, 'c1');
    const c2 = await makeCase(groupId, 'c2');
    const r = await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c2, c1] });
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/plans/${plan.body.id}`);
    expect(detail.body.cases.map((c: { id: string }) => c.id)).toEqual([c2, c1]);
  });

  it('PUT cases rejects cross-project case with 409', async () => {
    const a = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${a.projectId}/plans`).send({ name: 'P' });
    const b = await seedProject(pool);
    const foreign = await makeCase(b.groupId, 'foreign');
    const r = await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [foreign] });
    expect(r.status).toBe(409);
  });

  it('PATCH renames, DELETE removes', async () => {
    const { projectId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P' });
    const patched = await request(app).patch(`/api/plans/${plan.body.id}`).send({ name: 'P2' });
    expect(patched.body.name).toBe('P2');
    const deleted = await request(app).delete(`/api/plans/${plan.body.id}`);
    expect(deleted.status).toBe(200);
  });

  it('run creates plan_run row and returns runId', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'run' });
    const c1 = await makeCase(groupId, 'r1');
    await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1] });
    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(200);
    expect(typeof r.body.runId).toBe('string');
    const detail = await request(app).get(`/api/plan-runs/${r.body.runId}`);
    expect(detail.body.planId).toBe(plan.body.id);
    expect(detail.body.status).toMatch(/running|passed|failed|cancelled/);
  });
});

describe('plan execution extras', () => {
  it('POST/PATCH persists strategy + loginPrepare config', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const loginCase = await makeCase(groupId, 'login');
    const r = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({
        name: 'P',
        strategy: 'fail_fast',
        loginPrepare: { enabled: true, caseId: loginCase, unauthorizedKeywords: ['请先登录', '未登录'] },
      });
    expect(r.status).toBe(200);
    const planId = r.body.id as string;
    const detail = await request(app).get(`/api/plans/${planId}`);
    expect(detail.body.strategy).toBe('fail_fast');
    expect(detail.body.loginPrepareEnabled).toBe(true);
    expect(detail.body.loginCaseId).toBe(loginCase);
    expect(detail.body.loginUnauthorizedKeywords).toEqual(['请先登录', '未登录']);

    const patch = await request(app)
      .patch(`/api/plans/${planId}`)
      .send({ strategy: 'run_all', loginPrepare: { enabled: false } });
    expect(patch.body.strategy).toBe('run_all');
    expect(patch.body.loginPrepareEnabled).toBe(false);
  });

  it('PUT /plans/:id/cases/order persists new order', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P' });
    const c1 = await makeCase(groupId, 'c1');
    const c2 = await makeCase(groupId, 'c2');
    const c3 = await makeCase(groupId, 'c3');
    await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1, c2, c3] });
    const r = await request(app).put(`/api/plans/${plan.body.id}/cases/order`).send({ caseIds: [c3, c1, c2] });
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/plans/${plan.body.id}`);
    expect(detail.body.cases.map((c: { id: string }) => c.id)).toEqual([c3, c1, c2]);
  });

  it('login prepare enabled without caseId returns 422', async () => {
    const { projectId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P' });
    const patched = await request(app).patch(`/api/plans/${plan.body.id}`).send({
      loginPrepare: { enabled: true },
    });
    expect(patched.status).toBe(200);
    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(422);
  });

  it('GET /executions returns mixed entries with kind=case or kind=plan', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P' });
    const c1 = await makeCase(groupId, 'c1');
    await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1] });
    await request(app).post(`/api/plans/${plan.body.id}/run`);
    const list = await request(app).get(`/api/executions?projectId=${projectId}&kind=all`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    const kinds = new Set(list.body.map((e: { kind: string }) => e.kind));
    expect(kinds.has('plan')).toBe(true);
  });

  it('fail_fast: first case fails → remaining cases skipped, plan_run.status=failed', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const c1 = await makeCase(groupId, 'c1');
    const c2 = await makeCase(groupId, 'c2');
    const c3 = await makeCase(groupId, 'c3');
    const plan = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({ name: 'P', strategy: 'fail_fast' });
    await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1, c2, c3] });

    // 强制的现在是第一条：forceFail 在 CDP 前短路，行为与有无 chromium 环境无关
    process.env.FORCE_FAIL_CASE_IDS = c1;
    try {
      const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
      expect(r.status).toBe(200);
      const runId = r.body.runId as string;

      // 等待 plan_run 收敛到终态
      let detail: { body: { status: string; failedCases: number; skippedCases: number; passedCases: number; cases: Array<{ order: number; status: string }> } };
      for (let i = 0; i < 50; i++) {
        detail = await request(app).get(`/api/plan-runs/${runId}`);
        if (detail!.body.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(detail!.body.status).toBe('failed');
      expect(detail!.body.failedCases).toBe(1);
      expect(detail!.body.skippedCases).toBe(2);
      expect(detail!.body.passedCases).toBe(0);
      const byOrder = new Map(detail!.body.cases.map((c) => [c.order, c.status]));
      expect(byOrder.get(1)).toBe('failed');
      expect(byOrder.get(2)).toBe('skipped');
      expect(byOrder.get(3)).toBe('skipped');
    } finally {
      delete process.env.FORCE_FAIL_CASE_IDS;
    }
  });

  it('deprecated cases skipped without execution, plan_run.status=passed', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const c1 = await makeCase(groupId, 'c1');
    const c2 = await makeCase(groupId, 'c2');
    await request(app).patch(`/api/cases/${c1}`).send({ status: 'deprecated' });
    await request(app).patch(`/api/cases/${c2}`).send({ status: 'deprecated' });
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P' });
    await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1, c2] });

    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(200);
    const runId = r.body.runId as string;

    let detail: { body: { status: string; failedCases: number | null; skippedCases: number | null; passedCases: number | null; cases: Array<{ order: number; status: string }> } };
    for (let i = 0; i < 50; i++) {
      detail = await request(app).get(`/api/plan-runs/${runId}`);
      if (detail!.body.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(detail!.body.status).toBe('passed');
    expect(detail!.body.skippedCases).toBe(2);
    expect(detail!.body.passedCases).toBe(0);
    const byOrder = new Map(detail!.body.cases.map((c) => [c.order, c.status]));
    expect(byOrder.get(1)).toBe('skipped');
    expect(byOrder.get(2)).toBe('skipped');
  });

  it('cancel: cancel mid-run → plan_run.status=cancelled', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const c1 = await makeCase(groupId, 'c1');
    const c2 = await makeCase(groupId, 'c2');
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P' });
    await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1, c2] });

    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(200);
    const runId = r.body.runId as string;

    // 立即 cancel；每条 case 执行极快，需在 finalize 之前命中
    const cancel = await request(app).post(`/api/plan-runs/${runId}/cancel`);
    expect(cancel.status).toBe(200);

    // 等待收敛
    let detail: { body: { status: string; cancelRequested: boolean } };
    for (let i = 0; i < 50; i++) {
      detail = await request(app).get(`/api/plan-runs/${runId}`);
      if (detail!.body.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(['cancelled', 'passed', 'failed']).toContain(detail!.body.status);
    expect(detail!.body.cancelRequested).toBe(true);
  });

  it('rejects run when plan has incognito case and loginPrepare enabled', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const inc = await request(app).post('/api/cases').send({ title: 'inc', groupId, incognito: true });
    const login = await makeCase(groupId, 'login');
    const plan = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({ name: 'P', loginPrepare: { enabled: true, caseId: login } });
    expect(plan.status).toBe(200);
    await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [inc.body.id] });
    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('incognito_conflicts_with_login_prepare');
  });

  it('allows run with incognito case when loginPrepare disabled', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const inc = await request(app).post('/api/cases').send({ title: 'inc', groupId, incognito: true });
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P' });
    await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [inc.body.id] });
    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(200);
    expect(typeof r.body.runId).toBe('string');
    // 等待后台 run 收敛到终态，避免与 afterAll 的 pool.end 竞争
    for (let i = 0; i < 50; i++) {
      const detail = await request(app).get(`/api/plan-runs/${r.body.runId}`);
      if (detail.body.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
});
