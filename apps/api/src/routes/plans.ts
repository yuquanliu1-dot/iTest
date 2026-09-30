import { Router } from 'express';
import { z } from 'zod';
import { eq, asc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { executionPlans, planCases, testCases, groups } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { runCase } from '../execute/runCase.js';

export const plansRoute = Router({ mergeParams: true });

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  environment: z.string().max(100).optional(),
});

plansRoute.get('/', async (req, res) => {
  const { projectId } = req.params as { projectId: string };
  const ps = await db
    .select()
    .from(executionPlans)
    .where(eq(executionPlans.projectId, projectId))
    .orderBy(asc(executionPlans.createdAt));
  const pcs = await db.select().from(planCases);
  const countByPlan = new Map<string, number>();
  for (const pc of pcs) {
    countByPlan.set(pc.planId, (countByPlan.get(pc.planId) ?? 0) + 1);
  }
  res.json(ps.map((p) => ({ ...p, caseCount: countByPlan.get(p.id) ?? 0 })));
});

plansRoute.post('/', async (req, res) => {
  const { projectId } = req.params as { projectId: string };
  const body = CreateBody.parse(req.body);
  const rows = await db
    .insert(executionPlans)
    .values({ ...body, projectId })
    .returning();
  res.json(rows[0]);
});

plansRoute.get('/:id', async (req, res) => {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  const pcs = await db.select().from(planCases).where(eq(planCases.planId, plan.id)).orderBy(asc(planCases.order));
  const cases = pcs.length
    ? await db.select().from(testCases).where(inArray(testCases.id, pcs.map((p) => p.caseId)))
    : [];
  const byId = new Map(cases.map((c) => [c.id, c]));
  res.json({
    ...plan,
    cases: pcs.map((pc) => ({ id: pc.caseId, order: pc.order, title: byId.get(pc.caseId)?.title ?? 'unknown' })),
  });
});

plansRoute.patch('/:id', async (req, res) => {
  const body = CreateBody.partial().parse(req.body);
  const rows = await db
    .update(executionPlans)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(executionPlans.id, req.params.id))
    .returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'plan not found');
  res.json(rows[0]);
});

plansRoute.delete('/:id', async (req, res) => {
  const deleted = await db.delete(executionPlans).where(eq(executionPlans.id, req.params.id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'plan not found');
  res.json({ ok: true });
});

plansRoute.put('/:id/cases', async (req, res) => {
  const { caseIds } = z.object({ caseIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  const gs = await db.select().from(groups).where(eq(groups.projectId, plan.projectId));
  const validGids = new Set(gs.map((g) => g.id));
  const rows = await db.select().from(testCases).where(inArray(testCases.id, caseIds));
  if (rows.length !== caseIds.length || !rows.every((r) => validGids.has(r.groupId))) {
    throw new HttpError(409, 'cross_project', 'all cases must belong to the plan project');
  }
  await db.delete(planCases).where(eq(planCases.planId, plan.id));
  await db.insert(planCases).values(caseIds.map((caseId, i) => ({ planId: plan.id, caseId, order: i + 1 })));
  res.json({ ok: true });
});

plansRoute.post('/:id/run', async (req, res) => {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  const pcs = await db.select().from(planCases).where(eq(planCases.planId, plan.id)).orderBy(asc(planCases.order));
  const results: Array<{ caseId: string; reportId: string; status: string }> = [];
  for (const pc of pcs) {
    const { reportId, status } = await runCase(pc.caseId);
    results.push({ caseId: pc.caseId, reportId, status });
  }
  res.json({ results });
});
