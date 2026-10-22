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
});
