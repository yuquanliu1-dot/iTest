/**
 * 执行计划领域服务:计划 CRUD 与用例编排(replace/add/remove)。
 * 归属校验(计划 ∈ project、version/environment/cases ∈ 计划所属 project)在这里;
 * 用户可见性由调用方(HTTP 边界)负责。
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { executionPlans, groups, planCases, projectVersions, testCases, testEnvironments } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';

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
  return plans.map((p) => ({ ...p, caseCount: countByPlan.get(p.id) ?? 0 }));
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

export async function createPlan(projectId: string, input: CreatePlanInput) {
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

/** 计划详情:cases 按 order 带 title/url/versionId;versionName 一并解析。 */
export async function getPlanDetail(planId: string) {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
  if (!plan) return null;
  const pcs = await db.select().from(planCases).where(eq(planCases.planId, plan.id)).orderBy(asc(planCases.order));
  const cases = pcs.length
    ? await db.select().from(testCases).where(inArray(testCases.id, pcs.map((p) => p.caseId)))
    : [];
  const byId = new Map(cases.map((c) => [c.id, c]));
  let versionName: string | null = null;
  if (plan.versionId) {
    const v = (await db.select({ name: projectVersions.name }).from(projectVersions).where(eq(projectVersions.id, plan.versionId)).limit(1))[0];
    versionName = v?.name ?? null;
  }
  return {
    ...plan,
    versionName,
    cases: pcs.map((pc) => ({
      id: pc.caseId,
      order: pc.order,
      title: byId.get(pc.caseId)?.title ?? 'unknown',
      url: byId.get(pc.caseId)?.url ?? null,
      versionId: byId.get(pc.caseId)?.versionId ?? null,
    })),
  };
}

/** 所有 caseIds 必须属于计划所属项目(经分组归属);重复 id 去重后校验,避免误报 409。 */
async function assertCasesInProject(projectId: string, caseIds: string[]): Promise<void> {
  if (caseIds.length === 0) return;
  const ids = [...new Set(caseIds)];
  const gs = await db.select({ id: groups.id }).from(groups).where(eq(groups.projectId, projectId));
  const validGids = new Set(gs.map((g) => g.id));
  const rows = await db.select({ groupId: testCases.groupId }).from(testCases).where(inArray(testCases.id, ids));
  if (rows.length !== ids.length || !rows.every((r) => validGids.has(r.groupId))) {
    throw new HttpError(409, 'cross_project', 'all cases must belong to the plan project');
  }
}

/** assertCasesInProject 的只读预检版:返回不属于该项目的 caseId(含不存在者),空数组即全部通过。供工具在弹确认卡前校验,避免用户确认必然失败的操作。 */
export async function caseIdsOutsideProject(projectId: string, caseIds: string[]): Promise<string[]> {
  const ids = [...new Set(caseIds)];
  if (ids.length === 0) return [];
  const gs = await db.select({ id: groups.id }).from(groups).where(eq(groups.projectId, projectId));
  const validGids = new Set(gs.map((g) => g.id));
  const rows = await db.select({ id: testCases.id, groupId: testCases.groupId }).from(testCases).where(inArray(testCases.id, ids));
  const found = new Set(rows.map((r) => r.id));
  const invalid = rows.filter((r) => !validGids.has(r.groupId)).map((r) => r.id);
  return [...ids.filter((id) => !found.has(id)), ...new Set(invalid)];
}

/**
 * 事务内第一步锁计划行(SELECT ... FOR UPDATE):同计划的所有编排串行化,
 * 消除查-算-插竞态与 order 撞号;行不存在 → 404(requirePlan 语义并入锁步骤)。
 */
export async function replacePlanCases(planId: string, caseIds: string[]): Promise<number> {
  if (caseIds.length === 0) throw new HttpError(400, 'cases_required', 'caseIds must not be empty');
  const ids = [...new Set(caseIds)];
  await db.transaction(async (tx) => {
    const plan = (await tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1).for('update'))[0];
    if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
    await assertCasesInProject(plan.projectId, ids);
    await tx.delete(planCases).where(eq(planCases.planId, planId));
    await tx.insert(planCases).values(ids.map((caseId, i) => ({ planId, caseId, order: i + 1 })));
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
    await tx.insert(planCases).values(fresh.map((caseId, i) => ({ planId, caseId, order: base + i + 1 })));
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
    const rest = await tx.select({ caseId: planCases.caseId }).from(planCases)
      .where(eq(planCases.planId, planId)).orderBy(asc(planCases.order));
    if (rest.length > 0) {
      await tx.delete(planCases).where(eq(planCases.planId, planId));
      await tx.insert(planCases).values(rest.map((r, i) => ({ planId, caseId: r.caseId, order: i + 1 })));
    }
    return removed.length;
  });
}
