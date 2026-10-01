import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { organizationMembers, organizations } from '../db/schema.js';
import { isPathInSubtree } from './org-path.js';
import type { AuthUser } from './auth.service.js';

export interface OrgMembership {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  isManager: boolean;
  isUser: boolean;
}

/** 查组织 path；不存在返回 null。 */
export async function getOrgPath(orgId: string): Promise<string | null> {
  const rows = await db.select({ path: organizations.path }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return rows[0]?.path ?? null;
}

/** 物化路径子树内的全部组织 id（org 表量级小，直接全表扫 + 前缀判定）。 */
export async function subtreeOrgIds(orgPath: string): Promise<string[]> {
  const rows = await db.select({ id: organizations.id, path: organizations.path }).from(organizations);
  return rows.filter((r) => isPathInSubtree(r.path, orgPath)).map((r) => r.id);
}

/** 用户的全部组织成员资格（带组织信息）。 */
export async function membershipsOf(userId: string): Promise<Array<OrgMembership & { organizationId: string }>> {
  const rows = await db
    .select({
      organizationId: organizationMembers.organizationId,
      isManager: organizationMembers.isManager,
      isUser: organizationMembers.isUser,
      id: organizations.id,
      name: organizations.name,
      parentId: organizations.parentId,
      path: organizations.path,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id))
    .where(eq(organizationMembers.userId, userId));
  return rows;
}

/**
 * 用户可见的组织 id 集合 = 管理的每个组织的子树并集 ∪ 自己直接加入的组织。
 * 每请求现算（org 表小），不做缓存。
 */
export async function visibleOrgIdsFor(user: AuthUser): Promise<Set<string>> {
  const visible = new Set<string>();
  for (const p of user.managerOrgPaths) {
    for (const id of await subtreeOrgIds(p)) {
      visible.add(id);
    }
  }
  for (const m of await membershipsOf(user.userId)) {
    visible.add(m.organizationId);
  }
  return visible;
}
