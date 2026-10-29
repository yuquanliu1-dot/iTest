/**
 * 执行计划领域服务:计划 CRUD 与组内用例编排(set/add/remove/move/reorder)。
 * 归属校验(计划 ∈ project、version/environment/cases ∈ 计划所属 project)在这里;
 * 用户可见性由调用方(HTTP 边界)负责。
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { executionPlans, groups, planCaseGroups, planCases, projects, projectVersions, testCases, testEnvironments } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { attachCreators, attachCreator } from '../lib/creator.js';
import { assertDatasetRowIndexes } from './datasets.service.js';

export async function planProjectId(planId: string): Promise<string | null> {
  const row = (await db.select({ projectId: executionPlans.projectId }).from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
  return row?.projectId ?? null;
}

export async function listPlansByVersion(versionId: string) {
  const plans = await db.select().from(executionPlans)
    .where(eq(executionPlans.versionId, versionId))
    .orderBy(asc(executionPlans.createdAt));
  const pcs = plans.length
    ? await db.select().from(planCases).where(inArray(planCases.planId, plans.map((p) => p.id)))
    : [];
  const countByPlan = new Map<string, number>();
  for (const pc of pcs) countByPlan.set(pc.planId, (countByPlan.get(pc.planId) ?? 0) + 1);
  return attachCreators(plans.map((p) => ({ ...p, caseCount: countByPlan.get(p.id) ?? 0 })));
}

/** 计划级覆盖：用例默认 device_target / 浏览器上下文可在「加进计划」时改写,
 *  不动用例本体,仅本次计划执行时按覆盖解析。null = 沿用例自带值。 */
export type TargetOverride = {
  deviceTargetId?: string;
  browserContext?: 'incognito' | 'persistent';
} | null;

export interface UpdatePlanCasePatch {
  targetOverride?: TargetOverride;
}

export interface UpdatePlanCaseResult {
  caseId: string;
  targetOverride: TargetOverride;
}

/** 计划内用例覆盖值写入；null/undefined 显式落 null（清空覆盖回到用例自带值），
 *  undefined 表示不动（与 nullable 的语义分离，调用方通过 patch 里字段是否存在判定）。 */
export async function updatePlanCase(planId: string, caseId: string, patch: UpdatePlanCasePatch): Promise<UpdatePlanCaseResult> {
  const existing = (await db.select().from(planCases).where(and(eq(planCases.planId, planId), eq(planCases.caseId, caseId))).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'plan case not found');
  if (patch.targetOverride !== undefined) {
    await db.update(planCases).set({ targetOverride: patch.targetOverride }).where(eq(planCases.id, existing.id));
  }
  const after = (await db.select({ targetOverride: planCases.targetOverride }).from(planCases).where(eq(planCases.id, existing.id)).limit(1))[0];
  return { caseId, targetOverride: after?.targetOverride ?? null };
}

/** 计划级数据集行选择写入：按 plan_cases.id 定位（同用例跨组=多行，各改各的）。
 *  null = 清覆盖（执行回落用例级）；[] = 全部启用行；非空 = 启用行下标子集。
 *  非空时校验口径与用例级共用 assertDatasetRowIndexes（已绑数据集 + 下标在启用行范围内）。 */
export async function updatePlanCaseDatasetRows(
  planId: string,
  planCaseId: string,
  datasetRowIndexes: number[] | null,
): Promise<{ ok: boolean; datasetRowIndexes: number[] | null }> {
  const existing = (await db.select().from(planCases)
    .where(and(eq(planCases.planId, planId), eq(planCases.id, planCaseId))).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'plan case not found');
  if (datasetRowIndexes !== null) {
    const c = (await db.select({ datasetId: testCases.datasetId }).from(testCases)
      .where(eq(testCases.id, existing.caseId)).limit(1))[0];
    if (!c) throw new HttpError(404, 'not_found', 'case not found');
    await assertDatasetRowIndexes(c.datasetId, datasetRowIndexes);
  }
  const rows = await db.update(planCases)
    .set({ datasetRowIndexes })
    .where(eq(planCases.id, existing.id))
    .returning({ datasetRowIndexes: planCases.datasetRowIndexes });
  return { ok: true, datasetRowIndexes: rows[0]?.datasetRowIndexes ?? null };
}

