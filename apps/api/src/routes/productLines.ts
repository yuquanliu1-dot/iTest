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
import { rehomeProjectToProductLine, resolveProjectProductLineId } from '../services/projectRehome.js';

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

/** 删产品线：线内仍有项目时拒绝（line_not_empty），不级联删项目/用例/计划/报告。 */
productLinesRoute.delete('/:id', requireManager, async (req, res) => {
  const id = param(req, 'id');
  await assertProductLineVisible(id, req.user!);
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
 * 把项目挂进产品线（挂载即搬家：项目迁到该产品线所属组织，标签一并迁移）。
 * 从别的产品线移入会自动改归属——一个项目至多属于一条产品线；已在本线的项目幂等跳过。
 */
productLinesRoute.post('/:id/projects', requireManager, async (req, res) => {
  const id = param(req, 'id');
  const { organizationId } = await assertProductLineVisible(id, req.user!);
  const body = z.object({ projectIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  await assertProjectsAssignable(body.projectIds, req.user!);
  let moved = 0;
  for (const projectId of body.projectIds) {
    if ((await resolveProjectProductLineId(projectId)) === id) continue;
    await rehomeProjectToProductLine(projectId, id, organizationId);
    moved += 1;
  }
  res.json({ ok: true, count: body.projectIds.length, moved });
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