import { Router } from 'express';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groups, testCases } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible } from '../services/projectAccess.js';

export const groupsRoute = Router();

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  defaultUrl: z.string().optional(),
});

groupsRoute.patch('/:id', async (req, res) => {
  const body = PatchBody.parse(req.body);
  const existing = await db.select().from(groups).where(eq(groups.id, req.params.id)).limit(1);
  const group = existing[0];
  if (!group) throw new HttpError(404, 'not_found', 'group not found');
  await assertProjectVisible(group.projectId, req.user!);
  const rows = await db
    .update(groups)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(groups.id, req.params.id))
    .returning();
  res.json(rows[0]);
});

groupsRoute.delete('/:id', async (req, res) => {
  const existing = await db.select().from(groups).where(eq(groups.id, req.params.id)).limit(1);
  const group = existing[0];
  if (!group) throw new HttpError(404, 'not_found', 'group not found');
  await assertProjectVisible(group.projectId, req.user!);
  const count = (
    await db.select({ count: sql<number>`count(*)` }).from(testCases).where(eq(testCases.groupId, req.params.id))
  ).map((r) => Number(r.count))[0]!;
  if (count > 0) throw new HttpError(409, 'not_empty', 'group has cases');
  await db.delete(groups).where(eq(groups.id, req.params.id));
  res.json({ ok: true });
});