export interface CreatePlanInput {
  name: string;
  versionId: string;
  strategy?: string;
  rcaEnabled?: boolean;
}

async function assertVersionInProject(versionId: string, projectId: string): Promise<void> {
  const v = (await db.select({ projectId: projectVersions.projectId }).from(projectVersions).where(eq(projectVersions.id, versionId)).limit(1))[0];
  if (!v) throw new HttpError(404, 'not_found', 'version not found');
  if (v.projectId !== projectId) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
}

async function assertEnvInProject(environmentId: string, projectId: string): Promise<void> {
  const e = (await db.select({ projectId: testEnvironments.projectId }).from(testEnvironments).where(eq(testEnvironments.id, environmentId)).limit(1))[0];
  if (!e) throw new HttpError(404, 'not_found', 'environment not found');
  if (e.projectId !== projectId) throw new HttpError(400, 'env_project_mismatch', 'environment does not belong to this project');
}

export async function createPlan(projectId: string, input: CreatePlanInput, createdByUserId?: string | null) {
  await assertVersionInProject(input.versionId, projectId);
  if (input.strategy && !['run_all', 'fail_fast'].includes(input.strategy)) {
    throw new HttpError(400, 'bad_strategy', `invalid strategy: ${input.strategy}`);
  }
  return (
    await db.insert(executionPlans).values({
      projectId,
      name: input.name,
      versionId: input.versionId,
      strategy: input.strategy ?? 'run_all',
      rcaEnabled: input.rcaEnabled ?? false,
      ...(createdByUserId ? { createdByUserId } : {}),
    }).returning()
  )[0]!;
}

export interface UpdatePlanPatch {
  name?: string;
  versionId?: string | null;
  strategy?: string;
  rcaEnabled?: boolean;
}

export async function updatePlan(planId: string, patch: UpdatePlanPatch) {
  const existing = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'plan not found');
  if (patch.versionId !== undefined && patch.versionId !== null) await assertVersionInProject(patch.versionId, existing.projectId);
  if (patch.strategy !== undefined && !['run_all', 'fail_fast'].includes(patch.strategy)) {
    throw new HttpError(400, 'bad_strategy', `invalid strategy: ${patch.strategy}`);
  }
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.versionId !== undefined) update.versionId = patch.versionId;
  if (patch.strategy !== undefined) update.strategy = patch.strategy;
  if (patch.rcaEnabled !== undefined) update.rcaEnabled = patch.rcaEnabled;
  const rows = await db.update(executionPlans).set(update).where(eq(executionPlans.id, planId)).returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'plan not found');
  return rows[0]!;
}

/** 计划详情:分组形状 groups[].cases(组内 order 1..n,带 planCaseId);另保留平铺 cases(按组序拼接,
 *  order=组内序、globalOrder=全局 1..N)做旧读取兼容。versionName 一并解析。
 *  每条用例额外回带 projectId/projectName/versionName——跨产品线共享后,同一个计划里可能混着
 *  基线项目与局点项目的用例,前端要靠它标出「这条用例来自哪个项目哪个版本」。 */
