/**
 * Execution plan domain service: plan CRUD and in-group case orchestration (set/add/remove/move/reorder).
 * Ownership validation (plan ∈ project; version/environment/cases ∈ the plan's project) lives here;
 * user visibility is the caller's job (HTTP boundary).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { datasets, executionPlans, groups, planCaseGroups, planCases, projects, projectVersions, testCases, testEnvironments } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { attachCreators, attachCreator } from '../lib/creator.js';
import { assertDatasetRowIndexes, countEnabledRows } from './datasets.service.js';

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

/** Plan-level override: a case's default device_target / browser context can be rewritten at "add to plan" time,
 *  without touching the case itself; resolved per the override only for this plan's execution. null = use the case's own value. */
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

/** Writes a plan-case's override value; null/undefined explicitly land null (clearing the override back to the case's own value),
 *  undefined means untouched (semantics split from nullability; callers judge by whether the field exists in the patch). */
export async function updatePlanCase(planId: string, caseId: string, patch: UpdatePlanCasePatch): Promise<UpdatePlanCaseResult> {
  const existing = (await db.select().from(planCases).where(and(eq(planCases.planId, planId), eq(planCases.caseId, caseId))).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'plan case not found');
  if (patch.targetOverride !== undefined) {
    await db.update(planCases).set({ targetOverride: patch.targetOverride }).where(eq(planCases.id, existing.id));
  }
  const after = (await db.select({ targetOverride: planCases.targetOverride }).from(planCases).where(eq(planCases.id, existing.id)).limit(1))[0];
  return { caseId, targetOverride: after?.targetOverride ?? null };
}

/** Writes the plan-level dataset row selection: located by plan_cases.id (same case across groups = multiple rows, each edited independently).
 *  null = clear the override (execution falls back to case level); [] = all enabled rows; non-empty = subset of enabled-row indexes.
 *  Non-empty values share assertDatasetRowIndexes with the case level (dataset bound + indexes within the enabled-row range). */
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

/** Plan detail: grouped shape groups[].cases (in-group order 1..n, with planCaseId); also keeps the flat cases (concatenated in group
 *  order, order=in-group sequence, globalOrder=global 1..N) for old-reader compatibility. versionName is resolved too.
 *  Each case additionally carries projectId/projectName/versionName — after cross-product-line sharing a plan may mix cases from
 *  baseline and site projects, and the frontend needs it to label "which project and version this case came from". */
