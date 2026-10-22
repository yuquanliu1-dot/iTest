import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
import { EngineUnavailable } from '../src/execute/engine.js';

// Engine mocks at the class level. execute is a hoisted vi.fn so each test
// can reset/resolve per test. prepare/release are placed on the PROTOTYPE
// (not as arrow class fields) so individual tests can spy on them via
// vi.spyOn(MobileEngine.prototype, 'prepare') for one-off behavior such as
// throwing EngineUnavailable.
const { mobileExec, webExec } = vi.hoisted(() => ({
  mobileExec: vi.fn(),
  webExec: vi.fn(),
}));

function makeMobileEngine() {
  class MockMobileEngine {
    platform = 'mobile' as const;
    execute = mobileExec;
  }
  MockMobileEngine.prototype.prepare = vi.fn().mockResolvedValue(undefined);
  MockMobileEngine.prototype.release = vi.fn().mockResolvedValue(undefined);
  return MockMobileEngine;
}
function makeWebEngine() {
  class MockWebEngine {
    platform = 'web' as const;
    execute = webExec;
  }
  MockWebEngine.prototype.prepare = vi.fn().mockResolvedValue(undefined);
  MockWebEngine.prototype.release = vi.fn().mockResolvedValue(undefined);
  return MockWebEngine;
}

vi.mock('../src/execute/mobileEngine.js', () => ({
  MobileEngine: makeMobileEngine(),
}));
vi.mock('../src/execute/webEngine.js', () => ({
  WebEngine: makeWebEngine(),
}));

// runCase imports runCaseUrl lazily — keep default behavior. envContext requires
// a default env row to exist (resolveEnv → EnvMissing otherwise). Tests insert
// that in beforeAll. cdp/visionAssert are not exercised here because the
// engine execute mock short-circuits before they run.

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let projectId: string;
let groupId: string;
let versionId: string;
let deviceTargetId: string;
let mobileCaseId: string;
let webCaseId: string;

async function insertMobileCase(title: string): Promise<string> {
  const r = await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title, platform, mobile_os, mobile_device_target_id, app_ref) VALUES ($1, $2, $3, 'mobile', 'ios', $4, $5) RETURNING id`,
    [groupId, versionId, title, deviceTargetId, JSON.stringify({ bundleId: 'com.example.app' })],
  );
  return r.rows[0]!.id as string;
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

async function insertWebCase(title: string): Promise<string> {
  const r = await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, $3) RETURNING id`,
    [groupId, versionId, title],
  );
  return r.rows[0]!.id as string;
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
  // default env (otherwise resolveEnv throws EnvMissing → runCase writes a failed
  // report before reaching the engine branch).
  await pool.query(`INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认', true)`, [projectId]);
  // FK for mobile cases.
  const t = await pool.query(
    `INSERT INTO device_targets(project_id, name, mobile_os, device_ref) VALUES ($1, 'runcase-target', 'ios', 'iPhone 17 Pro') RETURNING id`,
    [projectId],
  );
  deviceTargetId = t.rows[0]!.id as string;
  mobileCaseId = await insertMobileCase('runcase-mobile');
  webCaseId = await insertWebCase('runcase-web');

  const { default: express } = await import('express');
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

beforeEach(() => {
  mobileExec.mockReset();
  webExec.mockReset();
});

