import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// mock 真实浏览器执行器：默认返回空结果（= 该行所有步骤通过）；各测试用 execMock 定制成败。
const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('../src/execute/cdp.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, executeCaseReal: execMock, executeCaseInBrowser: execMock };
});

// mock resolveCaseUrl：默认委托真实实现；urlMock 设置 once 实现时可注入 report 插入后的意外抛错。
const { urlMock } = vi.hoisted(() => ({ urlMock: vi.fn() }));
vi.mock('../src/lib/resolve-url.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/resolve-url.js')>();
  return {
    ...actual,
    resolveCaseUrl: (
      caseRow: Parameters<typeof actual.resolveCaseUrl>[0],
      o: Parameters<typeof actual.resolveCaseUrl>[1],
    ) => {
      const intercepted = urlMock(caseRow, o);
      return intercepted === undefined ? actual.resolveCaseUrl(caseRow, o) : intercepted;
    },
  };
});

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let projectId: string;
let groupId: string;
let versionId: string;

const dsBody = {
  name: '登录数据',
  columns: [
    { name: 'username', sensitive: false },
    { name: 'password', sensitive: true },
  ],
  rows: [
    { disabled: false, cells: { username: 'alice', password: 'pw-1' } },
    { disabled: false, cells: { username: 'bob', password: 'pw-2' } },
  ],
};

async function insertCase(title: string, datasetId: string | null): Promise<string> {
  const r = await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title, dataset_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [groupId, versionId, title, datasetId],
  );
  return r.rows[0].id as string;
}

/** 执行已异步化（POST 立即返回 running reportId，后台继续跑）：
 *  轮询指定 report 直到 status !== 'running'，再把 body 返回给断言。 */
