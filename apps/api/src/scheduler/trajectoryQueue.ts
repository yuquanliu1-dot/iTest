/**
 * Trajectory distillation queue: enqueued by the /stage/save persist hook; the worker reads the pi-sessions JSONL,
 * verifies criteria, then LLM-distills into the DB. REDIS_URL missing → inline fire-and-forget (same degradation as rcaQueue).
 * Idempotency is guarded by partial unique(source_case_id where active) + onConflictDoNothing.
 * Switch: ASSISTANT_TRAJECTORY_DISTILL=0 disables it (on by default).
 */
import { Queue, Worker } from 'bullmq';
import { getRedis } from './queue.js';
import { logger } from '../logger.js';

export const TRAJECTORY_QUEUE_NAME = 'trajectories';

export type TrajectoryJob = {
  kind: 'trajectory';
  threadId: string;
  versionId: string;
  userId: string | null;
  items: Array<{ localId: string; caseId: string }>;
};

let _queue: Queue<TrajectoryJob> | null = null;

export function isTrajectoryQueueReady(): boolean {
  return !!process.env.REDIS_URL;
}

export function getTrajectoryQueue(): Queue<TrajectoryJob> {
  if (!_queue) {
    _queue = new Queue<TrajectoryJob>(TRAJECTORY_QUEUE_NAME, { connection: getRedis() });
  }
  return _queue;
}

/** Build the worker (called by index.ts at startup). concurrency=1: distillation is an LLM task; serial to protect the gateway. */
export function buildTrajectoryWorker(processor: (job: TrajectoryJob) => Promise<void>): Worker<TrajectoryJob> {
  return new Worker<TrajectoryJob>(TRAJECTORY_QUEUE_NAME, async (job) => processor(job.data), {
    connection: getRedis(),
    concurrency: 1,
  });
}

/** Called by the persist hook. Dynamic import of trajectoryWorker avoids the static cycle (stageRoute→queue→worker→session→…). */
export async function enqueueTrajectoryDistill(data: TrajectoryJob): Promise<void> {
  if (process.env.ASSISTANT_TRAJECTORY_DISTILL === '0') return;
  if (data.items.length === 0) return;
  if (isTrajectoryQueueReady()) {
    try {
      await getTrajectoryQueue().add(TRAJECTORY_QUEUE_NAME, data);
      return;
    } catch (e) {
      logger.warn({ err: e, threadId: data.threadId }, 'trajectory queue add failed; running inline');
    }
  }
  const { processTrajectoryJobInline } = await import('./trajectoryWorker.js');
  void processTrajectoryJobInline(data).catch((err) => logger.error({ err, threadId: data.threadId }, 'inline trajectory job crashed'));
}

/** For tests/teardown only. */
export async function __closeTrajectoryQueue(): Promise<void> {
  if (_queue) await _queue.close();
  _queue = null;
}
