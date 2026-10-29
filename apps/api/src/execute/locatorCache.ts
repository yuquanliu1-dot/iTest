/**
 * 机械步骤 locator 修复记忆：AI 降级（ai_fallback_locator_failed）整步重做成功后，
 * 把 AI 动作解析回的稳定 selector 写入 step_locator_cache；后续回放把缓存 locator
 * 追加进候选链末位参与探测（零 LLM），失败由 cdp.ts 照旧走 AI 降级并覆写缓存（自愈协议）。
 *
 * 缓存永远不能阻塞回放：读失败/未命中一律返回 null，写失败只静默（调用方 .catch）。
 * key = stepId（+ action_kind 区分步内多动作归属）；步骤删除级联清缓存。
 */
import { eq, sql } from 'drizzle-orm';
import type { Locator } from '@itest/shared';
import { db } from '../db/client.js';
import { stepLocatorCache } from '../db/schema.js';
import { logger } from '../logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CachedLocator {
  locator: Locator;
  actionKind: string;
}

/** 读缓存：stepId 非 UUID（草稿 staged-N 等）→ null；db 异常 → null（不阻塞回放）。 */
export async function readLocatorCache(stepId: string): Promise<CachedLocator | null> {
  if (!UUID_RE.test(stepId)) return null;
  try {
    const row = (await db.select().from(stepLocatorCache).where(eq(stepLocatorCache.stepId, stepId)))[0];
    if (!row) return null;
    return { locator: row.locator, actionKind: row.actionKind };
  } catch (e) {
    logger.warn({ err: e, stepId }, 'locator cache read failed; ignoring');
    return null;
  }
}

/** 覆写缓存（upsert 就地替换，hits 保留累计）；调用方 fire-and-forget。 */
export async function writeLocatorCache(stepId: string, locator: Locator, actionKind: string): Promise<void> {
  await db
    .insert(stepLocatorCache)
    .values({ stepId, locator, actionKind })
    .onConflictDoUpdate({
      target: stepLocatorCache.stepId,
      set: { locator, actionKind, updatedAt: new Date() },
    });
}

/** 命中计数 +1（fire-and-forget，失败静默）。 */
export async function bumpLocatorCacheHit(stepId: string): Promise<void> {
  await db
    .update(stepLocatorCache)
    .set({ hits: sql`${stepLocatorCache.hits} + 1`, updatedAt: new Date() })
    .where(eq(stepLocatorCache.stepId, stepId));
}
