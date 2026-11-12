import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';

/** Replay AI-redo switch (global setting; applies to Web replay only).
 *  Only "mechanical step failed → AI redoes it per instruction" is optional; the on-the-spot execution of NL vision steps
 *  (empty compiled + has instruction) is official execution semantics, not governed by the switch (solidify optional since 2026-10-24). */
export interface AiFallbackSettings {
  /** When a mechanical step fails (for any failure reason), the AI redoes it using that step's instruction. */
  locatorFailed: boolean;
}

/** settings KV key, mirrored with the constants in apps/web/src/pages/Settings.tsx. */
export const AI_FALLBACK_KEYS = {
  locatorFailed: 'ai_fallback_locator_failed',
} as const;

/** Single query; a missing key reads as false (switch defaults to off). */
export async function readAiFallbackSettings(): Promise<AiFallbackSettings> {
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, AI_FALLBACK_KEYS.locatorFailed));
  const map = new Map(rows.map((r) => [r.key, r.value as unknown]));
  return {
    locatorFailed: map.get(AI_FALLBACK_KEYS.locatorFailed) === true,
  };
}