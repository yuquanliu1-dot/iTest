/**
 * Mechanical-step locator repair memory: after an AI fallback (ai_fallback_locator_failed) whole-step redo succeeds,
 * the stable selector the AI action resolved back to is written into step_locator_cache; subsequent replays append the cached locator
 * to the tail of the candidate chain for probing (zero LLM); on failure cdp.ts still goes through AI fallback and overwrites the cache (the self-heal protocol).
 *
 * The cache must never block replay: read failure/miss always returns null, write failure stays silent (caller .catch).
 * key = stepId (+ action_kind distinguishing multiple actions within one step); step deletion cascades the cache clear.
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

/** Read cache: non-UUID stepId (drafts like staged-N etc.) → null; db exception → null (doesn't block replay). */
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

/** Overwrite cache (upsert replaces in place, hits keeps accumulating); caller fire-and-forget. */
export async function writeLocatorCache(stepId: string, locator: Locator, actionKind: string): Promise<void> {
  await db
    .insert(stepLocatorCache)
    .values({ stepId, locator, actionKind })
    .onConflictDoUpdate({
      target: stepLocatorCache.stepId,
      set: { locator, actionKind, updatedAt: new Date() },
    });
}

/** Hit count +1 (fire-and-forget, failures silent). */
export async function bumpLocatorCacheHit(stepId: string): Promise<void> {
  await db
    .update(stepLocatorCache)
    .set({ hits: sql`${stepLocatorCache.hits} + 1`, updatedAt: new Date() })
    .where(eq(stepLocatorCache.stepId, stepId));
}
