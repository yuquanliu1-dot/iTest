/**
 * 执行计划领域服务:计划 CRUD 与用例编排(replace/add/remove)。
 * 归属校验(计划 ∈ project、version/environment/cases ∈ 计划所属 project)在这里;
 * 用户可见性由调用方(HTTP 边界)负责。
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { executionPlans, groups, planCaseGroups, planCases, projects, projectVersions, testCases, testEnvironments } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { attachCreators, attachCreator } from '../lib/creator.js';

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

export interface LoginPrepareInput {
  enabled: boolean;
  caseId?: string | null;
  detectionUrl?: string | null;
  successSelector?: string | null;
  unauthorizedKeywords?: string[] | null;
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

export interface CreatePlanInput {
  name: string;
  versionId: string;
  environment?: string;
  environmentId?: string;
  strategy?: string;
  loginPrepare?: LoginPrepareInput;
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
  if (input.environmentId) await assertEnvInProject(input.environmentId, projectId);
  if (input.strategy && !['run_all', 'fail_fast'].includes(input.strategy)) {
    throw new HttpError(400, 'bad_strategy', `invalid strategy: ${input.strategy}`);
  }
  return (
    await db.insert(executionPlans).values({
      projectId,
      name: input.name,
      versionId: input.versionId,
      environment: input.environment,
      environmentId: input.environmentId,
      strategy: input.strategy ?? 'run_all',
      loginPrepareEnabled: input.loginPrepare?.enabled ?? false,
      loginCaseId: input.loginPrepare?.caseId ?? null,
      detectionUrl: input.loginPrepare?.detectionUrl ?? null,
      loginSuccessSelector: input.loginPrepare?.successSelector ?? null,
      loginUnauthorizedKeywords: input.loginPrepare?.unauthorizedKeywords ?? null,
      rcaEnabled: input.rcaEnabled ?? false,
      ...(createdByUserId ? { createdByUserId } : {}),
    }).returning()
  )[0]!;
}

export interface UpdatePlanPatch {
  name?: string;
  environment?: string;
  environmentId?: string | null;
  versionId?: string | null;
  strategy?: string;
  loginPrepare?: LoginPrepareInput;
  rcaEnabled?: boolean;
}

export async function updatePlan(planId: string, patch: UpdatePlanPatch) {
  const existing = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'plan not found');
  if (patch.versionId !== undefined && patch.versionId !== null) await assertVersionInProject(patch.versionId, existing.projectId);
  if (patch.environmentId !== undefined && patch.environmentId !== null) await assertEnvInProject(patch.environmentId, existing.projectId);
  if (patch.strategy !== undefined && !['run_all', 'fail_fast'].includes(patch.strategy)) {
    throw new HttpError(400, 'bad_strategy', `invalid strategy: ${patch.strategy}`);
  }
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.environment !== undefined) update.environment = patch.environment;
  if (patch.environmentId !== undefined) update.environmentId = patch.environmentId;
  if (patch.versionId !== undefined) update.versionId = patch.versionId;
  if (patch.strategy !== undefined) update.strategy = patch.strategy;
  if (patch.rcaEnabled !== undefined) update.rcaEnabled = patch.rcaEnabled;
  if (patch.loginPrepare !== undefined) {
    update.loginPrepareEnabled = patch.loginPrepare.enabled;
    update.loginCaseId = patch.loginPrepare.caseId ?? null;
    update.detectionUrl = patch.loginPrepare.detectionUrl ?? null;
    update.loginSuccessSelector = patch.loginPrepare.successSelector ?? null;
    update.loginUnauthorizedKeywords = patch.loginPrepare.unauthorizedKeywords ?? null;
  }
  const rows = await db.update(executionPlans).set(update).where(eq(executionPlans.id, planId)).returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'plan not found');
  return rows[0]!;
}

/** 计划详情:cases 按 order 带 title/url/versionId;versionName 一并解析。
 *  每条用例额外回带 projectId/projectName/versionName——跨产品线共享后,同一个计划里可能混着
 *  基线项目与局点项目的用例,前端要靠它标出「这条用例来自哪个项目哪个版本」。 */
