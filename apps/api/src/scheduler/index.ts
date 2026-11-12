/**
 * Scheduler entry: startScheduler() is called when the API process starts.
 *
 * Behavior:
 * - If REDIS_URL is unset / ioredis connect fails → graceful degradation (warn + return); manual runs unaffected.
 * - reconcileAllSchedules() runs once before worker start, avoiding duplicate fires during startup.
 * - Registers SIGTERM / SIGINT graceful worker shutdown (other shutdown paths fall back to process exit).
 */
import type { Worker } from 'bullmq';
import { logger } from '../logger.js';
import { tryAcquireLock } from '../lib/redisLock.js';
import { buildWorker, isSchedulerReady } from './queue.js';
import { reconcileAllSchedules } from './sync.js';
import { processScheduleFire } from './worker.js';

let _worker: Worker<{ scheduleId: string }> | null = null;

export function getSchedulerWorker(): Worker<{ scheduleId: string }> | null {
  return _worker;
}

export async function startScheduler(): Promise<void> {
  if (!process.env.REDIS_URL) {
    logger.warn('REDIS_URL not set; plan scheduling disabled (manual run still works)');
    return;
  }
  try {
    _worker = buildWorker(processScheduleFire);
    _worker.on('ready', () => logger.info('plan-schedule worker ready'));
    _worker.on('error', (err) => logger.warn({ err: err.message }, 'plan-schedule worker error'));
    _worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err: err.message }, 'plan-schedule job failed'));
    // Sync the table's truth into BullMQ before power-on. All 3 replicas reach this on a simultaneous start: reconcile
    // single-flights via a distributed lock (the loser skips; workers still start — BullMQ consumes each job once, so multiple workers never duplicate execution).
    const reconcileLock = await tryAcquireLock('itest:sched-reconcile', 30_000);
    if (!reconcileLock) {
      logger.info('schedule reconcile skipped: another replica holds the lock');
    } else {
      try {
        await reconcileAllSchedules();
      } finally {
        await reconcileLock.release();
      }
    }
    logger.info('plan scheduler started');
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'scheduler init failed; continuing without scheduler');
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
    logger.info({ sig }, 'shutting down plan-schedule worker');
    try {
      await _worker.close();
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'worker close failed');
    }
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

/** For tests only: manually stop the worker + disconnect redis. */
export async function __stopSchedulerForTests(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
  }
  const { __closeForTests } = await import('./queue.js');
  await __closeForTests();
}

export { isSchedulerReady };