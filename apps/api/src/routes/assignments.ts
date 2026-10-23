import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { productLines, projects } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { requireAuth, isManagerOfOrg } from '../middleware/auth.js';
import { getOrgPath } from '../services/orgTree.js';
import { assignmentsService, assertProjectVisibleForAssignments } from '../services/assignments.service.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

/** 解析 project → 所属 org id（经 product_lines）；项目不存在返回 null。 */
async function projectOrgId(projectId: string): Promise<string | null> {
  const rows = await db
    .select({ organizationId: productLines.organizationId })
    .from(projects)
    .innerJoin(productLines, eq(productLines.id, projects.productLineId))
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows[0]?.organizationId ?? null;
}

/** 分配/解分配的管理员闸门：须是项目所属组织（或其祖先）的管理员。 */
async function requireProjectManager(projectId: string, user: NonNullable<Express.Request['user']>, missing: string): Promise<string> {
  const orgId = await projectOrgId(projectId);
  if (!orgId) throw new HttpError(404, 'not_found', missing);
  const orgPath = await getOrgPath(orgId);
  if (!isManagerOfOrg(user, orgPath)) throw new HttpError(403, 'forbidden', '需要项目所属组织的管理员角色');
  return orgId;
}

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
  const orgId = await requireProjectManager(projectId, req.user!, 'project not found');

  const body = AssignBody.parse(req.body);
  const result = await assignmentsService.assignMany(projectId, body.userIds, orgId);
  res.status(201).json(result);
});

const UnassignParams = z.object({
  projectId: z.string().uuid(),
  userId: z.string().uuid(),
});

router.delete('/:projectId/assignments/:userId', async (req, res) => {
  const { projectId, userId } = UnassignParams.parse(req.params);
  await requireProjectManager(projectId, req.user!, 'project not found');
  await assignmentsService.unassign(projectId, userId);
  res.status(204).end();
});

export default router;