/**
 * Reconciliation layer between persistence (plan_schedules table) and BullMQ (repeatable jobs).
 *
 * Key invariants:
 * - jobId = `schedule:${scheduleId}`  →  upsertScheduleJob is idempotent; delete-and-recreate won't pile up multiple jobs.
 * - Every schedule is cron mode: enters BullMQ via `repeat.pattern + tz`.
 * - reconcileAllSchedules is the source-of-truth sync: DB enabled=true ↔ BullMQ has the same-named job.
 *   Called once at API startup; not called after worker processing (repeatable jobs re-schedule themselves).
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

/** Write/remove a single schedule (regardless of enabled state) into/from the BullMQ queue. */
export async function upsertScheduleJob(scheduleId: string): Promise<void> {
  if (!isSchedulerReady()) return;
  const q = getQueue();
  const row = (await db.select().from(planSchedules).where(eq(planSchedules.id, scheduleId)))[0];
  if (!row) {
    await q.remove(jobIdFor(scheduleId));
    return;
  }
  // Remove then add: avoids stale repeat leftovers (especially needed when the cron expression changes)
  await q.remove(jobIdFor(scheduleId));
  if (!row.enabled) return;
  await q.add('fire', { scheduleId: row.id }, jobOptionsFor(row));
}

export async function removeScheduleJob(scheduleId: string): Promise<void> {
  if (!isSchedulerReady()) return;
  await getQueue().remove(jobIdFor(scheduleId));
}

/** Called once at startup. Reports added/removed/unchanged counts for troubleshooting. */
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
      // BullMQ's key looks like `repeat:schedule:<uuid>:<pattern>:<hash>`, not the jobId.
      // We take a "conservatively unchanged" stance: cron expression changes are proactively handled by upsertScheduleJob;
      // during bulk reconcile, "already exists" counts as unchanged to avoid duplicate enqueues.
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