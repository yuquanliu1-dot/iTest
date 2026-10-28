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

  it('setPlanGroupCases 跨产品线 → 409;addCases 幂等追加;removeCases 后重排 1..m', async () => {
    const { groupId, versionId, projectId } = await seedProject(pool);
    // R2 起成员范围按产品线判定：外案必须落在**另一条**产品线上才会被 409。
    const otherLineId = await seedOtherProductLine(pool);
    const other = await seedProject(pool, { productLineId: otherLineId });
    const svc = await import('../src/services/plans.service.js');
    const c1 = await makeCase(groupId, versionId, 'c1');
    const c2 = await makeCase(groupId, versionId, 'c2');
    const c3 = await makeCase(groupId, versionId, 'c3');
    const plan = await svc.createPlan(projectId, { name: '全量', versionId });
    const g = await svc.createPlanGroup(plan.id, { name: 'G' });

    await expect(svc.setPlanGroupCases(plan.id, g.id, [c1, (await makeCase(other.groupId, other.versionId, 'x'))]))
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

  it('重复 caseIds 去重不误报 409;remove 清空到 0;setPlanGroupCases 空数组清空组', async () => {
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
    const g = await svc.createPlanGroup(plan.id, { name: 'G' });
    await svc.setPlanGroupCases(plan.id, g.id, [c1]);
    expect(await svc.setPlanGroupCases(plan.id, g.id, [])).toBe(0); // 空数组 = 清空该组
    const detail2 = await svc.getPlanDetail(plan.id);
    expect(detail2!.groups!.find((x) => x.id === g.id)!.cases).toEqual([]);
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

describe('plan case groups CRUD', () => {
  it('建组递增 order、改组、删空组、删非空组 409、清空后可删', async () => {
    const s = await seedProject(pool);
    const svc = await import('../src/services/plans.service.js');
    const plan = await svc.createPlan(s.projectId, { name: '分组计划', versionId: s.versionId });
    const g1 = await svc.createPlanGroup(plan.id, { name: '组A' });
    const g2 = await svc.createPlanGroup(plan.id, { name: '组B' });
    expect(g1.order).toBe(1);
    expect(g2.order).toBe(2);

    const renamed = await svc.updatePlanGroup(plan.id, g1.id, { name: '组A1', failFast: true });
    expect(renamed.name).toBe('组A1');
    expect(renamed.failFast).toBe(true);

    await expect(svc.deletePlanGroup(plan.id, g2.id)).resolves.toMatchObject({ ok: true });

    // 组A 直插 plan_cases 造非空组(setPlanGroupCases 是 Task 4) → 删除 409
    const c = await makeCase(s.groupId, s.versionId, 'gc1');
    await pool.query(`INSERT INTO plan_cases(plan_id, case_id, group_id, "order") VALUES ($1,$2,$3,1)`, [plan.id, c, g1.id]);
    await expect(svc.deletePlanGroup(plan.id, g1.id)).rejects.toMatchObject({ status: 409, code: 'group_not_empty' });

    // 清空后可删
    await pool.query(`DELETE FROM plan_cases WHERE plan_id = $1 AND group_id = $2`, [plan.id, g1.id]);
    await expect(svc.deletePlanGroup(plan.id, g1.id)).resolves.toMatchObject({ ok: true });
  }, 30_000);

  it('组重排：整包替换 order，groupId 不属于该计划 → 404', async () => {
    const s = await seedProject(pool);
    const svc = await import('../src/services/plans.service.js');
    const plan = await svc.createPlan(s.projectId, { name: 'p2', versionId: s.versionId });
    const g1 = await svc.createPlanGroup(plan.id, { name: 'A' });
    const g2 = await svc.createPlanGroup(plan.id, { name: 'B' });
    await svc.reorderPlanGroups(plan.id, [g2.id, g1.id]);
    const after = await svc.listPlanGroups(plan.id);
    expect(after.map((g) => g.name)).toEqual(['B', 'A']);
    await expect(svc.reorderPlanGroups(plan.id, ['00000000-0000-4000-8000-000000000000']))
      .rejects.toMatchObject({ status: 404 });
  }, 30_000);

  it('组环境必须属于计划项目：跨产品线 → 400 env_project_mismatch', async () => {
    const s = await seedProject(pool);
    const svc = await import('../src/services/plans.service.js');
    const plan = await svc.createPlan(s.projectId, { name: 'p3', versionId: s.versionId });
    const otherLine = await seedOtherProductLine(pool);
    const s2 = await seedProject(pool, { productLineId: otherLine });
    const env = (await pool.query(
      `INSERT INTO test_environments(project_id, name) VALUES ($1,'e') RETURNING id`, [s2.projectId],
    )).rows[0]!.id as string;
    await expect(svc.createPlanGroup(plan.id, { name: 'g', environmentId: env }))
      .rejects.toMatchObject({ status: 400, code: 'env_project_mismatch' });
  }, 30_000);
});

describe('组内用例编排', () => {
  it('setPlanGroupCases 整包替换组内用例并 1..n 重排；同用例可入多组；组内去重', async () => {
    const s = await seedProject(pool);
    const svc = await import('../src/services/plans.service.js');
    const plan = await svc.createPlan(s.projectId, { name: 'p', versionId: s.versionId });
    const gA = await svc.createPlanGroup(plan.id, { name: 'A' });
    const gB = await svc.createPlanGroup(plan.id, { name: 'B' });
    const cs = await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, 'c1'), ($1, $2, 'c2') RETURNING id`,
      [s.groupId, s.versionId]);
    const [c1, c2] = cs.rows.map((r) => r.id as string);

    await svc.setPlanGroupCases(plan.id, gA.id, [c1, c2]);
    await svc.setPlanGroupCases(plan.id, gB.id, [c1, c1]); // 同组重复去重为 1 条；跨组重复合法
    const detailA = await svc.getPlanDetail(plan.id);
    const gAafter = detailA!.groups!.find((g) => g.id === gA.id)!;
    const gBafter = detailA!.groups!.find((g) => g.id === gB.id)!;
    expect(gAafter.cases.map((c) => c.id)).toEqual([c1, c2]);
    expect(gBafter.cases.map((c) => c.id)).toEqual([c1]);
    expect(gAafter.cases.map((c) => c.order)).toEqual([1, 2]);
    // 平铺 cases（兼容旧读取）：按组序拼接
    expect(detailA!.cases.map((c) => c.id)).toEqual([c1, c2, c1]);
  }, 30_000);

  it('addPlanCases 带 groupId 追加到指定组尾；无组计划自动建「默认分组」；remove 后受影响组内重排', async () => {
    const s = await seedProject(pool);
    const svc = await import('../src/services/plans.service.js');
    const plan = await svc.createPlan(s.projectId, { name: 'p', versionId: s.versionId });
    const cs = await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, 'x1'), ($1, $2, 'x2') RETURNING id`,
      [s.groupId, s.versionId]);
    const [x1, x2] = cs.rows.map((r) => r.id as string);

    const added = await svc.addPlanCases(plan.id, [x1]); // 无组 → 自动建默认分组
    expect(added).toBe(1);
    const d1 = await svc.getPlanDetail(plan.id);
    expect(d1!.groups!.map((g) => g.name)).toEqual(['默认分组']);

    await svc.addPlanCases(plan.id, [x2]);
    const d2 = await svc.getPlanDetail(plan.id);
    expect(d2!.groups![0]!.cases.map((c) => c.id)).toEqual([x1, x2]);

    await svc.removePlanCases(plan.id, [x1]);
    const d3 = await svc.getPlanDetail(plan.id);
    expect(d3!.groups![0]!.cases.map((c) => c.id)).toEqual([x2]);
    expect(d3!.groups![0]!.cases.map((c) => c.order)).toEqual([1]);
  }, 30_000);

  it('movePlanCases 跨组移动行；reorderPlanGroupCases 组内重排', async () => {
    const s = await seedProject(pool);
    const svc = await import('../src/services/plans.service.js');
    const plan = await svc.createPlan(s.projectId, { name: 'p', versionId: s.versionId });
    const gA = await svc.createPlanGroup(plan.id, { name: 'A' });
    const gB = await svc.createPlanGroup(plan.id, { name: 'B' });
    const cs = await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, 'm1'), ($1, $2, 'm2') RETURNING id`,
      [s.groupId, s.versionId]);
    const [m1, m2] = cs.rows.map((r) => r.id as string);
    await svc.setPlanGroupCases(plan.id, gA.id, [m1, m2]);

    const rows = await pool.query(`SELECT id, case_id FROM plan_cases WHERE plan_id = $1 ORDER BY "order"`, [plan.id]);
    const rowM2 = rows.rows.find((r) => r.case_id === m2)!;
    await svc.movePlanCases(plan.id, [rowM2.id as string], gB.id);
    let d = await svc.getPlanDetail(plan.id);
    expect(d!.groups!.find((g) => g.id === gA.id)!.cases.map((c) => c.id)).toEqual([m1]);
    expect(d!.groups!.find((g) => g.id === gB.id)!.cases.map((c) => c.id)).toEqual([m2]);

    await svc.setPlanGroupCases(plan.id, gA.id, [m1, m2]);
    await svc.reorderPlanGroupCases(plan.id, gA.id, [m2, m1]);
    d = await svc.getPlanDetail(plan.id);
    expect(d!.groups!.find((g) => g.id === gA.id)!.cases.map((c) => c.id)).toEqual([m2, m1]);
  }, 30_000);
});
