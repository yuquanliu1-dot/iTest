import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../middleware/errorHandler.js';
import { insertRunningReportRow, type PreseedReport } from '../execute/runCase.js';
import { DatasetConfigError } from '../services/datasets.service.js';
import { loadDatasetForRun } from '../services/datasets.service.js';
import { assertCaseVisible } from '../services/projectAccess.js';
import { handleLiveView, handleLiveReplay, handleLiveReplayMeta, replaySpeedOf } from '../execute/liveView.js';
import { db } from '../db/client.js';
import { testCases } from '../db/schema.js';
import { runCaseJob } from '../scheduler/execWorker.js';
import { getExecutionQueue, isExecutionQueueReady, EXEC_QUEUE_NAME } from '../scheduler/execQueue.js';
import { logger } from '../logger.js';

export const executeRoute = Router();

const Body = z.object({ caseId: z.string().uuid() });

/**
 * Single-case execution → run in background + return reportId immediately (execution jumps to the report page).
 * The report row is persisted before execution starts (status='running'), so the page can already render when the
 * frontend jumps to the report page; while running, the report page streams the MJPEG live view and polls every 2s until completion.
 * Preflight stays synchronous (missing case 404 / dataset config error 400 still throw within the request, no garbage report created);
 * execution errors after preflight are carried by the report (a failed report is written, no running zombie left behind).
 */
executeRoute.post('/cases/:caseId/execute', async (req, res) => {
  const { caseId } = Body.parse({ caseId: req.params.caseId });
  if (caseId !== req.params.caseId) throw new HttpError(400, 'bad_request', 'caseId mismatch');
  await assertCaseVisible(caseId, req.user!);
  const caseRow = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!caseRow) throw new HttpError(404, 'not_found', 'case not found');

  // Insert running report rows early to obtain reportIds: one per row in dataset mode, a single row otherwise.
  const preseed: PreseedReport[] = [];
  // In dataset mode, freeze the set of indexes actually executed this run and ship it with the job —
  // loadDatasetForRun on the worker side filters by the same set, guaranteeing preseed and the executed row set always agree
  // (otherwise, if the dataset changed between preflight and execution, "preseed report missing" would be thrown).
  let datasetRowIndexes: number[] | undefined;
  if (caseRow.datasetId) {
    let plan;
    try {
      plan = await loadDatasetForRun(caseRow.datasetId, { rowIndexes: caseRow.datasetRowIndexes ?? [] }); // Config errors (no enabled rows/illegal column names/decryption failure/row out of range) → 400, no garbage report created
    } catch (e) {
      if (e instanceof DatasetConfigError) throw new HttpError(400, 'dataset_config_error', e.message);
      throw e;
    }
    // Batch id: shared by all rows of one execution (the grouping key of the report detail page's row switcher).
    const batchId = randomUUID();
    for (const row of plan.rows) {
      preseed.push({ reportId: await insertRunningReportRow(caseRow, row, req.user!.userId, batchId), rowIndex: row.rowIndex });
    }
    datasetRowIndexes = plan.rows.map((r) => r.rowIndex);
  } else {
    preseed.push({ reportId: await insertRunningReportRow(caseRow, undefined, req.user!.userId), rowIndex: null });
  }

  // Background execution: prefer enqueuing (multi-replica, consumed by any exec worker via redis); without redis fall back to inline (behavior unchanged).
  if (isExecutionQueueReady()) {
    try {
      await getExecutionQueue().add(EXEC_QUEUE_NAME, {
        kind: 'case',
        caseId,
        preseed,
        datasetRowIndexes,
        createdByUserId: req.user!.userId,
      });
    } catch (e) {
      // redis false success (configured but unreachable): add rejects → fall back to inline, avoiding preseeded running report rows turning into zombies.
      logger.warn({ err: e, caseId }, 'exec queue add failed; running inline');
      void runCaseJob({ caseId, preseed, datasetRowIndexes, createdByUserId: req.user!.userId });
    }
  } else {
    void runCaseJob({ caseId, preseed, datasetRowIndexes, createdByUserId: req.user!.userId });
  }

  res.json({ reportId: preseed[0]!.reportId, ...(preseed.length > 1 ? { reportIds: preseed.map((p) => p.reportId) } : {}) });
});

/** Live view (MJPEG) of a single-case execution. Auth same as execute (case visibility); key is stable, connectable only while executing.
 *  ?replay=1 is the recording replay of the current run (within 30min after the run ends; a run with the same key overwrites it); &speed=N is the replay speed;
 *  ?replay=meta probes whether the recording is still replayable (the frontend uses this to decide whether to show the "replay" button). */
executeRoute.get('/cases/:caseId/live', async (req, res) => {
  const caseId = req.params.caseId!;
  await assertCaseVisible(caseId, req.user!);
  if (req.query.replay === 'meta') return handleLiveReplayMeta(res, `case:${caseId}`);
  if (req.query.replay === '1') return handleLiveReplay(req, res, `case:${caseId}`, { speed: replaySpeedOf(req.query) });
  handleLiveView(req, res, `case:${caseId}`);
});