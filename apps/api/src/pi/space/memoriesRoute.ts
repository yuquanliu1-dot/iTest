/**
 * assistant_memories admin side (settings page "assistant memories"): GET paginated list + DELETE soft delete.
 * Mounted at /api/assistant/memories, protected by requireManager at router.ts.
 * Visibility (same criteria as guidesRoute): global instance-level shared; product_line org-owned,
 * visible only to that org's subtree users (visibleProductLineIds), never returned across orgs.
 *
 * Visibility is filtered in SQL (not JS-filtered after fetching): after pagination, total must use the same criteria as the list,
 * and "limit first, filter later" would silently push this org's old rows out of the window (R1 final-review lesson).
 */
import { Router } from 'express';
import { and, count, desc, eq, inArray, or, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantMemories, productLines } from '../../db/schema.js';
import { parsePaging } from '../../lib/pagination.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AuthUser } from '../../services/auth.service.js';
import { assertProductLineVisible, visibleProductLineIds } from '../../services/projectAccess.js';

export const memoriesRoute = Router();

memoriesRoute.get('/', async (req, res) => {
  const user = req.user as AuthUser;
  const q = req.query;
  const { page, limit } = parsePaging(q as Record<string, unknown>);
  const conds: SQL[] = [];
  if (typeof q.status === 'string' && q.status) conds.push(eq(assistantMemories.status, q.status));
  if (typeof q.productLineId === 'string' && q.productLineId) conds.push(eq(assistantMemories.productLineId, q.productLineId));
  if (q.scope === 'global') conds.push(eq(assistantMemories.scope, 'global'));
  else if (q.scope === 'product_line') conds.push(eq(assistantMemories.scope, 'product_line'));

  // Visibility pushed down into SQL: global visible to everyone + lines under this org's subtree. When visible is empty only global remains
  // (inArray rejects empty arrays, hence two branches instead of or(..., inArray(..., []))).
  const visible = await visibleProductLineIds(user);
  conds.push(
    visible.length > 0
      ? or(eq(assistantMemories.scope, 'global'), inArray(assistantMemories.productLineId, visible))!
      : eq(assistantMemories.scope, 'global'),
  );

  const where = and(...conds);
  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: assistantMemories.id,
        scope: assistantMemories.scope,
        productLineId: assistantMemories.productLineId,
        productLineName: productLines.name,
        title: assistantMemories.title,
        hook: assistantMemories.hook,
        body: assistantMemories.body,
        provenance: assistantMemories.provenance,
        status: assistantMemories.status,
        hitCount: assistantMemories.hitCount,
        lastHitAt: assistantMemories.lastHitAt,
        createdByUserId: assistantMemories.createdByUserId,
        createdAt: assistantMemories.createdAt,
        updatedAt: assistantMemories.updatedAt,
      })
      .from(assistantMemories)
      .leftJoin(productLines, eq(assistantMemories.productLineId, productLines.id))
      .where(where)
      // updatedAt is not unique → append id as tiebreaker, otherwise pages overlap/skip rows
      .orderBy(desc(assistantMemories.updatedAt), desc(assistantMemories.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ count: count() }).from(assistantMemories).where(where),
  ]);
  res.json({ items: rows, total: Number(totalRows[0]?.count ?? 0), page, limit });
});

memoriesRoute.delete('/:id', async (req, res) => {
  const user = req.user as AuthUser;
  const existing = (await db.select().from(assistantMemories).where(eq(assistantMemories.id, req.params.id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', '记忆不存在');
  if (existing.scope === 'product_line' && existing.productLineId) {
    await assertProductLineVisible(existing.productLineId, user);
  }
  // Soft delete to preserve audit (R3/R5 consumption trails); injection and tools only take active → deleted means gone from the assistant's side
  await db.update(assistantMemories)
    .set({ status: 'deleted', updatedAt: new Date() })
    .where(eq(assistantMemories.id, req.params.id));
  res.status(204).end();
});
