import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { and, count, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { organizationMembers, organizations, users } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { isManagerOfOrg, requireAuth } from '../middleware/auth.js';
import { getOrgPath, membershipsOf, visibleOrgIdsFor } from '../services/orgTree.js';
import { findUserByUsername } from '../services/auth.service.js';

export const organizationsRoute = Router();

organizationsRoute.use(requireAuth);

/** 可见组织列表：自己加入的 ∪ 管理的子树，附成员数与自己角色。 */
organizationsRoute.get('/', async (req, res) => {
  const user = req.user!;
  const visible = await visibleOrgIdsFor(user);
  if (visible.size === 0) {
    res.json([]);
    return;
  }
  const own = new Map((await membershipsOf(user.userId)).map((m) => [m.organizationId, m]));
  const orgRows = await db.select().from(organizations).where(inArray(organizations.id, [...visible]));
  const counts = await db
    .select({ organizationId: organizationMembers.organizationId, memberCount: count() })
    .from(organizationMembers)
    .where(inArray(organizationMembers.organizationId, [...visible]))
    .groupBy(organizationMembers.organizationId);
  const countByOrg = new Map(counts.map((c) => [c.organizationId, Number(c.memberCount)]));
  // path 排序让树形列表天然有序（父在前、同层按字典序）
  const items = orgRows
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((o) => ({
      id: o.id,
      name: o.name,
      parentId: o.parentId,
      path: o.path,
      description: o.description,
      memberCount: countByOrg.get(o.id) ?? 0,
      isManager: own.get(o.id)?.isManager ?? isManagerOfOrg(user, o.path),
      isUser: own.get(o.id)?.isUser ?? false,
    }));
  res.json(items);
});

const CreateOrgBody = z.object({
  name: z.string().min(1).max(200),
  parentId: z.string().uuid(),
});

// 仅允许创建子组织；根组织（租户）只由种子迁移创建。
// 要求调用者是父组织（或其祖先）的管理员。
organizationsRoute.post('/', async (req, res) => {
  const user = req.user!;
  const body = CreateOrgBody.parse(req.body);
  const parentPath = await getOrgPath(body.parentId);
  if (!parentPath) throw new HttpError(404, 'not_found', 'parent organization not found');
  if (!isManagerOfOrg(user, parentPath)) throw new HttpError(403, 'forbidden', '需要目标组织的管理员角色');

  const id = randomUUID();
  // 物化路径 = 父路径 + 自身 id；组织不支持改父，路径不可变
  const path = `${parentPath}${id}/`;
  const inserted = await db
    .insert(organizations)
    .values({ id, name: body.name, parentId: body.parentId, path })
    .returning();
  res.status(201).json(inserted[0]);
});

/** 组织管理守卫：组织存在且调用者是其（或其祖先）管理员；否则 404/403。 */
async function requireOrgManager(orgId: string, reqUser: NonNullable<Express.Request['user']>): Promise<string> {
  const orgPath = await getOrgPath(orgId);
  if (!orgPath) throw new HttpError(404, 'not_found', 'organization not found');
  if (!isManagerOfOrg(reqUser, orgPath)) throw new HttpError(403, 'forbidden', '需要该组织的管理员角色');
  return orgPath;
}

organizationsRoute.get('/:orgId/members', async (req, res) => {
  const user = req.user!;
  const orgId = req.params.orgId!;
  const orgPath = await getOrgPath(orgId);
  if (!orgPath) throw new HttpError(404, 'not_found', 'organization not found');
  // 直属成员或该组织的管理员可读
  const isMember = (await membershipsOf(user.userId)).some((m) => m.organizationId === orgId);
  if (!isMember && !isManagerOfOrg(user, orgPath)) throw new HttpError(404, 'not_found', 'organization not found');

  const members = await db
    .select({
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      isManager: organizationMembers.isManager,
      isUser: organizationMembers.isUser,
      joinedAt: organizationMembers.joinedAt,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(organizationMembers.userId, users.id))
    .where(eq(organizationMembers.organizationId, orgId));
  res.json({ items: members });
});

const AddMemberBody = z.object({
  username: z.string().min(1).max(50),
  isManager: z.boolean().default(false),
  isUser: z.boolean().default(true),
});

organizationsRoute.post('/:orgId/members', async (req, res) => {
  const user = req.user!;
  const orgId = req.params.orgId!;
  await requireOrgManager(orgId, user);
  const body = AddMemberBody.parse(req.body);
  const target = await findUserByUsername(body.username);
  if (!target) throw new HttpError(404, 'not_found', 'user not found');
  const existing = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, target.id)))
    .limit(1);
  if (existing.length > 0) throw new HttpError(409, 'already_member', '该用户已是组织成员');
  await db.insert(organizationMembers).values({
    organizationId: orgId,
    userId: target.id,
    isManager: body.isManager,
    isUser: body.isUser,
  });
  res.status(201).json({ ok: true });
});

const UpdateMemberBody = z.object({
  isManager: z.boolean().optional(),
  isUser: z.boolean().optional(),
});

organizationsRoute.patch('/:orgId/members/:userId', async (req, res) => {
  const user = req.user!;
  const { orgId, userId } = req.params as { orgId: string; userId: string };
  await requireOrgManager(orgId, user);
  const body = UpdateMemberBody.parse(req.body);
  const updated = await db
    .update(organizationMembers)
    .set({
      ...(body.isManager !== undefined ? { isManager: body.isManager } : {}),
      ...(body.isUser !== undefined ? { isUser: body.isUser } : {}),
    })
    .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, userId)))
    .returning({ id: organizationMembers.id });
  if (updated.length === 0) throw new HttpError(404, 'not_found', 'member not found');
  res.json({ ok: true });
});

organizationsRoute.delete('/:orgId/members/:userId', async (req, res) => {
  const user = req.user!;
  const { orgId, userId } = req.params as { orgId: string; userId: string };
  await requireOrgManager(orgId, user);
  if (userId === user.userId) throw new HttpError(409, 'cannot_remove_self', '不能移除自己');
  const rows = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, userId)));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'member not found');
  // 不能移除用户在所有组织中的最后一个成员资格（否则该账号无法登录）
  const total = await db.select({ c: count() }).from(organizationMembers).where(eq(organizationMembers.userId, userId));
  if (Number(total[0]?.c ?? 0) <= 1) {
    throw new HttpError(409, 'last_membership', '不能移除用户的最后一个组织成员资格');
  }
  await db.delete(organizationMembers).where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, userId)));
  res.json({ ok: true });
});
