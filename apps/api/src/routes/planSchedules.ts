/**
 * /api/plans/:id/schedules 与 /api/plan-schedules/:scheduleId 路由。
 *
 * 模型：cron 表达式 + IANA 时区，按固定时刻重复触发。
 * 与 iDO Automation 的 schedule 一致：
 * - 「立即执行」沿用现有「一键执行」按钮（planRuns.triggered_by='manual'）。
 * - 这里的「调度」专指 cron 定时（planRuns.triggered_by='schedule'）。
 * - 用户可在 UI 临时关掉（enabled=false），不影响 plan/数据；worker 不入队。
 *
 * 写操作 DB commit 后立即同步 BullMQ（upsertScheduleJob / removeScheduleJob）。
 * 同步失败不回滚 DB（worker 下次 reconcile 兜底），但要在日志告警。
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { eq, asc } from 'drizzle-orm';
import cronParser from 'cron-parser';
import { db } from '../db/client.js';
import { executionPlans, planSchedules } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible } from '../services/projectAccess.js';
import { upsertScheduleJob, removeScheduleJob } from '../scheduler/sync.js';
import { logger } from '../logger.js';

export const planSchedulesRoute = Router();

const CreateBody = z.object({
  cronExpr: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64).default('Asia/Shanghai'),
  enabled: z.boolean().default(true),
});

const PatchBody = z.object({
  enabled: z.boolean().optional(),
  cronExpr: z.string().min(1).max(120).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

/** 把外部输入的 cron 跑一次 next() 验证合法性 + 顺手算出 next_run_at。 */
function validateCron(expr: string, tz: string): Date {
  try {
    const it = cronParser.parseExpression(expr, { currentDate: new Date(), tz });
    return it.next().toDate();
  } catch (e) {
    throw new HttpError(400, 'bad_cron_expr', (e as Error).message);
  }
}

async function loadPlanOr404(planId: string): Promise<{ id: string; projectId: string }> {
  const row = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)))[0];
  if (!row) throw new HttpError(404, 'not_found', 'plan not found');
  return { id: row.id, projectId: row.projectId };
}

/** GET /api/plans/:id/schedules  列表 */
planSchedulesRoute.get('/:id/schedules', async (req, res) => {
  const plan = await loadPlanOr404(req.params.id!);
  await assertProjectVisible(plan.projectId, req.user!);
  const rows = await db.select().from(planSchedules)
    .where(eq(planSchedules.planId, plan.id))
    .orderBy(asc(planSchedules.createdAt));
  res.json(rows);
});

/** POST /api/plans/:id/schedules  新建 */
planSchedulesRoute.post('/:id/schedules', async (req, res) => {
  const plan = await loadPlanOr404(req.params.id!);
  await assertProjectVisible(plan.projectId, req.user!);
  const body = CreateBody.parse(req.body);
  const nextRunAt = validateCron(body.cronExpr, body.timezone);

  const ins = await db.insert(planSchedules).values({
    planId: plan.id,
    enabled: body.enabled,
    cronExpr: body.cronExpr,
    timezone: body.timezone,
    nextRunAt,
    createdByUserId: req.user!.userId,
  }).returning();
  const row = ins[0];
  if (!row) throw new HttpError(500, 'insert_failed', 'failed to insert schedule');
  try {
    await upsertScheduleJob(row.id);
  } catch (e) {
    logger.warn({ err: (e as Error).message, scheduleId: row.id }, 'upsertScheduleJob failed after create');
  }
  res.json(row);
});

/** PATCH /api/plan-schedules/:scheduleId */
planSchedulesRoute.patch('/:scheduleId', async (req, res) => {
  const rawId = req.params.scheduleId;
  const scheduleId = typeof rawId === 'string' ? rawId : '';
  if (!scheduleId) throw new HttpError(400, 'bad_request', 'scheduleId required');
  const body = PatchBody.parse(req.body);
  const existing = (await db.select().from(planSchedules).where(eq(planSchedules.id, scheduleId)))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'schedule not found');
  const plan = await loadPlanOr404(existing.planId);
  await assertProjectVisible(plan.projectId, req.user!);

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (body.enabled !== undefined) update.enabled = body.enabled;
  if (body.timezone !== undefined) update.timezone = body.timezone;
  if (body.cronExpr !== undefined) {
    const tz = body.timezone ?? existing.timezone;
    update.cronExpr = body.cronExpr;
    // 验证并算一次 next_run_at
    update.nextRunAt = validateCron(body.cronExpr, tz);
  }

  const rows = await db.update(planSchedules).set(update).where(eq(planSchedules.id, scheduleId)).returning();
  if (rows.length === 0 || !rows[0]) throw new HttpError(404, 'not_found', 'schedule not found');
  try {
    await upsertScheduleJob(scheduleId);
  } catch (e) {
    logger.warn({ err: (e as Error).message, scheduleId }, 'upsertScheduleJob failed after update');
  }
  res.json(rows[0]);
});

/** DELETE /api/plan-schedules/:scheduleId */
planSchedulesRoute.delete('/:scheduleId', async (req, res) => {
  const rawId = req.params.scheduleId;
  const scheduleId = typeof rawId === 'string' ? rawId : '';
  if (!scheduleId) throw new HttpError(400, 'bad_request', 'scheduleId required');
  const existing = (await db.select().from(planSchedules).where(eq(planSchedules.id, scheduleId)))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'schedule not found');
  const plan = await loadPlanOr404(existing.planId);
  await assertProjectVisible(plan.projectId, req.user!);
  await db.delete(planSchedules).where(eq(planSchedules.id, scheduleId));
  try {
    await removeScheduleJob(scheduleId);
  } catch (e) {
    logger.warn({ err: (e as Error).message, scheduleId }, 'removeScheduleJob failed');
  }
  res.json({ ok: true });
});

/** POST /api/plan-schedules/:scheduleId/enable 与 /disable（语义等价于 PATCH enabled=true/false） */
planSchedulesRoute.post('/:scheduleId/enable', async (req, res) => {
  await setEnabled(req, res, true);
});
planSchedulesRoute.post('/:scheduleId/disable', async (req, res) => {
  await setEnabled(req, res, false);
});

async function setEnabled(req: Request, res: Response, enabled: boolean): Promise<void> {
  const rawId = req.params.scheduleId;
  const scheduleId = typeof rawId === 'string' ? rawId : '';
  if (!scheduleId) throw new HttpError(400, 'bad_request', 'scheduleId required');
  const existing = (await db.select().from(planSchedules).where(eq(planSchedules.id, scheduleId)))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'schedule not found');
  const plan = await loadPlanOr404(existing.planId);
  await assertProjectVisible(plan.projectId, req.user!);
  const rows = await db.update(planSchedules)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(planSchedules.id, scheduleId))
    .returning();
  const row = rows[0];
  if (!row) throw new HttpError(404, 'not_found', 'schedule not found');
  try {
    await upsertScheduleJob(scheduleId);
  } catch (e) {
    logger.warn({ err: (e as Error).message, scheduleId }, 'upsertScheduleJob failed after enable/disable');
  }
  res.json(row);
}
