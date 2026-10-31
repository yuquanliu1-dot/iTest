/**
 * assistant_trajectories 管理端（设置页「助手轨迹」）：GET 列表 + DELETE 软删。
 * 挂载于 /api/assistant/trajectories，router.ts 处 requireManager 保护。
 * 与 memoriesRoute 的差异：无 global 档；可见性条件下推 SQL 后再 limit（R1 终审教训：
 * 先 limit 后过滤会在全库超限时把本组织旧行静默挤出窗口）。
 */
import { Router } from 'express';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantTrajectories, productLines } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AuthUser } from '../../services/auth.service.js';
import { assertProductLineVisible, visibleProductLineIds } from '../../services/projectAccess.js';

export const trajectoriesRoute = Router();

trajectoriesRoute.get('/', async (req, res) => {
  const user = req.user as AuthUser;
  const q = req.query;
  const visible = await visibleProductLineIds(user);
  if (visible.length === 0) { res.json([]); return; }
  const conds: SQL[] = [
    eq(assistantTrajectories.status, typeof q.status === 'string' && q.status ? q.status : 'active'),
    inArray(assistantTrajectories.productLineId, visible),
  ];
  if (typeof q.productLineId === 'string' && q.productLineId) conds.push(eq(assistantTrajectories.productLineId, q.productLineId));
  const rows = await db
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
    .where(and(...conds))
    .orderBy(desc(assistantTrajectories.updatedAt))
    .limit(500);
  res.json(rows);
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
