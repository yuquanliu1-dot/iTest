/**
 * BullMQ queue infrastructure.
 *
 * Key constraints:
 * - BullMQ 5 forces worker connections to `maxRetriesPerRequest: null` (fail-blocking GET mode).
 * - Queue/Worker/Events each use their own ioredis connection (BullMQ recommendation).
 * - If REDIS_URL is unset or the connection fails, the scheduler degrades gracefully to "no scheduling" mode
 *   (the manual one-click run path still works). Consistent with cache.ts's fail-open behavior.
 */
import IORedis, { type Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { logger } from '../logger.js';

export const PLAN_SCHEDULE_QUEUE_NAME = 'plan-schedule';

let _redis: Redis | null = null;
let _queue: Queue<{ scheduleId: string }> | null = null;

export function isSchedulerReady(): boolean {
  return _redis !== null && _queue !== null;
}

export function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    // enableOfflineQueue:false → when redis disconnects, add() rejects immediately, letting callers fall back inline
    //(instead of buffering jobs endlessly in the offline queue, leaving plan_run/report stuck running forever).
    _redis = new IORedis(url, { maxRetriesPerRequest: null, enableOfflineQueue: false });
    _redis.on('error', (err) => logger.debug({ err: err.message }, 'scheduler redis error'));
  }
  return _redis;
}

export function getQueue(): Queue<{ scheduleId: string }> {
  if (!_queue) {
    _queue = new Queue<{ scheduleId: string }>(PLAN_SCHEDULE_QUEUE_NAME, { connection: getRedis() });
  }
  return _queue;
}

/** Build a worker (called by scheduler/index.ts in startScheduler). */
export function buildWorker(
  processor: (scheduleId: string) => Promise<void>,
): Worker<{ scheduleId: string }> {
  // Worker uses the top-level static import. This used to be require('bullmq') — api is pure ESM, require is undefined,
  // and startScheduler crashed on the very first 3-replica rollout (same gotcha as the exec worker's require crash; never use require again).
  return new Worker<{ scheduleId: string }>(
    PLAN_SCHEDULE_QUEUE_NAME,
    async (job) => processor(job.data.scheduleId),
    { connection: getRedis() },
  );
}

/** For tests/teardown only: disconnect and clear the singletons. */
export async function __closeForTests(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = null;
  }
  if (_redis) {
    _redis.disconnect();
    _redis = null;
  }
}