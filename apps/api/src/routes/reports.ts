import { Router } from 'express';
import { eq, desc, asc, inArray } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { db } from '../db/client.js';
import { reports, testCases, groups, planRunCases } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible, assertReportVisible, visibleProjectIds } from '../services/projectAccess.js';
import { attachCreators, attachCreator } from '../lib/creator.js';

export const reportsRoute = Router();

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

/** Clean up the screenshot directory of a report; silently swallow missing directories or permission errors (does not affect delete API success) */
async function unlinkReportScreenshots(reportId: string): Promise<void> {
  await rm(join(SCREENSHOTS_DIR, reportId), { recursive: true, force: true }).catch(() => {});
}

reportsRoute.get('/', async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  // List slimming: stepResults/datasetSnapshot/preflight heavy columns are consumed only by the detail endpoint (GET /:id);
  // the frontend list page (actually /executions) references none of them — carrying these JSONB columns in the list means dragging full step details every time.
  if (projectId) {
    await assertProjectVisible(projectId, req.user!);
    const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
    const caseRows = gs.length
      ? await db.select({ id: testCases.id }).from(testCases).where(inArray(testCases.groupId, gs.map((g) => g.id)))
      : [];
    const rows = caseRows.length
      ? await db
        .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, status: reports.status, durationMs: reports.durationMs, summary: reports.summary, createdAt: reports.createdAt, datasetRowIndex: reports.datasetRowIndex, platform: reports.platform, mobileOs: reports.mobileOs, deviceName: reports.deviceName, deviceTargetId: reports.deviceTargetId, healed: reports.healed, createdByUserId: reports.createdByUserId })
        .from(reports)
        .leftJoin(testCases, eq(testCases.id, reports.caseId))
        .where(inArray(reports.caseId, caseRows.map((c) => c.id)))
        .orderBy(desc(reports.createdAt))
      : [];
    res.json(await attachCreators(rows));
    return;
  }
  // No params: filter by visible projects
  const visiblePids = await visibleProjectIds(req.user!);
  const gs = visiblePids.length
    ? await db.select().from(groups).where(inArray(groups.projectId, visiblePids))
    : [];
  const caseRows = gs.length
    ? await db.select({ id: testCases.id }).from(testCases).where(inArray(testCases.groupId, gs.map((g) => g.id)))
    : [];
  const rows = caseRows.length
    ? await db
      .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, status: reports.status, durationMs: reports.durationMs, summary: reports.summary, createdAt: reports.createdAt, datasetRowIndex: reports.datasetRowIndex, platform: reports.platform, mobileOs: reports.mobileOs, deviceName: reports.deviceName, deviceTargetId: reports.deviceTargetId, healed: reports.healed, createdByUserId: reports.createdByUserId })
      .from(reports)
      .leftJoin(testCases, eq(testCases.id, reports.caseId))
      .where(inArray(reports.caseId, caseRows.map((c) => c.id)))
      .orderBy(desc(reports.createdAt))
    : [];
  res.json(await attachCreators(rows));
});

