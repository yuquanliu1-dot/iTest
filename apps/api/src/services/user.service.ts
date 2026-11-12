/**
 * User management service. Auth / visibility model:
 *   - The caller's "visible org set" = union of managerOrgPaths subtrees ∪ direct memberships
 *   - Cross-tenant existence defense: USER_NOT_FOUND and USER_NOT_AUTHZ are both mapped to 404 at the route layer,
 *     never leaking the "user exists but cross-tenant" existence oracle.
 *   - A user's visible "project assignments" come from project_assignments, trimmed to visible orgs before display,
 *     avoiding showing projects "I can't see in org B, but that org B assigned to me".
 *
 * Design follows iDO apps/dispatch-gateway/src/services/user.service.ts, adapted to the iTest PG schema
 * (uuid, timestamp, boolean instead of bigint 0/1).
 */
import { and, eq, ilike, inArray, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  organizationMembers,
  organizations,
  productLines,
  projectAssignments,
  projects,
  users,
} from '../db/schema.js';
import { isPathInSubtree } from './org-path.js';
import { subtreeOrgIds } from './orgTree.js';
import { generateRandomPassword, hashPassword } from './auth.service.js';
import type { AuthUser } from './auth.service.js';

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
}

export interface UserOrgMembership {
  organizationId: string;
  organizationName: string;
  organizationPath: string;
  isManager: boolean;
  isUser: boolean;
}

export interface UserDetail extends UserSummary {
  createdAt: string;
  disabledAt: string | null;
  organizations: UserOrgMembership[];
  projectCount: number;
}

export interface CallerScope {
  userId: string;
  managerOrgPaths: string[];
}

/** Same source as organizationService.getManagedSubtree's subtree test. Empty paths are historical dirty data, filtered out. */
async function visibleOrgIds(caller: CallerScope): Promise<string[]> {
  const ids = new Set<string>();
  for (const p of caller.managerOrgPaths) {
    if (!p) continue;
    for (const id of await subtreeOrgIds(p)) ids.add(id);
  }
  const ms = await db
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, caller.userId));
  for (const m of ms) ids.add(m.organizationId);
  return [...ids];
}

function toUserSummary(row: typeof users.$inferSelect): UserSummary {
  return { id: row.id, username: row.username, displayName: row.displayName, email: row.email };
}

/** Excludes the disabled (non-null disabledAt); consistent with iDO auth.service.login's guard. */
const activeUserFilter = sql`${users.disabledAt} IS NULL`;

/** User directory search predicate. excludeOrgId is mostly for filtering "candidate lists when adding members to org X".
 *  Note: excludeOrgId also excludes subtree memberships — sub-org members count as "already in the org", avoiding same-org cross-level duplicates.
 */
function buildUserSearchWhere(orgIds: string[], q: string | undefined, excludeSubtreeOrgIds?: string[]) {
  const conds: ReturnType<typeof eq>[] = [inArray(organizationMembers.organizationId, orgIds)];
  if (excludeSubtreeOrgIds && excludeSubtreeOrgIds.length > 0) {
    conds.push(
      notInArray(
        users.id,
        db
          .select({ id: organizationMembers.userId })
          .from(organizationMembers)
          .where(inArray(organizationMembers.organizationId, excludeSubtreeOrgIds))!,
      )!,
    );
  }
  if (q && q.trim()) {
    const like = `%${q.trim()}%`;
    conds.push(or(ilike(users.username, like), ilike(users.displayName, like))!);
  }
  return and(...conds, activeUserFilter)!;
}

