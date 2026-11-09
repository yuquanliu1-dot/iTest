/**
 * assistant_memories 管理端（设置页「助手记忆」）：GET 分页列表 + DELETE 软删。
 * 挂载于 /api/assistant/memories，router.ts 处 requireManager 保护。
 * 可见性（guidesRoute 同口径）：global 实例级共享；product_line 归属组织，
 * 仅该组织子树用户可见（visibleProductLineIds），跨组织一律不返回。
 *
 * 可见性在 SQL 里过滤（而非查完再 JS filter）：分页后 total 必须与列表同口径，
 * 且「先 limit 后过滤」会把本组织的旧行静默挤出窗口（R1 终审教训）。
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

  // 可见性下推 SQL：global 全员可见 + 本组织子树下的线。visible 为空时只剩 global
  // （inArray 不吃空数组，故分两支而不是 or(..., inArray(..., []))）。
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
      // updatedAt 非唯一 → 追加 id 作 tiebreaker，否则跨页会重复/漏行
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
  // 软删保审计（R3/R5 消费轨迹）；注入与工具只取 active → 删除即从助手侧消失
  await db.update(assistantMemories)
    .set({ status: 'deleted', updatedAt: new Date() })
    .where(eq(assistantMemories.id, req.params.id));
  res.status(204).end();
});
