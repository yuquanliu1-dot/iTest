import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { and, count, eq, inArray, or, ilike } from 'drizzle-orm';
import { db } from '../db/client.js';
import { organizationMembers, organizations, productLines, projects, users, projectAssignments as projectAssignmentsTable } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { isManagerOfOrg, requireAuth, requireManager } from '../middleware/auth.js';
import { getOrgPath, invalidateMemberships, invalidateOrgTree, membershipsOf, visibleOrgIdsFor } from '../services/orgTree.js';
import { findUserByUsername } from '../services/auth.service.js';
import { subtreeOrgIds } from '../services/orgTree.js';
import { isPathInSubtree } from '../services/org-path.js';

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
  // 新建子组织影响所有 path/subtree 视图 + 子树成员的可见列表
  await invalidateOrgTree();
  res.status(201).json(inserted[0]);
});

/** 组织管理守卫：组织存在且调用者是其（或其祖先）管理员；否则 404/403。 */
async function requireOrgManager(orgId: string, reqUser: NonNullable<Express.Request['user']>): Promise<string> {
  const orgPath = await getOrgPath(orgId);
  if (!orgPath) throw new HttpError(404, 'not_found', 'organization not found');
  if (!isManagerOfOrg(reqUser, orgPath)) throw new HttpError(403, 'forbidden', '需要该组织的管理员角色');
  return orgPath;
}

/** GET /managed-subtree：祖先链 manager 视角下的全部组织（含直接 membership），节点带 memberCount / projectCount。
 * 必须在 GET /:orgId 之前注册以便静态段优先匹配。 */
