import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groups, productLines, projects, projectVersions } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import {
  assertProductLineVisible,
  assertProjectVisible,
  visibleProductLineIds,
} from '../services/projectAccess.js';
import { isManagerOfOrg } from '../middleware/auth.js';
import { getOrgPath } from '../services/orgTree.js';
import type { AuthUser } from '../services/auth.service.js';
import { moveProductLineToOrg } from '../services/productLineMove.js';
import { attachProjectToProductLine, resolveProjectProductLineId } from '../services/projectRehome.js';

export const productLinesRoute = Router({ mergeParams: true });

/** Express 5 把路由参数类型放宽成 string | string[]，这里收敛成单个 string。 */
function param(req: { params: unknown }, key: string): string {
  const v = (req.params as Record<string, string | string[] | undefined>)[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  /** 归属组织；缺省为当前激活组织。成员管理界面按组织建线时显式传。 */
  organizationId: z.string().uuid().optional(),
});

const PatchBody = CreateBody.omit({ organizationId: true }).partial();

/**
 * 产品线写操作守卫：调用者须是该产品线**所属组织**（或其祖先）的管理员。
 * 不用全局 requireManager——那是「是不是某处管理员」的口径，会让 A 组织的管理员
 * 改到 B 组织下的线；而产品线随组织走，权限就该随组织走。
 */
async function requireLineManager(productLineId: string, user: AuthUser): Promise<string> {
  const { organizationId } = await assertProductLineVisible(productLineId, user);
  const orgPath = await getOrgPath(organizationId);
  if (!orgPath) throw new HttpError(404, 'not_found', 'product line not found');
  if (!isManagerOfOrg(user, orgPath)) {
    throw new HttpError(403, 'forbidden', '需要该产品线所属组织的管理员角色');
  }
  return organizationId;
}

/** 建线守卫：目标组织须存在，且调用者是该组织（或其祖先）的管理员。 */
async function requireTargetOrgManager(organizationId: string, user: AuthUser): Promise<void> {
  const orgPath = await getOrgPath(organizationId);
  if (!orgPath) throw new HttpError(404, 'not_found', 'organization not found');
  if (!isManagerOfOrg(user, orgPath)) {
    throw new HttpError(403, 'forbidden', '需要该组织的管理员角色');
  }
}

/**
 * 挂项目：项目本身须可见。不存在与不可见都报 404。
 * 跨组织不再拦——挂载即搬家（见 rehomeProjectToProductLine），项目会迁到产品线所属组织。
 */
async function assertProjectsAssignable(projectIds: string[], user: AuthUser): Promise<void> {
  for (const projectId of projectIds) {
    await assertProjectVisible(projectId, user);
  }
}

productLinesRoute.get('/', async (req, res) => {
  const ids = await visibleProductLineIds(req.user!);
  res.json(
    ids.length
      ? await db
          .select()
          .from(productLines)
          .where(inArray(productLines.id, ids))
          .orderBy(asc(productLines.createdAt))
      : [],
  );
});

productLinesRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const organizationId = body.organizationId ?? req.user!.orgId;
  await requireTargetOrgManager(organizationId, req.user!);
  const rows = await db
    .insert(productLines)
    .values({
      organizationId,
      name: body.name,
      description: body.description ?? null,
      createdByUserId: req.user!.userId,
    })
    .returning();
  res.status(201).json(rows[0]!);
});

productLinesRoute.get('/:id', async (req, res) => {
  const id = param(req, 'id');
  await assertProductLineVisible(id, req.user!);
  const row = (await db.select().from(productLines).where(eq(productLines.id, id)).limit(1))[0];
  if (!row) throw new HttpError(404, 'not_found', 'product line not found');
  const ps = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.productLineId, id))
    .orderBy(asc(projects.createdAt));
  res.json({ ...row, projects: ps });
});

productLinesRoute.patch('/:id', async (req, res) => {
  const id = param(req, 'id');
  await requireLineManager(id, req.user!);
  const body = PatchBody.parse(req.body);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) set.name = body.name;
  if (body.description !== undefined) set.description = body.description;
  const rows = await db
    .update(productLines)
    .set(set as Partial<typeof productLines.$inferInsert>)
    .where(eq(productLines.id, id))
    .returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'product line not found');
  res.json(rows[0]!);
});

