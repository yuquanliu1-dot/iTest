import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';

export const settingsRoute = Router();

const PutBody = z.object({
  key: z.string().min(1).max(100),
  value: z.unknown(),
});

settingsRoute.get('/', async (_req, res) => {
  const rows = await db.select().from(settings);
  const out: Record<string, unknown> = {};
  for (const row of rows) out[row.key] = row.value;
  res.json(out);
});

settingsRoute.get('/:key', async (req, res) => {
  const rows = await db.select().from(settings).where(eq(settings.key, req.params.key));
  if (rows.length === 0) throw new HttpError(404, 'not_found', `key ${req.params.key} not found`);
  res.json({ key: rows[0]!.key, value: rows[0]!.value, updatedAt: rows[0]!.updatedAt });
});

settingsRoute.put('/', async (req, res) => {
  const body = PutBody.parse(req.body);
  const rows = await db
    .insert(settings)
    .values({ key: body.key, value: body.value as object })
    .onConflictDoUpdate({ target: settings.key, set: { value: body.value as object, updatedAt: new Date() } })
    .returning();
  res.json({ key: rows[0]!.key, value: rows[0]!.value });
});