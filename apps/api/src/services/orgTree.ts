import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { organizationMembers, organizations } from '../db/schema.js';
import { isPathInSubtree } from './org-path.js';
import { cache, wrap } from '../lib/cache.js';
import { membershipsKey, orgPathKey, subtreeKey } from '../lib/cache-keys.js';
import type { AuthUser } from './auth.service.js';

export interface OrgMembership {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  isManager: boolean;
  isUser: boolean;
}

/** Looks up an org path; returns null when missing. Paths are immutable → effectively permanent (invalidation lives in the organizations write path). */
export async function getOrgPath(orgId: string): Promise<string | null> {
  return wrap(orgPathKey(orgId), 5 * 60_000, async () => {
    const rows = await db.select({ path: organizations.path }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    return rows[0]?.path ?? null;
  });
}

/** All org ids inside the materialized-path subtree (the org table is small: full scan + prefix check). */
export async function subtreeOrgIds(orgPath: string): Promise<string[]> {
  return wrap(subtreeKey(orgPath), 5 * 60_000, async () => {
    const rows = await db.select({ id: organizations.id, path: organizations.path }).from(organizations);
    return rows.filter((r) => isPathInSubtree(r.path, orgPath)).map((r) => r.id);
  });
}

/** The user's full set of org memberships (with org info). */
export async function membershipsOf(userId: string): Promise<Array<OrgMembership & { organizationId: string }>> {
  return wrap(membershipsKey(userId), 120_000, async () => {
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
  });
}

/** Explicitly deletes a user's membership cache (called by member add/remove paths). */
export async function invalidateMemberships(userId: string): Promise<void> {
  await cache.del(membershipsKey(userId));
}

/** Explicitly invalidates all org subtree/path caches (called on org create/patch/delete). */
export async function invalidateOrgTree(): Promise<void> {
  await cache.delPattern('org:subtree:*');
  await cache.delPattern('org:path:*');
}

/**
 * The set of org ids visible to the user = union of the subtrees of every managed org ∪ orgs joined directly.
 * The org table is small; subtrees/memberships are each cached.
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