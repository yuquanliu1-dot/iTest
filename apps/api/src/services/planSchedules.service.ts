/**
 * Plan scheduling (plan_schedules) domain service.
 *
 * Shared by the REST route (routes/planSchedules.ts) and the AI assistant tool (manage_plans in pi/space/tools/plans.ts):
 * cron validation, ownership checks, DB writes, and BullMQ sync all converge here.
 *
 * Sync strategy: upsertScheduleJob / removeScheduleJob immediately after the DB commit;
 * a sync failure doesn't roll back the DB (the worker's next reconcile covers it), but must leave a logger.warn trail.
 * When Redis is unavailable, upsert/remove themselves are no-ops.
 */
import { asc, eq } from 'drizzle-orm';
import cronParser from 'cron-parser';
import { db } from '../db/client.js';
import { executionPlans, planSchedules, type planSchedules as planSchedulesTable } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { logger } from '../logger.js';
import { upsertScheduleJob, removeScheduleJob } from '../scheduler/sync.js';

export type PlanScheduleRow = typeof planSchedulesTable.$inferSelect;

/** Runs next() once on the externally supplied cron to validate it + computes next_run_at along the way. Throws 400 on failure. */
export function validateCron(expr: string, tz: string): Date {
  try {
    const it = cronParser.parseExpression(expr, { currentDate: new Date(), tz });
    return it.next().toDate();
  } catch (e) {
    throw new HttpError(400, 'bad_cron_expr', `cron 表达式非法: ${(e as Error).message}`);
  }
}

/** Loads the plan row + 404 when missing. Reused by every entry point (route / tool) needing plan_id context. */
export async function loadPlanOr404(planId: string): Promise<{ id: string; projectId: string }> {
  const row = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
  if (!row) throw new HttpError(404, 'not_found', 'plan not found');
  return { id: row.id, projectId: row.projectId };
}

export async function listPlanSchedules(planId: string): Promise<PlanScheduleRow[]> {
  return db.select().from(planSchedules).where(eq(planSchedules.planId, planId)).orderBy(asc(planSchedules.createdAt));
}

export async function getPlanSchedule(scheduleId: string): Promise<PlanScheduleRow | null> {
  const row = (await db.select().from(planSchedules).where(eq(planSchedules.id, scheduleId)).limit(1))[0];
  return row ?? null;
}

export interface CreatePlanScheduleInput {
  cronExpr: string;
  timezone?: string;
  enabled?: boolean;
  /** Creator; nullable — null when the tool context has no userId. */
  createdByUserId?: string | null;
}

/** Creates a schedule: write DB → trigger BullMQ sync. Scenarios beyond the existing plan are ownership-checked by the caller. */
export async function createPlanSchedule(planId: string, input: CreatePlanScheduleInput): Promise<PlanScheduleRow> {
  const tz = input.timezone ?? 'Asia/Shanghai';
  const nextRunAt = validateCron(input.cronExpr, tz);
  const ins = await db.insert(planSchedules).values({
    planId,
    enabled: input.enabled ?? true,
    cronExpr: input.cronExpr,
    timezone: tz,
    nextRunAt,
    createdByUserId: input.createdByUserId ?? null,
  }).returning();
  const row = ins[0];
  if (!row) throw new HttpError(500, 'insert_failed', 'failed to insert schedule');
  try {
    await upsertScheduleJob(row.id);
  } catch (e) {
    logger.warn({ err: (e as Error).message, scheduleId: row.id }, 'upsertScheduleJob failed after create');
  }
  return row;
}

export interface UpdatePlanSchedulePatch {
  enabled?: boolean;
  cronExpr?: string;
  timezone?: string;
}

/** Updates enabled / cronExpr / timezone. A cron change recomputes next_run_at; triggers BullMQ sync. */
export async function updatePlanSchedule(scheduleId: string, patch: UpdatePlanSchedulePatch): Promise<PlanScheduleRow> {
  const existing = (await db.select().from(planSchedules).where(eq(planSchedules.id, scheduleId)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'schedule not found');
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.enabled !== undefined) update.enabled = patch.enabled;
  if (patch.timezone !== undefined) update.timezone = patch.timezone;
  if (patch.cronExpr !== undefined) {
    const tz = patch.timezone ?? existing.timezone;
    update.cronExpr = patch.cronExpr;
    update.nextRunAt = validateCron(patch.cronExpr, tz);
  }
  const rows = await db.update(planSchedules).set(update).where(eq(planSchedules.id, scheduleId)).returning();
  const row = rows[0];
  if (!row) throw new HttpError(404, 'not_found', 'schedule not found');
  try {
    await upsertScheduleJob(scheduleId);
  } catch (e) {
    logger.warn({ err: (e as Error).message, scheduleId }, 'upsertScheduleJob failed after update');
  }
  return row;
}

/** Deletes the schedule + triggers BullMQ sync; returns deleted=false when missing. */
export async function deletePlanSchedule(scheduleId: string): Promise<{ deleted: boolean }> {
  const existing = (await db.select().from(planSchedules).where(eq(planSchedules.id, scheduleId)).limit(1))[0];
  if (!existing) return { deleted: false };
  await db.delete(planSchedules).where(eq(planSchedules.id, scheduleId));
  try {
    await removeScheduleJob(scheduleId);
  } catch (e) {
    logger.warn({ err: (e as Error).message, scheduleId }, 'removeScheduleJob failed');
  }
  return { deleted: true };
}