import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testSteps, testCases } from '../db/schema.js';
import { eq, asc, inArray } from 'drizzle-orm';
import { StepAction } from '@itest/shared';
import { HttpError } from '../middleware/errorHandler.js';

export const stepsRoute = Router();

const AppendBody = z.object({
  steps: z
    .array(
      z.object({
        order: z.number().int().nonnegative(),
        source: z.enum(['agent', 'recorder', 'manual']),
        action: StepAction,
        assertion: z.unknown().optional(),
      }),
    )
    .min(1),
});

stepsRoute.post('/:caseId/steps', async (req, res) => {
  const body = AppendBody.parse(req.body);
  const exists = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  const rows = await db
    .insert(testSteps)
    .values(
      body.steps.map((s) => ({
        caseId: req.params.caseId,
        order: s.order,
        source: s.source,
        action: s.action as object,
        assertion: (s.assertion ?? null) as object | null,
      })),
    )
    .returning();
  const sorted = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, req.params.caseId))
    .orderBy(asc(testSteps.order));
  res.json({ count: rows.length, steps: sorted });
});

const ReorderBody = z.object({ stepIds: z.array(z.string().uuid()).min(1) });

/** 按传入的 id 顺序重排（stepIds 须恰好覆盖该用例全部步骤），order 重写为 1..n。 */
stepsRoute.put('/:caseId/steps/reorder', async (req, res) => {
  const { stepIds } = ReorderBody.parse(req.body);
  const rows = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, req.params.caseId))
    .orderBy(asc(testSteps.order));
  const existing = new Set(rows.map((r) => r.id));
  if (stepIds.length !== rows.length || !stepIds.every((id) => existing.has(id))) {
    throw new HttpError(400, 'invalid_order', 'stepIds must cover exactly the case steps');
  }
  for (let i = 0; i < stepIds.length; i++) {
    await db.update(testSteps).set({ order: i + 1 }).where(eq(testSteps.id, stepIds[i]!));
  }
  const sorted = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, req.params.caseId))
    .orderBy(asc(testSteps.order));
  res.json({ steps: sorted });
});

stepsRoute.delete('/:caseId/steps/:stepId', async (req, res) => {
  const rows = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, req.params.caseId))
    .orderBy(asc(testSteps.order));
  const target = rows.find((r) => r.id === req.params.stepId);
  if (!target) throw new HttpError(404, 'not_found', 'step not found');
  const remaining = rows.filter((r) => r.id !== target.id).map((r) => r.id);
  await db.delete(testSteps).where(inArray(testSteps.id, [target.id]));
  // 剩余步骤 order 紧凑化为 1..n
  for (let i = 0; i < remaining.length; i++) {
    await db.update(testSteps).set({ order: i + 1 }).where(eq(testSteps.id, remaining[i]!));
  }
  res.json({ ok: true });
});