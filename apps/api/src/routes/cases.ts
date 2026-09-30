import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testCases, testSteps, groups } from '../db/schema.js';
import { eq, asc, inArray } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';

export const casesRoute = Router();

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P1'),
  requirementId: z.string().uuid().optional(),
  groupId: z.string().uuid(),
  url: z.string().optional(),
});

casesRoute.get('/', async (req, res) => {
  const { priority, groupId, projectId } = req.query as Record<string, string | undefined>;
  let rows;
  if (projectId) {
    const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
    const gids = gs.map((g) => g.id);
    rows = gids.length
      ? await db.select().from(testCases).where(inArray(testCases.groupId, gids))
      : [];
  } else if (groupId) {
    rows = await db.select().from(testCases).where(eq(testCases.groupId, groupId));
  } else {
    rows = await db.select().from(testCases);
  }
  if (priority) rows = rows.filter((r) => r.priority === priority);
  res.json(rows);
});

casesRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const g = await db.select().from(groups).where(eq(groups.id, body.groupId));
  if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  const rows = await db.insert(testCases).values(body).returning();
  res.json(rows[0]);
});

casesRoute.get('/:id', async (req, res) => {
  const rows = await db.select().from(testCases).where(eq(testCases.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  const steps = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, req.params.id))
    .orderBy(asc(testSteps.order));
  const resolvedUrl = await resolveCaseUrl(rows[0]!);
  res.json({ ...rows[0], steps, resolvedUrl });
});

casesRoute.patch('/:id', async (req, res) => {
  const body = CreateBody.partial().parse(req.body);
  if (body.groupId) {
    const g = await db.select().from(groups).where(eq(groups.id, body.groupId));
    if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  }
  const rows = await db
    .update(testCases)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(testCases.id, req.params.id))
    .returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  res.json(rows[0]);
});
