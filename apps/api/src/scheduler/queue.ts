/**
 * BullMQ 队列基础设施。
 *
 * 关键约束：
 * - BullMQ 5 强制 worker 连接 `maxRetriesPerRequest: null`（失败阻塞 GET 模式）。
 * - Queue/Worker/Events 各自用独立 ioredis 连接（BullMQ 推荐）。
 * - 若 REDIS_URL 未设置或连接失败，scheduler 优雅降级到「无调度」模式
 *   （手动一键执行路径仍然能用）。与 cache.ts 的 fail-open 行为一致。
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
    // enableOfflineQueue:false → redis 断开时 add() 立即 reject,让调用方走 inline 回落
    //（而非把任务无限缓冲在 offline 队列,留下永远 running 的 plan_run/report）。
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

/** 构造一个 worker（由 scheduler/index.ts 在 startScheduler 时调用）。 */
export function buildWorker(
  processor: (scheduleId: string) => Promise<void>,
): Worker<{ scheduleId: string }> {
  // Worker 走顶部静态 import。此处曾是 require('bullmq')——api 是纯 ESM,require 未定义,
  // startScheduler 首次上 3 副本即崩(exec worker 的 require 崩溃同款坑,勿再走 require)。
  return new Worker<{ scheduleId: string }>(
    PLAN_SCHEDULE_QUEUE_NAME,
    async (job) => processor(job.data.scheduleId),
    { connection: getRedis() },
  );
}

/** 仅供测试/teardown：断开连接、清空单例。 */
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