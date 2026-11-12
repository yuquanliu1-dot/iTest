/**
 * assistant_trajectories admin surface (settings page "助手轨迹"): GET paged list + DELETE soft delete.
 * Mounted at /api/assistant/trajectories, protected by requireManager in router.ts.
 * Difference from memoriesRoute: no global tier; visibility conditions are pushed down into SQL before paging (R1 final-review lesson:
 * limit-then-filter silently squeezes this organization's old rows out of the window when the DB-wide cap is exceeded).
 */
import { Router } from 'express';
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantTrajectories, productLines } from '../../db/schema.js';
import { parsePaging } from '../../lib/pagination.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AuthUser } from '../../services/auth.service.js';
import { assertProductLineVisible, visibleProductLineIds } from '../../services/projectAccess.js';

export const trajectoriesRoute = Router();

trajectoriesRoute.get('/', async (req, res) => {
  const user = req.user as AuthUser;
  const q = req.query;
  const { page, limit } = parsePaging(q as Record<string, unknown>);
  const visible = await visibleProductLineIds(user);
  // inArray rejects empty arrays → with no visible lines, return an empty page directly (must not degrade to "drop the visibility condition")
  if (visible.length === 0) {
    res.json({ items: [], total: 0, page, limit });
    return;
  }
  const conds: SQL[] = [
    eq(assistantTrajectories.status, typeof q.status === 'string' && q.status ? q.status : 'active'),
    inArray(assistantTrajectories.productLineId, visible),
  ];
  if (typeof q.productLineId === 'string' && q.productLineId) conds.push(eq(assistantTrajectories.productLineId, q.productLineId));
  const where = and(...conds);
  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: assistantTrajectories.id,
        productLineId: assistantTrajectories.productLineId,
        productLineName: productLines.name,
        taskTitle: assistantTrajectories.taskTitle,
        taskKeywords: assistantTrajectories.taskKeywords,
        digest: assistantTrajectories.digest,
        caseTitle: assistantTrajectories.caseTitle,
        status: assistantTrajectories.status,
        hitCount: assistantTrajectories.hitCount,
        lastHitAt: assistantTrajectories.lastHitAt,
        createdAt: assistantTrajectories.createdAt,
        updatedAt: assistantTrajectories.updatedAt,
      })
      .from(assistantTrajectories)
      .leftJoin(productLines, eq(assistantTrajectories.productLineId, productLines.id))
      .where(where)
      // updatedAt isn't unique → append id as tiebreaker, otherwise paging repeats/skips rows
      .orderBy(desc(assistantTrajectories.updatedAt), desc(assistantTrajectories.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: count() }).from(assistantTrajectories).where(where),
  ]);
  res.json({ items: rows, total: Number(totalRows[0]?.count ?? 0), page, limit });
});

trajectoriesRoute.delete('/:id', async (req, res) => {
  const user = req.user as AuthUser;
  const existing = (await db.select().from(assistantTrajectories).where(eq(assistantTrajectories.id, req.params.id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', '轨迹不存在');
  await assertProductLineVisible(existing.productLineId, user);
  // Soft delete preserves audit; injection and retrieval only take active → deletion makes it vanish from the assistant side
  await db.update(assistantTrajectories)
    .set({ status: 'deleted', updatedAt: new Date() })
    .where(eq(assistantTrajectories.id, req.params.id));
  res.status(204).end();
});
