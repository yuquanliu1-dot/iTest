import { Router } from 'express';
import { z } from 'zod';
import { eq, sql, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectVersions, testCases, testEnvironments, executionPlans } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible, assertVersionVisible } from '../services/projectAccess.js';

export const projectVersionsRoute = Router({ mergeParams: true });

const CreateBody = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
});

const PatchBody = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
});

projectVersionsRoute.get('/projects/:projectId/versions', async (req, res) => {
  const pid = String(req.params.projectId);
  await assertProjectVisible(pid, req.user!);
  const rows = await db.select().from(projectVersions).where(eq(projectVersions.projectId, pid)).orderBy(projectVersions.createdAt);
  const counts = await db.execute(sql`
    SELECT v.id,
      (SELECT count(*) FROM test_cases c WHERE c.version_id = v.id)         AS case_count,
      (SELECT count(*) FROM test_environments e WHERE e.version_id = v.id)  AS environment_count,
      (SELECT count(*) FROM execution_plans p WHERE p.version_id = v.id)    AS plan_count
    FROM project_versions v
    WHERE v.project_id = ${pid}
  `);
  const byId = new Map<string, { case_count: number; environment_count: number; plan_count: number }>();
  for (const r of counts.rows as Array<{ id: string; case_count: string; environment_count: string; plan_count: string }>) {
    byId.set(r.id, {
      case_count: Number(r.case_count),
      environment_count: Number(r.environment_count),
      plan_count: Number(r.plan_count),
    });
  }
  res.json(rows.map((v) => ({
    ...v,
    caseCount: byId.get(v.id)?.case_count ?? 0,
    environmentCount: byId.get(v.id)?.environment_count ?? 0,
    planCount: byId.get(v.id)?.plan_count ?? 0,
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
    isDefault: false,
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
  await db.update(projectVersions).set({
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    updatedAt: new Date(),
  }).where(eq(projectVersions.id, id));
  const rows = await db.select().from(projectVersions).where(eq(projectVersions.id, id));
  res.json(rows[0]);
});

projectVersionsRoute.post('/project-versions/:id/set-default', async (req, res) => {
  const id = String(req.params.id);
  const { projectId } = await assertVersionVisible(id, req.user!);
  await db.transaction(async (tx) => {
    await tx.update(projectVersions).set({ isDefault: false, updatedAt: new Date() })
      .where(eq(projectVersions.projectId, projectId));
    await tx.update(projectVersions).set({ isDefault: true, updatedAt: new Date() })
      .where(eq(projectVersions.id, id));
  });
  res.status(204).end();
});

projectVersionsRoute.delete('/project-versions/:id', async (req, res) => {
  const id = String(req.params.id);
  const { projectId } = await assertVersionVisible(id, req.user!);
  const all = await db.select({ id: projectVersions.id }).from(projectVersions).where(eq(projectVersions.projectId, projectId));
  if (all.length <= 1) throw new HttpError(400, 'last_version', 'cannot delete the last version of a project');
  const caseCount = (await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.versionId, id))).length;
  const envCount = (await db.select({ id: testEnvironments.id }).from(testEnvironments).where(eq(testEnvironments.versionId, id))).length;
  const planCount = (await db.select({ id: executionPlans.id }).from(executionPlans).where(eq(executionPlans.versionId, id))).length;
  if (caseCount + envCount + planCount > 0) {
    throw new HttpError(400, 'version_not_empty', `version has ${caseCount} cases, ${envCount} environments, ${planCount} plans`, {
      caseCount, envCount, planCount,
    } as Record<string, unknown>);
  }
  await db.transaction(async (tx) => {
    const [v] = await tx.select().from(projectVersions).where(eq(projectVersions.id, id)).limit(1);
    if (v?.isDefault) {
      const next = await tx.select({ id: projectVersions.id }).from(projectVersions)
        .where(and(eq(projectVersions.projectId, projectId))).orderBy(projectVersions.createdAt).limit(1);
      if (next[0]) await tx.update(projectVersions).set({ isDefault: true, updatedAt: new Date() }).where(eq(projectVersions.id, next[0].id));
    }
    await tx.delete(projectVersions).where(eq(projectVersions.id, id));
  });
  res.status(204).end();
});