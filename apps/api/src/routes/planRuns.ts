import { Router } from 'express';
import { eq, and, asc, inArray, sql } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { db } from '../db/client.js';
import { planRuns, planRunCases, executionPlans, testCases, reports } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { requestCancel, subscribeRun } from '../execute/runPlan.js';
import { sseHeaders } from '../sse/pi.js';
import { assertPlanRunVisible, assertProjectVisible } from '../services/projectAccess.js';
import { handleLiveView, handleLiveReplay, handleLiveReplayMeta, replaySpeedOf } from '../execute/liveView.js';
import { resolveUsersByIds } from '../lib/creator.js';
import { cache } from '../lib/cache.js';
import { planRunDetailKey } from '../lib/cache-keys.js';

export const planRunsRoute = Router();

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

/** Clean up the screenshot directory of a report; silently swallow missing directories or permission errors (does not affect delete API success) */
async function unlinkReportScreenshots(reportId: string): Promise<void> {
  await rm(join(SCREENSHOTS_DIR, reportId), { recursive: true, force: true }).catch(() => {});
}

/** Collect all report ids produced by one plan run: plan_run_cases.report_id plus every id in the report_ids array. */
async function collectRunReportIds(planRunIds: string[]): Promise<string[]> {
  const rows = await db
    .select({ reportId: planRunCases.reportId, reportIds: planRunCases.reportIds })
    .from(planRunCases)
    .where(inArray(planRunCases.planRunId, planRunIds));
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.reportId) ids.add(r.reportId);
    for (const id of Array.isArray(r.reportIds) ? r.reportIds : []) if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Delete plan runs and their member reports.
 *
 * Member reports must be deleted along with them: plan_run_cases is the only link establishing
 * "this report belongs to a plan run"; once the run is deleted the link disappears and the report
 * reappears in the execution history single-case list as an "independent case execution"
 * (the executions case branch excludes plan member reports via not exists) — to the user this looks
 * like "the run was deleted but the reports are still there".
 *
 * After reports are deleted, their screenshots/<reportId>/ directories are cleaned up too, avoiding disk buildup.
 */
export async function deleteRunsWithReports(planRunIds: string[]): Promise<number> {
  const reportIds = await collectRunReportIds(planRunIds);
  const deleted = await db
    .delete(planRuns)
    .where(inArray(planRuns.id, planRunIds))
    .returning({ id: planRuns.id });
  if (reportIds.length) {
    // The report_id FK is ON DELETE SET NULL; deleting reports nulls plan_run_cases' links;
    // by then plan_runs is already gone and member rows cascade away with it, leaving no dangling references.
    await db.delete(reports).where(inArray(reports.id, reportIds));
    await Promise.all(reportIds.map((id) => unlinkReportScreenshots(id).catch(() => {})));
  }
  // Terminal detail cache invalidation: a revisit right after deletion must be able to 404 immediately, not return a ghost snapshot
  await Promise.all(deleted.map((d) => cache.del(planRunDetailKey(d.id))));
  return deleted.length;
}

/** Running plan runs must not be deleted: the executor keeps writing to the member and report tables; deleting the DB rows equals deleting half. */
export async function assertNotRunning(planRunIds: string[]): Promise<void> {
  const running = await db
    .select({ id: planRuns.id })
    .from(planRuns)
    .where(and(inArray(planRuns.id, planRunIds), eq(planRuns.status, 'running')));
  if (running.length > 0) {
    throw new HttpError(409, 'plan_run_running', 'plan run is still running');
  }
}

const PLAN_RUN_TERMINAL_STATUSES = ['passed', 'failed', 'cancelled'];
const PLAN_RUN_DETAIL_TTL_MS = 5 * 60_000;

/**
 * Assemble the run detail payload; returns null when the run doesn't exist (wrap doesn't cache null, so a deleted run can 404 immediately).
 * Terminal snapshots can still change due to rca persistence / member report deletion — the former is invalidated
 * explicitly by rcaWorker/saveRcaResult, the latter relies on TTL as fallback (a known tradeoff, see planRunDetailKey).
 */
