import { Router } from 'express';
import { z } from 'zod';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  executionPlans,
  planCases,
  planRuns,
  testCases,
  groups,
  projectVersions,
} from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible, assertVersionVisible, visibleProjectIds } from '../services/projectAccess.js';
import {
  createPlan, updatePlan, getPlanDetail, setPlanGroupCases, createPlanGroup, updatePlanGroup, deletePlanGroup, reorderPlanGroups,
  addPlanCases, reorderPlanGroupCases, movePlanCases,
  planProjectId, removePlanCases, updatePlanCase, updatePlanCaseDatasetRows,
} from '../services/plans.service.js';
import { attachCreators } from '../lib/creator.js';
import { logger } from '../logger.js';
import { enqueuePlanRun } from '../execute/enqueuePlanRun.js';
import { assertNotRunning, deleteRunsWithReports } from './planRuns.js';

export const plansRoute = Router({ mergeParams: true });

const StrategyEnum = z.enum(['run_all', 'fail_fast']);

/** Group-level login-prepare config (environment-credential auto login / login-case pre-run). Plan level is retired. */
const GroupLoginPrepareBody = z
  .object({
    enabled: z.boolean(),
    caseId: z.string().uuid().optional().nullable(),
    detectionUrl: z.string().url().optional().nullable(),
    successSelector: z.string().max(500).optional().nullable(),
    unauthorizedKeywords: z.array(z.string().max(80)).max(20).optional().nullable(),
    /** Login-case dataset row override, three states: null/absent = follow case level; [] = all rows; non-empty = subset */
    datasetRowIndexes: z.array(z.number().int().min(0)).max(500).optional().nullable(),
  })
  .optional();

/** planCases row-level override: when adding to a plan, may rewrite the case's device_target / browser context; absent/null = keep the case's own value. */
const TargetOverrideBody = z
  .object({
    deviceTargetId: z.string().uuid().optional(),
    browserContext: z.enum(['incognito', 'persistent']).optional(),
  })
  .nullable()
  .optional();

/** Group-level unified device/browser context (same shape as the planCases row-level override). */
const TargetConfigBody = TargetOverrideBody;

const CreateGroupBody = z.object({
  name: z.string().min(1).max(200),
  environmentId: z.string().uuid().optional().nullable(),
  loginPrepare: GroupLoginPrepareBody,
  failFast: z.boolean().optional(),
  targetConfig: TargetConfigBody,
});

const PatchGroupBody = z.object({
  name: z.string().min(1).max(200).optional(),
  environmentId: z.string().uuid().nullable().optional(),
  loginPrepare: GroupLoginPrepareBody,
  failFast: z.boolean().optional(),
  targetConfig: TargetConfigBody,
});

// Plan-level Create/Patch has been slimmed: environment/login-prepare config moved to group level (/groups endpoint); unknown fields stripped by zod.
const CreateBody = z.object({
  name: z.string().min(1).max(200),
  versionId: z.string().uuid().optional(),
  strategy: StrategyEnum.default('run_all'),
  rcaEnabled: z.boolean().optional(),
});

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  versionId: z.string().uuid().nullable().optional(),
  strategy: StrategyEnum.optional(),
  rcaEnabled: z.boolean().optional(),
});

plansRoute.get('/', async (req, res) => {
  const { projectId } = req.params as { projectId?: string };
  let ps;
  if (projectId) {
    await assertProjectVisible(projectId, req.user!);
    ps = await db
      .select()
      .from(executionPlans)
      .where(eq(executionPlans.projectId, projectId))
      .orderBy(asc(executionPlans.createdAt));
  } else {
    // Direct mount: filter by visible projects
    const visiblePids = await visibleProjectIds(req.user!);
    ps = visiblePids.length
      ? await db.select().from(executionPlans).where(inArray(executionPlans.projectId, visiblePids)).orderBy(asc(executionPlans.createdAt))
      : [];
  }
  const pcs = await db.select().from(planCases);
  const countByPlan = new Map<string, number>();
  for (const pc of pcs) countByPlan.set(pc.planId, (countByPlan.get(pc.planId) ?? 0) + 1);
  // Fetch version names
  const vIds = Array.from(new Set(ps.map((p) => p.versionId).filter((v): v is string => !!v)));
  const vRows = vIds.length ? await db.select().from(projectVersions).where(inArray(projectVersions.id, vIds)) : [];
  const vName = new Map(vRows.map((v) => [v.id, v.name] as const));
  res.json(await attachCreators(ps.map((p) => ({
    ...p,
    versionName: p.versionId ? vName.get(p.versionId) ?? null : null,
    caseCount: countByPlan.get(p.id) ?? 0,
  }))));
});

