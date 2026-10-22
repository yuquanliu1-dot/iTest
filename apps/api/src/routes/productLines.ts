import { Router } from 'express';
import { z } from 'zod';
import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groups, productLines, projects, projectVersions } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import {
  assertProductLineVisible,
  assertProjectVisible,
  visibleProductLineIds,
} from '../services/projectAccess.js';
import { requireManager } from '../middleware/auth.js';
import type { AuthUser } from '../services/auth.service.js';

export const productLinesRoute = Router({ mergeParams: true });

/** Express 5 把路由参数类型放宽成 string | string[]，这里收敛成单个 string。 */
function param(req: { params: unknown }, key: string): string {
  const v = (req.params as Record<string, string | string[] | undefined>)[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const PatchBody = CreateBody.partial();

/**
 * 挂项目：项目本身须可见，且须与产品线同组织——跨组织挂载会让「同产品线共享用例」
 * 跨出租户边界，等于绕过组织可见性。逐条校验，不存在与不可见都报 404。
 */
async function assertProjectsAssignable(projectIds: string[], user: AuthUser, organizationId: string): Promise<void> {
  for (const projectId of projectIds) {
    await assertProjectVisible(projectId, user);
    const row = (await db
      .select({ organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1))[0];
    if (row && row.organizationId !== organizationId) {
      throw new HttpError(400, 'cross_project', 'project does not belong to the product line organization');
    }
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

productLinesRoute.post('/', requireManager, async (req, res) => {
  const body = CreateBody.parse(req.body);
  const rows = await db
    .insert(productLines)
    .values({
      organizationId: req.user!.orgId,
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

productLinesRoute.patch('/:id', requireManager, async (req, res) => {
  const id = param(req, 'id');
  await assertProductLineVisible(id, req.user!);
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

/** 删产品线；projects.product_line_id 是 on delete set null，项目保留并退回「未归线」。 */
productLinesRoute.delete('/:id', requireManager, async (req, res) => {
  const id = param(req, 'id');
  await assertProductLineVisible(id, req.user!);
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

/** 把项目挂进产品线（从别的产品线移入会自动改归属：一个项目至多属于一条产品线）。 */
productLinesRoute.post('/:id/projects', requireManager, async (req, res) => {
  const id = param(req, 'id');
  const { organizationId } = await assertProductLineVisible(id, req.user!);
  const body = z.object({ projectIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  await assertProjectsAssignable(body.projectIds, req.user!, organizationId);
  for (const projectId of body.projectIds) {
    await db.update(projects).set({ productLineId: id, updatedAt: new Date() }).where(eq(projects.id, projectId));
  }
  res.json({ ok: true, count: body.projectIds.length });
});

/** 解绑单个项目：product_line_id 置空，退回「未归线」（计划重新严格限同项目用例）。 */
productLinesRoute.delete('/:id/projects/:projectId', requireManager, async (req, res) => {
  await assertProductLineVisible(param(req, 'id'), req.user!);
  const projectId = param(req, 'projectId');
  await assertProjectVisible(projectId, req.user!);
  await db
    .update(projects)
    .set({ productLineId: null, updatedAt: new Date() })
    .where(eq(projects.id, projectId));
  res.json({ ok: true });
});