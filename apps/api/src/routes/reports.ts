import { Router } from 'express';
import { eq, desc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reports, testCases, groups } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';

export const reportsRoute = Router();

reportsRoute.get('/', async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  if (projectId) {
    const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
    const caseRows = gs.length
      ? await db.select({ id: testCases.id }).from(testCases).where(inArray(testCases.groupId, gs.map((g) => g.id)))
      : [];
    const rows = caseRows.length
      ? await db.select().from(reports).where(inArray(reports.caseId, caseRows.map((c) => c.id))).orderBy(desc(reports.createdAt))
      : [];
    res.json(rows);
    return;
  }
  const rows = await db.select().from(reports).orderBy(desc(reports.createdAt));
  res.json(rows);
});

reportsRoute.get('/:id', async (req, res) => {
  const rows = await db.select().from(reports).where(eq(reports.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'report not found');
  res.json(rows[0]);
});