plansRoute.post('/', async (req, res) => {
  const projectId = (req.params as { projectId?: string }).projectId;
  if (!projectId) throw new HttpError(400, 'bad_request', 'projectId is required');
  const body = CreateBody.parse(req.body);
  await assertProjectVisible(projectId, req.user!);
  // versionId is required: every frontend entry passes the version explicitly, no implicit fallback; if passed it must be the same project
  const versionId = body.versionId;
  if (!versionId) throw new HttpError(400, 'version_required', 'versionId is required');
  {
    const { projectId: vp } = await assertVersionVisible(versionId, req.user!);
    if (vp !== projectId) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
  }
  // Ownership validation repeated inside the service (intentional redundancy): AI tools bypassing the HTTP layer have no route validation as fallback
  res.json(await createPlan(projectId, { ...body, versionId }, req.user!.userId));
});

plansRoute.get('/:id', async (req, res) => {
  const detail = await getPlanDetail(req.params.id!);
  if (!detail) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(detail.projectId, req.user!);
  res.json(detail);
});

plansRoute.patch('/:id', async (req, res) => {
  const existing = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(existing.projectId, req.user!);
  const body = PatchBody.parse(req.body);
  // Version ownership (∈ the plan's project) is enforced by the service as fallback
  res.json(await updatePlan(req.params.id!, body));
});

/** Plan deletion unified semantics: delete run history too (runs + member reports + screenshots). reports has no FK (plan_run_cases.report_id → SET NULL);
 *  deleting only the plan row would let orphan reports flow back into execution history as "independent case executions", so deleteRunsWithReports must run first. */
async function deletePlansWithRuns(planIds: string[]): Promise<void> {
  const runRows = await db.select({ id: planRuns.id }).from(planRuns).where(inArray(planRuns.planId, planIds));
  const runIds = runRows.map((r) => r.id);
  await assertNotRunning(runIds);
  if (runIds.length) await deleteRunsWithReports(runIds);
}