reportsRoute.get('/:id', async (req, res) => {
  const rows = await db
    .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, status: reports.status, durationMs: reports.durationMs, stepResults: reports.stepResults, preflight: reports.preflight, summary: reports.summary, createdAt: reports.createdAt, startedAt: reports.startedAt, finishedAt: reports.finishedAt, datasetRowIndex: reports.datasetRowIndex, datasetSnapshot: reports.datasetSnapshot, datasetBatchId: reports.datasetBatchId, platform: reports.platform, mobileOs: reports.mobileOs, deviceName: reports.deviceName, deviceTargetId: reports.deviceTargetId, healed: reports.healed, createdByUserId: reports.createdByUserId })
    .from(reports)
    .leftJoin(testCases, eq(testCases.id, reports.caseId))
    .where(eq(reports.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'report not found');
  // Visibility judged via the report → case → group → project chain
  const report = rows[0]!;
  const c = (await db.select().from(testCases).where(eq(testCases.id, report.caseId)))[0];
  if (!c) throw new HttpError(404, 'not_found', 'report not found');
  const g = (await db.select().from(groups).where(eq(groups.id, c.groupId)))[0];
  if (!g) throw new HttpError(404, 'not_found', 'report not found');
  try {
    await assertProjectVisible(g.projectId, req.user!);
  } catch {
    throw new HttpError(404, 'not_found', 'report not found');
  }
  // Plan-run member reports: attach planRunId + planId to the response so the frontend shows the "back to plan run" button when arriving from a plan run detail
  const prcRows = await db
    .select({ planRunId: planRunCases.planRunId, reportId: planRunCases.reportId, reportIds: planRunCases.reportIds, caseId: planRunCases.caseId, rca: planRunCases.rca })
    .from(planRunCases)
    .where(eq(planRunCases.caseId, report.caseId))
    .limit(50);
  // Limited to the same case: avoid multiple candidates across plan_runs when a dataset has multiple rows
  const link = prcRows.find((r) => r.reportId === report.id)
    ?? prcRows.find((r) => Array.isArray(r.reportIds) && r.reportIds.includes(report.id));
  if (!link) {
    res.json(await attachCreator(report));
    return;
  }
  // planId comes from planRuns.planId; one extra query avoids joining the whole table
  const { planRuns } = await import('../db/schema.js');
  const planRun = (await db.select({ planId: planRuns.planId }).from(planRuns).where(eq(planRuns.id, link.planRunId)))[0];
  res.json(await attachCreator({ ...report, planRunId: link.planRunId, planId: planRun?.planId ?? null, rca: link.rca ?? null }));
});

/** Dataset row switcher: sibling-row summaries of the same batch (grouped by datasetBatchId; polled at 2s while the report page is running).
 *  Deliberately returns only summaries (row index/status/duration/row snapshot), without stepResults — step details still go through GET /:id.
 *  Old reports without a batchId → { batchId: null, rows: [] }; the frontend hides the switcher on that. */
reportsRoute.get('/:id/dataset-batch', async (req, res) => {
  await assertReportVisible(req.params.id!, req.user!);
  const report = (await db.select({ datasetBatchId: reports.datasetBatchId }).from(reports).where(eq(reports.id, req.params.id!)))[0];
  if (!report?.datasetBatchId) {
    res.json({ batchId: null, rows: [] });
    return;
  }
  const rows = await db
    .select({ id: reports.id, datasetRowIndex: reports.datasetRowIndex, status: reports.status, durationMs: reports.durationMs, datasetSnapshot: reports.datasetSnapshot })
    .from(reports)
    .where(eq(reports.datasetBatchId, report.datasetBatchId))
    .orderBy(asc(reports.datasetRowIndex));
  res.json({ batchId: report.datasetBatchId, rows });
});

reportsRoute.delete('/:id', async (req, res) => {
  await assertReportVisible(req.params.id!, req.user!);
  const deleted = await db
    .delete(reports)
    .where(eq(reports.id, req.params.id))
    .returning({ id: reports.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'report not found');
  await unlinkReportScreenshots(req.params.id!);
  res.json({ ok: true });
});

reportsRoute.post('/batch-delete', async (req, res) => {
  const body = z.object({ reportIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  // Same as cases: validate visibility one by one first, violations 404 directly (no distinction between existence and visibility)
  for (const id of body.reportIds) await assertReportVisible(id, req.user!);
  const deleted = await db
    .delete(reports)
    .where(inArray(reports.id, body.reportIds))
    .returning({ id: reports.id });
  // Screenshot cleanup runs in parallel; individual failures don't affect API success (the files may not exist in the first place)
  await Promise.all(deleted.map((d) => unlinkReportScreenshots(d.id).catch(() => {})));
  res.json({ count: deleted.length });
});
