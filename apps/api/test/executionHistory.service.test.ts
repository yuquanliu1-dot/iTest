import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let pool: Pool;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

async function makeCase(groupId: string, versionId: string, title: string): Promise<string> {
  return (await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1,$2,$3) RETURNING id`, [groupId, versionId, title],
  )).rows[0]!.id as string;
}

async function makeReport(
  caseId: string,
  status: 'passed' | 'failed',
  opts: { healed?: boolean; createdAt?: Date; durationMs?: number; stepResults?: unknown[] } = {},
): Promise<string> {
  return (await pool.query(
    `INSERT INTO reports(case_id, status, duration_ms, step_results, healed, created_at)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6, now())) RETURNING id`,
    [caseId, status, opts.durationMs ?? 100,
      JSON.stringify(opts.stepResults ?? [{ order: 1, status, durationMs: 10 }]),
      opts.healed ?? false, opts.createdAt ?? null],
  )).rows[0]!.id as string;
}

describe('executionHistory.service caseStats', () => {
  it('项目域聚合:含计划成员执行;失败数排序;版本标注;跨项目隔离;days 过滤', async () => {
    const a = await seedProject(pool); // {projectId, groupId, versionId(v0)}
    const b = await seedProject(pool);
    const v1 = (await pool.query(
      `INSERT INTO project_versions(project_id, name) VALUES ($1,'v1') RETURNING id`, [a.projectId],
    )).rows[0]!.id as string;

    const c1 = await makeCase(a.groupId, a.versionId, '登录-正常');
    const c2 = await makeCase(a.groupId, v1, '下单-失败');
    const cB = await makeCase(b.groupId, b.versionId, '别家的用例');

    // c1: one pass + one healed pass + two failures (one hung on a plan-run member) + one 40-day-old failure (should be filtered by days)
    await makeReport(c1, 'passed');
    await makeReport(c1, 'passed', { healed: true });
    const f1 = await makeReport(c1, 'failed', { stepResults: [{ order: 1, status: 'failed', durationMs: 5, error: '元素未找到' }] });
    const f2 = await makeReport(c1, 'failed');
    await makeReport(c1, 'failed', { createdAt: new Date(Date.now() - 40 * 86_400_000) });
    // hang f2 as a plan-run member -> case_stats must still count it (different accounting from the executions list page)
    const plan = (await pool.query(
      `INSERT INTO execution_plans(project_id, version_id, name) VALUES ($1,$2,'回归') RETURNING id`, [a.projectId, a.versionId],
    )).rows[0]!.id as string;
    const run = (await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1,$2,'failed','run_all') RETURNING id`, [plan, a.projectId],
    )).rows[0]!.id as string;
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, report_id, "order", status, step_kind) VALUES ($1,$2,$3,1,'failed','mechanical')`,
      [run, c1, f2],
    );
    // c2: one pass
    await makeReport(c2, 'passed');
    // project B's report: not visible
    await makeReport(cB, 'failed');

    const svc = await import('../src/services/executionHistory.service.js');
    const rows = await svc.caseStats(a.projectId);
    expect(rows).toHaveLength(2); // cB not visible; old reports produce no rows
    expect(rows[0]!.caseId).toBe(c1); // failed=2 sorts first
    expect(rows[0]).toMatchObject({ caseTitle: '登录-正常', versionName: 'v0', total: 4, passed: 1, healed: 1, failed: 2 });
    expect(rows[0]!.lastStatus).toBe('failed');
    expect(rows[1]).toMatchObject({ caseId: c2, versionName: 'v1', total: 1, failed: 0 });

    // versionId filter
    expect((await svc.caseStats(a.projectId, { versionId: v1 })).map((r: { caseId: string }) => r.caseId)).toEqual([c2]);
    // caseIds filter
    expect((await svc.caseStats(a.projectId, { caseIds: [c1] })).map((r: { caseId: string }) => r.caseId)).toEqual([c1]);
  }, 30_000);
});

describe('executionHistory.service overview + failures', () => {
  it('overview:总数/通过率/top5;failures:失败明细含 lastAssertion 与 planRunId', async () => {
    const a = await seedProject(pool);
    const c1 = await makeCase(a.groupId, a.versionId, '充值-超时');
    const c2 = await makeCase(a.groupId, a.versionId, '查询-正常');
    await makeReport(c2, 'passed');
    await makeReport(c1, 'failed', {
      stepResults: [
        { order: 1, status: 'passed', durationMs: 10 },
        { order: 2, status: 'passed', durationMs: 10 },
        { order: -1, status: 'failed', durationMs: 0, error: 'vision 追加失败步', visionAssert: { passed: false, reason: '页面缺少充值入口' } },
      ],
    });
    const member = await makeReport(c1, 'failed', {
      stepResults: [{ order: 1, status: 'failed', durationMs: 3, error: '按钮不可点击' }],
    });
    const plan = (await pool.query(
      `INSERT INTO execution_plans(project_id, name) VALUES ($1,'无版本计划') RETURNING id`, [a.projectId], // version_id is null
    )).rows[0]!.id as string;
    const run = (await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy, total_cases, passed_cases, failed_cases) VALUES ($1,$2,'failed','run_all',2,0,2) RETURNING id`, [plan, a.projectId],
    )).rows[0]!.id as string;
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, report_id, "order", status, step_kind) VALUES ($1,$2,$3,1,'failed','mechanical')`,
      [run, c1, member],
    );

    const svc = await import('../src/services/executionHistory.service.js');
    const ov = await svc.historyOverview(a.projectId);
    expect(ov.caseReports).toMatchObject({ total: 3, passed: 1, healed: 0, failed: 2 });
    expect(ov.caseReports.passRatePct).toBeCloseTo(33.3, 1);
    expect(ov.planRuns).toMatchObject({ total: 1, failed: 1, passed: 0 });
    expect(ov.topFailedCases[0]!.caseId).toBe(c1);
    expect(ov.topFailedCases.length).toBeLessThanOrEqual(5);

    const fs = await svc.failureList(a.projectId);
    expect(fs).toHaveLength(2);
    expect(fs[0]!.caseId).toBe(c1); // newest failure first (member inserted later)
    const byId = new Map(fs.map((f: { reportId: string }) => [f.reportId, f]));
    const visionRow = fs.find((f: { lastAssertion: string | null }) => f.lastAssertion === '页面缺少充值入口');
    expect(visionRow).toBeTruthy(); // lastAssertion prefers visionAssert.reason
    expect(byId.get(member)!.lastAssertion).toBe('按钮不可点击'); // failed step's error as fallback
    expect(byId.get(member)!.planRunId).toBe(run); // plan members trace back to plan_run
    // caseId filter + limit
    expect((await svc.failureList(a.projectId, { caseId: c2 }))).toHaveLength(0);
    expect((await svc.failureList(a.projectId, { limit: 1 }))).toHaveLength(1);
  }, 30_000);
});

describe('executionHistory.service reportDetail + planRunList', () => {
  it('reportDetail:步骤时间线映射 visionAssert/healed/degraded;跨项目/不存在 → null', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    const c1 = await makeCase(a.groupId, a.versionId, '导出-报表');
    const rid = await makeReport(c1, 'failed', {
      stepResults: [
        { order: 1, status: 'passed', durationMs: 12, instruction: '打开报表页' },
        { order: 2, status: 'failed', durationMs: 30, instruction: '点击导出按钮', error: 'timeout 30000ms exceeded', humanMessage: '导出按钮未响应', failureReason: 'LocatorMismatch', degraded: true },
        { order: -1, status: 'failed', durationMs: 0, visionAssert: { passed: false, reason: '页面未出现下载提示' } },
      ],
    });
    const ridB = await makeReport((await makeCase(b.groupId, b.versionId, '隔离用')), 'passed');

    const svc = await import('../src/services/executionHistory.service.js');
    const d = await svc.reportDetail(a.projectId, rid);
    expect(d!.caseTitle).toBe('导出-报表');
    expect(d!.versionName).toBe('v0');
    expect(d!.steps).toHaveLength(3);
    expect(d!.steps[0]).toMatchObject({ order: 1, status: 'passed', instruction: '打开报表页' });
    expect(d!.steps[1]).toMatchObject({ status: 'failed', error: 'timeout 30000ms exceeded', humanMessage: '导出按钮未响应', failureReason: 'LocatorMismatch', degraded: true });
    expect(d!.steps[2]!.visionAssert).toMatchObject({ passed: false, reason: '页面未出现下载提示' });
    expect(await svc.reportDetail(a.projectId, ridB)).toBeNull(); // cross-project not visible
    expect(await svc.reportDetail(a.projectId, '00000000-0000-0000-0000-000000000000')).toBeNull();
  }, 30_000);

  it('planRunList:版本标注(无版本→null);触发人解析;status/planId 过滤', async () => {
    const a = await seedProject(pool);
    const c1 = await makeCase(a.groupId, a.versionId, 'p-用例');
    const planV = (await pool.query(
      `INSERT INTO execution_plans(project_id, version_id, name) VALUES ($1,$2,'带版本计划') RETURNING id`, [a.projectId, a.versionId],
    )).rows[0]!.id as string;
    const planN = (await pool.query(
      `INSERT INTO execution_plans(project_id, name) VALUES ($1,'无版本计划') RETURNING id`, [a.projectId],
    )).rows[0]!.id as string;
    // trigger user = the seeded admin
    const org = (await pool.query(`SELECT id FROM users ORDER BY created_at DESC LIMIT 1`)).rows[0]!;
    await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy, total_cases, passed_cases, triggered_by_user_id, started_at)
       VALUES ($1,$2,'passed','run_all',1,1,$3, now() - interval '1 hour'), ($4,$2,'failed','run_all',1,0,$3, now())`,
      [planV, a.projectId, org.id, planN],
    );
    // another project's run: not visible
    const b = await seedProject(pool);
    await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1,$2,'failed','run_all')`,
      [(await pool.query(`INSERT INTO execution_plans(project_id, name) VALUES ($1,'B计划') RETURNING id`, [b.projectId])).rows[0]!.id, b.projectId],
    );

    const svc = await import('../src/services/executionHistory.service.js');
    const rows = await svc.planRunList(a.projectId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.planName).toBe('无版本计划'); // newest first
    expect(rows[0]!.versionName).toBeNull();
    expect(rows[1]!.versionName).toBe('v0');
    expect(rows.every((r: { triggeredBy: string | null }) => r.triggeredBy === '测试管理员')).toBe(true);
    expect((await svc.planRunList(a.projectId, { status: 'passed' })).map((r: { planName: string }) => r.planName)).toEqual(['带版本计划']);
    expect((await svc.planRunList(a.projectId, { planId: planN }))).toHaveLength(1);
  }, 30_000);
});
