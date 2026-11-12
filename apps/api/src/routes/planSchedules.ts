/**
 * /api/plans/:id/schedules and /api/plan-schedules/:scheduleId routes.
 *
 * Model: cron expression + IANA timezone, triggered repeatedly at fixed times.
 * Consistent with iDO Automation's schedule:
 * - "Run now" reuses the existing "one-click run" button (planRuns.triggered_by='manual').
 * - "Scheduling" here specifically means cron timing (planRuns.triggered_by='schedule').
 * - The user can temporarily turn it off in the UI (enabled=false) without affecting the plan/data; the worker won't enqueue.
 *
 * After a write operation's DB commit, BullMQ is synced immediately (upsertScheduleJob / removeScheduleJob).
 * Sync failure does not roll back the DB (the worker's next reconcile is the fallback), but it must be logged as a warning.
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

/** GET /api/plans/:id/schedules  list */
planSchedulesRoute.get('/:id/schedules', async (req, res) => {
  const plan = await loadPlanOr404(req.params.id!);
  await assertProjectVisible(plan.projectId, req.user!);
  res.json(await listPlanSchedules(plan.id));
});

/** POST /api/plans/:id/schedules  create */
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

/** POST /api/plan-schedules/:scheduleId/enable and /disable (semantically equivalent to PATCH enabled=true/false) */
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