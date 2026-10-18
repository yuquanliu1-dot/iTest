/**
 * 执行队列：计划运行 / 单用例执行统一入队,跨 api 副本经 redis 被任一 exec worker 消费。
 * 与 plan-schedule 队列同款守卫:REDIS_URL 缺失 → isExecutionQueueReady()=false,
 * 调用方回落同步(fire-and-forget)执行,单容器/dev 行为不变。 */
import { Queue, type Worker } from 'bullmq';
import { getRedis } from './queue.js';

export const EXEC_QUEUE_NAME = 'exec';

export type ExecJob =
  | { kind: 'plan'; planRunId: string }
  | { kind: 'case'; caseId: string; preseed: Array<{ reportId: string; rowIndex: number | null }>; createdByUserId?: string | null };

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

/** 构造执行 worker。concurrency = 每容器 chromium 并发闸门(docker 用 EXEC_CONCURRENCY 控制)。
 *  峰值并发 chromium ≈ 副本数 × concurrency。 */
export function buildExecutionWorker(
  processor: (job: ExecJob) => Promise<void>,
): Worker<ExecJob> {
  const { Worker } = require('bullmq') as typeof import('bullmq');
  const raw = Number(process.env.EXEC_CONCURRENCY);
  const concurrency = Number.isInteger(raw) && raw > 0 ? raw : 3;
  return new Worker<ExecJob>(EXEC_QUEUE_NAME, async (job) => processor(job.data), {
    connection: getRedis(),
    concurrency,
  });
}

/** 仅供测试/teardown：断开连接、清空单例。 */
export async function __closeExecutionQueue(): Promise<void> {
  if (_queue) await _queue.close();
  _queue = null;
}