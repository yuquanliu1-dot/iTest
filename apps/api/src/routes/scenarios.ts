import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scenarios } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible } from '../services/projectAccess.js';
import {
  listScenariosByProject,
  createScenario,
  updateScenario,
  deleteScenario,
  requirementProjectId,
  scenarioProjectId,
} from '../services/scenarios.service.js';

export const scenariosRoute = Router({ mergeParams: true });

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
});
const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
});

// 直挂载：GET /api/scenarios?projectId=...
// 列出该项目下 requirement 衍生的场景全集，让场景过滤下拉不被选中项收缩。
scenariosRoute.get('/', async (req, res) => {
  const projectId = req.query.projectId as string | undefined;
  const rid = (req.params as { requirementId?: string }).requirementId;
  if (projectId) {
    await assertProjectVisible(projectId, req.user!);
    res.json(await listScenariosByProject(projectId));
    return;
  }
  if (!rid) throw new HttpError(400, 'bad_request', 'projectId or requirementId required');
  const pid = await requirementProjectId(rid);
  if (!pid) throw new HttpError(404, 'not_found', 'requirement not found');
  await assertProjectVisible(pid, req.user!);
  const rows = await db
    .select()
    .from(scenarios)
    .where(eq(scenarios.requirementId, rid))
    .orderBy(scenarios.order, scenarios.createdAt);
  res.json(rows);
});

scenariosRoute.post('/', async (req, res) => {
  const rid = (req.params as { requirementId?: string }).requirementId!;
  const pid = await requirementProjectId(rid);
  if (!pid) throw new HttpError(404, 'not_found', 'requirement not found');
  await assertProjectVisible(pid, req.user!);
  const body = CreateBody.parse(req.body);
  res.json(await createScenario(rid, body));
});

scenariosRoute.patch('/:id', async (req, res) => {
  const pid = await scenarioProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'scenario not found');
  await assertProjectVisible(pid, req.user!);
  const body = PatchBody.parse(req.body);
  res.json(await updateScenario(req.params.id!, body));
});

scenariosRoute.delete('/:id', async (req, res) => {
  const pid = await scenarioProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'scenario not found');
  await assertProjectVisible(pid, req.user!);
  // FK ON DELETE SET NULL: cases 自动解除绑定；不要 409
  await deleteScenario(req.params.id!);
  res.json({ ok: true });
});
