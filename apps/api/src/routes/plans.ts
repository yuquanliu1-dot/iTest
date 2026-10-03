import { Router } from 'express';
import { z } from 'zod';
import { eq, asc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  executionPlans,
  planCases,
  planRuns,
  testCases,
  groups,
} from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { findIncognitoCaseIds, runPlanAsync } from '../execute/runPlan.js';
import { assertProjectVisible, visibleProjectIds } from '../services/projectAccess.js';
import { logger } from '../logger.js';

export const plansRoute = Router({ mergeParams: true });

const StrategyEnum = z.enum(['run_all', 'fail_fast']);

const LoginPrepareBody = z
  .object({
    enabled: z.boolean(),
    caseId: z.string().uuid().optional().nullable(),
    detectionUrl: z.string().url().optional().nullable(),
    successSelector: z.string().max(500).optional().nullable(),
    unauthorizedKeywords: z.array(z.string().max(80)).max(20).optional().nullable(),
  })
  .optional();

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  environment: z.string().max(100).optional(),
  strategy: StrategyEnum.default('run_all'),
  loginPrepare: LoginPrepareBody,
});

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  environment: z.string().max(100).optional(),
  environmentId: z.string().uuid().nullable().optional(),
  strategy: StrategyEnum.optional(),
  loginPrepare: LoginPrepareBody,
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
    // 直挂载：按可见项目过滤
    const visiblePids = await visibleProjectIds(req.user!);
    ps = visiblePids.length
      ? await db.select().from(executionPlans).where(inArray(executionPlans.projectId, visiblePids)).orderBy(asc(executionPlans.createdAt))
      : [];
  }
  const pcs = await db.select().from(planCases);
  const countByPlan = new Map<string, number>();
  for (const pc of pcs) countByPlan.set(pc.planId, (countByPlan.get(pc.planId) ?? 0) + 1);
  res.json(ps.map((p) => ({ ...p, caseCount: countByPlan.get(p.id) ?? 0 })));
});

plansRoute.post('/', async (req, res) => {
  const projectId = (req.params as { projectId?: string }).projectId;
  if (!projectId) throw new HttpError(400, 'bad_request', 'projectId is required');
  const body = CreateBody.parse(req.body);
  await assertProjectVisible(projectId, req.user!);
  const rows = await db
    .insert(executionPlans)
    .values({
      projectId,
      name: body.name,
      environment: body.environment,
      strategy: body.strategy,
      loginPrepareEnabled: body.loginPrepare?.enabled ?? false,
      loginCaseId: body.loginPrepare?.caseId ?? null,
      detectionUrl: body.loginPrepare?.detectionUrl ?? null,
      loginSuccessSelector: body.loginPrepare?.successSelector ?? null,
      loginUnauthorizedKeywords: body.loginPrepare?.unauthorizedKeywords ?? null,
    })
    .returning();
  res.json(rows[0]);
});

plansRoute.get('/:id', async (req, res) => {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(plan.projectId, req.user!);
  const pcs = await db
    .select()
    .from(planCases)
    .where(eq(planCases.planId, plan.id))
    .orderBy(asc(planCases.order));
  const cases = pcs.length
    ? await db.select().from(testCases).where(inArray(testCases.id, pcs.map((p) => p.caseId)))
    : [];
  const byId = new Map(cases.map((c) => [c.id, c]));
  res.json({
    ...plan,
    cases: pcs.map((pc) => ({ id: pc.caseId, order: pc.order, title: byId.get(pc.caseId)?.title ?? 'unknown', url: byId.get(pc.caseId)?.url ?? null })),
  });
});

