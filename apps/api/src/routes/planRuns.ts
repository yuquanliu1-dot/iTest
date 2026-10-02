import { Router } from 'express';
import { eq, asc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { planRuns, planRunCases, executionPlans, testCases } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { requestCancel, subscribeRun } from '../execute/runPlan.js';
import { sseHeaders } from '../sse/agentRunStream.js';
import { assertProjectVisible } from '../services/projectAccess.js';

export const planRunsRoute = Router();

planRunsRoute.get('/:id', async (req, res) => {
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) throw new HttpError(404, 'not_found', 'plan run not found');
  await assertProjectVisible(run.projectId, req.user!);
  const caseRows = await db
    .select()
    .from(planRunCases)
    .where(eq(planRunCases.planRunId, run.id))
    .orderBy(asc(planRunCases.order));
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, run.planId)))[0];
  // 批量查 case 标题，避免 N+1
  const caseIds = Array.from(new Set(caseRows.map((c) => c.caseId)));
  const titleRows = caseIds.length
    ? await db.select({ id: testCases.id, title: testCases.title }).from(testCases).where(inArray(testCases.id, caseIds))
    : [];
  const titleMap = new Map(titleRows.map((t) => [t.id, t.title]));
  const cases = caseRows.map((c) => ({ ...c, caseTitle: titleMap.get(c.caseId) ?? null }));
  res.json({
    ...run,
    planName: plan?.name ?? null,
    cases,
  });
});

planRunsRoute.post('/:id/cancel', async (req, res) => {
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) throw new HttpError(404, 'not_found', 'plan run not found');
  await assertProjectVisible(run.projectId, req.user!);
  requestCancel(run.id);
  await db.update(planRuns).set({ cancelRequested: true }).where(eq(planRuns.id, run.id));
  res.json({ ok: true });
});

planRunsRoute.get('/:id/events', async (req, res) => {
  sseHeaders(res);
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) {
    res.status(404).end();
    return;
  }
  // EventSource 无法带自定义头，靠 cookie 鉴权；不可见一律断开
  try {
    await assertProjectVisible(run.projectId, req.user!);
  } catch {
    res.status(404).end();
    return;
  }
  const unsub = subscribeRun(run.id, res);
  // initial snapshot
  res.write(
    `data: ${JSON.stringify({
      type: 'plan_run_snapshot',
      status: run.status,
      summary: run.summary,
      totalCases: run.totalCases,
      passedCases: run.passedCases,
      failedCases: run.failedCases,
      skippedCases: run.skippedCases,
    })}\n\n`,
  );
  req.on('close', () => unsub());
});