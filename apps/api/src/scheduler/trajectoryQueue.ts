/**
 * 轨迹蒸馏队列：/stage/save 落库钩子投递，worker 读 pi-sessions JSONL 判据核实后
 * LLM 蒸馏入库。REDIS_URL 缺失 → inline fire-and-forget（rcaQueue 同款降级）。
 * 幂等由 partial unique(source_case_id where active) + onConflictDoNothing 兜底。
 * 开关：ASSISTANT_TRAJECTORY_DISTILL=0 关闭（默认开）。
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

/** 构造 worker（index.ts 启动时调用）。concurrency=1：蒸馏是 LLM 任务，串行防网关压力。 */
export function buildTrajectoryWorker(processor: (job: TrajectoryJob) => Promise<void>): Worker<TrajectoryJob> {
  return new Worker<TrajectoryJob>(TRAJECTORY_QUEUE_NAME, async (job) => processor(job.data), {
    connection: getRedis(),
    concurrency: 1,
  });
}

/** 落库钩子调用。动态 import trajectoryWorker 防静态环（stageRoute→queue→worker→session→…）。 */
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

/** 仅供测试/teardown。 */
export async function __closeTrajectoryQueue(): Promise<void> {
  if (_queue) await _queue.close();
  _queue = null;
}
