import { Router } from 'express';
import { db } from '../db/client.js';
import { reports } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';

export const reportsRoute = Router();

reportsRoute.get('/', async (_req, res) => {
  const rows = await db.select().from(reports).orderBy(desc(reports.createdAt));
  res.json(rows);
});

reportsRoute.get('/:id', async (req, res) => {
  const rows = await db.select().from(reports).where(eq(reports.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'report not found');
  res.json(rows[0]);
});