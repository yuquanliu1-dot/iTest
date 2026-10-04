import { Router } from 'express';
import { z } from 'zod';
import { eq, sql, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, projectVersions, testCases, executionPlans } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertEnvironmentVisible, assertProjectVisible, assertVersionVisible } from '../services/projectAccess.js';
import { listRefs, type GitProviderName } from '../services/gitProvider.js';
import { requireManager } from '../middleware/auth.js';

export const projectVersionsRoute = Router({ mergeParams: true });

const RefKindEnum = z.enum(['branch', 'tag']);

const CreateBody = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  ref: z.string().max(200).optional(),
  refKind: RefKindEnum.optional(),
});

const PatchBody = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  ref: z.string().max(200).nullable().optional(),
  refKind: RefKindEnum.nullable().optional(),
  environmentId: z.string().uuid().nullable().optional(),
});

projectVersionsRoute.get('/projects/:projectId/versions', async (req, res) => {
  const pid = String(req.params.projectId);
  await assertProjectVisible(pid, req.user!);
  const rows = await db.select().from(projectVersions).where(eq(projectVersions.projectId, pid)).orderBy(projectVersions.createdAt);
  const counts = await db.execute(sql`
    SELECT v.id,
      (SELECT count(*) FROM test_cases c WHERE c.version_id = v.id)          AS case_count,
      (SELECT count(*) FROM execution_plans p WHERE p.version_id = v.id)     AS plan_count,
      (SELECT e.name FROM test_environments e WHERE e.id = v.environment_id) AS environment_name
    FROM project_versions v
    WHERE v.project_id = ${pid}
  `);
  const byId = new Map<string, { case_count: number; plan_count: number; environment_name: string | null }>();
  for (const r of counts.rows as Array<{ id: string; case_count: string; plan_count: string; environment_name: string | null }>) {
    byId.set(r.id, {
      case_count: Number(r.case_count),
      plan_count: Number(r.plan_count),
      environment_name: r.environment_name,
    });
  }
  res.json(rows.map((v) => ({
    ...v,
    caseCount: byId.get(v.id)?.case_count ?? 0,
    planCount: byId.get(v.id)?.plan_count ?? 0,
    environmentName: byId.get(v.id)?.environment_name ?? null,
  })));
});

projectVersionsRoute.post('/projects/:projectId/versions', async (req, res) => {
  const pid = String(req.params.projectId);
  await assertProjectVisible(pid, req.user!);
  const body = CreateBody.parse(req.body);
  const dup = await db.select({ id: projectVersions.id }).from(projectVersions)
    .where(and(eq(projectVersions.projectId, pid), eq(projectVersions.name, body.name))).limit(1);
  if (dup.length > 0) throw new HttpError(409, 'version_name_taken', `version name "${body.name}" already exists in this project`);
  const rows = await db.insert(projectVersions).values({
    projectId: pid,
    name: body.name,
    description: body.description ?? null,
    ref: body.ref ?? null,
    refKind: body.refKind ?? null,
  }).returning();
  res.status(201).json(rows[0]);
});

projectVersionsRoute.patch('/project-versions/:id', async (req, res) => {
  const id = String(req.params.id);
  const { projectId } = await assertVersionVisible(id, req.user!);
  const body = PatchBody.parse(req.body);
  if (body.name !== undefined) {
    const dup = await db.select({ id: projectVersions.id }).from(projectVersions)
      .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.name, body.name))).limit(1);
    if (dup.length > 0 && dup[0]!.id !== id) {
      throw new HttpError(409, 'version_name_taken', `version name "${body.name}" already exists`);
    }
  }
  // 关联环境必须属于同项目；null 表示清除关联（回退项目默认环境）
  if (body.environmentId != null) {
    const { projectId: envPid } = await assertEnvironmentVisible(body.environmentId, req.user!);
    if (envPid !== projectId) throw new HttpError(400, 'env_project_mismatch', 'environment does not belong to this project');
  }
  // ref 和 refKind 强相关：ref 非空时 refKind 必填；refKind 置空时 ref 也清空
  const nextRef = body.ref === undefined ? undefined : body.ref;
  const nextRefKind = body.refKind === undefined ? undefined : body.refKind;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) set.name = body.name;
  if (body.description !== undefined) set.description = body.description;
  if (nextRef !== undefined) set.ref = nextRef;
  if (nextRefKind !== undefined) set.refKind = nextRefKind;
  if (body.environmentId !== undefined) set.environmentId = body.environmentId;
  await db.update(projectVersions).set(set as Partial<typeof projectVersions.$inferInsert>).where(eq(projectVersions.id, id));
  const rows = await db.select().from(projectVersions).where(eq(projectVersions.id, id));
  res.json(rows[0]);
});

/** GET /projects/:projectId/refs?kind=branch|tag — 列远端 refs。仅 manager。 */
projectVersionsRoute.get('/projects/:projectId/refs', requireManager, async (req, res) => {
  const pid = String(req.params.projectId);
  await assertProjectVisible(pid, req.user!);
  const kind = RefKindEnum.parse(req.query.kind ?? 'branch');
  const ps = await db.select().from(projects).where(eq(projects.id, pid));
  if (ps.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  const p = ps[0]!;
  if (!p.repoUrl) throw new HttpError(400, 'no_repo', '项目未配置仓库');
  try {
    const refs = await listRefs({
      repoUrl: p.repoUrl,
      provider: (p.provider as GitProviderName) ?? 'github',
      pat: p.patOverride ?? undefined,
      kind,
    });
    res.json({ kind, refs });
  } catch (err) {
    res.status(400).json({ kind, refs: [], error: (err as Error).message });
  }
});

projectVersionsRoute.delete('/projects/:projectId/versions/:id', async (req, res) => {
  const pid = String(req.params.projectId);
  const id = String(req.params.id);
  await assertProjectVisible(pid, req.user!);
  await assertVersionVisible(id, req.user!);
  const all = await db.select({ id: projectVersions.id }).from(projectVersions).where(eq(projectVersions.projectId, pid));
  if (all.length <= 1) throw new HttpError(400, 'last_version', 'cannot delete the last version of a project');
  const caseCount = (await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.versionId, id))).length;
  const planCount = (await db.select({ id: executionPlans.id }).from(executionPlans).where(eq(executionPlans.versionId, id))).length;
  if (caseCount + planCount > 0) {
    throw new HttpError(400, 'version_not_empty', `version has ${caseCount} cases, ${planCount} plans`, {
      caseCount, planCount,
    } as Record<string, unknown>);
  }
  await db.transaction(async (tx) => {
    await tx.delete(projectVersions).where(eq(projectVersions.id, id));
  });
  res.status(204).end();
});

projectVersionsRoute.delete('/project-versions/:id', async (req, res) => {
  const id = String(req.params.id);
  const { projectId } = await assertVersionVisible(id, req.user!);
  const all = await db.select({ id: projectVersions.id }).from(projectVersions).where(eq(projectVersions.projectId, projectId));
  if (all.length <= 1) throw new HttpError(400, 'last_version', 'cannot delete the last version of a project');
  const caseCount = (await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.versionId, id))).length;
  const planCount = (await db.select({ id: executionPlans.id }).from(executionPlans).where(eq(executionPlans.versionId, id))).length;
  if (caseCount + planCount > 0) {
    throw new HttpError(400, 'version_not_empty', `version has ${caseCount} cases, ${planCount} plans`, {
      caseCount, planCount,
    } as Record<string, unknown>);
  }
  await db.transaction(async (tx) => {
    await tx.delete(projectVersions).where(eq(projectVersions.id, id));
  });
  res.status(204).end();
});