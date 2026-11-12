/**
 * The BullMQ worker's processor: at fire time turns a plan_schedules row → enqueuePlanRun → writes audit fields.
 *
 * Flow:
 *   1. SELECT the plan row; if missing / enabled=false → return (job was deleted in the UI, swallow it).
 *   2. enqueuePlanRun({ callerUser: null, trigger: { source: 'schedule', scheduleId, userId } })
 *      callerUser=null skips project visibility checks (the schedule row exists = validated at creation).
 *   3. UPDATE last_run_at=now() + compute next_run_at once with cron-parser and write it back,
 *      without depending on BullMQ's internal keys, so the UI can show it immediately.
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
    // Don't throw: avoids BullMQ dead-lettering; users can watch schedule.last_run_at advance in the UI
  }

  const nextRunAt = computeNextRunAt(row);
  await db.update(planSchedules)
    .set({ lastRunAt: new Date(), nextRunAt, updatedAt: new Date() })
    .where(eq(planSchedules.id, scheduleId));
}