organizationsRoute.get('/managed-subtree', requireManager, async (_req, res) => {
  try {
    const visible = await visibleOrgIdsFor(_req.user!);
    if (visible.size === 0) {
      res.json([]);
      return;
    }
    const orgIds = [...visible];
    const [orgRows, memberCounts, projectCounts] = await Promise.all([
      db.select().from(organizations).where(inArray(organizations.id, orgIds)).orderBy(organizations.path),
      db
        .select({ organizationId: organizationMembers.organizationId, count: count() })
        .from(organizationMembers)
        .where(inArray(organizationMembers.organizationId, orgIds))
        .groupBy(organizationMembers.organizationId),
      db
        .select({ organizationId: projects.organizationId, count: count() })
        .from(projects)
        .where(inArray(projects.organizationId, orgIds))
        .groupBy(projects.organizationId),
    ]);
    const memberMap = new Map(memberCounts.map((c) => [c.organizationId, Number(c.count)]));
    const projectMap = new Map(projectCounts.map((c) => [c.organizationId, Number(c.count)]));
    res.json(
      orgRows.map((o) => ({
        id: o.id,
        name: o.name,
        parentId: o.parentId,
        path: o.path,
        description: o.description,
        memberCount: memberMap.get(o.id) ?? 0,
        projectCount: projectMap.get(o.id) ?? 0,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /lookup-user?username=xxx：按 username 查用户（仅 manager）。 */
organizationsRoute.get('/lookup-user', requireManager, async (req, res) => {
  const username = req.query.username as string;
  if (!username) {
    res.status(400).json({ error: 'username is required' });
    return;
  }
  const user = await findUserByUsername(username);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(user);
});

/** GET /:orgId — 组织详情。直属成员或管理员可读。 */
organizationsRoute.get('/:orgId', async (req, res) => {
  const user = req.user!;
  const orgId = req.params.orgId!;
  const orgPath = await getOrgPath(orgId);
  if (!orgPath) throw new HttpError(404, 'not_found', 'organization not found');
  const isMember = (await membershipsOf(user.userId)).some((m) => m.organizationId === orgId);
  if (!isMember && !isManagerOfOrg(user, orgPath)) throw new HttpError(404, 'not_found', 'organization not found');
  const row = await db
    .select({ id: organizations.id, name: organizations.name, parentId: organizations.parentId, path: organizations.path, description: organizations.description, createdAt: organizations.createdAt, updatedAt: organizations.updatedAt })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row[0]) throw new HttpError(404, 'not_found', 'organization not found');
  res.json(row[0]);
});

const PatchOrgBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
});

/** PATCH /:orgId — 编辑组织（仅 manager）。path/parentId 不可改（避免搬成环）。 */
organizationsRoute.patch('/:orgId', async (req, res) => {
  const user = req.user!;
  const orgId = req.params.orgId!;
  await requireOrgManager(orgId, user);
  const body = PatchOrgBody.parse(req.body);
  const set: Partial<typeof organizations.$inferInsert> = { updatedAt: new Date() };
  if (body.name !== undefined) set.name = body.name;
  if (body.description !== undefined) set.description = body.description;
  const updated = await db.update(organizations).set(set).where(eq(organizations.id, orgId)).returning();
  if (updated.length === 0) throw new HttpError(404, 'not_found', 'organization not found');
  res.json(updated[0]);
});

/** DELETE /:orgId — 删除组织。仅 manager；非空（存在子组织或项目）拒删。 */
organizationsRoute.delete('/:orgId', async (req, res) => {
  const user = req.user!;
  const orgId = req.params.orgId!;
  await requireOrgManager(orgId, user);
  const childCount = await db
    .select({ c: count() })
    .from(organizations)
    .where(eq(organizations.parentId, orgId));
  if (Number(childCount[0]?.c ?? 0) > 0) throw new HttpError(409, 'not_empty', 'organization has child organizations');
  const projectCount = await db
    .select({ c: count() })
    .from(projects)
    .where(eq(projects.organizationId, orgId));
  if (Number(projectCount[0]?.c ?? 0) > 0) throw new HttpError(409, 'not_empty', 'organization has projects');
  const deleted = await db.delete(organizations).where(eq(organizations.id, orgId)).returning({ id: organizations.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'organization not found');
  res.json({ ok: true });
});

/** GET /:orgId/projects?q=&includeSubtree=&page=&limit= — 组织项目分页 + 已分配人数。 */
organizationsRoute.get('/:orgId/projects', async (req, res) => {
  const user = req.user!;
  const orgId = req.params.orgId!;
  const orgPath = await getOrgPath(orgId);
  if (!orgPath) throw new HttpError(404, 'not_found', 'organization not found');
  const isMember = (await membershipsOf(user.userId)).some((m) => m.organizationId === orgId);
  if (!isMember && !isManagerOfOrg(user, orgPath)) throw new HttpError(404, 'not_found', 'organization not found');

  const includeSubtree = req.query.includeSubtree === 'true';
  const q = (req.query.q as string | undefined)?.trim();
  const page = Math.min(parseInt(req.query.page as string) || 1, 1_000_000);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const orgIds = includeSubtree ? await subtreeOrgIds(orgPath) : [orgId];

  if (orgIds.length === 0) {
    res.json({ items: [], total: 0, page, limit });
    return;
  }
  const qPattern = q ? `%${q}%` : null;
  const filter = qPattern
    ? and(inArray(projects.organizationId, orgIds), ilike(projects.name, qPattern))!
    : inArray(projects.organizationId, orgIds);

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        organizationId: projects.organizationId,
        repoUrl: projects.repoUrl,
      })
      .from(projects)
      .where(filter)
      .orderBy(projects.name)
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: count() }).from(projects).where(filter),
  ]);
  // 单查 assignment 计数（按当前页 id 集合）
  const pageIds = rows.map((r) => r.id);
  const assignmentCounts = pageIds.length
    ? await db
        .select({ projectId: projectAssignmentsTable.projectId, count: count() })
        .from(projectAssignmentsTable)
        .where(inArray(projectAssignmentsTable.projectId, pageIds))
        .groupBy(projectAssignmentsTable.projectId)
    : [];
  const countByProject = new Map(assignmentCounts.map((c) => [c.projectId, Number(c.count)]));
  res.json({
    items: rows.map((r) => ({ ...r, assignedCount: countByProject.get(r.id) ?? 0 })),
    total: Number(totalRows[0]?.count ?? 0),
    page,
    limit,
  });
});

/**
 * GET /:orgId/product-lines?q=&includeSubtree=&page=&limit= — 组织下的产品线分页 + 线内项目数。
 *
 * 成员管理界面里产品线完全替代项目（项目不再直接挂组织），所以组织视图要给的是「这个组织下
 * 有哪些产品线」，而不是「这个组织下有哪些项目」。项目数取线内项目数，供列表直接展示归属规模。
 */