export async function getPlanDetail(planId: string) {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
  if (!plan) return null;
  const gs = await db.select().from(planCaseGroups).where(eq(planCaseGroups.planId, plan.id)).orderBy(asc(planCaseGroups.order));
  const pcs = await db.select().from(planCases).where(eq(planCases.planId, plan.id)).orderBy(asc(planCases.order));
  // 一次 join 取回每个用例的项目/版本归属,避免逐条回查（N+1）
  const rows = pcs.length
    ? await db
        .select({
          id: testCases.id,
          title: testCases.title,
          url: testCases.url,
          versionId: testCases.versionId,
          versionName: projectVersions.name,
          projectId: groups.projectId,
          projectName: projects.name,
        })
        .from(testCases)
        .innerJoin(groups, eq(groups.id, testCases.groupId))
        .innerJoin(projects, eq(projects.id, groups.projectId))
        .leftJoin(projectVersions, eq(projectVersions.id, testCases.versionId))
        .where(inArray(testCases.id, pcs.map((p) => p.caseId)))
    : [];
  const byId = new Map(rows.map((c) => [c.id, c]));
  const caseMeta = (caseId: string) => {
    const c = byId.get(caseId);
    return {
      id: caseId,
      title: c?.title ?? 'unknown',
      url: c?.url ?? null,
      versionId: c?.versionId ?? null,
      versionName: c?.versionName ?? null,
      projectId: c?.projectId ?? null,
      projectName: c?.projectName ?? null,
    };
  };
  let versionName: string | null = null;
  if (plan.versionId) {
    const v = (await db.select({ name: projectVersions.name }).from(projectVersions).where(eq(projectVersions.id, plan.versionId)).limit(1))[0];
    versionName = v?.name ?? null;
  }
  const planGroups = gs.map((g) => ({
    id: g.id,
    name: g.name,
    order: g.order,
    environmentId: g.environmentId,
    loginPrepareEnabled: g.loginPrepareEnabled,
    loginCaseId: g.loginCaseId,
    detectionUrl: g.detectionUrl,
    loginSuccessSelector: g.loginSuccessSelector,
    loginUnauthorizedKeywords: g.loginUnauthorizedKeywords,
    failFast: g.failFast,
    targetConfig: g.targetConfig,
    cases: pcs.filter((pc) => pc.groupId === g.id).map((pc, i) => ({
      planCaseId: pc.id,
      order: i + 1,
      ...caseMeta(pc.caseId),
    })),
  }));
  // 平铺 cases:按组序拼接,order=组内序,globalOrder=全局 1..N(兼容旧读取/UI 过渡)
  const flat = planGroups.flatMap((g) => g.cases);
  return attachCreator({
    ...plan,
    versionName,
    groups: planGroups,
    cases: flat.map((c, i) => ({ ...c, globalOrder: i + 1 })),
  });
}

/**
 * 计划可容纳的用例所属项目集合。
 *
 * 项目未归入产品线（product_line_id 为 null）时只放它自己——保持既有严格语义不变；
 * 归入产品线后，放行该产品线下所有项目的用例，这是「基线用例被各局点计划共享」的落点。
 */
async function allowedCaseProjectIds(planProjectId: string): Promise<string[]> {
  const row = (await db
    .select({ productLineId: projects.productLineId })
    .from(projects)
    .where(eq(projects.id, planProjectId))
    .limit(1))[0];
  if (!row?.productLineId) return [planProjectId];
  const lineProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.productLineId, row.productLineId));
  return lineProjects.map((p) => p.id);
}

/** 返回不属于允许项目集合的 caseId（含不存在者）；空数组即全部通过。 */
async function caseIdsOutsideAllowedProjects(planProjectId: string, caseIds: string[]): Promise<string[]> {
  const ids = [...new Set(caseIds)];
  if (ids.length === 0) return [];
  const allowed = new Set(await allowedCaseProjectIds(planProjectId));
  const rows = await db
    .select({ id: testCases.id, groupId: testCases.groupId })
    .from(testCases)
    .where(inArray(testCases.id, ids));
  const gs = await db.select({ id: groups.id, projectId: groups.projectId }).from(groups)
    .where(inArray(groups.id, [...new Set(rows.map((r) => r.groupId))]));
  const projectOfGroup = new Map(gs.map((g) => [g.id, g.projectId]));
  const found = new Set(rows.map((r) => r.id));
  const invalid = rows
    .filter((r) => !allowed.has(projectOfGroup.get(r.groupId) ?? ''))
    .map((r) => r.id);
  return [...ids.filter((id) => !found.has(id)), ...new Set(invalid)];
}

/** 所有 caseIds 必须落在计划所属项目（或其产品线的兄弟项目）内；重复 id 去重后校验，避免误报 409。 */
async function assertCasesInProject(projectId: string, caseIds: string[]): Promise<void> {
  if (caseIds.length === 0) return;
  const outside = await caseIdsOutsideAllowedProjects(projectId, caseIds);
  if (outside.length > 0) {
    throw new HttpError(409, 'cross_project', 'all cases must belong to the plan project or its product line');
  }
}