export async function getPlanDetail(planId: string) {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
  if (!plan) return null;
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
  let versionName: string | null = null;
  if (plan.versionId) {
    const v = (await db.select({ name: projectVersions.name }).from(projectVersions).where(eq(projectVersions.id, plan.versionId)).limit(1))[0];
    versionName = v?.name ?? null;
  }
  return attachCreator({
    ...plan,
    versionName,
    cases: pcs.map((pc) => {
      const c = byId.get(pc.caseId);
      return {
        id: pc.caseId,
        order: pc.order,
        title: c?.title ?? 'unknown',
        url: c?.url ?? null,
        versionId: c?.versionId ?? null,
        versionName: c?.versionName ?? null,
        projectId: c?.projectId ?? null,
        projectName: c?.projectName ?? null,
      };
    }),
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

/** 事务内确保计划至少有一个分组（取 order 最小组，无则建「默认分组」），返回组 id。
 *  group_id NOT NULL 后旧编排路径（replace/add）经此桥接；Task 4 将全面分组化。 */
async function ensureDefaultGroup(tx: Tx, planId: string): Promise<string> {
  const first = (await tx.select({ id: planCaseGroups.id }).from(planCaseGroups)
    .where(eq(planCaseGroups.planId, planId)).orderBy(asc(planCaseGroups.order)).limit(1))[0];
  if (first) return first.id;
  const g = (await tx.insert(planCaseGroups).values({ planId, name: '默认分组', order: 1 }).returning())[0]!;
  return g.id;
}

export async function replacePlanCases(planId: string, caseIds: string[]): Promise<number> {
  if (caseIds.length === 0) throw new HttpError(400, 'cases_required', 'caseIds must not be empty');
  const ids = [...new Set(caseIds)];
  await db.transaction(async (tx) => {
    const plan = (await tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1).for('update'))[0];
    if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
    await assertCasesInProject(plan.projectId, ids);
    await tx.delete(planCases).where(eq(planCases.planId, planId));
    const gid = await ensureDefaultGroup(tx, planId);
    await tx.insert(planCases).values(ids.map((caseId, i) => ({ planId, caseId, groupId: gid, order: i + 1 })));
  });
  return ids.length;
}

/** 追加用例(已存在的跳过),返回实际新增数;order 接 max+1。事务 + 计划行锁,查-算-插原子化。 */
export async function addPlanCases(planId: string, caseIds: string[]): Promise<number> {
  return db.transaction(async (tx) => {
    const plan = (await tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1).for('update'))[0];
    if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
    await assertCasesInProject(plan.projectId, caseIds);
    const existing = await tx.select({ caseId: planCases.caseId }).from(planCases).where(eq(planCases.planId, planId));
    const have = new Set(existing.map((e) => e.caseId));
    const fresh = [...new Set(caseIds)].filter((c) => !have.has(c));
    if (fresh.length === 0) return 0;
    const base = Number((await tx.select({ m: sql<number>`coalesce(max("order"), 0)` }).from(planCases).where(eq(planCases.planId, planId)))[0]?.m ?? 0);
    const gid = await ensureDefaultGroup(tx, planId);
    await tx.insert(planCases).values(fresh.map((caseId, i) => ({ planId, caseId, groupId: gid, order: base + i + 1 })));
    return fresh.length;
  });
}

/** 移除用例并把剩余重排为 1..m,返回移除数;事务 + 计划行锁,无命中直接返回(免无效全删重插)。 */
export async function removePlanCases(planId: string, caseIds: string[]): Promise<number> {
  if (caseIds.length === 0) return 0;
  return db.transaction(async (tx) => {
    const plan = (await tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1).for('update'))[0];
    if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
    const removed = await tx.delete(planCases)
      .where(and(eq(planCases.planId, planId), inArray(planCases.caseId, caseIds)))
      .returning({ id: planCases.id });
    if (removed.length === 0) return 0;
    const rest = await tx.select({ caseId: planCases.caseId, groupId: planCases.groupId }).from(planCases)
      .where(eq(planCases.planId, planId)).orderBy(asc(planCases.order));
    if (rest.length > 0) {
      await tx.delete(planCases).where(eq(planCases.planId, planId));
      await tx.insert(planCases).values(rest.map((r, i) => ({ planId, caseId: r.caseId, groupId: r.groupId, order: i + 1 })));
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
