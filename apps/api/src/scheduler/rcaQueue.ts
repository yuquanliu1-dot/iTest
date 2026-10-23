/**
 * RCA 队列：计划运行结束后的失败用例根因分析任务。全局并发 1——同一时间只有一个
 * 分析线程在跑，不与执行引擎抢 chromium 资源。REDIS_URL 缺失 → inline fire-and-forget
 * (dev/单容器)，与 exec 队列的降级模式一致。幂等判重由 worker 侧线程查重兜底。
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

/** 构造 RCA worker（由 scheduler 启动时调用）。concurrency=1：全局串行分析。 */
export function buildRcaWorker(processor: (job: RcaJob) => Promise<void>): Worker<RcaJob> {
  return new Worker<RcaJob>(RCA_QUEUE_NAME, async (job) => processor(job.data), {
    connection: getRedis(),
    concurrency: 1,
  });
}

/** 运行收尾调用：开关打开且有业务失败才投递。动态 import rcaWorker 防静态环
 *  (runPlan→rcaQueue→rcaWorker→session→…)；测试也靠它 mock rcaWorker。 */
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

/** 仅供测试/teardown。 */
export async function __closeRcaQueue(): Promise<void> {
  if (_queue) await _queue.close();
  _queue = null;
}
