/**
 * Execution worker: consumes the exec queue. Job granularity = one full planRun or one single-case execution (including all dataset rows),
 * storageState doesn't cross containers (in-process Map in execute/runPlan.ts); holds as long as a job isn't split apart.
 */
import { eq } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import { reports } from '../db/schema.js';
import { runPlanAsync } from '../execute/runPlan.js';
import { runCase, type PreseedReport } from '../execute/runCase.js';
import { registerLiveView } from '../execute/liveView.js';
import { buildExecutionWorker, type ExecJob } from './execQueue.js';

/** Shared single-case execution body: both the worker and execute.ts's inline fallback go through it (DRY, prevents behavior divergence between the two).
 *  runCase already contains dataset-row errors; a real throw (random crash) flips all preseeded reports to failed to avoid zombies. */
export async function runCaseJob(data: { caseId: string; preseed?: PreseedReport[]; datasetRowIndexes?: number[]; createdByUserId?: string | null }): Promise<void> {
  const live = registerLiveView(`case:${data.caseId}`);
  try {
    await runCase(data.caseId, {
      liveView: live,
      preseed: data.preseed,
      datasetRowIndexes: data.datasetRowIndexes,
      createdByUserId: data.createdByUserId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: e, caseId: data.caseId }, 'background case execute failed; writing failed reports');
    for (const p of data.preseed ?? []) {
      await db
        .update(reports)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          stepResults: [{ order: 1, status: 'failed', durationMs: 0, startedAt: new Date().toISOString(), error: msg, failureReason: 'InternalError' }] as object,
          summary: msg,
        })
        .where(eq(reports.id, p.reportId))
        .catch(() => undefined);
    }
  } finally {
    live.close();
  }
}

/** Queue job handler. Errors are already contained by runPlan's per-stage handling / runCaseJob writing failed reports / runSolidifyBatchCaseJob
 *  persisting failed_* row states; this swallows one more layer, logging only, to prevent accidentally re-running half-finished work. */
async function processExecJob(data: ExecJob): Promise<void> {
  try {
    if (data.kind === 'plan') {
      await runPlanAsync({ planRunId: data.planRunId });
    } else if (data.kind === 'solidify') {
      const { runSolidifyBatchCaseJob } = await import('../execute/batchSolidify.js');
      await runSolidifyBatchCaseJob({ batchId: data.batchId, caseId: data.caseId });
    } else if (data.kind === 'exploration') {
      const { runExplorationSession } = await import('../execute/exploration.js');
      await runExplorationSession({ sessionId: data.sessionId });
    } else {
      await runCaseJob({ caseId: data.caseId, preseed: data.preseed, datasetRowIndexes: data.datasetRowIndexes, createdByUserId: data.createdByUserId });
    }
  } catch (e) {
    logger.error({ err: e, kind: data.kind }, 'exec job crashed');
  }
}

let _worker: Worker<ExecJob> | null = null;

export function getExecWorker(): Worker<ExecJob> | null {
  return _worker;
}

/** Called at API process startup (REDIS_URL missing/connect failed → degrade gracefully to inline execution, same guard as the scheduler). */
export async function startExecutionWorker(): Promise<void> {
  if (!process.env.REDIS_URL) {
    logger.warn('REDIS_URL not set; execution queue disabled (inline execution)');
    return;
  }
  try {
    _worker = buildExecutionWorker(processExecJob);
    _worker.on('ready', () => logger.info('exec worker ready'));
    _worker.on('error', (err) => logger.warn({ err: err.message }, 'exec worker error'));
    _worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err: err.message }, 'exec job failed'));
    logger.info('exec worker started');
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'exec worker init failed; continuing inline');
    _worker = null;
  }
  registerShutdown();
}

let _shutdownRegistered = false;
function registerShutdown(): void {
  if (_shutdownRegistered) return;
  _shutdownRegistered = true;
  const stop = async (sig: string) => {
    if (!_worker) return;
    logger.info({ sig }, 'shutting down exec worker');
    try { await _worker.close(); } catch (e) { logger.warn({ err: (e as Error).message }, 'exec worker close failed'); }
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

/** For tests only: stop the worker + disconnect the exec queue. */
export async function __stopExecWorkerForTests(): Promise<void> {
  if (_worker) { await _worker.close(); _worker = null; }
  const { __closeExecutionQueue } = await import('./execQueue.js');
  await __closeExecutionQueue();
}