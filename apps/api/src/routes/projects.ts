import { Router } from 'express';
import { z } from 'zod';
import { eq, asc, desc, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, groups, productLines, testCases, reports, requirements, projectVersions, testEnvironments } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProductLineVisible, assertProjectVisible } from '../services/projectAccess.js';
import { visibleOrgIdsFor } from '../services/orgTree.js';
import { isManagerOfOrg, requireManager } from '../middleware/auth.js';
import { getOrgPath } from '../services/orgTree.js';
import { verifyRepoAccess } from '../services/gitProvider.js';
import { createGroup } from '../services/cases.service.js';
import { attachCreators, attachCreator } from '../lib/creator.js';

export const projectsRoute = Router({ mergeParams: true });

const ProviderEnum = z.enum(['github', 'gitee', 'gitlab']);

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  /** Required: the project belongs to a product line; the project's org is derived from it. */
  productLineId: z.string().uuid(),
  description: z.string().optional(),
  repoUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  defaultBranch: z.string().max(200).optional(),
  provider: ProviderEnum.optional(),
  gitlabUrlOverride: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  patOverride: z.string().optional(),
});

/** PATCH doesn't include productLineId: changing lines is a separate action (POST /product-lines/:id/projects, attaching equals moving house). */
const PatchBody = CreateBody.omit({ productLineId: true }).partial();

/** Mask PAT: every return path must go through this function to avoid leakage. */
function maskProject<T extends { patOverride?: string | null; provider?: string | null }>(p: T): Omit<T, 'patOverride'> & { hasPat: boolean } {
  const hasPat = !!p.patOverride;
  const { patOverride, ...rest } = p as T & { patOverride?: string | null };
  void patOverride;
  return { ...(rest as Omit<T, 'patOverride'>), hasPat };
}

async function caseCountsByGroup(versionIds?: string[]): Promise<Map<string, number>> {
  const base = db.select({ groupId: testCases.groupId, count: sql<number>`count(*)` }).from(testCases);
  // Version narrowing: group counts must use the same criterion as the case list, otherwise the left numbers and the right table disagree
  const rows = versionIds && versionIds.length > 0
    ? await base.where(inArray(testCases.versionId, versionIds)).groupBy(testCases.groupId)
    : await base.groupBy(testCases.groupId);
  return new Map(rows.map((r) => [r.groupId, Number(r.count)]));
}

/** Project → product-line name mapping: projectLineId is already a projects column; this only adds the name so the frontend can show ownership. */
async function productLineNames(): Promise<Map<string, string>> {
  const rows = await db.select({ id: productLines.id, name: productLines.name }).from(productLines);
  return new Map(rows.map((r) => [r.id, r.name]));
}

projectsRoute.get('/', async (req, res) => {
  // Only list projects under orgs visible to the user (a project's org = its product line's org)
  const visibleOrgs = await visibleOrgIdsFor(req.user!);
  const ps = visibleOrgs.size
    ? await db
        .select({ project: projects, organizationId: productLines.organizationId })
        .from(projects)
        .innerJoin(productLines, eq(productLines.id, projects.productLineId))
        .where(inArray(productLines.organizationId, [...visibleOrgs]))
        .orderBy(asc(projects.createdAt))
    : [];
  const gs = await db.select().from(groups);
  const counts = await caseCountsByGroup();
  const byProject = new Map<string, number>();
  for (const g of gs) {
    byProject.set(g.projectId, (byProject.get(g.projectId) ?? 0) + (counts.get(g.id) ?? 0));
  }
  const vs = await db
    .select({ projectId: projectVersions.projectId, count: sql<number>`count(*)` })
    .from(projectVersions)
    .groupBy(projectVersions.projectId);
  const es = await db
    .select({ projectId: testEnvironments.projectId, count: sql<number>`count(*)` })
    .from(testEnvironments)
    .groupBy(testEnvironments.projectId);
  const vByProject = new Map(vs.map((r) => [r.projectId, Number(r.count)]));
  const eByProject = new Map(es.map((r) => [r.projectId, Number(r.count)]));
  const lineNames = await productLineNames();
  res.json(
    await attachCreators(
      ps.map(({ project: p, organizationId }) => ({
        ...maskProject(p),
        // Org derived from the product line; the response still carries organizationId, zero changes to frontend types.
        organizationId,
        caseCount: byProject.get(p.id) ?? 0,
        versionCount: vByProject.get(p.id) ?? 0,
        environmentCount: eByProject.get(p.id) ?? 0,
        productLineName: lineNames.get(p.productLineId) ?? null,
      })),
    ),
  );
});

