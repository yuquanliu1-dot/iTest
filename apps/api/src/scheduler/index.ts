/**
 * 调度器入口：startScheduler() 在 API 进程启动时调用。
 *
 * 行为：
 * - 若 REDIS_URL 未设置 / ioredis 连接失败 → 优雅降级（warn + return），手动 run 不受影响。
 * - reconcileAllSchedules() 在 worker start 之前跑一遍，避免启动期间重复 fire。
 * - 注册 SIGTERM / SIGINT 优雅关闭 worker（其它关闭路径由进程退出兜底）。
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
    // 上电前先把表里的 truth 同步到 BullMQ。3 副本同启都跑到这里：reconcile 靠分布式锁
    // 单飞（输家直接跳过，worker 照常启动——BullMQ 每 job 单消费，多 worker 无重复执行）。
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

/** 仅供测试：手动停掉 worker + 断开 redis。 */
export async function __stopSchedulerForTests(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
  }
  const { __closeForTests } = await import('./queue.js');
  await __closeForTests();
}

export { isSchedulerReady };