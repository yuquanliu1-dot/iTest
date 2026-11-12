/**
 * RCA queue: root-cause analysis tasks for failed cases after a plan run ends. Global concurrency 1 —
 * only one analysis thread runs at a time, never contending with the execution engine for chromium.
 * REDIS_URL missing → inline fire-and-forget (dev/single container), same degraded mode as the exec
 * queue. Idempotency is guarded by the worker-side thread dedup check.
 */
import { Queue, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { getRedis } from './queue.js';
import { db } from '../db/client.js';
import { planRuns } from '../db/schema.js';
import { logger } from '../logger.js';

export const RCA_QUEUE_NAME = 'rca';

export type RcaJob = { kind: 'rca'; planRunId: string };

let _queue: Queue<RcaJob> | null = null;

export function isRcaQueueReady(): boolean {
  return !!process.env.REDIS_URL;
}

export function getRcaQueue(): Queue<RcaJob> {
  if (!_queue) {
    _queue = new Queue<RcaJob>(RCA_QUEUE_NAME, { connection: getRedis() });
  }
  return _queue;
}

/** Build the RCA worker (called at scheduler startup). concurrency=1: globally serial analysis. */
export function buildRcaWorker(processor: (job: RcaJob) => Promise<void>): Worker<RcaJob> {
  return new Worker<RcaJob>(RCA_QUEUE_NAME, async (job) => processor(job.data), {
    connection: getRedis(),
    concurrency: 1,
  });
}

/** Called at run finish: enqueue only when the switch is on and there are business failures. Dynamic import of rcaWorker avoids the static cycle
 *  (runPlan→rcaQueue→rcaWorker→session→…); tests also rely on it to mock rcaWorker. */
export async function enqueueRcaForPlanRun(planRunId: string): Promise<void> {
  const run = (await db
    .select({ rcaEnabled: planRuns.rcaEnabled, failedCases: planRuns.failedCases })
    .from(planRuns)
    .where(eq(planRuns.id, planRunId))
    .limit(1))[0];
  if (!run?.rcaEnabled || (run.failedCases ?? 0) <= 0) return;
  const job: RcaJob = { kind: 'rca', planRunId };
  if (isRcaQueueReady()) {
    try {
      await getRcaQueue().add(RCA_QUEUE_NAME, job);
      return;
    } catch (e) {
      logger.warn({ err: e, planRunId }, 'rca queue add failed; running inline');
    }
  }
  const { processRcaJob } = await import('./rcaWorker.js');
  void processRcaJob(job).catch((err) => logger.error({ err, planRunId }, 'inline rca job crashed'));
}

/** For tests/teardown only. */
export async function __closeRcaQueue(): Promise<void> {
  if (_queue) await _queue.close();
  _queue = null;
}