export const userService = {
  async listUsers(
    caller: CallerScope,
    opts: { orgId?: string; includeSubtree?: boolean; q?: string; excludeOrgId?: string; page: number; limit: number },
  ): Promise<Paged<UserSummary>> {
    const visible = await visibleOrgIds(caller);
    let scopeIds: string[];
    if (opts.orgId) {
      if (!visible.includes(opts.orgId)) throw new Error('FORBIDDEN_ORG');
      if (opts.includeSubtree) {
        const orgPath = (await db.select({ path: organizations.path }).from(organizations).where(eq(organizations.id, opts.orgId)).limit(1))[0]?.path;
        if (orgPath) {
          const sub = await subtreeOrgIds(orgPath);
          scopeIds = sub.filter((id) => visible.includes(id));
        } else {
          scopeIds = [];
        }
      } else {
        scopeIds = [opts.orgId];
      }
    } else {
      scopeIds = visible;
    }
    if (opts.excludeOrgId && !visible.includes(opts.excludeOrgId)) throw new Error('FORBIDDEN_ORG');

    const page = Math.min(Math.max(1, Math.trunc(opts.page)), 1_000_000);
    const limit = Math.min(Math.max(1, Math.trunc(opts.limit)), 100);

    if (scopeIds.length === 0) {
      return { items: [], total: 0, page, limit };
    }
    // excludeOrgId is widened to "that org + subtree": avoids re-adding "sub-org members" to an ancestor org.
    let excludeSubtree: string[] | undefined;
    if (opts.excludeOrgId) {
      const exPath = (await db.select({ path: organizations.path }).from(organizations).where(eq(organizations.id, opts.excludeOrgId)).limit(1))[0]?.path;
      if (exPath) excludeSubtree = await subtreeOrgIds(exPath);
    }
    const where = buildUserSearchWhere(scopeIds, opts.q, excludeSubtree);
    const [items, totalRows] = await Promise.all([
      db
        .selectDistinct({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          email: users.email,
        })
        .from(users)
        .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
        .where(where)
        .orderBy(users.username)
        .limit(limit)
        .offset((page - 1) * limit),
      db
        .select({ count: sql<number>`count(distinct ${users.id})` })
        .from(users)
        .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
        .where(where),
    ]);
    return { items, total: Number(totalRows[0]?.count ?? 0), page, limit };
  },

  async getUserDetail(caller: CallerScope, userId: string): Promise<UserDetail> {
    const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!user || user.disabledAt !== null) throw new Error('USER_NOT_FOUND');

    const visible = new Set(await visibleOrgIds(caller));
    const memberships = await db
      .select({
        organizationId: organizationMembers.organizationId,
        isManager: organizationMembers.isManager,
        isUser: organizationMembers.isUser,
      })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId));
    if (!memberships.some((m) => visible.has(m.organizationId))) throw new Error('USER_NOT_AUTHZ');

    const orgRows = memberships.length
      ? await db
          .select({ id: organizations.id, name: organizations.name, path: organizations.path })
          .from(organizations)
          .where(inArray(organizations.id, memberships.map((m) => m.organizationId)))
      : [];
    const orgById = new Map(orgRows.map((o) => [o.id, o]));
    const organizations_ = memberships
      .filter((m) => visible.has(m.organizationId))
      .map((m) => {
        const o = orgById.get(m.organizationId);
        if (!o) return null;
        return {
          organizationId: m.organizationId,
          organizationName: o.name,
          organizationPath: o.path,
          isManager: m.isManager,
          isUser: m.isUser,
        };
      })
      .filter((x): x is UserOrgMembership => x !== null)
      .sort((a, b) => a.organizationPath.localeCompare(b.organizationPath));

    // Only counts project assignments that happened in "orgs within the caller's visible range". For cross-org assignments,
    // assignment.organizationId doesn't necessarily fall in the caller's visible set — such projects don't count into projectCount.
    const projectIds = await projectAssignmentsByUserInOrgs(userId, [...visible]);

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      createdAt: (user.createdAt as Date).toISOString(),
      disabledAt: user.disabledAt ? (user.disabledAt as Date).toISOString() : null,
      organizations: organizations_,
      projectCount: projectIds.length,
    };
  },

  async getUserProjects(
    caller: CallerScope,
    userId: string,
    opts: { page: number; limit: number },
  ): Promise<Paged<{ id: string; name: string; description: string | null; organizationId: string | null }>> {
    await this.getUserDetail(caller, userId); // same visibility check

    const visible = await visibleOrgIds(caller);
    const ids = await projectAssignmentsByUserInOrgs(userId, visible);
    if (ids.length === 0) return { items: [], total: 0, page: opts.page, limit: opts.limit };

    // A project's org is derived from its product line (projects no longer has an organization_id column); the response still returns the derived value.
    const rows = ids.length
      ? await db
          .select({ id: projects.id, name: projects.name, description: projects.description, organizationId: productLines.organizationId })
          .from(projects)
          .innerJoin(productLines, eq(productLines.id, projects.productLineId))
          .where(inArray(projects.id, ids))
      : [];
    const visibleSet = new Set(visible);
    const sorted = rows
      .filter((r) => visibleSet.has(r.organizationId))
      .sort((a, b) => a.name.localeCompare(b.name));
    const p = Math.max(1, Math.trunc(opts.page));
    const l = Math.max(1, Math.trunc(opts.limit));
    const start = (p - 1) * l;
    return {
      items: sorted.slice(start, start + l).map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        organizationId: r.organizationId,
      })),
      total: sorted.length,
      page: p,
      limit: l,
    };
  },

  /** Soft delete: disable + clear memberships and assignments + tokenVersion +1 (kicks sessions offline). */
  async disableUser(caller: CallerScope, userId: string): Promise<void> {
    await this.getUserDetail(caller, userId); // same visibility check
    await db
      .update(users)
      .set({ disabledAt: new Date(), tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: new Date() })
      .where(eq(users.id, userId));
    await db.delete(organizationMembers).where(eq(organizationMembers.userId, userId));
    await db.delete(projectAssignments).where(eq(projectAssignments.userId, userId));
  },

  async updateUser(
    caller: CallerScope,
    userId: string,
    patch: { displayName?: string; email?: string | null; languagePreference?: 'zh-CN' | 'en-US' },
  ): Promise<UserDetail> {
    await this.getUserDetail(caller, userId);
    const set: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (patch.displayName !== undefined) set.displayName = patch.displayName;
    if (patch.email !== undefined) set.email = patch.email;
    if (patch.languagePreference !== undefined) set.languagePreference = patch.languagePreference;
    await db.update(users).set(set).where(eq(users.id, userId));
    return await this.getUserDetail(caller, userId);
  },

  /** Resets someone else's password: one-time temporary password + forced change on first login + kicked offline. Stricter auth than updateUser: must be within the caller's managed subtree. */
  async resetUserPassword(caller: CallerScope, userId: string): Promise<string> {
    const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!user || user.disabledAt !== null) throw new Error('USER_NOT_FOUND');

    const ms = await db
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId));
    const orgIds = ms.map((m) => m.organizationId);
    const orgRows = orgIds.length
      ? await db.select({ id: organizations.id, path: organizations.path }).from(organizations).where(inArray(organizations.id, orgIds))
      : [];
    const managedPaths = caller.managerOrgPaths.filter((p) => p.length > 0);
    const inManagedSubtree = orgRows.some((o) => managedPaths.some((p) => isPathInSubtree(o.path, p)));
    if (!inManagedSubtree) throw new Error('USER_NOT_AUTHZ');

    const temporaryPassword = generateRandomPassword();
    await db
      .update(users)
      .set({
        passwordHash: await hashPassword(temporaryPassword),
        passwordUpdatedAt: null,
        mustChangePassword: true,
        tokenVersion: sql`${users.tokenVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    return temporaryPassword;
  },

  /** admin use: creates an account within the caller's visible range (not auto-joined to any org). */
  async createUser(input: {
    username: string;
    displayName: string;
    email?: string | null;
    password: string;
    languagePreference?: 'zh-CN' | 'en-US';
  }): Promise<{ id: string; username: string; displayName: string; email: string | null; _temporaryPassword: string }> {
    const existing = (await db.select({ id: users.id }).from(users).where(eq(users.username, input.username)).limit(1))[0];
    if (existing) throw new Error('Username already exists');
    const passwordHash = await hashPassword(input.password);
    const [row] = await db
      .insert(users)
      .values({
        username: input.username,
        displayName: input.displayName,
        email: input.email ?? null,
        languagePreference: input.languagePreference ?? 'zh-CN',
        passwordHash,
        mustChangePassword: true,
        passwordUpdatedAt: null,
      })
      .returning();
    return { ...toUserSummary(row!), _temporaryPassword: input.password };
  },

  /** For organizationMemberRepo: lists a user's assigned project ids within the caller's visible orgs. */
  async getAssignedProjectIdsInOrgs(userId: string, orgIds: string[]): Promise<string[]> {
    return projectAssignmentsByUserInOrgs(userId, orgIds);
  },
};

async function projectAssignmentsByUserInOrgs(userId: string, orgIds: string[]): Promise<string[]> {
  if (orgIds.length === 0) return [];
  const rows = await db
    .select({ projectId: projectAssignments.projectId })
    .from(projectAssignments)
    .where(and(eq(projectAssignments.userId, userId), inArray(projectAssignments.organizationId, orgIds)));
  return rows.map((r) => r.projectId);
}