export async function getPlanDetail(planId: string) {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
  if (!plan) return null;
  const gs = await db.select().from(planCaseGroups).where(eq(planCaseGroups.planId, plan.id)).orderBy(asc(planCaseGroups.order));
  const pcs = await db.select().from(planCases).where(eq(planCases.planId, plan.id)).orderBy(asc(planCases.order));
  // One join fetches each case's project/version ownership, avoiding per-row lookups (N+1)
  const caseRows = pcs.length
    ? await db
        .select({
          id: testCases.id,
          title: testCases.title,
          url: testCases.url,
          versionId: testCases.versionId,
          versionName: projectVersions.name,
          projectId: groups.projectId,
          projectName: projects.name,
          // Needed for the plan-level row-selection three-state display: bound dataset id + case-level selection
          datasetId: testCases.datasetId,
          caseRowIndexes: testCases.datasetRowIndexes,
        })
        .from(testCases)
        .innerJoin(groups, eq(groups.id, testCases.groupId))
        .innerJoin(projects, eq(projects.id, groups.projectId))
        .leftJoin(projectVersions, eq(projectVersions.id, testCases.versionId))
        .where(inArray(testCases.id, pcs.map((p) => p.caseId)))
    : [];
  // The login case may not be among the plan's cases: fetch title/dataset fields separately via each group's loginCaseId (for row-selection three-state display and dialog echo).
  const loginIds = [...new Set(gs.map((g) => g.loginCaseId).filter((v): v is string => !!v))];
  const loginRows = loginIds.length
    ? await db
        .select({
          id: testCases.id,
          title: testCases.title,
          datasetId: testCases.datasetId,
          caseRowIndexes: testCases.datasetRowIndexes,
        })
        .from(testCases)
        .where(inArray(testCases.id, loginIds))
    : [];
  const loginById = new Map(loginRows.map((r) => [r.id, r]));
  // Dataset names and enabled-row counts: fetched in one shot per distinct datasetId, each dataset's rows jsonb parsed only once
  // (a correlated subquery in the join used to count per row, re-parsing the whole rows N×M times). Plan-case and login-case datasetIds are merged and deduped.
  const dsIds = [...new Set(
    [...caseRows.map((r) => r.datasetId), ...loginRows.map((r) => r.datasetId)].filter((v): v is string => !!v),
  )];
  const dsMeta = new Map<string, { name: string; enabledRowCount: number }>();
  if (dsIds.length > 0) {
    const dsRows = await db
      .select({ id: datasets.id, name: datasets.name, rows: datasets.rows })
      .from(datasets)
      .where(inArray(datasets.id, dsIds));
    for (const d of dsRows) {
      dsMeta.set(d.id, { name: d.name, enabledRowCount: countEnabledRows(d.rows) });
    }
  }
  const byId = new Map(caseRows.map((c) => [c.id, c]));
  const caseMeta = (caseId: string) => {
    const c = byId.get(caseId);
    const ds = c?.datasetId ? dsMeta.get(c.datasetId) : undefined;
    return {
      id: caseId,
      title: c?.title ?? 'unknown',
      url: c?.url ?? null,
      versionId: c?.versionId ?? null,
      versionName: c?.versionName ?? null,
      projectId: c?.projectId ?? null,
      projectName: c?.projectName ?? null,
      // Needed for the plan-level row-selection three-state display (datasetId null when no dataset is bound)
      datasetId: c?.datasetId ?? null,
      datasetName: ds?.name ?? null,
      datasetEnabledRowCount: ds?.enabledRowCount ?? 0,
      caseRowIndexes: c?.caseRowIndexes ?? [],
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
    // Needed for login-case display / row-selection three-state: the selected case's title + its bound dataset (same-shaped fields as plan cases)
    loginCaseTitle: g.loginCaseId ? loginById.get(g.loginCaseId)?.title ?? null : null,
    loginCaseDatasetId: g.loginCaseId ? loginById.get(g.loginCaseId)?.datasetId ?? null : null,
    loginCaseRowIndexes: g.loginCaseId ? loginById.get(g.loginCaseId)?.caseRowIndexes ?? [] : [],
    loginCaseEnabledRowCount: (() => {
      const dsId = g.loginCaseId ? loginById.get(g.loginCaseId)?.datasetId : null;
      return dsId ? dsMeta.get(dsId)?.enabledRowCount ?? 0 : 0;
    })(),
    // Login-case row override three-state: null = follow case level; [] = all rows; non-empty = subset
    loginDatasetRowIndexes: g.loginDatasetRowIndexes ?? null,
    targetConfig: g.targetConfig,
    cases: pcs.filter((pc) => pc.groupId === g.id).map((pc, i) => ({
      planCaseId: pc.id,
      order: i + 1,
      ...caseMeta(pc.caseId),
      // Plan row override three-state: null = follow case level; [] = all rows; non-empty = subset
      planRowIndexes: pc.datasetRowIndexes ?? null,
    })),
  }));
  // Flat cases: concatenated in group order, order=in-group sequence, globalOrder=global 1..N (old-reader compatibility / UI transition)
  const flat = planGroups.flatMap((g) => g.cases);
  return attachCreator({
    ...plan,
    versionName,
    groups: planGroups,
    cases: flat.map((c, i) => ({ ...c, globalOrder: i + 1 })),
  });
}

/**
 * The set of projects whose cases a plan may contain.
 *
 * When the project isn't attached to a product line (product_line_id null), only itself is allowed — keeping the existing strict semantics;
 * once attached, cases from every project under that product line are allowed — this is where "baseline cases shared by site plans" lands.
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

/** Returns the caseIds outside the allowed project set (nonexistent ones included); an empty array means all passed. */
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

/** All caseIds must fall within the plan's project (or sibling projects of its product line); duplicate ids are deduped before validation to avoid false 409s. */
async function assertCasesInProject(projectId: string, caseIds: string[]): Promise<void> {
  if (caseIds.length === 0) return;
  const outside = await caseIdsOutsideAllowedProjects(projectId, caseIds);
  if (outside.length > 0) {
    throw new HttpError(409, 'cross_project', 'all cases must belong to the plan project or its product line');
  }
}

/** Read-only precheck variant of assertCasesInProject: returns disallowed caseIds (nonexistent ones included); an empty array means all passed. Lets the tool validate before popping the confirm card, so the user never confirms an operation doomed to fail. */
export async function caseIdsOutsideProject(projectId: string, caseIds: string[]): Promise<string[]> {
  return caseIdsOutsideAllowedProjects(projectId, caseIds);
}

/**
 * First step inside the transaction locks the plan row (SELECT ... FOR UPDATE): serializes all orchestration of the same plan,
 * eliminating the read-compute-insert race and order collisions; missing row → 404 (requirePlan semantics folded into the lock step).
 */