projectsRoute.post('/', requireManager, async (req, res) => {
  const body = CreateBody.parse(req.body);
  // A project's org is derived from its product line: the line must be visible, and the caller must be a manager of the line's owning org.
  // projects no longer has an organization_id column; ownership is decided solely by product_line_id.
  const line = await assertProductLineVisible(body.productLineId, req.user!);
  const lineOrgPath = await getOrgPath(line.organizationId);
  if (!lineOrgPath) throw new HttpError(404, 'not_found', 'product line organization not found');
  if (!isManagerOfOrg(req.user!, lineOrgPath)) throw new HttpError(403, 'forbidden', '无权在该产品线所属组织下建项目');
  const rows = await db
    .insert(projects)
    .values({
      name: body.name,
      description: body.description,
      repoUrl: body.repoUrl,
      defaultBranch: body.defaultBranch?.trim() || 'main',
      provider: body.provider ?? 'github',
      gitlabUrlOverride: body.gitlabUrlOverride,
      patOverride: body.patOverride,
      productLineId: body.productLineId,
      createdByUserId: req.user!.userId,
    })
    .returning();
  res.status(201).json({ ...maskProject(rows[0]!), organizationId: line.organizationId });
});

projectsRoute.get('/:id', async (req, res) => {
  const projectId = String(req.params.id);
  await assertProjectVisible(projectId, req.user!);
  const rows = await db.select().from(projects).where(eq(projects.id, projectId));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  res.json(await attachCreator(maskProject(rows[0]!)));
});

projectsRoute.patch('/:id', requireManager, async (req, res) => {
  const projectId = String(req.params.id);
  await assertProjectVisible(projectId, req.user!);
  const body = PatchBody.parse(req.body);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) set.name = body.name;
  if (body.description !== undefined) set.description = body.description;
  if (body.repoUrl !== undefined) set.repoUrl = body.repoUrl;
  if (body.defaultBranch !== undefined) set.defaultBranch = body.defaultBranch?.trim() || 'main';
  if (body.provider !== undefined) set.provider = body.provider;
  if (body.gitlabUrlOverride !== undefined) set.gitlabUrlOverride = body.gitlabUrlOverride;
  if (body.patOverride !== undefined) set.patOverride = body.patOverride;
  const rows = await db.update(projects).set(set as Partial<typeof projects.$inferInsert>).where(eq(projects.id, projectId)).returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  res.json(maskProject(rows[0]!));
});