async function buildPlanRunDetail(runId: string) {
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, runId)))[0];
  if (!run) return null;
  const caseRows = await db
    .select()
    .from(planRunCases)
    .where(eq(planRunCases.planRunId, run.id))
    .orderBy(asc(planRunCases.order));
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, run.planId)))[0];
  // Batch-fetch case titles, avoiding N+1
  const caseIds = Array.from(new Set(caseRows.map((c) => c.caseId)));
  const titleRows = caseIds.length
    ? await db.select({ id: testCases.id, title: testCases.title }).from(testCases).where(inArray(testCases.id, caseIds))
    : [];
  const titleMap = new Map(titleRows.map((t) => [t.id, t.title]));
  // Dataset iterations: batch-fetch the statuses of all row reports so the frontend can show "i/N rows passed"
  const reportIdList = caseRows.flatMap((c) => (Array.isArray(c.reportIds) ? c.reportIds : []));
  const statusRows = reportIdList.length
    ? await db.select({ id: reports.id, status: reports.status }).from(reports).where(inArray(reports.id, reportIdList))
    : [];
  const statusMap = new Map(statusRows.map((r) => [r.id, r.status]));
  // Batch-fetch each report's last assertion (vision reason / failed step error), same criterion as the /executions list
  const allReportIds = Array.from(
    new Set([...reportIdList, ...caseRows.map((c) => c.reportId).filter((v): v is string => !!v)]),
  );
  const assertionRows = allReportIds.length
    ? await db
        .select({
          id: reports.id,
          // Last assertion: the last element of the step_results array — vision reason first, otherwise the failed step's error
          lastAssertion: sql<string | null>`
            case
              when jsonb_typeof(${reports.stepResults}) = 'array' and jsonb_array_length(${reports.stepResults}) > 0 then
                (select coalesce(
                   e -> 'visionAssert' ->> 'reason',
                   case when e ->> 'status' = 'failed' then e ->> 'error' end
                 )
                 from jsonb_array_elements(${reports.stepResults}) with ordinality as t(e, ord)
                 order by ord desc
                 limit 1)
              else null
            end`,
        })
        .from(reports)
        .where(inArray(reports.id, allReportIds))
    : [];
  const assertionMap = new Map(assertionRows.map((r) => [r.id, r.lastAssertion]));
  const cases = caseRows.map((c) => {
    const ids = c.reportIds?.length ? c.reportIds : c.reportId ? [c.reportId] : [];
    // Dataset multi-row: prefer the first failed row's assertion; when all pass, take the last row
    const assertions = ids.map((id) => assertionMap.get(id) ?? null);
    const failedIdx = ids.findIndex((id) => statusMap.get(id) === 'failed');
    const lastAssertion = (failedIdx >= 0 ? assertions[failedIdx] : assertions[assertions.length - 1]) ?? null;
    return {
      ...c,
      caseTitle: titleMap.get(c.caseId) ?? null,
      rowStatuses: (c.reportIds ?? []).map((id) => statusMap.get(id) ?? 'unknown'),
      lastAssertion,
    };
  });
  return {
    ...run,
    planName: plan?.name ?? null,
    cases,
    triggeredBy: run.triggeredByUserId ? (await resolveUsersByIds([run.triggeredByUserId])).get(run.triggeredByUserId) ?? null : null,
  };
}

planRunsRoute.get('/:id', async (req, res) => {
  const run = (await db.select({ id: planRuns.id, projectId: planRuns.projectId, status: planRuns.status }).from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) throw new HttpError(404, 'not_found', 'plan run not found');
  // Visibility must stay outside the cache: what's cached is data, not authorization results; cross-org users must not hit someone else's payload
  await assertProjectVisible(run.projectId, req.user!);
  // While running (polling) assemble in real time, uncached; terminal snapshots cache 5min, shared by the frontend's 2s polling/revisits
  const payload = PLAN_RUN_TERMINAL_STATUSES.includes(run.status)
    ? await cache.wrap(planRunDetailKey(run.id), PLAN_RUN_DETAIL_TTL_MS, () => buildPlanRunDetail(run.id))
    : await buildPlanRunDetail(run.id);
  if (!payload) throw new HttpError(404, 'not_found', 'plan run not found');
  res.json(payload);
});

planRunsRoute.post('/:id/cancel', async (req, res) => {
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) throw new HttpError(404, 'not_found', 'plan run not found');
  await assertProjectVisible(run.projectId, req.user!);
  requestCancel(run.id);
  await db.update(planRuns).set({ cancelRequested: true }).where(eq(planRuns.id, run.id));
  res.json({ ok: true });
});

planRunsRoute.delete('/:id', async (req, res) => {
  const id = req.params.id!;
  await assertPlanRunVisible(id, req.user!);
  await assertNotRunning([id]);
  const count = await deleteRunsWithReports([id]);
  if (count === 0) throw new HttpError(404, 'not_found', 'plan run not found');
  res.json({ ok: true });
});

planRunsRoute.post('/batch-delete', async (req, res) => {
  const body = z.object({ planRunIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  // Same as reports/batch-delete: validate visibility one by one, violations 404 immediately
  for (const id of body.planRunIds) await assertPlanRunVisible(id, req.user!);
  await assertNotRunning(body.planRunIds);
  const count = await deleteRunsWithReports(body.planRunIds);
  res.json({ count });
});

planRunsRoute.get('/:id/events', async (req, res) => {
  sseHeaders(res);
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) {
    res.status(404).end();
    return;
  }
  // EventSource cannot carry custom headers; auth relies on cookies; invisible always disconnects
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

/** Plan run live view (MJPEG): the `planrun:<id>` source registered by runPlanAsync; connectable only while running.
 *  ?replay=1 replays this run's recording (within 30min after the run ends); &speed=N sets the replay speed;
 *  ?replay=meta probes whether the recording is still replayable (the frontend uses this to decide whether to show the "replay" button). */
planRunsRoute.get('/:id/live', async (req, res) => {
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) throw new HttpError(404, 'not_found', 'plan run not found');
  await assertProjectVisible(run.projectId, req.user!);
  if (req.query.replay === 'meta') return handleLiveReplayMeta(res, `planrun:${run.id}`);
  if (req.query.replay === '1') return handleLiveReplay(req, res, `planrun:${run.id}`, { speed: replaySpeedOf(req.query) });
  handleLiveView(req, res, `planrun:${run.id}`);
});