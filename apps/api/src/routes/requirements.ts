import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { requirements } from '../db/schema.js';
import { eq, asc, inArray } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible, visibleProjectIds } from '../services/projectAccess.js';

export const requirementsRoute = Router({ mergeParams: true });

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  projectId: z.string().uuid().optional(),
});

/** 双挂载：/projects/:projectId/requirements 与 /requirements。可见性从项目维度判定。 */
requirementsRoute.get('/', async (req, res) => {
  const { projectId } = req.params as { projectId?: string };
  let rows;
  if (projectId) {
    await assertProjectVisible(projectId, req.user!);
    rows = await db.select().from(requirements).where(eq(requirements.projectId, projectId)).orderBy(asc(requirements.createdAt));
  } else {
    // 直挂载：按可见项目过滤
    const visiblePids = await visibleProjectIds(req.user!);
    rows = visiblePids.length
      ? await db.select().from(requirements).where(inArray(requirements.projectId, visiblePids)).orderBy(asc(requirements.createdAt))
      : [];
  }
  res.json(rows);
});

requirementsRoute.post('/', async (req, res) => {
  const paramsProjectId = (req.params as { projectId?: string }).projectId;
  const body = CreateBody.parse(req.body);
  const projectId = paramsProjectId ?? body.projectId;
  if (!projectId) throw new HttpError(400, 'bad_request', 'projectId is required');
  await assertProjectVisible(projectId, req.user!);
  const rows = await db
    .insert(requirements)
    .values({ ...body, projectId })
    .returning();
  res.json(rows[0]);
});

requirementsRoute.get('/:id', async (req, res) => {
  const rows = await db.select().from(requirements).where(eq(requirements.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'requirement not found');
  // 经所属项目判定可见性（不依赖挂载参数，两种挂载统一）
  await assertProjectVisible(rows[0]!.projectId, req.user!);
  res.json(rows[0]);
});
