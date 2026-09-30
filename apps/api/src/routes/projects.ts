import { Router } from 'express';
import { z } from 'zod';
import { eq, asc, desc, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, groups, testCases, reports, requirements } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';

export const projectsRoute = Router({ mergeParams: true });

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  defaultUrl: z.string().optional(),
});

async function caseCountsByGroup(): Promise<Map<string, number>> {
  const rows = await db
    .select({ groupId: testCases.groupId, count: sql<number>`count(*)` })
    .from(testCases)
    .groupBy(testCases.groupId);
  return new Map(rows.map((r) => [r.groupId, Number(r.count)]));
}

projectsRoute.get('/', async (_req, res) => {
  const ps = await db.select().from(projects).orderBy(asc(projects.createdAt));
  const gs = await db.select().from(groups);
  const counts = await caseCountsByGroup();
  const byProject = new Map<string, number>();
  for (const g of gs) {
    byProject.set(g.projectId, (byProject.get(g.projectId) ?? 0) + (counts.get(g.id) ?? 0));
  }
  res.json(ps.map((p) => ({ ...p, caseCount: byProject.get(p.id) ?? 0 })));
});

projectsRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const rows = await db.insert(projects).values(body).returning();
  res.json(rows[0]);
});

projectsRoute.get('/:id', async (req, res) => {
  const rows = await db.select().from(projects).where(eq(projects.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  res.json(rows[0]);
});

projectsRoute.patch('/:id', async (req, res) => {
  const body = CreateBody.partial().parse(req.body);
  const rows = await db
    .update(projects)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(projects.id, req.params.id))
    .returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  res.json(rows[0]);
});

projectsRoute.delete('/:id', async (req, res) => {
  const gs = await db.select().from(groups).where(eq(groups.projectId, req.params.id));
  if (gs.length > 0) throw new HttpError(409, 'not_empty', 'project has groups');
  const deleted = await db.delete(projects).where(eq(projects.id, req.params.id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  res.json({ ok: true });
});

projectsRoute.get('/:id/groups', async (req, res) => {
  const gs = await db.select().from(groups).where(eq(groups.projectId, req.params.id)).orderBy(asc(groups.createdAt));
  const counts = await caseCountsByGroup();
  res.json(gs.map((g) => ({ ...g, caseCount: counts.get(g.id) ?? 0 })));
});

projectsRoute.post('/:id/groups', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const p = await db.select().from(projects).where(eq(projects.id, req.params.id));
  if (p.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  const rows = await db.insert(groups).values({ ...body, projectId: req.params.id }).returning();
  res.json(rows[0]);
});

projectsRoute.get('/:id/stats', async (req, res) => {
  const p = await db.select().from(projects).where(eq(projects.id, req.params.id));
  if (p.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  const gs = await db.select().from(groups).where(eq(groups.projectId, req.params.id));
  const gids = gs.map((g) => g.id);
  const caseRows = gids.length
    ? await db.select().from(testCases).where(inArray(testCases.groupId, gids))
    : [];
  const caseIds = caseRows.map((c) => c.id);
  const reportRows = caseIds.length
    ? await db.select().from(reports).where(inArray(reports.caseId, caseIds)).orderBy(desc(reports.createdAt))
    : [];
  const counts = await caseCountsByGroup();
  const reqCount = (
    await db.select({ count: sql<number>`count(*)` }).from(requirements).where(eq(requirements.projectId, req.params.id))
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