/**
 * BullMQ worker 的 processor：到点把 plan_schedules 行 → enqueuePlanRun → 写入审计字段。
 *
 * 流程：
 *   1. SELECT 计划行；若不存在 / enabled=false → return（job 已被 UI 删除，吞掉）。
 *   2. enqueuePlanRun({ callerUser: null, trigger: { source: 'schedule', scheduleId, userId } })
 *      callerUser=null 跳过项目可见性校验（schedule 行已存 = 创建时已校验）。
 *   3. UPDATE last_run_at=now() + 用 cron-parser 算一次 next_run_at 写回,
 *      不依赖 BullMQ 内部 key,便于 UI 立即显示。
 */
import { eq } from 'drizzle-orm';
import cronParser from 'cron-parser';
import { db } from '../db/client.js';
import { planSchedules } from '../db/schema.js';
import { logger } from '../logger.js';
import { enqueuePlanRun } from '../execute/enqueuePlanRun.js';

function computeNextRunAt(row: typeof planSchedules.$inferSelect): Date | null {
  try {
    const it = cronParser.parseExpression(row.cronExpr, { currentDate: new Date(), tz: row.timezone });
    const n = it.next();
    return n.toDate();
  } catch (e) {
    logger.warn({ err: (e as Error).message, scheduleId: row.id }, 'cron parse failed');
    return null;
  }
}

export async function processScheduleFire(scheduleId: string): Promise<void> {
  const row = (await db.select().from(planSchedules).where(eq(planSchedules.id, scheduleId)))[0];
  if (!row) {
    logger.warn({ scheduleId }, 'schedule row missing, skipping fire');
    return;
  }
  if (!row.enabled) return;

  try {
    const { runId } = await enqueuePlanRun({
      planId: row.planId,
      trigger: {
        source: 'schedule',
        userId: row.createdByUserId,
        scheduleId: row.id,
      },
      callerUser: null,
    });
    logger.info({ scheduleId, runId, planId: row.planId }, 'scheduled plan run enqueued');
  } catch (e) {
    logger.error({ err: (e as Error).message, scheduleId }, 'scheduled run enqueue failed');
    // 不抛：避免 BullMQ 进入死信；用户可在 UI 看 schedule.last_run_at 是否推进
  }

  const nextRunAt = computeNextRunAt(row);
  await db.update(planSchedules)
    .set({ lastRunAt: new Date(), nextRunAt, updatedAt: new Date() })
    .where(eq(planSchedules.id, scheduleId));
}