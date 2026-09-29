import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testCases, testSteps } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';

export const casesRoute = Router();

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P1'),
  requirementId: z.string().uuid().optional(),
});

casesRoute.get('/', async (req, res) => {
  const priority = req.query.priority as string | undefined;
  const rows = priority
    ? await db.select().from(testCases).where(eq(testCases.priority, priority))
    : await db.select().from(testCases);
  res.json(rows);
});

casesRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
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
  res.json({ ...rows[0], steps });
});

casesRoute.patch('/:id', async (req, res) => {
  const body = CreateBody.partial().parse(req.body);
  const rows = await db
    .update(testCases)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(testCases.id, req.params.id))
    .returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  res.json(rows[0]);
});