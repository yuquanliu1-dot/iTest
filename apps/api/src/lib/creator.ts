/**
 * Creator resolution helper: batch-resolves userIds into user summaries; all list/detail serializers append createdBy uniformly.
 * created_by_user_id is nullable (legacy rows / user deleted with ON DELETE SET NULL); misses are always treated as null.
 */
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';

export interface ResolvedUser {
  id: string;
  username: string;
  displayName: string;
}

/** Batch-resolves userIds → a map of user summaries. Deduplicates + skips empties; nonexistent ids never appear in the map. */
export async function resolveUsersByIds(
  ids: Array<string | null | undefined>,
): Promise<Map<string, ResolvedUser>> {
  const uniq = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (uniq.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, uniq));
  const map = new Map<string, ResolvedUser>();
  for (const r of rows) map.set(r.id, { id: r.id, username: r.username, displayName: r.displayName });
  return map;
}

/** Batch-attaches createdBy onto a set of rows carrying createdByUserId (keeps the original createdByUserId field). */
export async function attachCreators<T extends { createdByUserId?: string | null }>(
  rows: T[],
): Promise<Array<T & { createdBy: ResolvedUser | null }>> {
  const map = await resolveUsersByIds(rows.map((r) => r.createdByUserId));
  return rows.map((r) => ({
    ...r,
    createdBy: r.createdByUserId ? map.get(r.createdByUserId) ?? null : null,
  }));
}

/** Single-row version of attachCreators: null/undefined rows return null as-is. */
export async function attachCreator<T extends { createdByUserId?: string | null }>(
  row: T | null | undefined,
): Promise<(T & { createdBy: ResolvedUser | null }) | null> {
  if (!row) return null;
  return (await attachCreators([row]))[0]!;
}