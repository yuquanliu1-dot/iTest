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
  /** 必填：项目归属产品线，项目的组织由产品线推导。 */
  productLineId: z.string().uuid(),
  description: z.string().optional(),
  repoUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  defaultBranch: z.string().max(200).optional(),
  provider: ProviderEnum.optional(),
  gitlabUrlOverride: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  patOverride: z.string().optional(),
});

/** PATCH 不含 productLineId：改线是独立动作（走 POST /product-lines/:id/projects，挂载即搬家）。 */
const PatchBody = CreateBody.omit({ productLineId: true }).partial();

/** mask PAT：所有返回路径必须走此函数，避免泄露。 */
function maskProject<T extends { patOverride?: string | null; provider?: string | null }>(p: T): Omit<T, 'patOverride'> & { hasPat: boolean } {
  const hasPat = !!p.patOverride;
  const { patOverride, ...rest } = p as T & { patOverride?: string | null };
  void patOverride;
  return { ...(rest as Omit<T, 'patOverride'>), hasPat };
}

async function caseCountsByGroup(): Promise<Map<string, number>> {
  const rows = await db
    .select({ groupId: testCases.groupId, count: sql<number>`count(*)` })
    .from(testCases)
    .groupBy(testCases.groupId);
  return new Map(rows.map((r) => [r.groupId, Number(r.count)]));
}

/** 项目 → 产品线名映射：projectLineId 已是 projects 自带列，这里只补名字供前端展示归属。 */
async function productLineNames(): Promise<Map<string, string>> {
  const rows = await db.select({ id: productLines.id, name: productLines.name }).from(productLines);
  return new Map(rows.map((r) => [r.id, r.name]));
}

projectsRoute.get('/', async (req, res) => {
  // 只列出用户可见组织下的项目（项目组织 = 其产品线的组织）
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
        // 组织由产品线推导；响应仍带 organizationId，前端类型零改动。
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
  // 项目的组织由产品线推导：产品线须可见，且调用者须是该产品线所属组织的管理员。
  // projects 已无 organization_id 列，归属只由 product_line_id 决定。
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
  const gs = await db.select().from(groups).where(eq(groups.projectId, projectId)).orderBy(asc(groups.createdAt));
  const counts = await caseCountsByGroup();
  res.json(gs.map((g) => ({ ...g, caseCount: counts.get(g.id) ?? 0 })));
});

projectsRoute.post('/:id/groups', async (req, res) => {
  const projectId = String(req.params.id);
  await assertProjectVisible(projectId, req.user!);
  // 只取 name：分组创建不涉及项目创建的那些字段（CreateBody 现含必填 productLineId）。
  const body = z.object({ name: z.string().min(1).max(200) }).parse(req.body);
  res.json(await createGroup(projectId, { name: body.name }));
});

/** POST /verify-repo — 仓库元数据可达性 + 分支存在性。仅 manager。 */
projectsRoute.post('/verify-repo', requireManager, async (req, res) => {
  const repoUrl = z.string().url().parse(req.body.repoUrl);
  const branch = req.body.branch as string | undefined;
  const provider = (req.body.provider as 'github' | 'gitee' | 'gitlab' | undefined) ?? 'github';
  const pat = req.body.patOverride as string | undefined;
  try {
    const result = await verifyRepoAccess({ repoUrl, provider, pat, branch });
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
