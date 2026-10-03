import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { requireAuth, isManagerOfOrg } from '../middleware/auth.js';
import { getOrgPath } from '../services/orgTree.js';
import { assignmentsService, assertProjectVisibleForAssignments } from '../services/assignments.service.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

/** 与 iDO requireProjectAccess 等价：manager 走子树，user 走 assignment。 */
async function requireProjectAccess(projectId: string, user: NonNullable<Express.Request['user']>): Promise<void> {
  await assertProjectVisibleForAssignments(projectId, user);
}

const AssignBody = z.object({
  userIds: z.array(z.string().uuid()).min(1),
});

router.get('/:projectId/assignments', async (req, res) => {
  const projectId = req.params.projectId!;
  await requireProjectAccess(projectId, req.user!);
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const q = req.query.q as string | undefined;
  const result = await assignmentsService.list(projectId, { q, page, limit });
  res.json(result);
});

router.post('/:projectId/assignments', async (req, res) => {
  const projectId = req.params.projectId!;
  // 仅 manager 可分配（与 iDO 一致）
  const projectRows = await db.select({ organizationId: projects.organizationId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!projectRows[0]) throw new HttpError(404, 'not_found', 'project not found');
  const orgPath = await getOrgPath(projectRows[0].organizationId);
  if (!isManagerOfOrg(req.user!, orgPath)) throw new HttpError(403, 'forbidden', '需要项目所属组织的管理员角色');

  const body = AssignBody.parse(req.body);
  const result = await assignmentsService.assignMany(projectId, body.userIds, projectRows[0].organizationId);
  res.status(201).json(result);
});

const UnassignParams = z.object({
  projectId: z.string().uuid(),
  userId: z.string().uuid(),
});

router.delete('/:projectId/assignments/:userId', async (req, res) => {
  const { projectId, userId } = UnassignParams.parse(req.params);
  const projectRows = await db.select({ organizationId: projects.organizationId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!projectRows[0]) throw new HttpError(404, 'not_found', 'project not found');
  const orgPath = await getOrgPath(projectRows[0].organizationId);
  if (!isManagerOfOrg(req.user!, orgPath)) throw new HttpError(403, 'forbidden', '需要项目所属组织的管理员角色');
  await assignmentsService.unassign(projectId, userId);
  res.status(204).end();
});

export default router;