plansRoute.patch('/:id', async (req, res) => {
  const existing = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(existing.projectId, req.user!);
  const body = PatchBody.parse(req.body);
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) update.name = body.name;
  if (body.environment !== undefined) update.environment = body.environment;
  if (body.environmentId !== undefined) update.environmentId = body.environmentId;
  if (body.environmentId !== undefined && body.environmentId !== null) {
    const { assertEnvironmentVisible } = await import('../services/projectAccess.js');
    await assertEnvironmentVisible(body.environmentId, req.user!);
  }
  if (body.strategy !== undefined) update.strategy = body.strategy;
  if (body.loginPrepare !== undefined) {
    update.loginPrepareEnabled = body.loginPrepare.enabled;
    update.loginCaseId = body.loginPrepare.caseId ?? null;
    update.detectionUrl = body.loginPrepare.detectionUrl ?? null;
    update.loginSuccessSelector = body.loginPrepare.successSelector ?? null;
    update.loginUnauthorizedKeywords = body.loginPrepare.unauthorizedKeywords ?? null;
  }
  const rows = await db.update(executionPlans).set(update).where(eq(executionPlans.id, req.params.id)).returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'plan not found');
  res.json(rows[0]);
});

plansRoute.delete('/:id', async (req, res) => {
  const existing = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(existing.projectId, req.user!);
  const deleted = await db.delete(executionPlans).where(eq(executionPlans.id, req.params.id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'plan not found');
  res.json({ ok: true });
});

async function validateCaseProject(planId: string, caseIds: string[], user: NonNullable<Express.Request['user']>) {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(plan.projectId, user);
  const gs = await db.select().from(groups).where(eq(groups.projectId, plan.projectId));
  const validGids = new Set(gs.map((g) => g.id));
  const rows = await db.select().from(testCases).where(inArray(testCases.id, caseIds));
  if (rows.length !== caseIds.length || !rows.every((r) => validGids.has(r.groupId))) {
    throw new HttpError(409, 'cross_project', 'all cases must belong to the plan project');
  }
}

plansRoute.put('/:id/cases', async (req, res) => {
  const { caseIds } = z.object({ caseIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  await validateCaseProject(req.params.id!, caseIds, req.user!);
  await db.delete(planCases).where(eq(planCases.planId, req.params.id));
  await db.insert(planCases).values(caseIds.map((caseId, i) => ({ planId: req.params.id!, caseId, order: i + 1 })));
  res.json({ ok: true });
});

plansRoute.put('/:id/cases/order', async (req, res) => {
  const { caseIds } = z.object({ caseIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  await validateCaseProject(req.params.id!, caseIds, req.user!);
  await db.delete(planCases).where(eq(planCases.planId, req.params.id));
  await db.insert(planCases).values(caseIds.map((caseId, i) => ({ planId: req.params.id!, caseId, order: i + 1 })));
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
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(plan.projectId, req.user!);
  if (plan.loginPrepareEnabled && !plan.loginCaseId) {
    throw new HttpError(422, 'login_case_required', 'login prepare enabled but no login case set');
  }
  if (plan.loginPrepareEnabled) {
    const incognitoIds = await findIncognitoCaseIds(plan.id);
    if (incognitoIds.length > 0) {
      throw new HttpError(422, 'incognito_conflicts_with_login_prepare', `cases: ${incognitoIds.join(',')}`);
    }
  }
  const ins = await db
    .insert(planRuns)
    .values({
      planId: plan.id,
      projectId: plan.projectId,
      status: 'running',
      strategy: plan.strategy,
      loginPrepareEnabled: plan.loginPrepareEnabled,
      loginCaseId: plan.loginCaseId,
      detectionUrl: plan.detectionUrl,
      loginSuccessSelector: plan.loginSuccessSelector,
      loginUnauthorizedKeywords: plan.loginUnauthorizedKeywords,
      totalCases: 0,
    })
    .returning();
  const runId = ins[0]!.id;
  // fire-and-forget
  void runPlanAsync({ planRunId: runId }).catch((e) => {
    logger.error({ err: e, planRunId: runId }, 'runPlanAsync crashed');
  });
  res.json({ runId });
});