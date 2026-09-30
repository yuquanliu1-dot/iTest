import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { requirements } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';

export const requirementsRoute = Router();

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  projectId: z.string().uuid().optional(),
});

requirementsRoute.get('/', async (_req, res) => {
  const rows = await db.select().from(requirements).orderBy(requirements.createdAt);
  res.json(rows);
});

requirementsRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const rows = await db.insert(requirements).values(body).returning();
  res.json(rows[0]);
});

requirementsRoute.get('/:id', async (req, res) => {
  const rows = await db.select().from(requirements).where(eq(requirements.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'requirement not found');
  res.json(rows[0]);
});