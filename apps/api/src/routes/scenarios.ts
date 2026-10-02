import { Router } from 'express';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scenarios, requirements } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible } from '../services/projectAccess.js';

export const scenariosRoute = Router({ mergeParams: true });

async function projectIdFor(reqId: string): Promise<string> {
  const rows = await db
    .select({ projectId: requirements.projectId })
    .from(requirements)
    .where(eq(requirements.id, reqId))
    .limit(1);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'requirement not found');
  return rows[0].projectId;
}

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
});
const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
});

// 直挂载：GET /api/scenarios?projectId=...
// 列出该项目下 requirement 衍生的场景全集，让场景过滤下拉不被选中项收缩。
scenariosRoute.get('/', async (req, res) => {
  const projectId = req.query.projectId as string | undefined;
  const rid = (req.params as { requirementId?: string }).requirementId;
  if (projectId) {
    await assertProjectVisible(projectId, req.user!);
    const rows = await db
      .select({
        id: scenarios.id,
        title: scenarios.title,
        requirementId: scenarios.requirementId,
      })
      .from(scenarios)
      .innerJoin(requirements, eq(scenarios.requirementId, requirements.id))
      .where(eq(requirements.projectId, projectId))
      .orderBy(scenarios.createdAt);
    res.json(rows);
    return;
  }
  if (!rid) throw new HttpError(400, 'bad_request', 'projectId or requirementId required');
  await assertProjectVisible(await projectIdFor(rid), req.user!);
  const rows = await db
    .select()
    .from(scenarios)
    .where(eq(scenarios.requirementId, rid))
    .orderBy(scenarios.order, scenarios.createdAt);
  res.json(rows);
});

scenariosRoute.post('/', async (req, res) => {
  const rid = (req.params as { requirementId?: string }).requirementId!;
  await assertProjectVisible(await projectIdFor(rid), req.user!);
  const body = CreateBody.parse(req.body);
  const max = (
    await db
      .select({ m: sql<number>`coalesce(max("order"), 0)` })
      .from(scenarios)
      .where(eq(scenarios.requirementId, rid))
  )[0]?.m ?? 0;
  const rows = await db
    .insert(scenarios)
    .values({ requirementId: rid, title: body.title, description: body.description, order: Number(max) + 1 })
    .returning();
  res.json(rows[0]);
});

scenariosRoute.patch('/:id', async (req, res) => {
  const rows = await db.select().from(scenarios).where(eq(scenarios.id, req.params.id!)).limit(1);
  const sc = rows[0];
  if (!sc) throw new HttpError(404, 'not_found', 'scenario not found');
  await assertProjectVisible(await projectIdFor(sc.requirementId), req.user!);
  const body = PatchBody.parse(req.body);
  const updated = await db.update(scenarios).set(body).where(eq(scenarios.id, sc.id)).returning();
  res.json(updated[0]);
});

scenariosRoute.delete('/:id', async (req, res) => {
  const rows = await db.select().from(scenarios).where(eq(scenarios.id, req.params.id!)).limit(1);
  const sc = rows[0];
  if (!sc) throw new HttpError(404, 'not_found', 'scenario not found');
  await assertProjectVisible(await projectIdFor(sc.requirementId), req.user!);
  // FK ON DELETE SET NULL: cases 自动解除绑定；不要 409
  await db.delete(scenarios).where(eq(scenarios.id, sc.id));
  res.json({ ok: true });
});
