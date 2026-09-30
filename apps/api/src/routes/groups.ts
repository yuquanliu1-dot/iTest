import { Router } from 'express';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groups, testCases } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';

export const groupsRoute = Router();

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  defaultUrl: z.string().optional(),
});

groupsRoute.patch('/:id', async (req, res) => {
  const body = PatchBody.parse(req.body);
  const rows = await db
    .update(groups)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(groups.id, req.params.id))
    .returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  res.json(rows[0]);
});

groupsRoute.delete('/:id', async (req, res) => {
  const count = (
    await db.select({ count: sql<number>`count(*)` }).from(testCases).where(eq(testCases.groupId, req.params.id))
  ).map((r) => Number(r.count))[0]!;
  if (count > 0) throw new HttpError(409, 'not_empty', 'group has cases');
  const deleted = await db.delete(groups).where(eq(groups.id, req.params.id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  res.json({ ok: true });
});