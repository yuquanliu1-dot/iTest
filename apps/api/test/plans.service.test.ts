import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject, seedOtherProductLine } from './helpers/db.js';

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

describe('plans.service', () => {
  it('createPlan:version 跨项目 → 400;environmentId 跨项目 → 400;成功返回行', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    const env = (await pool.query(
      `INSERT INTO test_environments(project_id, name) VALUES ($1,'B环境') RETURNING id`, [b.projectId],
    )).rows[0]!.id as string;
    const svc = await import('../src/services/plans.service.js');
    await expect(svc.createPlan(a.projectId, { name: 'p', versionId: b.versionId }))
      .rejects.toMatchObject({ status: 400, code: 'version_mismatch' });
    const plan = await svc.createPlan(a.projectId, { name: '冒烟', versionId: a.versionId });
    await expect(svc.createPlan(a.projectId, { name: 'p2', versionId: a.versionId, environmentId: env }))
      .rejects.toMatchObject({ status: 400, code: 'env_project_mismatch' });
    expect(plan.versionId).toBe(a.versionId);
    expect(await svc.planProjectId(plan.id)).toBe(a.projectId);
  }, 30_000);

  it('replacePlanCases 跨产品线 → 409;addCases 幂等追加;removeCases 后重排 1..m', async () => {
    const { groupId, versionId, projectId } = await seedProject(pool);
    // R2 起成员范围按产品线判定：外案必须落在**另一条**产品线上才会被 409。
    const otherLineId = await seedOtherProductLine(pool);
    const other = await seedProject(pool, { productLineId: otherLineId });
    const svc = await import('../src/services/plans.service.js');
    const c1 = await makeCase(groupId, versionId, 'c1');
    const c2 = await makeCase(groupId, versionId, 'c2');
    const c3 = await makeCase(groupId, versionId, 'c3');
    const plan = await svc.createPlan(projectId, { name: '全量', versionId });

    await expect(svc.replacePlanCases(plan.id, [c1, (await makeCase(other.groupId, other.versionId, 'x'))]))
      .rejects.toMatchObject({ status: 409, code: 'cross_project' });

    await svc.addPlanCases(plan.id, [c1, c2]);
    const addedAgain = await svc.addPlanCases(plan.id, [c2, c3]); // c2 已在 → 只追加 c3
    expect(addedAgain).toBe(1);
    let detail = await svc.getPlanDetail(plan.id);
    expect(detail!.cases.map((c) => c.order)).toEqual([1, 2, 3]);

    await svc.removePlanCases(plan.id, [c2]);
    detail = await svc.getPlanDetail(plan.id);
    expect(detail!.cases.map((c) => c.order)).toEqual([1, 2]); // c1, c3 重排
  }, 30_000);

  it('重复 caseIds 去重不误报 409;remove 清空到 0;replace 空数组 400', async () => {
    const { groupId, versionId, projectId } = await seedProject(pool);
    const svc = await import('../src/services/plans.service.js');
    const c1 = await makeCase(groupId, versionId, 'rc1');
    const c2 = await makeCase(groupId, versionId, 'rc2');
    const plan = await svc.createPlan(projectId, { name: '重复', versionId });
    expect(await svc.addPlanCases(plan.id, [c1, c1])).toBe(1); // 重复去重,只加 1
    expect(await svc.addPlanCases(plan.id, [c1, c2])).toBe(1); // c1 已在,补 c2
    expect(await svc.removePlanCases(plan.id, [c1, c2])).toBe(2); // 清空
    const detail = await svc.getPlanDetail(plan.id);
    expect(detail!.cases).toEqual([]);
    expect(await svc.removePlanCases(plan.id, [c1])).toBe(0); // 空计划再删 → 0
    await expect(svc.replacePlanCases(plan.id, [])).rejects.toMatchObject({ status: 400 });
  }, 30_000);

  it('listPlansByVersion 带 caseCount;updatePlan 归属校验', async () => {
    const { groupId, versionId, projectId } = await seedProject(pool);
    const svc = await import('../src/services/plans.service.js');
    const plan = await svc.createPlan(projectId, { name: 'L', versionId });
    await svc.addPlanCases(plan.id, [await makeCase(groupId, versionId, 'lc')]);
    const list = await svc.listPlansByVersion(versionId);
    expect(list).toHaveLength(1);
    expect(list[0]!.caseCount).toBe(1);
    await expect(svc.updatePlan(plan.id, { versionId: (await seedProject(pool)).versionId }))
      .rejects.toMatchObject({ status: 400, code: 'version_mismatch' });
    const upd = await svc.updatePlan(plan.id, { name: 'L2', strategy: 'fail_fast' });
    expect(upd.name).toBe('L2');
  }, 30_000);
});
