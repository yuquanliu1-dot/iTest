/**
 * Runtime action cache for aiTask vision steps ("automatic solidification", borrowed from the midscene cache self-heal protocol):
 * after the first successful replay, the action sequence the AI actually executed is written to step_action_cache; subsequent replays
 * execute the cached actions mechanically first (zero LLM); on failure cdp.ts silently falls back to AI redo and overwrites the cache.
 *
 * The cache must never block replay: read failures/misses always return null; write failures only warn.
 * key = (stepId, exact instruction match) — any instruction change invalidates it.
 */
import { eq, sql } from 'drizzle-orm';
import type { StepAction } from '@itest/shared';
import { db } from '../db/client.js';
import { stepActionCache } from '../db/schema.js';
import { logger } from '../logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read cache: non-UUID stepId (drafts staged-N etc.) or instruction mismatch → null; db error → null (never blocks replay). */
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

/** Overwrite cache (upsert in-place replacement, hits keep accumulating); callers fire-and-forget. */
export async function writeAiTaskCache(stepId: string, instruction: string, actions: StepAction[]): Promise<void> {
  await db
    .insert(stepActionCache)
    .values({ stepId, instruction, actions })
    .onConflictDoUpdate({
      target: stepActionCache.stepId,
      set: { instruction, actions, updatedAt: new Date() },
    });
}

/** Hit counter +1 (fire-and-forget, failures silent). */
export async function bumpAiTaskCacheHit(stepId: string): Promise<void> {
  await db
    .update(stepActionCache)
    .set({ hits: sql`${stepActionCache.hits} + 1`, updatedAt: new Date() })
    .where(eq(stepActionCache.stepId, stepId));
}
