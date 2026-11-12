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

/** Express 5 loosens route param types to string | string[]; this narrows to a single string. */
function param(req: { params: unknown }, key: string): string {
  const v = (req.params as Record<string, string | string[] | undefined>)[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  /** Owning org; defaults to the current active org. Passed explicitly when the member management UI creates lines per org. */
  organizationId: z.string().uuid().optional(),
});

const PatchBody = CreateBody.omit({ organizationId: true }).partial();

/**
 * Product-line write guard: the caller must be a manager of the product line's **owning org** (or an ancestor).
 * Not the global requireManager — that answers "is a manager somewhere", which would let an org-A manager
 * modify lines under org B; product lines follow their org, so permissions must follow the org too.
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

/** Line creation guard: the target org must exist and the caller must be a manager of that org (or an ancestor). */
async function requireTargetOrgManager(organizationId: string, user: AuthUser): Promise<void> {
  const orgPath = await getOrgPath(organizationId);
  if (!orgPath) throw new HttpError(404, 'not_found', 'organization not found');
  if (!isManagerOfOrg(user, orgPath)) {
    throw new HttpError(403, 'forbidden', '需要该组织的管理员角色');
  }
}

/**
 * Attach projects: the projects themselves must be visible. Missing and invisible both 404.
 * Cross-org is no longer blocked — attaching equals moving house (see rehomeProjectToProductLine); the project migrates to the product line's org.
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

/** Delete product line: refuses while projects remain in the line (line_not_empty); does not cascade-delete projects/cases/plans/reports. */
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

/** All groups under the product line (cross-project): the plan "add case" group filter needs a cross-project fetch once, not just the plan's own project. */
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

/** All versions under the product line (cross-project): same idea — the "cross-version" filter must see sibling projects' version names. */
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
 * Attach a project into the product line. Projects no longer have their own org column — ownership is decided
 * solely by product_line_id, so moving in from another line automatically switches the org (guaranteed by
 * structure, no sync code needed), and tags migrate to the target org by same name.
 * A project belongs to at most one product line; projects already in this line are idempotently skipped.
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
 * Move a product line to another org. All projects in the line switch orgs along with it, tags migrate too.
 * Double gate: a manager of the source org (ownership of the line) + a manager of the target org (moving someone else's home into yours requires the right).
 * Same-name line conflicts must be pre-checked: product_lines has UNIQUE(organization_id, name); missing it leaks a bare 23505.
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