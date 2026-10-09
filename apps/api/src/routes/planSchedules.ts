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
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible } from '../services/projectAccess.js';
import {
  createPlanSchedule,
  deletePlanSchedule,
  getPlanSchedule,
  listPlanSchedules,
  loadPlanOr404,
  updatePlanSchedule,
} from '../services/planSchedules.service.js';

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

/** GET /api/plans/:id/schedules  列表 */
planSchedulesRoute.get('/:id/schedules', async (req, res) => {
  const plan = await loadPlanOr404(req.params.id!);
  await assertProjectVisible(plan.projectId, req.user!);
  res.json(await listPlanSchedules(plan.id));
});

/** POST /api/plans/:id/schedules  新建 */
planSchedulesRoute.post('/:id/schedules', async (req, res) => {
  const plan = await loadPlanOr404(req.params.id!);
  await assertProjectVisible(plan.projectId, req.user!);
  const body = CreateBody.parse(req.body);
  const row = await createPlanSchedule(plan.id, {
    cronExpr: body.cronExpr,
    timezone: body.timezone,
    enabled: body.enabled,
    createdByUserId: req.user!.userId,
  });
  res.json(row);
});

/** PATCH /api/plan-schedules/:scheduleId */
planSchedulesRoute.patch('/:scheduleId', async (req, res) => {
  const rawId = req.params.scheduleId;
  const scheduleId = typeof rawId === 'string' ? rawId : '';
  if (!scheduleId) throw new HttpError(400, 'bad_request', 'scheduleId required');
  const body = PatchBody.parse(req.body);
  const existing = await getPlanSchedule(scheduleId);
  if (!existing) throw new HttpError(404, 'not_found', 'schedule not found');
  const plan = await loadPlanOr404(existing.planId);
  await assertProjectVisible(plan.projectId, req.user!);
  const row = await updatePlanSchedule(scheduleId, body);
  res.json(row);
});

/** DELETE /api/plan-schedules/:scheduleId */
planSchedulesRoute.delete('/:scheduleId', async (req, res) => {
  const rawId = req.params.scheduleId;
  const scheduleId = typeof rawId === 'string' ? rawId : '';
  if (!scheduleId) throw new HttpError(400, 'bad_request', 'scheduleId required');
  const existing = await getPlanSchedule(scheduleId);
  if (!existing) throw new HttpError(404, 'not_found', 'schedule not found');
  const plan = await loadPlanOr404(existing.planId);
  await assertProjectVisible(plan.projectId, req.user!);
  const r = await deletePlanSchedule(scheduleId);
  if (!r.deleted) throw new HttpError(404, 'not_found', 'schedule not found');
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
  const existing = await getPlanSchedule(scheduleId);
  if (!existing) throw new HttpError(404, 'not_found', 'schedule not found');
  const plan = await loadPlanOr404(existing.planId);
  await assertProjectVisible(plan.projectId, req.user!);
  const row = await updatePlanSchedule(scheduleId, { enabled });
  res.json(row);
}