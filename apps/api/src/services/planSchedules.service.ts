/**
 * 计划调度（plan_schedules）领域服务。
 *
 * 与 REST 路由（routes/planSchedules.ts）与 AI 助手工具（pi/space/tools/plans.ts 的 manage_plans）
 * 共用：cron 校验、归属校验、DB 写、BullMQ 同步全部收敛到这里。
 *
 * 同步策略：DB commit 后立即 upsertScheduleJob / removeScheduleJob；
 * 同步失败不回滚 DB（worker 下次 reconcile 兜底），但要在 logger.warn 留痕。
 * Redis 不可用时 upsert/remove 自身就是空操作。
 */
import { asc, eq } from 'drizzle-orm';
import cronParser from 'cron-parser';
import { db } from '../db/client.js';
import { executionPlans, planSchedules, type planSchedules as planSchedulesTable } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { logger } from '../logger.js';
import { upsertScheduleJob, removeScheduleJob } from '../scheduler/sync.js';

export type PlanScheduleRow = typeof planSchedulesTable.$inferSelect;

/** 把外部输入的 cron 跑一次 next() 验证合法性 + 顺手算出 next_run_at。失败抛 400。 */
export function validateCron(expr: string, tz: string): Date {
  try {
    const it = cronParser.parseExpression(expr, { currentDate: new Date(), tz });
    return it.next().toDate();
  } catch (e) {
    throw new HttpError(400, 'bad_cron_expr', `cron 表达式非法: ${(e as Error).message}`);
  }
}

/** 计划行查 + 缺失 404。供所有需要 plan_id 上下文的入口（路由 / 工具）复用。 */
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
  /** 创建人；可空——tool 上下文无 userId 时给 null。 */
  createdByUserId?: string | null;
}

/** 新建调度：写 DB → 触发 BullMQ 同步。已存在计划以外的场景由调用方做归属校验。 */
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

/** 改 enabled / cronExpr / timezone。cron 改则重算 next_run_at；触发 BullMQ 同步。 */
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

/** 删调度 + 触发 BullMQ 同步；不存在返回 deleted=false。 */
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