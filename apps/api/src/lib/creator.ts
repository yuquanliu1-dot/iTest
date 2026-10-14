/**
 * 创建人解析 helper：批量把 userId 解析为用户摘要，各处 list/detail 序列化统一追加 createdBy。
 * created_by_user_id 可空（历史存量 / 用户已删 ON DELETE SET NULL），未命中一律按 null 处理。
 */
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';

export interface ResolvedUser {
  id: string;
  username: string;
  displayName: string;
}

/** 批量解析 userId → 用户摘要 Map。去重 + 跳过空值；不存在的 id 不出现在 Map 里。 */
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

/** 给一组含 createdByUserId 的行批量附加 createdBy（保留原始 createdByUserId 字段）。 */
export async function attachCreators<T extends { createdByUserId?: string | null }>(
  rows: T[],
): Promise<Array<T & { createdBy: ResolvedUser | null }>> {
  const map = await resolveUsersByIds(rows.map((r) => r.createdByUserId));
  return rows.map((r) => ({
    ...r,
    createdBy: r.createdByUserId ? map.get(r.createdByUserId) ?? null : null,
  }));
}

/** 单行版 attachCreators：null/undefined 行原样返回 null。 */
export async function attachCreator<T extends { createdByUserId?: string | null }>(
  row: T | null | undefined,
): Promise<(T & { createdBy: ResolvedUser | null }) | null> {
  if (!row) return null;
  return (await attachCreators([row]))[0]!;
}