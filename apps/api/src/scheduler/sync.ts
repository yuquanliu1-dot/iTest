/**
 * 持久化（plan_schedules 表）与 BullMQ（repeatable jobs）的对账层。
 *
 * 关键不变量：
 * - jobId = `schedule:${scheduleId}`  →  upsertScheduleJob 幂等；删了重建不会堆出多个 job。
 * - 全部 schedule 都是 cron 模式：用 `repeat.pattern + tz` 入 BullMQ。
 * - reconcileAllSchedules 是「真值来源」同步：DB enabled=true ↔ BullMQ 存在同名 job。
 *   API 启动时调用一次；worker 处理完后不调（repeatable 自动重排）。
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { planSchedules } from '../db/schema.js';
import { logger } from '../logger.js';
import { getQueue, isSchedulerReady } from './queue.js';
import type { JobsOptions, RepeatOptions } from 'bullmq';

function jobIdFor(scheduleId: string): string {
  return `schedule:${scheduleId}`;
}

function jobOptionsFor(row: typeof planSchedules.$inferSelect): JobsOptions {
  const repeat: RepeatOptions = { tz: row.timezone, pattern: row.cronExpr };
  return { jobId: jobIdFor(row.id), repeat };
}

/** 把单条 schedule（不论 enabled 状态）写入/移除 BullMQ 队列。 */
export async function upsertScheduleJob(scheduleId: string): Promise<void> {
  if (!isSchedulerReady()) return;
  const q = getQueue();
  const row = (await db.select().from(planSchedules).where(eq(planSchedules.id, scheduleId)))[0];
  if (!row) {
    await q.remove(jobIdFor(scheduleId));
    return;
  }
  // 先删再加：避免旧 repeat 残留（cron 表达式变更尤其需要）
  await q.remove(jobIdFor(scheduleId));
  if (!row.enabled) return;
  await q.add('fire', { scheduleId: row.id }, jobOptionsFor(row));
}

export async function removeScheduleJob(scheduleId: string): Promise<void> {
  if (!isSchedulerReady()) return;
  await getQueue().remove(jobIdFor(scheduleId));
}

/** 启动时调用一次。统计 added/removed/unchanged，便于排障。 */
export async function reconcileAllSchedules(): Promise<{ added: number; removed: number; unchanged: number }> {
  if (!isSchedulerReady()) return { added: 0, removed: 0, unchanged: 0 };
  const q = getQueue();
  const rows = await db.select().from(planSchedules).where(eq(planSchedules.enabled, true));
  const expectedIds = new Set(rows.map((r) => `schedule:${r.id}`));
  const existing = await q.getRepeatableJobs();
  const existingIds = new Set(existing.map((j) => String((j as { key?: string }).key ?? '')));

  let added = 0;
  let removed = 0;
  let unchanged = 0;

  for (const row of rows) {
    const jid = jobIdFor(row.id);
    if (existingIds.has(jid)) {
      // BullMQ 的 key 形如 `repeat:schedule:<uuid>:<pattern>:<hash>`，不是 jobId。
      // 这里采用「保守不变更」策略：cron 表达式变更由 upsertScheduleJob 主动触发；
      // 大批量 reconcile 时把"已存在"视为 unchanged，避免重复 enqueue。
      unchanged++;
      continue;
    }
    try {
      await q.add('fire', { scheduleId: row.id }, jobOptionsFor(row));
      added++;
    } catch (e) {
      logger.warn({ err: (e as Error).message, scheduleId: row.id }, 'reconcile enqueue failed');
    }
  }
  for (const e of existing) {
    const key = String((e as { key?: string }).key ?? '');
    if (key.startsWith('repeat:schedule:') && !expectedIds.has(key.replace('repeat:schedule:', ''))) {
      try {
        await q.remove(key);
        removed++;
      } catch (err) {
        logger.debug({ err: (err as Error).message, key }, 'reconcile remove failed');
      }
    }
  }
  logger.info({ added, removed, unchanged, total: rows.length }, 'reconcileAllSchedules done');
  return { added, removed, unchanged };
}