projectsRoute.delete('/:id', requireManager, async (req, res) => {
  const projectId = String(req.params.id);
  await assertProjectVisible(projectId, req.user!);
  const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
  if (gs.length > 0) {
    const counts = await caseCountsByGroup();
    const total = gs.reduce((sum, g) => sum + (counts.get(g.id) ?? 0), 0);
    if (total > 0) throw new HttpError(409, 'not_empty', 'project has cases');
  }
  const deleted = await db.delete(projects).where(eq(projects.id, projectId)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  res.json({ ok: true });
});

projectsRoute.get('/:id/groups', async (req, res) => {
  const projectId = String(req.params.id);
  await assertProjectVisible(projectId, req.user!);
  // versionIds as comma-separated or repeated params both work, same parsing criterion as GET /cases.
  // The frontend passes selected in-line versions when switching the "product-line case library" scope; without it, the whole line counts.
  const rawVersionIds = (req.query as Record<string, string | string[] | undefined>).versionIds;
  const versionIds = (Array.isArray(rawVersionIds) ? rawVersionIds : rawVersionIds != null ? [rawVersionIds] : [])
    .flatMap((v) => v.split(','))
    .filter((v) => v.length > 0);
  const gs = await db.select().from(groups).where(eq(groups.projectId, projectId)).orderBy(asc(groups.createdAt));
  const counts = await caseCountsByGroup(versionIds);
  res.json(gs.map((g) => ({ ...g, caseCount: counts.get(g.id) ?? 0 })));
});

projectsRoute.post('/:id/groups', async (req, res) => {
  const projectId = String(req.params.id);
  await assertProjectVisible(projectId, req.user!);
  // Take only name: group creation doesn't involve those project-creation fields (CreateBody now has a required productLineId).
  const body = z.object({ name: z.string().min(1).max(200) }).parse(req.body);
  res.json(await createGroup(projectId, { name: body.name }));
});

/** POST /verify-repo — repo metadata reachability + branch existence. Managers only. */
projectsRoute.post('/verify-repo', requireManager, async (req, res) => {
  const repoUrl = z.string().url().parse(req.body.repoUrl);
  const branch = req.body.branch as string | undefined;
  const provider = (req.body.provider as 'github' | 'gitee' | 'gitlab' | undefined) ?? 'github';
  const pat = req.body.patOverride as string | undefined;
  // Empty form PAT with a projectId (editing an existing project) → fall back to the stored PAT in the DB.
  // GET never returns the PAT (maskProject); without the fallback, existing projects clicking "test connection"
  // would always probe a private repo without credentials and falsely report "authentication failed"
  // (2026-10-24 prod228 base-all; exposed only once GitLab went through real ls-remote since 9f99a39).
  let effectivePat = pat;
  if (!effectivePat && req.body.projectId) {
    const projectId = z.string().uuid().parse(req.body.projectId);
    await assertProjectVisible(projectId, req.user!);
    const row = (await db.select({ patOverride: projects.patOverride }).from(projects).where(eq(projects.id, projectId)))[0];
    effectivePat = row?.patOverride ?? undefined;
  }
  try {
    const result = await verifyRepoAccess({ repoUrl, provider, pat: effectivePat, branch });
    res.json(result);
  } catch (err) {
    res.status(400).json({ valid: false, error: (err as Error).message });
  }
});

projectsRoute.get('/:id/stats', async (req, res) => {
  const projectId = String(req.params.id);
  await assertProjectVisible(projectId, req.user!);
  const p = await db.select().from(projects).where(eq(projects.id, projectId));
  if (p.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
  const gids = gs.map((g) => g.id);
  const caseRows = gids.length
    ? await db.select().from(testCases).where(inArray(testCases.groupId, gids))
    : [];
  const caseIds = caseRows.map((c) => c.id);
  const reportRows = caseIds.length
    ? await db.select().from(reports).where(inArray(reports.caseId, caseIds)).orderBy(desc(reports.createdAt))
    : [];
  const counts = new Map<string, number>();
  for (const c of caseRows) counts.set(c.groupId, (counts.get(c.groupId) ?? 0) + 1);
  const reqCount = (
    await db.select({ count: sql<number>`count(*)` }).from(requirements).where(eq(requirements.projectId, projectId))
  ).map((r) => Number(r.count))[0]!;
  res.json({
    requirements: reqCount,
    cases: caseRows.length,
    passes: reportRows.filter((r) => r.status === 'passed').length,
    failures: reportRows.filter((r) => r.status === 'failed').length,
    groups: gs.map((g) => ({ id: g.id, name: g.name, caseCount: counts.get(g.id) ?? 0 })),
    recentRuns: reportRows.slice(0, 6).map((r) => ({ id: r.id, caseId: r.caseId, status: r.status, createdAt: r.createdAt })),
  });
});