organizationsRoute.get('/:orgId/product-lines', async (req, res) => {
  const user = req.user!;
  const orgId = req.params.orgId!;
  const orgPath = await getOrgPath(orgId);
  if (!orgPath) throw new HttpError(404, 'not_found', 'organization not found');
  const isMember = (await membershipsOf(user.userId)).some((m) => m.organizationId === orgId);
  if (!isMember && !isManagerOfOrg(user, orgPath)) throw new HttpError(404, 'not_found', 'organization not found');

  const includeSubtree = req.query.includeSubtree === 'true';
  const q = (req.query.q as string | undefined)?.trim();
  const page = Math.min(parseInt(req.query.page as string) || 1, 1_000_000);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const orgIds = includeSubtree ? await subtreeOrgIds(orgPath) : [orgId];

  if (orgIds.length === 0) {
    res.json({ items: [], total: 0, page, limit });
    return;
  }
  const qPattern = q ? `%${q}%` : null;
  const filter = qPattern
    ? and(inArray(productLines.organizationId, orgIds), ilike(productLines.name, qPattern))!
    : inArray(productLines.organizationId, orgIds);

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: productLines.id,
        name: productLines.name,
        description: productLines.description,
        organizationId: productLines.organizationId,
      })
      .from(productLines)
      .where(filter)
      .orderBy(productLines.name)
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: count() }).from(productLines).where(filter),
  ]);
  // 线内项目数：按当前页的线 id 集合单查，避免 N+1。
  const pageIds = rows.map((r) => r.id);
  const projectCounts = pageIds.length
    ? await db
        .select({ productLineId: projects.productLineId, count: count() })
        .from(projects)
        .where(inArray(projects.productLineId, pageIds))
        .groupBy(projects.productLineId)
    : [];
  const countByLine = new Map(projectCounts.map((c) => [c.productLineId, Number(c.count)]));
  res.json({
    items: rows.map((r) => ({ ...r, projectCount: countByLine.get(r.id) ?? 0 })),
    total: Number(totalRows[0]?.count ?? 0),
    page,
    limit,
  });
});

/** 列表版的成员查询：直接成员 ∨ 祖先链 manager；带分页 + 模糊搜索 username/displayName。 */
organizationsRoute.get('/:orgId/members', async (req, res) => {
  const user = req.user!;
  const orgId = req.params.orgId!;
  const orgPath = await getOrgPath(orgId);
  if (!orgPath) throw new HttpError(404, 'not_found', 'organization not found');
  // 直属成员或该组织的管理员可读
  const isMember = (await membershipsOf(user.userId)).some((m) => m.organizationId === orgId);
  if (!isMember && !isManagerOfOrg(user, orgPath)) throw new HttpError(404, 'not_found', 'organization not found');

  const includeSubtree = req.query.includeSubtree === 'true';
  const q = (req.query.q as string | undefined)?.trim();
  const page = Math.min(parseInt(req.query.page as string) || 1, 1_000_000);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const orgIds = includeSubtree ? await subtreeOrgIds(orgPath) : [orgId];

  if (orgIds.length === 0) {
    res.json({ items: [], total: 0, page, limit });
    return;
  }
  const orgFilter = inArray(organizationMembers.organizationId, orgIds);
  const userPattern = q ? `%${q}%` : null;
  const filter = userPattern
    ? and(orgFilter, or(ilike(users.username, userPattern), ilike(users.displayName, userPattern)))!
    : orgFilter;

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: users.id,
        organizationId: organizationMembers.organizationId,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        isManager: organizationMembers.isManager,
        isUser: organizationMembers.isUser,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(filter)
      .orderBy(users.username)
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ count: count() })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(filter),
  ]);
  // 带上组织名（子树口径下同一个人会在多个组织各出一条 membership）
  const orgNameRows = await db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, orgIds));
  const nameByOrg = new Map(orgNameRows.map((o) => [o.id, o.name]));
  const items = rows.map((m) => ({
    id: m.id,
    userId: m.id,
    organizationId: m.organizationId,
    organizationName: nameByOrg.get(m.organizationId) ?? null,
    username: m.username,
    displayName: m.displayName,
    email: m.email,
    isManager: m.isManager,
    isUser: m.isUser,
    joinedAt: m.joinedAt,
  }));
  res.json({ items, total: Number(totalRows[0]?.count ?? 0), page, limit });
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
  // 目标用户的可见组织列表 + 成员身份缓存失效
  await invalidateMemberships(target.id);
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
  await invalidateMemberships(userId);
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
  await invalidateMemberships(userId);
  res.json({ ok: true });
});