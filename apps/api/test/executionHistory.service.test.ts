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

    // c1: 一次通过 + 一次自愈通过 + 两次失败(其一挂在计划运行成员上) + 一次 40 天前的失败(应被 days 过滤)
    await makeReport(c1, 'passed');
    await makeReport(c1, 'passed', { healed: true });
    const f1 = await makeReport(c1, 'failed', { stepResults: [{ order: 1, status: 'failed', durationMs: 5, error: '元素未找到' }] });
    const f2 = await makeReport(c1, 'failed');
    await makeReport(c1, 'failed', { createdAt: new Date(Date.now() - 40 * 86_400_000) });
    // 把 f2 挂成计划运行成员 → case_stats 仍须计入(与 executions 列表页口径不同)
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
    // c2: 一次通过
    await makeReport(c2, 'passed');
    // 项目 B 的报告:不可见
    await makeReport(cB, 'failed');

    const svc = await import('../src/services/executionHistory.service.js');
    const rows = await svc.caseStats(a.projectId);
    expect(rows).toHaveLength(2); // cB 不可见;老报告不产生行
    expect(rows[0]!.caseId).toBe(c1); // failed=2 排最前
    expect(rows[0]).toMatchObject({ caseTitle: '登录-正常', versionName: 'v0', total: 4, passed: 1, healed: 1, failed: 2 });
    expect(rows[0]!.lastStatus).toBe('failed');
    expect(rows[1]).toMatchObject({ caseId: c2, versionName: 'v1', total: 1, failed: 0 });

    // versionId 过滤
    expect((await svc.caseStats(a.projectId, { versionId: v1 })).map((r: { caseId: string }) => r.caseId)).toEqual([c2]);
    // caseIds 过滤
    expect((await svc.caseStats(a.projectId, { caseIds: [c1] })).map((r: { caseId: string }) => r.caseId)).toEqual([c1]);
  }, 30_000);
});
