/**
 * assistant_trajectories 管理端（设置页「助手轨迹」）：GET 分页列表 + DELETE 软删。
 * 挂载于 /api/assistant/trajectories，router.ts 处 requireManager 保护。
 * 与 memoriesRoute 的差异：无 global 档；可见性条件下推 SQL 后再分页（R1 终审教训：
 * 先 limit 后过滤会在全库超限时把本组织旧行静默挤出窗口）。
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
  // inArray 不吃空数组 → 无可见线时直接回空页（不能退化成「不加可见性条件」）
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
      // updatedAt 非唯一 → 追加 id 作 tiebreaker，否则跨页会重复/漏行
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
  // 软删保审计；注入与检索只取 active → 删除即从助手侧消失
  await db.update(assistantTrajectories)
    .set({ status: 'deleted', updatedAt: new Date() })
    .where(eq(assistantTrajectories.id, req.params.id));
  res.status(204).end();
});