plansRoute.delete('/:id', async (req, res) => {
  const existing = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(existing.projectId, req.user!);
  await deletePlansWithRuns([req.params.id!]);
  const deleted = await db.delete(executionPlans).where(eq(executionPlans.id, req.params.id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'plan not found');
  res.json({ ok: true });
});

const BatchDeleteBody = z.object({ planIds: z.array(z.string().uuid()).min(1) });

plansRoute.post('/batch-delete', async (req, res) => {
  const { planIds: raw } = BatchDeleteBody.parse(req.body);
  const planIds = [...new Set(raw)];
  const rows = await db.select().from(executionPlans).where(inArray(executionPlans.id, planIds));
  if (rows.length !== planIds.length) throw new HttpError(404, 'not_found', 'plan not found');
  for (const p of rows) await assertProjectVisible(p.projectId, req.user!);
  await deletePlansWithRuns(planIds);
  const deleted = await db
    .delete(executionPlans)
    .where(inArray(executionPlans.id, planIds))
    .returning({ id: executionPlans.id });
  res.json({ count: deleted.length });
});

// caseIds ownership (∈ the plan's project, 409 cross_project) is handled by the service's assertCasesInProject;
// the route keeps only plan-level per-user visibility.
// Whole-package replacement has been consolidated to group level (PUT /:id/groups/:groupId/cases); plan-level PUT /:id/cases is retired.

// Append cases: groupId absent = append to the first group / auto-create a default group (the service's default behavior).
plansRoute.post('/:id/cases', async (req, res) => {
  const { caseIds, groupId } = z.object({
    caseIds: z.array(z.string().uuid()).min(1),
    groupId: z.string().uuid().optional(),
  }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  res.json({ added: await addPlanCases(req.params.id!, caseIds, groupId) });
});

// In-group reorder: groupId is required, and caseIds must be exactly the group's current case set.
plansRoute.put('/:id/cases/order', async (req, res) => {
  const { groupId, caseIds } = z.object({
    groupId: z.string().uuid(),
    caseIds: z.array(z.string().uuid()).min(1),
  }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  res.json(await reorderPlanGroupCases(req.params.id!, groupId, caseIds));
});

// Cross-group move: move by planCaseId (plan_cases row id) to the target group's tail; the source group reorders automatically.
plansRoute.put('/:id/cases/move', async (req, res) => {
  const { planCaseIds, toGroupId } = z.object({
    planCaseIds: z.array(z.string().uuid()).min(1),
    toGroupId: z.string().uuid(),
  }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  res.json(await movePlanCases(req.params.id!, planCaseIds, toGroupId));
});

plansRoute.delete('/:id/cases', async (req, res) => {
  const { caseIds } = z.object({ caseIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  await removePlanCases(req.params.id!, caseIds);
  res.json({ ok: true });
});

// planCases row-level PATCH: currently only supports targetOverride (device_target / browser context override).
// The body looks like { caseId, targetOverride }: caseId is required; targetOverride may be an object/null/undefined.
plansRoute.patch('/:id/cases/:caseId', async (req, res) => {
  const { caseId } = req.params as { caseId?: string };
  if (!caseId) throw new HttpError(400, 'bad_request', 'caseId is required');
  const body = z.object({
    targetOverride: TargetOverrideBody,
  }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  res.json(await updatePlanCase(req.params.id!, caseId, { targetOverride: body.targetOverride }));
});

// Plan-level dataset row selection: located by plan_cases.id (the same case in multiple groups = multiple rows, each edited independently).
// null = clear the override (execution falls back to case level); [] = all enabled rows; non-empty = subset of enabled row indexes.
// Does not reuse PATCH /:id/cases/:caseId — that one locates by caseId+limit(1), ambiguous for cases duplicated across groups.
plansRoute.patch('/:id/plan-cases/:planCaseId', async (req, res) => {
  const { datasetRowIndexes } = z.object({
    datasetRowIndexes: z.array(z.number().int().min(0)).max(500).nullable(),
  }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  res.json(await updatePlanCaseDatasetRows(req.params.id!, req.params.planCaseId!, datasetRowIndexes));
});

// ---- Plan group endpoints: each group independently configures environment/login-prepare/failFast/device browser context. ----

/** zod group login-prepare body → service input (null consolidates absent fields). */
function toGroupLoginPrepare(b?: z.infer<typeof GroupLoginPrepareBody>) {
  return b && {
    enabled: b.enabled,
    caseId: b.caseId ?? null,
    detectionUrl: b.detectionUrl ?? null,
    successSelector: b.successSelector ?? null,
    unauthorizedKeywords: b.unauthorizedKeywords ?? null,
    datasetRowIndexes: b.datasetRowIndexes ?? null,
  };
}

plansRoute.post('/:id/groups', async (req, res) => {
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  const b = CreateGroupBody.parse(req.body);
  res.json(await createPlanGroup(req.params.id!, {
    name: b.name,
    environmentId: b.environmentId ?? undefined,
    loginPrepare: toGroupLoginPrepare(b.loginPrepare),
    failFast: b.failFast,
    targetConfig: b.targetConfig ?? null,
  }));
});

plansRoute.patch('/:id/groups/:groupId', async (req, res) => {
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  const b = PatchGroupBody.parse(req.body);
  res.json(await updatePlanGroup(req.params.id!, req.params.groupId!, {
    name: b.name,
    environmentId: b.environmentId,
    loginPrepare: toGroupLoginPrepare(b.loginPrepare),
    failFast: b.failFast,
    targetConfig: b.targetConfig,
  }));
});

plansRoute.delete('/:id/groups/:groupId', async (req, res) => {
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  res.json(await deletePlanGroup(req.params.id!, req.params.groupId!));
});

plansRoute.put('/:id/groups/order', async (req, res) => {
  const { groupIds } = z.object({ groupIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  res.json(await reorderPlanGroups(req.params.id!, groupIds));
});

plansRoute.put('/:id/groups/:groupId/cases', async (req, res) => {
  const { caseIds } = z.object({ caseIds: z.array(z.string().uuid()) }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  await setPlanGroupCases(req.params.id!, req.params.groupId!, caseIds);
  res.json({ ok: true });
});

plansRoute.get('/:id/login-cases', async (req, res) => {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(plan.projectId, req.user!);
  const q = (req.query.q as string | undefined)?.trim().toLowerCase() ?? '';
  const groupId = req.query.groupId as string | undefined;
  const gs = await db.select().from(groups).where(eq(groups.projectId, plan.projectId));
  const gids = new Set(gs.map((g) => g.id));
  let rows = await db.select().from(testCases);
  rows = rows.filter((r) => gids.has(r.groupId));
  if (groupId) rows = rows.filter((r) => r.groupId === groupId);
  if (q) {
    const groupNameById = new Map(gs.map((g) => [g.id, g.name.toLowerCase()]));
    rows = rows.filter((r) => {
      if (r.title.toLowerCase().includes(q)) return true;
      return (groupNameById.get(r.groupId) ?? '').includes(q);
    });
  }
  res.json(rows.map((r) => ({ id: r.id, title: r.title, groupId: r.groupId })));
});

plansRoute.post('/:id/run', async (req, res) => {
  const { runId } = await enqueuePlanRun({
    planId: req.params.id,
    trigger: { source: 'manual', userId: req.user!.userId },
    callerUser: req.user!,
  });
  res.json({ runId });
});