/** 删产品线：线内仍有项目时拒绝（line_not_empty），不级联删项目/用例/计划/报告。 */
productLinesRoute.delete('/:id', async (req, res) => {
  const id = param(req, 'id');
  await requireLineManager(id, req.user!);
  const remaining = await db.select({ id: projects.id }).from(projects).where(eq(projects.productLineId, id)).limit(1);
  if (remaining.length > 0) {
    throw new HttpError(409, 'line_not_empty', 'product line still contains projects');
  }
  await db.delete(productLines).where(eq(productLines.id, id));
  res.json({ ok: true });
});

productLinesRoute.get('/:id/projects', async (req, res) => {
  const id = param(req, 'id');
  await assertProductLineVisible(id, req.user!);
  res.json(
    await db
      .select({ id: projects.id, name: projects.name, description: projects.description })
      .from(projects)
      .where(eq(projects.productLineId, id))
      .orderBy(asc(projects.createdAt)),
  );
});

/** 产品线下的全部分组（跨项目）：计划「添加用例」按分组筛选时需要跨项目取一次，不能只查计划所属项目。 */
productLinesRoute.get('/:id/groups', async (req, res) => {
  const id = param(req, 'id');
  await assertProductLineVisible(id, req.user!);
  const pids = (await db.select({ id: projects.id }).from(projects).where(eq(projects.productLineId, id))).map((p) => p.id);
  if (pids.length === 0) return res.json([]);
  const rows = await db
    .select({
      id: groups.id,
      projectId: groups.projectId,
      name: groups.name,
      createdAt: groups.createdAt,
      updatedAt: groups.updatedAt,
    })
    .from(groups)
    .where(inArray(groups.projectId, pids))
    .orderBy(asc(groups.createdAt));
  res.json(rows);
});

/** 产品线下的全部版本（跨项目）：同理，「跨版本」筛选要能看到兄弟项目的版本名。 */
productLinesRoute.get('/:id/versions', async (req, res) => {
  const id = param(req, 'id');
  await assertProductLineVisible(id, req.user!);
  const pids = (await db.select({ id: projects.id }).from(projects).where(eq(projects.productLineId, id))).map((p) => p.id);
  if (pids.length === 0) return res.json([]);
  res.json(
    await db
      .select()
      .from(projectVersions)
      .where(inArray(projectVersions.projectId, pids))
      .orderBy(asc(projectVersions.createdAt)),
  );
});

/**
 * 把项目挂进产品线。项目已无自己的组织列——归属只由 product_line_id 决定，
 * 从别的线移入即自动换组织（结构保证，无需同步代码），标签按同名迁到目标组织。
 * 一个项目至多属于一条产品线；已在本线的项目幂等跳过。
 */
productLinesRoute.post('/:id/projects', async (req, res) => {
  const id = param(req, 'id');
  await requireLineManager(id, req.user!);
  const body = z.object({ projectIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  await assertProjectsAssignable(body.projectIds, req.user!);
  let moved = 0;
  for (const projectId of body.projectIds) {
    if ((await resolveProjectProductLineId(projectId)) === id) continue;
    await attachProjectToProductLine(projectId, id);
    moved += 1;
  }
  res.json({ ok: true, count: body.projectIds.length, moved });
});

const MoveBody = z.object({ organizationId: z.string().uuid() });

/**
 * 移动产品线到另一个组织。线内全部项目跟着换组织，标签一并迁移。
 * 双闸门：源组织的管理员（线的归属权）+ 目标组织的管理员（把别人的家搬进自己家得有权限）。
 * 同名线冲突必须预检：product_lines 有 UNIQUE(organization_id, name)，漏出去就是裸 23505。
 */
productLinesRoute.post('/:id/move', async (req, res) => {
  const id = param(req, 'id');
  const sourceOrgId = await requireLineManager(id, req.user!);
  const body = MoveBody.parse(req.body);
  if (body.organizationId === sourceOrgId) throw new HttpError(409, 'same_org', 'target organization is the current one');
  await requireTargetOrgManager(body.organizationId, req.user!);

  const line = (await db.select({ name: productLines.name }).from(productLines).where(eq(productLines.id, id)).limit(1))[0];
  if (!line) throw new HttpError(404, 'not_found', 'product line not found');
  const clash = await db
    .select({ id: productLines.id })
    .from(productLines)
    .where(and(eq(productLines.organizationId, body.organizationId), eq(productLines.name, line.name)))
    .limit(1);
  if (clash.length > 0) {
    throw new HttpError(409, 'line_name_conflict', 'target organization already has a product line with this name');
  }

  const projectCount = await moveProductLineToOrg(id, sourceOrgId, body.organizationId);
  res.json({ ok: true, projectCount });
});