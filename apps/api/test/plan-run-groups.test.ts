import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

/**
 * Task 8 引擎双层循环集成测试：组级 fail_fast / 计划级 fail_fast（组边界评估）/ 登录复用签名 / 老运行兼容。
 * 机械执行 mock 成空步骤（不启浏览器）；失败用 FORCE_FAIL_CASE_IDS（runCase 在 CDP 前短路写失败报告）。
 */
const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('../src/execute/cdp.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, executeCaseReal: execMock, executeCaseInBrowser: execMock };
});

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
  const { plansRoute } = await import('../src/routes/plans.js');
  const { planRunsRoute } = await import('../src/routes/planRuns.js');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/projects/:projectId/plans', plansRoute);
  app.use('/api/plans', plansRoute);
  app.use('/api/plan-runs', planRunsRoute);
  app.use('/api/cases', casesRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function makeCase(groupId: string, versionId: string, title: string): Promise<string> {
  const c = await request(app).post('/api/cases').send({ title, groupId, versionId });
  return c.body.id as string;
}

/** 造默认 web 环境（无内嵌凭据）：机械用例可解析环境并 passed（执行被 mock 成空步骤）。 */
async function seedDefaultEnv(projectId: string): Promise<void> {
  await pool.query(`INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认', true)`, [projectId]);
}

interface RunDetail {
  status: string;
  failedCases: number;
  skippedCases: number;
  passedCases: number;
}

async function waitRun(runId: string): Promise<RunDetail> {
  let detail: { body: RunDetail } | undefined;
  for (let i = 0; i < 100; i++) {
    detail = await request(app).get(`/api/plan-runs/${runId}`);
    if (detail.body.status !== 'running') return detail.body;
    await new Promise((r) => setTimeout(r, 100));
  }
  return detail!.body;
}

describe('runPlan 双层循环（组级语义）', () => {
  it('组内 fail_fast：首例失败只跳过本组剩余，另一组照跑（plan=run_all）', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    await seedDefaultEnv(projectId);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const planId = plan.body.id as string;
    const gA = await request(app).post(`/api/plans/${planId}/groups`).send({ name: 'A', failFast: true });
    const gB = await request(app).post(`/api/plans/${planId}/groups`).send({ name: 'B' });
    expect(gA.status).toBe(200);
    expect(gB.status).toBe(200);
    const cFail = await makeCase(groupId, versionId, 'a1-fail');
    const a2 = await makeCase(groupId, versionId, 'a2');
    const b1 = await makeCase(groupId, versionId, 'b1');
    const b2 = await makeCase(groupId, versionId, 'b2');
    await request(app).put(`/api/plans/${planId}/groups/${gA.body.id}/cases`).send({ caseIds: [cFail, a2] });
    await request(app).put(`/api/plans/${planId}/groups/${gB.body.id}/cases`).send({ caseIds: [b1, b2] });

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    process.env.FORCE_FAIL_CASE_IDS = cFail;
    try {
      const r = await request(app).post(`/api/plans/${planId}/run`);
      expect(r.status).toBe(200);
      const runId = r.body.runId as string;
      const detail = await waitRun(runId);
      expect(detail.status).toBe('failed');
      expect(detail.failedCases).toBe(1);
      expect(detail.passedCases).toBe(2);
      expect(detail.skippedCases).toBe(1);

      const rows = (
        await pool.query(
          `SELECT case_id, status, error, group_id, group_name, group_order FROM plan_run_cases WHERE plan_run_id = $1 ORDER BY group_order, "order"`,
          [runId],
        )
      ).rows;
      expect(rows).toHaveLength(4);
      const byCase = new Map(rows.map((row: { case_id: string }) => [row.case_id, row]));
      expect(byCase.get(cFail)!.status).toBe('failed');
      const a2Row = byCase.get(a2)!;
      expect(a2Row.status).toBe('skipped');
      expect(a2Row.error).toContain('group fail_fast');
      expect(a2Row.group_name).toBe('A');
      expect(a2Row.group_order).toBe(1);
      expect(a2Row.group_id).toBe(gA.body.id);
      expect(byCase.get(b1)!.status).toBe('passed');
      expect(byCase.get(b2)!.status).toBe('passed');
      expect(byCase.get(b1)!.group_name).toBe('B');
      expect(byCase.get(b1)!.group_order).toBe(2);
      expect(byCase.get(b1)!.group_id).toBe(gB.body.id);
    } finally {
      delete process.env.FORCE_FAIL_CASE_IDS;
    }
  }, 30_000);

  it('计划级 fail_fast：前组失败 → 后续组整组 skipped（error 含 plan fail_fast）', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    await seedDefaultEnv(projectId);
    const plan = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({ name: 'P', versionId, strategy: 'fail_fast' });
    const planId = plan.body.id as string;
    const gA = await request(app).post(`/api/plans/${planId}/groups`).send({ name: 'A' });
    const gB = await request(app).post(`/api/plans/${planId}/groups`).send({ name: 'B' });
    expect(gA.status).toBe(200);
    expect(gB.status).toBe(200);
    const cFail = await makeCase(groupId, versionId, 'a1-fail');
    const b1 = await makeCase(groupId, versionId, 'b1');
    await request(app).put(`/api/plans/${planId}/groups/${gA.body.id}/cases`).send({ caseIds: [cFail] });
    await request(app).put(`/api/plans/${planId}/groups/${gB.body.id}/cases`).send({ caseIds: [b1] });

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    process.env.FORCE_FAIL_CASE_IDS = cFail;
    try {
      const r = await request(app).post(`/api/plans/${planId}/run`);
      expect(r.status).toBe(200);
      const runId = r.body.runId as string;
      const detail = await waitRun(runId);
      expect(detail.status).toBe('failed');
      expect(detail.failedCases).toBe(1);
      expect(detail.skippedCases).toBe(1);
      expect(detail.passedCases).toBe(0);

      const rows = (
        await pool.query(
          `SELECT case_id, status, error, group_name, group_order FROM plan_run_cases WHERE plan_run_id = $1 ORDER BY group_order, "order"`,
          [runId],
        )
      ).rows;
      expect(rows).toHaveLength(2);
      const byCase = new Map(rows.map((row: { case_id: string }) => [row.case_id, row]));
      expect(byCase.get(cFail)!.status).toBe('failed');
      const b1Row = byCase.get(b1)!;
      expect(b1Row.status).toBe('skipped');
      expect(b1Row.error).toContain('plan fail_fast');
      expect(b1Row.group_name).toBe('B');
      expect(b1Row.group_order).toBe(2);
    } finally {
      delete process.env.FORCE_FAIL_CASE_IDS;
    }
  }, 30_000);

  it('loginSignature 纯函数：相同配置同签名（组 id/名/序不参与）；environmentId/failFast 差异异签名', async () => {
    const { loginSignature } = await import('../src/execute/runPlan.js');
    type G = Parameters<typeof loginSignature>[0];
    const g = (over: Partial<G>): G => ({
      id: 'x',
      name: 'n',
      order: 1,
      environmentId: null,
      loginPrepareEnabled: true,
      loginCaseId: null,
      detectionUrl: null,
      loginSuccessSelector: null,
      loginUnauthorizedKeywords: null,
      failFast: false,
      targetConfig: null,
      ...over,
    });
    expect(loginSignature(g({}))).toBe(loginSignature(g({ id: 'y', name: 'z', order: 9 })));
    expect(loginSignature(g({}))).not.toBe(loginSignature(g({ environmentId: 'e1' })));
    expect(loginSignature(g({}))).not.toBe(loginSignature(g({ failFast: true })));
  });

  it('老运行兼容：plan_runs.groups=null 按标量登录快照合成单组，跑完不抛错、行照常落库', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    await seedDefaultEnv(projectId);
    const c1 = await makeCase(groupId, versionId, 'legacy-1');
    const c2 = await makeCase(groupId, versionId, 'legacy-2');
    const p = await pool.query(`INSERT INTO execution_plans(project_id, name) VALUES ($1, '老计划') RETURNING id`, [projectId]);
    const planId = p.rows[0].id as string;
    await pool.query(`INSERT INTO plan_cases(plan_id, case_id, "order") VALUES ($1, $2, 1)`, [planId, c1]);
    await pool.query(`INSERT INTO plan_cases(plan_id, case_id, "order") VALUES ($1, $2, 2)`, [planId, c2]);
    // groups=null + 标量登录快照（开登录但无登录用例、无环境凭据 → loginPrepare 以 no login case 跳过，不启浏览器）
    const run = await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy, groups, login_prepare_enabled)
       VALUES ($1, $2, 'running', 'run_all', NULL, true) RETURNING id`,
      [planId, projectId],
    );
    const runId = run.rows[0].id as string;

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await expect(runPlanAsync({ planRunId: runId })).resolves.toBeUndefined();

    const runRow = (await pool.query(`SELECT status, passed_cases FROM plan_runs WHERE id = $1`, [runId])).rows[0]!;
    expect(runRow.status).toBe('passed');
    expect(runRow.passed_cases).toBe(2);
    const rows = (
      await pool.query(
        `SELECT case_id, status, group_id, group_name, group_order FROM plan_run_cases WHERE plan_run_id = $1 ORDER BY "order"`,
        [runId],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('passed');
      expect(row.group_id).toBeNull();
      expect(row.group_name).toBe('默认分组');
      expect(row.group_order).toBe(1);
    }
  }, 30_000);
});