async function waitReportDone(reportId: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rep = await request(app).get(`/api/reports/${reportId}`);
    expect(rep.status).toBe(200);
    if (rep.body.status !== 'running') return rep.body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`report ${reportId} still running after ${timeoutMs}ms`);
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
  // 项目默认环境：避免 EnvMissing 把每行 report 直接判失败
  await pool.query(`INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认', true)`, [projectId]);

  const { default: express } = await import('express');
  const { datasetsRoute } = await import('../src/routes/datasets.js');
  const { executeRoute } = await import('../src/routes/execute.js');
  const { reportsRoute } = await import('../src/routes/reports.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(seed.userId, seed.username, seed.orgId, seed.orgPath);
    next();
  });
  app.use('/api', datasetsRoute);
  app.use('/api', executeRoute);
  app.use('/api/reports', reportsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('runCase dataset iteration', () => {
  it('绑 2 行数据集 → 2 条 report，带 rowIndex/快照（敏感打码），执行器收到解密 initialVars', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send(dsBody);
    expect(created.status).toBe(200);
    const caseId = await insertCase('登录回放', created.body.id);

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(200);
    expect(r.body.reportIds).toHaveLength(2);
    expect(r.body.reportId).toBe(r.body.reportIds[0]);
    expect(r.body.status).toBeUndefined(); // 单执行入口不回传 status（保持旧响应形状）

    // 后台执行：轮询到两条 report 都收敛后再断言执行器调用与落库结果
    await waitReportDone(r.body.reportIds[0]);
    await waitReportDone(r.body.reportIds[1]);

    // 执行器收到该行解密后的初始变量 + 敏感列名
    expect(execMock).toHaveBeenCalledTimes(2);
    const firstCtx = execMock.mock.calls[0]![2] as { initialVars?: Record<string, string>; sensitiveVarKeys?: string[] };
    expect(firstCtx.initialVars).toEqual({ username: 'alice', password: 'pw-1' });
    expect(firstCtx.sensitiveVarKeys).toEqual(['password']);

    const rep = await request(app).get(`/api/reports/${r.body.reportIds[1]}`);
    expect(rep.status).toBe(200);
    expect(rep.body.datasetRowIndex).toBe(1);
    expect(rep.body.datasetSnapshot).toEqual({
      rowIndex: 1,
      totalRows: 2,
      values: { username: 'bob', password: '******' },
    });
    // 解密值绝不落库：report 行里搜不到明文
    const raw = await pool.query(`SELECT dataset_snapshot::text AS s FROM reports WHERE id = $1`, [r.body.reportIds[1]]);
    expect(raw.rows[0].s).not.toContain('pw-2');

    // 用例级执行起止时刻：每行各落自己的（数据集模式下两行独立）
    expect(rep.body.startedAt).toBeTruthy();
    expect(rep.body.finishedAt).toBeTruthy();
    const rep0 = await request(app).get(`/api/reports/${r.body.reportIds[0]}`);
    expect(rep0.body.startedAt).toBeTruthy();
    expect(rep0.body.finishedAt).toBeTruthy();
  });

  it('部分行选择：只跑选中的行 —— 1 条 report，rowIndex 是数据集行号，preseed 一致', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '选行执行' });
    const caseId = await insertCase('选行回放', created.body.id);
    // 只选第 2 行（启用行下标 1）
    await pool.query(`UPDATE test_cases SET dataset_row_indexes = ARRAY[1] WHERE id = $1`, [caseId]);

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(200);
    // 只产生 1 条 report（不再跑全部行）；单行时响应沿用旧形状：只有 reportId，无 reportIds
    expect(r.body.reportIds).toBeUndefined();
    expect(r.body.reportId).toBeTruthy();

    await waitReportDone(r.body.reportId);

    // 执行器只被调一次，且拿到的是被选中那一行的解密变量
    expect(execMock).toHaveBeenCalledTimes(1);
    const ctx = execMock.mock.calls[0]![2] as { initialVars?: Record<string, string> };
    expect(ctx.initialVars).toEqual({ username: 'bob', password: 'pw-2' });

    // 报告行号 = 数据集启用行号；分母 = 本批次执行行数
    const rep = await request(app).get(`/api/reports/${r.body.reportId}`);
    expect(rep.body.datasetRowIndex).toBe(1);
    expect(rep.body.datasetSnapshot).toEqual({
      rowIndex: 1,
      totalRows: 1,
      values: { username: 'bob', password: '******' },
    });

    // 该用例名下确实只有 1 条 report（preseed 与执行行集一致，没有多跑/漏跑）
    const all = await pool.query(
      `SELECT dataset_row_index FROM reports WHERE case_id = $1 ORDER BY dataset_row_index`,
      [caseId],
    );
    expect(all.rows).toHaveLength(1);
    expect(all.rows[0].dataset_row_index).toBe(1);
  });

  it('部分行选择：选多行按数据集行序执行', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({
      ...dsBody,
      name: '选多行',
      rows: [
        ...dsBody.rows,
        { disabled: false, cells: { username: 'carol', password: 'pw-3' } },
      ],
    });
    const caseId = await insertCase('选多行回放', created.body.id);
    await pool.query(`UPDATE test_cases SET dataset_row_indexes = ARRAY[2,0] WHERE id = $1`, [caseId]);

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(200);
    expect(r.body.reportIds).toHaveLength(2);

    await waitReportDone(r.body.reportIds[0]);
    await waitReportDone(r.body.reportIds[1]);

    // 执行序 = 数据集行序（升序）：第 1 行 → 第 3 行
    const first = execMock.mock.calls[0]![2] as { initialVars?: Record<string, string> };
    expect(first.initialVars?.username).toBe('alice');
    const second = execMock.mock.calls[1]![2] as { initialVars?: Record<string, string> };
    expect(second.initialVars?.username).toBe('carol');
    // report 的 rowIndex 是数据集行号（0 与 2），不是批内位置（0 与 1）
    const rows = await pool.query(
      `SELECT dataset_row_index FROM reports WHERE case_id = $1 ORDER BY dataset_row_index`,
      [caseId],
    );
    expect(rows.rows.map((x: { dataset_row_index: number }) => x.dataset_row_index)).toEqual([0, 2]);
  });

  it('越界选择 → 400 且不产生任何 report', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '越界选行' });
    const caseId = await insertCase('越界选行', created.body.id);
    await pool.query(`UPDATE test_cases SET dataset_row_indexes = ARRAY[9] WHERE id = $1`, [caseId]);
    const before = await pool.query(`SELECT count(*)::int AS n FROM reports WHERE case_id = $1`, [caseId]);

    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('超出该数据集的启用行范围');
    const after = await pool.query(`SELECT count(*)::int AS n FROM reports WHERE case_id = $1`, [caseId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('单行失败不中断：第 1 行抛错记 failed，第 2 行继续；两条 report 齐全', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '失败迭代' });
    const caseId = await insertCase('失败不中断', created.body.id);

    execMock.mockReset();
    execMock.mockRejectedValueOnce(new Error('row boom')).mockResolvedValue([]);
    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(200);
    expect(r.body.reportIds).toHaveLength(2);

    await waitReportDone(r.body.reportIds[0]);
    await waitReportDone(r.body.reportIds[1]);

    const rep0 = await request(app).get(`/api/reports/${r.body.reportIds[0]}`);
    expect(rep0.body.status).toBe('failed');
    const rep1 = await request(app).get(`/api/reports/${r.body.reportIds[1]}`);
    expect(rep1.body.status).toBe('passed');
  });

  it('report 落库后的意外错误兜底：该行记 InternalError failed，不留 running，后续行继续', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '兜底迭代' });
    const caseId = await insertCase('兜底不中断', created.body.id);

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    urlMock.mockReset();
    // 第 1 行在 report 插入之后、执行器之前抛出意外错误（非 EnvMissing/CDPUnavailable 分类路径）
    urlMock.mockImplementationOnce(() => {
      throw new Error('boom after insert');
    });
    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(200);
    expect(r.body.reportIds).toHaveLength(2);

    await waitReportDone(r.body.reportIds[0]);
    await waitReportDone(r.body.reportIds[1]);

    const rep0 = await request(app).get(`/api/reports/${r.body.reportIds[0]}`);
    expect(rep0.body.status).toBe('failed');
    expect(rep0.body.stepResults[0].failureReason).toBe('InternalError');
    expect(rep0.body.stepResults[0].error).toContain('boom after insert');
    expect(rep0.body.stepResults[0].humanMessage).toBe('执行器内部错误，该行已记为失败');

    // 后续行照常执行
    const rep1 = await request(app).get(`/api/reports/${r.body.reportIds[1]}`);
    expect(rep1.body.status).toBe('passed');
    expect(rep1.body.datasetRowIndex).toBe(1);

    // 该用例名下没有遗留 running 僵尸 report
    const all = await pool.query(
      `SELECT status, dataset_row_index FROM reports WHERE case_id = $1 ORDER BY dataset_row_index`,
      [caseId],
    );
    expect(all.rows).toHaveLength(2);
    expect(all.rows.every((x: { status: string }) => x.status !== 'running')).toBe(true);
  });

  it('异步契约：POST 立即返回 running 态 report（报告先落库，执行在后台收敛）', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '异步契约' });
    const caseId = await insertCase('异步执行', created.body.id);

    execMock.mockReset();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    // 第 1 行执行器在 gate 上挂起直到放行 → 保证 POST 返回时执行必然未完成
    execMock.mockImplementationOnce(async () => {
      await gate;
      return [{ order: 1, status: 'passed', durationMs: 0 }];
    }).mockResolvedValue([]);
    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(200);
    expect(r.body.reportIds).toHaveLength(2);
    // 执行被 gate 挂起 → 此刻 report 仍是 running（报告行先于执行存在）
    const running = await request(app).get(`/api/reports/${r.body.reportIds[0]}`);
    expect(running.body.status).toBe('running');

    release!();
    await waitReportDone(r.body.reportIds[0]);
    await waitReportDone(r.body.reportIds[1]);
    const done = await request(app).get(`/api/reports/${r.body.reportIds[0]}`);
    expect(done.body.status).toBe('passed');
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it('0 启用行 → 400 且不产生任何 report', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({
      ...dsBody,
      name: '全禁用行',
      rows: dsBody.rows.map((row) => ({ ...row, disabled: true })),
    });
    const caseId = await insertCase('空数据集', created.body.id);
    const before = await request(app).get(`/api/reports?projectId=${projectId}`);

    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(400);
    const after = await request(app).get(`/api/reports?projectId=${projectId}`);
    expect(after.body).toHaveLength(before.body.length);
  });

  it('未绑定数据集：单 report，无 reportIds（零行为变化）', async () => {
    const caseId = await insertCase('普通用例', null);
    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(200);
    expect(r.body.reportId).toBeTruthy();
    expect(r.body.reportIds).toBeUndefined();
  });

  it('批次落库：同一次执行的 N 行共用 datasetBatchId；dataset-batch 端点回同批行摘要（rowIndex 升序）', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '批次切换' });
    const caseId = await insertCase('批次切换', created.body.id);

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(200);
    await waitReportDone(r.body.reportIds[0]!);
    await waitReportDone(r.body.reportIds[1]!);

    // 同批：两行 batchId 一致且非空
    const b0 = await pool.query(`SELECT dataset_batch_id FROM reports WHERE id = $1`, [r.body.reportIds[0]]);
    const b1 = await pool.query(`SELECT dataset_batch_id FROM reports WHERE id = $1`, [r.body.reportIds[1]]);
    expect(b0.rows[0]!.dataset_batch_id).toBeTruthy();
    expect(b0.rows[0]!.dataset_batch_id).toBe(b1.rows[0]!.dataset_batch_id);

    // 端点：以第 2 行为锚也能拉到全批，rowIndex 升序 = reportIds 执行序；只回摘要列
    const batch = await request(app).get(`/api/reports/${r.body.reportIds[1]}/dataset-batch`);
    expect(batch.status).toBe(200);
    expect(batch.body.batchId).toBe(b0.rows[0]!.dataset_batch_id);
    expect(batch.body.rows).toHaveLength(2);
    expect(batch.body.rows.map((x: { datasetRowIndex: number | null }) => x.datasetRowIndex)).toEqual([0, 1]);
    expect(batch.body.rows.map((x: { id: string }) => x.id)).toEqual(r.body.reportIds);
    expect(batch.body.rows[1]!.status).toBe('passed');
    expect(batch.body.rows[1]!.datasetSnapshot).toBeTruthy();
    expect(batch.body.rows[0]!.stepResults).toBeUndefined(); // 摘要端点不带步骤明细
  });

  it('无批次/非数据集 → { batchId: null, rows: [] }；他组织报告 → 404（不泄露存在性）', async () => {
    // 非数据集执行：单 report 不落批次
    const plainId = await insertCase('普通无批次', null);
    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const pr = await request(app).post(`/api/cases/${plainId}/execute`);
    expect(pr.status).toBe(200);
    await waitReportDone(pr.body.reportId!);
    const pb = await request(app).get(`/api/reports/${pr.body.reportId}/dataset-batch`);
    expect(pb.status).toBe(200);
    expect(pb.body).toEqual({ batchId: null, rows: [] });

    // 老报告（直插、无 dataset_batch_id）同样回空
    const legacyCase = await insertCase('老报告', null);
    const ins = await pool.query(
      `INSERT INTO reports(case_id, status, step_results, summary) VALUES ($1,'passed','[]','x') RETURNING id`,
      [legacyCase],
    );
    const none = await request(app).get(`/api/reports/${ins.rows[0]!.id}/dataset-batch`);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ batchId: null, rows: [] });

    // 跨组织：他 org 项目 → 分组 → 用例 → 报告，种子身份不可见 → 404
    const otherOrg = crypto.randomUUID();
    await pool.query(`INSERT INTO organizations(id, name, path) VALUES ($1,'他组织-batch',$2)`, [otherOrg, `/${otherOrg}/`]);
    const lineId = (await pool.query(`INSERT INTO product_lines(organization_id, name) VALUES ($1,'他家线') RETURNING id`, [otherOrg])).rows[0]!.id as string;
    const projId = (await pool.query(`INSERT INTO projects(product_line_id, name) VALUES ($1,'他家项目') RETURNING id`, [lineId])).rows[0]!.id as string;
    const gId = (await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1,'他家分组') RETURNING id`, [projId])).rows[0]!.id as string;
    const cId = (await pool.query(`INSERT INTO test_cases(group_id, title) VALUES ($1,'他家用例') RETURNING id`, [gId])).rows[0]!.id as string;
    const repId = (await pool.query(
      `INSERT INTO reports(case_id, status, step_results, summary, dataset_batch_id) VALUES ($1,'passed','[]','x',$2) RETURNING id`,
      [cId, crypto.randomUUID()],
    )).rows[0]!.id as string;
    const foreign = await request(app).get(`/api/reports/${repId}/dataset-batch`);
    expect(foreign.status).toBe(404);
  });
});
