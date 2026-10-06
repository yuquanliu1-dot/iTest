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
import { cache, wrap } from '../lib/cache.js';
import { scenariosForProjectKey, scenariosForRequirementKey } from '../lib/cache-keys.js';

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
    const rows = await wrap(scenariosForProjectKey(projectId), 5 * 60_000, () => listScenariosByProject(projectId));
    res.json(rows);
    return;
  }
  if (!rid) throw new HttpError(400, 'bad_request', 'projectId or requirementId required');
  const pid = await requirementProjectId(rid);
  if (!pid) throw new HttpError(404, 'not_found', 'requirement not found');
  await assertProjectVisible(pid, req.user!);
  const rows = await wrap(scenariosForRequirementKey(rid), 5 * 60_000, async () => {
    return db
      .select()
      .from(scenarios)
      .where(eq(scenarios.requirementId, rid))
      .orderBy(scenarios.order, scenarios.createdAt);
  });
  res.json(rows);
});

scenariosRoute.post('/', async (req, res) => {
  const rid = (req.params as { requirementId?: string }).requirementId!;
  const pid = await requirementProjectId(rid);
  if (!pid) throw new HttpError(404, 'not_found', 'requirement not found');
  await assertProjectVisible(pid, req.user!);
  const body = CreateBody.parse(req.body);
  const created = await createScenario(rid, body);
  await cache.del(scenariosForProjectKey(pid));
  await cache.del(scenariosForRequirementKey(rid));
  res.json(created);
});

scenariosRoute.patch('/:id', async (req, res) => {
  const pid = await scenarioProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'scenario not found');
  await assertProjectVisible(pid, req.user!);
  const body = PatchBody.parse(req.body);
  const updated = await updateScenario(req.params.id!, body);
  await cache.del(scenariosForProjectKey(pid));
  // 通过 scenario → requirement 反查
  await cache.del(scenariosForRequirementKey(updated.requirementId));
  res.json(updated);
});

scenariosRoute.delete('/:id', async (req, res) => {
  const pid = await scenarioProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'scenario not found');
  await assertProjectVisible(pid, req.user!);
  // FK ON DELETE SET NULL: cases 自动解除绑定；不要 409
  await deleteScenario(req.params.id!);
  await cache.del(scenariosForProjectKey(pid));
  res.json({ ok: true });
});