/** assertCasesInProject 的只读预检版:返回不被允许的 caseId(含不存在者),空数组即全部通过。供工具在弹确认卡前校验,避免用户确认必然失败的操作。 */
export async function caseIdsOutsideProject(projectId: string, caseIds: string[]): Promise<string[]> {
  return caseIdsOutsideAllowedProjects(projectId, caseIds);
}

/**
 * 事务内第一步锁计划行(SELECT ... FOR UPDATE):同计划的所有编排串行化,
 * 消除查-算-插竞态与 order 撞号;行不存在 → 404(requirePlan 语义并入锁步骤)。
 */
/** db.transaction 回调的 tx 参数类型（组编排 helper 共用）。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 事务内锁计划行 + 校验组归属（组编排写路径共用）。 */
async function lockPlanGroup(tx: Tx, planId: string, groupId: string) {
  const plan = (await tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1).for('update'))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  const g = (await tx.select().from(planCaseGroups)
    .where(and(eq(planCaseGroups.id, groupId), eq(planCaseGroups.planId, planId))).limit(1))[0];
  if (!g) throw new HttpError(404, 'group_not_found', 'plan case group not found');
  return { plan, group: g };
}

/** 整包替换该组用例(组内去重、1..n;空数组=清空该组);跨组重复合法。事务 + 计划行锁。 */
export async function setPlanGroupCases(planId: string, groupId: string, caseIds: string[]): Promise<number> {
  const ids = [...new Set(caseIds)];
  return db.transaction(async (tx) => {
    const { plan } = await lockPlanGroup(tx, planId, groupId);
    await assertCasesInProject(plan.projectId, ids);
    await tx.delete(planCases).where(eq(planCases.groupId, groupId));
    if (ids.length > 0) {
      await tx.insert(planCases).values(ids.map((caseId, i) => ({ planId, caseId, groupId, order: i + 1 })));
    }
    return ids.length;
  });
}

/** 组内重排:caseIds 必须恰为该组当前用例集合。事务 + 计划行锁。 */
export async function reorderPlanGroupCases(planId: string, groupId: string, caseIds: string[]) {
  const ids = [...new Set(caseIds)];
  return db.transaction(async (tx) => {
    await lockPlanGroup(tx, planId, groupId);
    const rows = await tx.select({ caseId: planCases.caseId })
      .from(planCases).where(eq(planCases.groupId, groupId));
    const have = new Set(rows.map((r) => r.caseId));
    if (ids.length !== have.size || ids.some((c) => !have.has(c))) {
      throw new HttpError(400, 'cases_mismatch', 'caseIds must be exactly the group cases');
    }
    for (let i = 0; i < ids.length; i++) {
      await tx.update(planCases).set({ order: i + 1 })
        .where(and(eq(planCases.groupId, groupId), eq(planCases.caseId, ids[i]!)));
    }
    return { ok: true };
  });
}

/** 跨组移动行(按 plan_cases.id,不是 caseId——同用例可多行)。追加到目标组尾,源组重排。事务 + 计划行锁。 */
export async function movePlanCases(planId: string, planCaseIds: string[], toGroupId: string) {
  const ids = [...new Set(planCaseIds)];
  return db.transaction(async (tx) => {
    await lockPlanGroup(tx, planId, toGroupId);
    const rows = await tx.select().from(planCases)
      .where(and(eq(planCases.planId, planId), inArray(planCases.id, ids)));
    if (rows.length !== ids.length) throw new HttpError(404, 'not_found', 'plan case row not found');
    const base = Number((await tx.select({ m: sql<number>`coalesce(max("order"), 0)` })
      .from(planCases).where(eq(planCases.groupId, toGroupId)))[0]?.m ?? 0);
    for (let i = 0; i < rows.length; i++) {
      await tx.update(planCases).set({ groupId: toGroupId, order: base + i + 1 }).where(eq(planCases.id, rows[i]!.id));
    }
    // 源组重排
    for (const gid of [...new Set(rows.map((r) => r.groupId))]) {
      if (gid === toGroupId) continue;
      await renumberGroup(tx, gid);
    }
    return { ok: true };
  });
}