describe('runCase platform routing', () => {
  it('mobile case → MobileEngine.execute called with correct appRef/mobileOs/deviceTargetId; web not called', async () => {
    mobileExec.mockResolvedValue([{ order: 1, status: 'passed', durationMs: 0 }]);
    webExec.mockResolvedValue([{ order: 1, status: 'passed', durationMs: 0 }]);
    const r = await request(app).post(`/api/cases/${mobileCaseId}/execute`);
    expect(r.status).toBe(200);
    await waitReportDone(r.body.reportId);
    expect(mobileExec).toHaveBeenCalledTimes(1);
    expect(webExec).not.toHaveBeenCalled();
    const input = mobileExec.mock.calls[0]![0] as import('../src/execute/engine.js').EngineInput;
    expect(input.appRef?.bundleId).toBe('com.example.app');
    expect(input.mobileOs).toBe('ios');
    expect(input.deviceTargetId).toBe(deviceTargetId);

    const rep = await request(app).get(`/api/reports/${r.body.reportId}`);
    expect(rep.status).toBe(200);
    expect(rep.body.status).toBe('passed');
    expect(rep.body.platform).toBe('mobile');
    expect(rep.body.mobileOs).toBe('ios');
    expect(rep.body.deviceTargetId).toBe(deviceTargetId);
  });

  it('MobileEngine.prepare throws EngineUnavailable → report.failureReason=EngineUnavailable, status=failed', async () => {
    const { MobileEngine } = await import('../src/execute/mobileEngine.js');
    vi.spyOn(MobileEngine.prototype, 'prepare').mockRejectedValueOnce(
      new EngineUnavailable('test device not available'),
    );
    mobileExec.mockResolvedValue([{ order: 1, status: 'passed', durationMs: 0 }]);
    const r = await request(app).post(`/api/cases/${mobileCaseId}/execute`);
    expect(r.status).toBe(200);
    await waitReportDone(r.body.reportId);
    const rep = await request(app).get(`/api/reports/${r.body.reportId}`);
    expect(rep.status).toBe(200);
    expect(rep.body.status).toBe('failed');
    expect(rep.body.stepResults).toHaveLength(1);
    expect(rep.body.stepResults[0].failureReason).toBe('EngineUnavailable');
    expect(rep.body.stepResults[0].humanMessage).toContain('移动端引擎不可用');
    // 合成失败步也带开始时刻——报告页统一展示「开始 HH:MM:SS」，不留空洞
    expect(rep.body.stepResults[0].startedAt).toBeTruthy();
    expect(Number.isNaN(new Date(rep.body.stepResults[0].startedAt).getTime())).toBe(false);
    // mobileExec must NOT have been called when prepare failed
    expect(mobileExec).not.toHaveBeenCalled();
  });

  it('web engine 执行抛错 → 合成 CDPUnavailable 失败步也带 startedAt', async () => {
    webExec.mockRejectedValue(new Error('page.goto: net::ERR_CONNECTION_REFUSED'));
    const r = await request(app).post(`/api/cases/${webCaseId}/execute`);
    expect(r.status).toBe(200);
    await waitReportDone(r.body.reportId);
    const rep = await request(app).get(`/api/reports/${r.body.reportId}`);
    expect(rep.body.status).toBe('failed');
    expect(rep.body.stepResults).toHaveLength(1);
    expect(rep.body.stepResults[0].failureReason).toBe('CDPUnavailable');
    // 合成失败步也带开始时刻（prod228 实测：浏览器起不来时该步原本无时间戳，报告页留空洞）
    expect(rep.body.stepResults[0].startedAt).toBeTruthy();
    // 用例级起止也要落——引擎挂掉不等于报告没跑
    expect(rep.body.startedAt).toBeTruthy();
    expect(rep.body.finishedAt).toBeTruthy();
  });

  it('web case → WebEngine.execute called; mobile not called', async () => {
    webExec.mockResolvedValue([{ order: 1, status: 'passed', durationMs: 0 }]);
    mobileExec.mockResolvedValue([{ order: 1, status: 'passed', durationMs: 0 }]);
    const r = await request(app).post(`/api/cases/${webCaseId}/execute`);
    expect(r.status).toBe(200);
    await waitReportDone(r.body.reportId);
    expect(webExec).toHaveBeenCalledTimes(1);
    expect(mobileExec).not.toHaveBeenCalled();
    const input = webExec.mock.calls[0]![0] as import('../src/execute/engine.js').EngineInput;
    expect(input.mobileOs).toBeNull();
    expect(input.deviceTargetId).toBeNull();

    const rep = await request(app).get(`/api/reports/${r.body.reportId}`);
    expect(rep.body.status).toBe('passed');
    expect(rep.body.platform).toBe('web');
  });

  it('dataset-bound mobile case → multiple reports (one per row), each routed to MobileEngine', async () => {
    // create a dataset and bind to the mobile case
    const { createDataset } = await import('../src/services/datasets.service.js');
    const ds = await createDataset(projectId, {
      name: 'mobile-ds',
      columns: [
        { name: 'username', sensitive: false },
        { name: 'password', sensitive: true },
      ],
      rows: [
        { disabled: false, cells: { username: 'a', password: 'pw-1' } },
        { disabled: false, cells: { username: 'b', password: 'pw-2' } },
      ],
    });
    const dsCaseId = await insertMobileCase('mobile-ds-case');
    await pool.query(`UPDATE test_cases SET dataset_id = $1 WHERE id = $2`, [ds.id, dsCaseId]);

    mobileExec.mockReset();
    mobileExec.mockResolvedValue([{ order: 1, status: 'passed', durationMs: 0 }]);
    const r = await request(app).post(`/api/cases/${dsCaseId}/execute`);
    expect(r.status).toBe(200);
    expect(r.body.reportIds).toHaveLength(2);
    expect(r.body.reportId).toBe(r.body.reportIds[0]);
    await waitReportDone(r.body.reportIds[0]);
    await waitReportDone(r.body.reportIds[1]);
    expect(mobileExec).toHaveBeenCalledTimes(2);
    // row 0 should see decrypted initialVars
    const firstInput = mobileExec.mock.calls[0]![0] as import('../src/execute/engine.js').EngineInput;
    expect(firstInput.initialVars).toEqual({ username: 'a', password: 'pw-1' });
    expect(firstInput.sensitiveVarKeys).toEqual(['password']);

    const rep0 = await request(app).get(`/api/reports/${r.body.reportIds[0]}`);
    expect(rep0.body.datasetRowIndex).toBe(0);
    expect(rep0.body.status).toBe('passed');
    const rep1 = await request(app).get(`/api/reports/${r.body.reportIds[1]}`);
    expect(rep1.body.datasetRowIndex).toBe(1);
    expect(rep1.body.status).toBe('passed');
  });
});