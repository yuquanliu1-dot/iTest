import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('query_stats 工具', () => {
  it('buildSpaceTools 注册了 query_stats;各 action 分发返回 JSON 且数字与 service 一致', async () => {
    const seed = await seedProject(pool);
    const caseId = (await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1,$2,'t-登录') RETURNING id`, [seed.groupId, seed.versionId],
    )).rows[0]!.id as string;
    await pool.query(
      `INSERT INTO reports(case_id, status, duration_ms, step_results) VALUES ($1,'failed',88,$2), ($1,'passed',10,$2)`,
      [caseId, JSON.stringify([{ order: 1, status: 'failed', durationMs: 88, error: 'x'.repeat(600) }])],
    );
    const planId = (await pool.query(
      `INSERT INTO execution_plans(project_id, version_id, name) VALUES ($1,$2,'t-计划') RETURNING id`, [seed.projectId, seed.versionId],
    )).rows[0]!.id as string;
    await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1,$2,'failed','run_all')`, [planId, seed.projectId],
    );

    const { buildSpaceTools } = await import('../src/pi/space/tools/index.js');
    const ctx = {
      threadId: 't1', versionId: seed.versionId, projectId: seed.projectId,
      repo: { cwd: null, issue: null, noRepo: false }, emit: () => {}, createdByUserId: null,
    };
    const tools = buildSpaceTools(ctx as never);
    const tool = tools.find((t) => t.name === 'query_stats');
    expect(tool).toBeTruthy();

    const ov = JSON.parse(((await tool!.execute({ action: 'overview' })) as { ok: true; data: string }).data!);
    expect(ov.caseReports.total).toBe(2);
    expect(ov.caseReports.failed).toBe(1);

    const cs = JSON.parse(((await tool!.execute({ action: 'case_stats' })) as { ok: true; data: string }).data!);
    expect(cs[0].caseTitle).toBe('t-登录');
    expect(cs[0].versionName).toBe('v0');

    const pr = JSON.parse(((await tool!.execute({ action: 'plan_runs' })) as { ok: true; data: string }).data!);
    expect(pr).toHaveLength(1);
    expect(pr[0].planName).toBe('t-计划');
  }, 30_000);

  it('failures 空结果给明确文案;report_detail 截断 1000 字;参数错误文案可操作', async () => {
    const seed = await seedProject(pool);
    const { buildHistoryTools } = await import('../src/pi/space/tools/history.js');
    const ctx = {
      threadId: 't2', versionId: seed.versionId, projectId: seed.projectId,
      repo: { cwd: null, issue: null, noRepo: false }, emit: () => {}, createdByUserId: null,
    };
    const [tool] = buildHistoryTools(ctx as never);

    // 空历史:failures → 明确文案(不是空数组 JSON)
    const empty = (await tool.execute({ action: 'failures', days: 7 })) as { ok: true; data: string };
    expect(empty.data).toContain('近 7 天无失败记录');

    // 长错误截断:600 字不截(预算内);1200 → 1000 + 省略号
    const caseId = (await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1,$2,'t-截断') RETURNING id`, [seed.groupId, seed.versionId],
    )).rows[0]!.id as string;
    const rid = (await pool.query(
      `INSERT INTO reports(case_id, status, duration_ms, step_results) VALUES ($1,'failed',1,$2) RETURNING id`,
      [caseId, JSON.stringify([{ order: 1, status: 'failed', durationMs: 1, error: 'x'.repeat(1200) }])],
    )).rows[0]!.id as string;
    const detail = JSON.parse(((await tool.execute({ action: 'report_detail', reportId: rid })) as { ok: true; data: string }).data!);
    expect(detail.steps[0].error.length).toBe(1001); // 1000 + '…'
    expect(detail.steps[0].error.endsWith('…')).toBe(true);

    // 参数校验:未知 action / 缺 reportId / limit 超界
    const bad1 = await tool.execute({ action: 'nope' });
    expect(bad1.ok).toBe(false);
    const bad2 = await tool.execute({ action: 'report_detail' });
    expect(bad2).toMatchObject({ ok: false, error: expect.stringContaining('reportId') });
    const bad3 = await tool.execute({ action: 'failures', limit: 1000 });
    expect(bad3).toMatchObject({ ok: false, error: expect.stringContaining('参数不合法') });

    // 不存在/跨项目报告
    const nf = await tool.execute({ action: 'report_detail', reportId: '00000000-0000-0000-0000-000000000000' });
    expect(nf).toMatchObject({ ok: false, error: '报告不存在或不属于当前项目' });
  }, 30_000);
});