/** 组内行按现有 order 重排为 1..m(删除/移动后收口)。 */
async function renumberGroup(tx: Tx, groupId: string) {
  const rest = await tx.select({ id: planCases.id }).from(planCases)
    .where(eq(planCases.groupId, groupId)).orderBy(asc(planCases.order));
  for (let i = 0; i < rest.length; i++) {
    await tx.update(planCases).set({ order: i + 1 }).where(eq(planCases.id, rest[i]!.id));
  }
}

/** 追加用例到指定组(缺省取第一个组;无组计划自动建「默认分组」)。仅对目标组内已有 id 去重,跨组重复合法。 */
export async function addPlanCases(planId: string, caseIds: string[], groupId?: string): Promise<number> {
  return db.transaction(async (tx) => {
    const plan = (await tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1).for('update'))[0];
    if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
    await assertCasesInProject(plan.projectId, caseIds);
    let gid = groupId;
    if (!gid) {
      const first = (await tx.select({ id: planCaseGroups.id }).from(planCaseGroups)
        .where(eq(planCaseGroups.planId, planId)).orderBy(asc(planCaseGroups.order)).limit(1))[0];
      gid = first ? first.id : (await tx.insert(planCaseGroups).values({ planId, name: '默认分组', order: 1 }).returning())[0]!.id;
    } else {
      const g = (await tx.select({ id: planCaseGroups.id }).from(planCaseGroups)
        .where(and(eq(planCaseGroups.id, gid), eq(planCaseGroups.planId, planId))).limit(1))[0];
      if (!g) throw new HttpError(404, 'group_not_found', 'plan case group not found');
    }
    const existing = await tx.select({ caseId: planCases.caseId }).from(planCases).where(eq(planCases.groupId, gid));
    const have = new Set(existing.map((e) => e.caseId));
    const fresh = [...new Set(caseIds)].filter((c) => !have.has(c));
    if (fresh.length === 0) return 0;
    const base = Number((await tx.select({ m: sql<number>`coalesce(max("order"), 0)` })
      .from(planCases).where(eq(planCases.groupId, gid)))[0]?.m ?? 0);
    await tx.insert(planCases).values(fresh.map((caseId, i) => ({ planId, caseId, groupId: gid!, order: base + i + 1 })));
    return fresh.length;
  });
}

/** 移除用例(按 caseId 删该计划所有行——同用例多行一并删),受影响组内重排 1..m;事务 + 计划行锁,无命中返回 0。 */
export async function removePlanCases(planId: string, caseIds: string[]): Promise<number> {
  if (caseIds.length === 0) return 0;
  return db.transaction(async (tx) => {
    await tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1).for('update');
    const removed = await tx.delete(planCases)
      .where(and(eq(planCases.planId, planId), inArray(planCases.caseId, caseIds)))
      .returning({ id: planCases.id, groupId: planCases.groupId });
    if (removed.length === 0) return 0;
    for (const gid of [...new Set(removed.map((r) => r.groupId))]) {
      await renumberGroup(tx, gid);
    }
    return removed.length;
  });
}

export interface PlanGroupLoginPrepareInput {
  enabled: boolean;
  caseId?: string | null;
  detectionUrl?: string | null;
  successSelector?: string | null;
  unauthorizedKeywords?: string[] | null;
}

