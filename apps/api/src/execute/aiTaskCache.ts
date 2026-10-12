/**
 * aiTask 视觉步骤的运行时动作缓存（"自动挡固化"，借鉴 midscene cache 自愈协议）：
 * 首次回放成功后把 AI 实际执行的动作序列写入 step_action_cache，后续回放先机械执行
 * 缓存动作（零 LLM），失败由 cdp.ts 静默回退 AI 重做并覆写缓存。
 *
 * 缓存永远不能阻塞回放：读失败/未命中一律返回 null，写失败只 warn。
 * key = (stepId, instruction 精确匹配)——指令一改即过期。
 */
import { eq, sql } from 'drizzle-orm';
import type { StepAction } from '@itest/shared';
import { db } from '../db/client.js';
import { stepActionCache } from '../db/schema.js';
import { logger } from '../logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 读缓存：stepId 非 UUID（草稿 staged-N 等）或 instruction 不一致 → null；db 异常 → null（不阻塞回放）。 */
export async function readAiTaskCache(stepId: string, instruction: string): Promise<StepAction[] | null> {
  if (!UUID_RE.test(stepId)) return null;
  try {
    const row = (await db.select().from(stepActionCache).where(eq(stepActionCache.stepId, stepId)))[0];
    if (!row || row.instruction !== instruction) return null;
    return row.actions;
  } catch (e) {
    logger.warn({ err: e, stepId }, 'aiTask cache read failed; falling back to AI');
    return null;
  }
}

/** 覆写缓存（upsert 就地替换，hits 保留累计）；调用方 fire-and-forget。 */
export async function writeAiTaskCache(stepId: string, instruction: string, actions: StepAction[]): Promise<void> {
  await db
    .insert(stepActionCache)
    .values({ stepId, instruction, actions })
    .onConflictDoUpdate({
      target: stepActionCache.stepId,
      set: { instruction, actions, updatedAt: new Date() },
    });
}

/** 命中计数 +1（fire-and-forget，失败静默）。 */
export async function bumpAiTaskCacheHit(stepId: string): Promise<void> {
  await db
    .update(stepActionCache)
    .set({ hits: sql`${stepActionCache.hits} + 1`, updatedAt: new Date() })
    .where(eq(stepActionCache.stepId, stepId));
}
