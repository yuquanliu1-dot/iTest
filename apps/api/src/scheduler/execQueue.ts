/**
 * Execution queue: plan runs / single-case executions all enqueue here; across api replicas any exec worker consumes via redis.
 * Same guard as the plan-schedule queue: REDIS_URL missing → isExecutionQueueReady()=false,
 * callers fall back to synchronous (fire-and-forget) execution; single-container/dev behavior unchanged. */
import { Queue, Worker } from 'bullmq';
import { getRedis } from './queue.js';

export const EXEC_QUEUE_NAME = 'exec';

export type ExecJob =
  | { kind: 'plan'; planRunId: string }
  | { kind: 'case'; caseId: string; preseed: Array<{ reportId: string; rowIndex: number | null }>;
      /** Dataset row index set frozen at preflight (enabled row indexes). The worker filters by it, keeping consistent with the preseed row set. */
      datasetRowIndexes?: number[]; createdByUserId?: string | null }
  | { kind: 'solidify'; batchId: string; caseId: string }
  | { kind: 'exploration'; sessionId: string };

let _queue: Queue<ExecJob> | null = null;

export function isExecutionQueueReady(): boolean {
  return !!process.env.REDIS_URL;
}

export function getExecutionQueue(): Queue<ExecJob> {
  if (!_queue) {
    _queue = new Queue<ExecJob>(EXEC_QUEUE_NAME, { connection: getRedis() });
  }
  return _queue;
}

/** Build the execution worker. concurrency = per-container chromium concurrency gate (docker controls it via EXEC_CONCURRENCY).
 *  Peak concurrent chromium ≈ replica count × concurrency. */
export function buildExecutionWorker(
  processor: (job: ExecJob) => Promise<void>,
): Worker<ExecJob> {
  const raw = Number(process.env.EXEC_CONCURRENCY);
  const concurrency = Number.isInteger(raw) && raw > 0 ? raw : 3;
  return new Worker<ExecJob>(EXEC_QUEUE_NAME, async (job) => processor(job.data), {
    connection: getRedis(),
    concurrency,
  });
}

/** For tests/teardown only: disconnect and clear the singleton. */
export async function __closeExecutionQueue(): Promise<void> {
  if (_queue) await _queue.close();
  _queue = null;
}