export interface CreatePlanGroupInput {
  name: string;
  environmentId?: string | null;
  loginPrepare?: PlanGroupLoginPrepareInput;
  failFast?: boolean;
  targetConfig?: { deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null;
}

export interface UpdatePlanGroupPatch extends Partial<Omit<CreatePlanGroupInput, 'name'>> {
  name?: string;
}

/** 组必须属于该计划;不存在 → 404(事务外用的只读版)。 */
async function getPlanGroup(planId: string, groupId: string) {
  const g = (await db.select().from(planCaseGroups)
    .where(and(eq(planCaseGroups.id, groupId), eq(planCaseGroups.planId, planId))).limit(1))[0];
  if (!g) throw new HttpError(404, 'group_not_found', 'plan case group not found');
  return g;
}

export async function listPlanGroups(planId: string) {
  return db.select().from(planCaseGroups).where(eq(planCaseGroups.planId, planId)).orderBy(asc(planCaseGroups.order));
}

export async function createPlanGroup(planId: string, input: CreatePlanGroupInput) {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  if (input.environmentId) await assertEnvInProject(input.environmentId, plan.projectId);
  const base = Number((await db.select({ m: sql<number>`coalesce(max("order"), 0)` })
    .from(planCaseGroups).where(eq(planCaseGroups.planId, planId)))[0]?.m ?? 0);
  return (await db.insert(planCaseGroups).values({
    planId,
    name: input.name,
    order: base + 1,
    environmentId: input.environmentId ?? null,
    loginPrepareEnabled: input.loginPrepare?.enabled ?? false,
    loginCaseId: input.loginPrepare?.caseId ?? null,
    detectionUrl: input.loginPrepare?.detectionUrl ?? null,
    loginSuccessSelector: input.loginPrepare?.successSelector ?? null,
    loginUnauthorizedKeywords: input.loginPrepare?.unauthorizedKeywords ?? null,
    failFast: input.failFast ?? false,
    targetConfig: input.targetConfig ?? null,
  }).returning())[0]!;
}

export async function updatePlanGroup(planId: string, groupId: string, patch: UpdatePlanGroupPatch) {
  await getPlanGroup(planId, groupId);
  if (patch.environmentId !== undefined && patch.environmentId !== null) {
    const plan = (await db.select({ projectId: executionPlans.projectId }).from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
    if (plan) await assertEnvInProject(patch.environmentId, plan.projectId);
  }
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.environmentId !== undefined) update.environmentId = patch.environmentId;
  if (patch.failFast !== undefined) update.failFast = patch.failFast;
  if (patch.targetConfig !== undefined) update.targetConfig = patch.targetConfig;
  if (patch.loginPrepare !== undefined) {
    update.loginPrepareEnabled = patch.loginPrepare.enabled;
    update.loginCaseId = patch.loginPrepare.caseId ?? null;
    update.detectionUrl = patch.loginPrepare.detectionUrl ?? null;
    update.loginSuccessSelector = patch.loginPrepare.successSelector ?? null;
    update.loginUnauthorizedKeywords = patch.loginPrepare.unauthorizedKeywords ?? null;
  }
  return (await db.update(planCaseGroups).set(update).where(eq(planCaseGroups.id, groupId)).returning())[0]!;
}

/** 组内有用例 → 409(对齐删产品线 409 惯例);空组直接删。 */
export async function deletePlanGroup(planId: string, groupId: string) {
  await getPlanGroup(planId, groupId);
  const n = (await db.select({ c: sql<number>`count(*)::int` }).from(planCases)
    .where(eq(planCases.groupId, groupId)))[0]?.c ?? 0;
  if (n > 0) throw new HttpError(409, 'group_not_empty', `group still has ${n} case(s); move or remove them first`);
  await db.delete(planCaseGroups).where(eq(planCaseGroups.id, groupId));
  return { ok: true };
}

/** 组排序整包替换;groupIds 必须恰好是计划的全部分组。事务 + 计划行锁。 */
export async function reorderPlanGroups(planId: string, groupIds: string[]) {
  return db.transaction(async (tx) => {
    await tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1).for('update');
    const current = await tx.select({ id: planCaseGroups.id }).from(planCaseGroups).where(eq(planCaseGroups.planId, planId));
    const have = new Set(current.map((g) => g.id));
    if (groupIds.length !== have.size || groupIds.some((id) => !have.has(id))) {
      throw new HttpError(404, 'group_not_found', 'groupIds must be exactly the plan groups');
    }
    for (let i = 0; i < groupIds.length; i++) {
      await tx.update(planCaseGroups).set({ order: i + 1, updatedAt: new Date() }).where(eq(planCaseGroups.id, groupIds[i]!));
    }
    return { ok: true };
  });
}
