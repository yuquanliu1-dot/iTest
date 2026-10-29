import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('../src/execute/cdp.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, executeCaseReal: execMock, executeCaseInBrowser: execMock };
});

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let projectId: string;
let groupId: string;
let versionId: string;

const dsBody = {
  name: '计划数据',
  columns: [{ name: 'username', sensitive: false }],
  rows: [
    { disabled: false, cells: { username: 'u1' } },
    { disabled: false, cells: { username: 'u2' } },
  ],
};

async function insertCase(title: string, datasetId: string | null): Promise<string> {
  const r = await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title, dataset_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [groupId, versionId, title, datasetId],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  groupId = seed.groupId;
  versionId = seed.versionId;
  await pool.query(`INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认', true)`, [projectId]);

  const { default: express } = await import('express');
  const { datasetsRoute } = await import('../src/routes/datasets.js');
  const { planRunsRoute } = await import('../src/routes/planRuns.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(seed.userId, seed.username, seed.orgId, seed.orgPath);
    next();
  });
  app.use('/api', datasetsRoute);
  app.use('/api/plan-runs', planRunsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function makePlan(boundCaseId: string, plainCaseId: string): Promise<string> {
  const p = await pool.query(
    `INSERT INTO execution_plans(project_id, name) VALUES ($1, '数据集计划') RETURNING id`,
    [projectId],
  );
  const planId = p.rows[0].id as string;
  await pool.query(`INSERT INTO plan_cases(plan_id, case_id, "order") VALUES ($1, $2, 1)`, [planId, boundCaseId]);
  await pool.query(`INSERT INTO plan_cases(plan_id, case_id, "order") VALUES ($1, $2, 2)`, [planId, plainCaseId]);
  const r = await pool.query(
    `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1, $2, 'running', 'run_all') RETURNING id`,
    [planId, projectId],
  );
  return r.rows[0].id as string;
}

describe('runPlan dataset aggregation', () => {
  it('绑数据集用例产生 reportIds（N 行全过 → 用例 pass）；详情接口附 rowStatuses', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send(dsBody);
    const boundCaseId = await insertCase('绑定用例', created.body.id);
    const plainCaseId = await insertCase('普通用例', null);
    const planRunId = await makePlan(boundCaseId, plainCaseId);

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await runPlanAsync({ planRunId });

    const prc = await pool.query(`SELECT * FROM plan_run_cases WHERE plan_run_id = $1 ORDER BY "order"`, [planRunId]);
    expect(prc.rows).toHaveLength(2);
    const bound = prc.rows.find((r: { case_id: string }) => r.case_id === boundCaseId)!;
    const plain = prc.rows.find((r: { case_id: string }) => r.case_id === plainCaseId)!;
    expect(Array.isArray(bound.report_ids)).toBe(true);
    expect(bound.report_ids).toHaveLength(2);
    expect(bound.report_id).toBe(bound.report_ids[0]); // 兼容字段指向第一条
    expect(bound.status).toBe('passed'); // N 行全 pass 才 pass
    expect(plain.report_ids).toBeNull();
    expect(plain.status).toBe('passed');

    // report 实际 2 条
    const reps = await pool.query(`SELECT count(*)::int AS n FROM reports WHERE case_id = $1`, [boundCaseId]);
    expect(reps.rows[0].n).toBe(2);

    // 详情接口：rowStatuses 与 reportIds 对齐
    const detail = await request(app).get(`/api/plan-runs/${planRunId}`);
    expect(detail.status).toBe(200);
    const boundCase = detail.body.cases.find((c: { caseId: string }) => c.caseId === boundCaseId);
    expect(boundCase.rowStatuses).toEqual(['passed', 'passed']);
  });

  it('用例级行选择：计划运行只跑选中的行（report_ids 只 1 条）', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '计划行选择' });
    const boundCaseId = await insertCase('计划行选择用例', created.body.id);
    // 只跑第 2 行（启用行下标 1）
    await pool.query(`UPDATE test_cases SET dataset_row_indexes = ARRAY[1] WHERE id = $1`, [boundCaseId]);
    const plainCaseId = await insertCase('普通3', null);
    const planRunId = await makePlan(boundCaseId, plainCaseId);

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await runPlanAsync({ planRunId });

    const prc = await pool.query(`SELECT * FROM plan_run_cases WHERE plan_run_id = $1 ORDER BY "order"`, [planRunId]);
    const bound = prc.rows.find((r: { case_id: string }) => r.case_id === boundCaseId)!;
    expect(bound.report_ids).toHaveLength(1);
    expect(bound.status).toBe('passed');

    // 报告实际只有 1 条，且行号 = 数据集启用行号 1
    const reps = await pool.query(`SELECT dataset_row_index FROM reports WHERE case_id = $1`, [boundCaseId]);
    expect(reps.rows).toHaveLength(1);
    expect(reps.rows[0].dataset_row_index).toBe(1);

    const detail = await request(app).get(`/api/plan-runs/${planRunId}`);
    const boundCase = detail.body.cases.find((c: { caseId: string }) => c.caseId === boundCaseId);
    expect(boundCase.rowStatuses).toEqual(['passed']);
  });

  it('任一行 fail → 该用例 fail，计划计数 failed+1', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '行失败' });
    const boundCaseId = await insertCase('行失败用例', created.body.id);
    const plainCaseId = await insertCase('普通2', null);
    const planRunId = await makePlan(boundCaseId, plainCaseId);

    execMock.mockReset();
    execMock.mockRejectedValueOnce(new Error('row boom')).mockResolvedValue([]);
    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await runPlanAsync({ planRunId });

    const detail = await request(app).get(`/api/plan-runs/${planRunId}`);
    const boundCase = detail.body.cases.find((c: { caseId: string }) => c.caseId === boundCaseId);
    expect(boundCase.status).toBe('failed');
    expect(boundCase.rowStatuses).toEqual(['failed', 'passed']);
    expect(detail.body.failedCases).toBe(1);
    expect(detail.body.passedCases).toBe(1);
  });
});