/** The tx parameter type of db.transaction callbacks (shared by the group-orchestration helpers). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Locks the plan row + verifies group ownership inside the transaction (shared by group-orchestration write paths). */
async function lockPlanGroup(tx: Tx, planId: string, groupId: string) {
  const plan = (await tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1).for('update'))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  const g = (await tx.select().from(planCaseGroups)
    .where(and(eq(planCaseGroups.id, groupId), eq(planCaseGroups.planId, planId))).limit(1))[0];
  if (!g) throw new HttpError(404, 'group_not_found', 'plan case group not found');
  return { plan, group: g };
}

/** Whole-batch replaces the group's cases (deduped in-group, 1..n; empty array = clears the group); cross-group duplicates are legal. Transaction + plan row lock. */
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

/** In-group reorder: caseIds must be exactly the group's current case set. Transaction + plan row lock. */
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

/** Moves rows across groups (by plan_cases.id, not caseId — one case may occupy several rows). Appends to the target group's tail; source groups are renumbered. Transaction + plan row lock. */
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
    // Renumber source groups
    for (const gid of [...new Set(rows.map((r) => r.groupId))]) {
      if (gid === toGroupId) continue;
      await renumberGroup(tx, gid);
    }
    return { ok: true };
  });
}

/** Renumbers the group's rows to 1..m by existing order (compacts after delete/move). */
async function renumberGroup(tx: Tx, groupId: string) {
  const rest = await tx.select({ id: planCases.id }).from(planCases)
    .where(eq(planCases.groupId, groupId)).orderBy(asc(planCases.order));
  for (let i = 0; i < rest.length; i++) {
    await tx.update(planCases).set({ order: i + 1 }).where(eq(planCases.id, rest[i]!.id));
  }
}

/** Appends cases to the given group (defaults to the first group; a group-less plan auto-creates "默认分组"). Dedupes only against ids already in the target group; cross-group duplicates are legal. */
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

/** Removes cases (by caseId, deleting every row of this plan — multiple rows of one case all go), affected groups renumbered 1..m; transaction + plan row lock, returns 0 on no match. */
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
  /** Login-case dataset row override three-state: null = follow case level; [] = all rows; non-empty = subset */
  datasetRowIndexes?: number[] | null;
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

/** The group must belong to this plan; missing → 404 (read-only variant used outside transactions). */
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
  const loginRows = input.loginPrepare?.datasetRowIndexes ?? null;
  if (loginRows && loginRows.length > 0 && input.loginPrepare?.caseId) {
    const c = (await db.select({ datasetId: testCases.datasetId }).from(testCases)
      .where(eq(testCases.id, input.loginPrepare.caseId)).limit(1))[0];
    await assertDatasetRowIndexes(c?.datasetId, loginRows);
  }
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
    loginDatasetRowIndexes: loginRows,
    failFast: input.failFast ?? false,
    targetConfig: input.targetConfig ?? null,
  }).returning())[0]!;
}

export async function updatePlanGroup(planId: string, groupId: string, patch: UpdatePlanGroupPatch) {
  const existing = await getPlanGroup(planId, groupId);
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
    // Login-case row override: switching/clearing the case → set null (the index space belongs to the old case's dataset; validation skipped to avoid stale-value false alarms);
    // an explicit value is accepted only when the case is unchanged, validated with the same criteria as case/plan level when non-empty.
    let loginRows: number[] | null;
    if (patch.loginPrepare.caseId !== existing.loginCaseId) {
      loginRows = null;
    } else {
      loginRows = patch.loginPrepare.datasetRowIndexes ?? null;
      if (loginRows && loginRows.length > 0 && patch.loginPrepare.caseId) {
        const c = (await db.select({ datasetId: testCases.datasetId }).from(testCases)
          .where(eq(testCases.id, patch.loginPrepare.caseId)).limit(1))[0];
        await assertDatasetRowIndexes(c?.datasetId, loginRows);
      }
    }
    update.loginDatasetRowIndexes = loginRows;
  }
  return (await db.update(planCaseGroups).set(update).where(eq(planCaseGroups.id, groupId)).returning())[0]!;
}

/** Group still has cases → 409 (aligned with the delete-product-line 409 convention); an empty group deletes directly. */
export async function deletePlanGroup(planId: string, groupId: string) {
  await getPlanGroup(planId, groupId);
  const n = (await db.select({ c: sql<number>`count(*)::int` }).from(planCases)
    .where(eq(planCases.groupId, groupId)))[0]?.c ?? 0;
  if (n > 0) throw new HttpError(409, 'group_not_empty', `group still has ${n} case(s); move or remove them first`);
  await db.delete(planCaseGroups).where(eq(planCaseGroups.id, groupId));
  return { ok: true };
}

/** Whole-batch replaces group ordering; groupIds must be exactly the plan's full group set. Transaction + plan row lock. */
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
