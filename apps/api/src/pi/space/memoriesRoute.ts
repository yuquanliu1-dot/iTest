/**
 * assistant_memories 管理端（设置页「助手记忆」）：GET 列表 + DELETE 软删。
 * 挂载于 /api/assistant/memories，router.ts 处 requireManager 保护。
 * 可见性（guidesRoute 同口径）：global 实例级共享；product_line 归属组织，
 * 仅该组织子树用户可见（visibleProductLineIds），跨组织一律不返回。
 */
import { Router } from 'express';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantMemories, productLines } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AuthUser } from '../../services/auth.service.js';
import { assertProductLineVisible, visibleProductLineIds } from '../../services/projectAccess.js';

export const memoriesRoute = Router();

memoriesRoute.get('/', async (req, res) => {
  const user = req.user as AuthUser;
  const q = req.query;
  const conds: SQL[] = [];
  if (typeof q.status === 'string' && q.status) conds.push(eq(assistantMemories.status, q.status));
  if (typeof q.productLineId === 'string' && q.productLineId) conds.push(eq(assistantMemories.productLineId, q.productLineId));
  const rows = await db
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
    .where(and(...conds))
    .orderBy(desc(assistantMemories.updatedAt))
    .limit(500);
  const visible = new Set(await visibleProductLineIds(user));
  res.json(rows.filter((r) => r.scope === 'global' || (r.productLineId != null && visible.has(r.productLineId))));
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