describe('runPlan 计划级行选择覆盖', () => {
  it('计划级子集覆盖用例级：用例级全部、计划 [1] → 只跑启用行 2', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '计划覆盖A' });
    const boundCaseId = await insertCase('计划覆盖A用例', created.body.id);
    await pool.query(`UPDATE test_cases SET dataset_row_indexes = ARRAY[0,1] WHERE id = $1`, [boundCaseId]);
    const plainCaseId = await insertCase('普通5', null);
    const planRunId = await makePlan(boundCaseId, plainCaseId);
    const { rows: pr } = await pool.query(`SELECT plan_id FROM plan_runs WHERE id = $1`, [planRunId]);
    await pool.query(
      `UPDATE plan_cases SET dataset_row_indexes = ARRAY[1]::integer[] WHERE plan_id = $1 AND case_id = $2`,
      [pr[0].plan_id, boundCaseId],
    );

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await runPlanAsync({ planRunId });

    const reps = await pool.query(`SELECT dataset_row_index FROM reports WHERE case_id = $1`, [boundCaseId]);
    expect(reps.rows).toHaveLength(1);
    expect(reps.rows[0].dataset_row_index).toBe(1);
  });

  it('计划级 null → 回落用例级选择（[1] 只跑行 2）', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '计划回落' });
    const boundCaseId = await insertCase('计划回落用例', created.body.id);
    await pool.query(`UPDATE test_cases SET dataset_row_indexes = ARRAY[1] WHERE id = $1`, [boundCaseId]);
    const plainCaseId = await insertCase('普通6', null);
    const planRunId = await makePlan(boundCaseId, plainCaseId);
    // plan_cases.dataset_row_indexes 保持 NULL（默认）

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await runPlanAsync({ planRunId });

    const reps = await pool.query(`SELECT dataset_row_index FROM reports WHERE case_id = $1`, [boundCaseId]);
    expect(reps.rows).toHaveLength(1);
    expect(reps.rows[0].dataset_row_index).toBe(1);
  });

  it('计划级 [] 覆盖为全部行：用例级 [0] 子集 → 跑 2 行', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '计划全行' });
    const boundCaseId = await insertCase('计划全行用例', created.body.id);
    await pool.query(`UPDATE test_cases SET dataset_row_indexes = ARRAY[0] WHERE id = $1`, [boundCaseId]);
    const plainCaseId = await insertCase('普通7', null);
    const planRunId = await makePlan(boundCaseId, plainCaseId);
    const { rows: pr } = await pool.query(`SELECT plan_id FROM plan_runs WHERE id = $1`, [planRunId]);
    await pool.query(
      `UPDATE plan_cases SET dataset_row_indexes = ARRAY[]::integer[] WHERE plan_id = $1 AND case_id = $2`,
      [pr[0].plan_id, boundCaseId],
    );

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await runPlanAsync({ planRunId });

    const reps = await pool.query(
      `SELECT dataset_row_index FROM reports WHERE case_id = $1 ORDER BY dataset_row_index`,
      [boundCaseId],
    );
    expect(reps.rows.map((r: { dataset_row_index: number }) => r.dataset_row_index)).toEqual([0, 1]);
  });
});
