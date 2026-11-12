/**
 * Project ACL: assignments (user ⇄ project allocation). Auth model:
 *   - manager: requires the caller to be an admin of the project's owning org (or an ancestor)
 *   - user: requires the caller to have an assignment for the project in project_assignments
 *
 * Difference from assertProjectVisible: assignments allow a user to be allocated to a project across orgs.
 * iTest currently uses assertProjectVisible for "project visibility"; assignments serve only as
 * the "user's extra identity under that project"; reads still go through projectAccess's subtree + cross-org assignment.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { organizationMembers, productLines, projectAssignments, projects, users } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { getOrgPath, subtreeOrgIds } from './orgTree.js';
import { isManagerOfOrg } from '../middleware/auth.js';
import type { AuthUser } from './auth.service.js';

/** Resolve project → owning org id (via product_lines); returns null when the project doesn't exist. */
async function projectOrgId(projectId: string): Promise<string | null> {
  const rows = await db
    .select({ organizationId: productLines.organizationId })
    .from(projects)
    .innerJoin(productLines, eq(productLines.id, projects.productLineId))
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows[0]?.organizationId ?? null;
}

/**
 * Whether the project is visible. manager goes through subtree judgment; user goes through "I have an assignment for this project".
 * Cross-org assignments allow a user to see projects outside their activated org (same as iDO).
 *
 * Note: projectAssignments.organizationId is only a snapshot of the org at assignment time (for audit);
 * we deliberately don't use it as the visibility gate — since R2 the project's org has a single source of truth: its product line.
 */
export async function assertProjectVisibleForAssignments(projectId: string, user: AuthUser): Promise<void> {
  const orgId = await projectOrgId(projectId);
  if (!orgId) throw new HttpError(404, 'not_found', 'project not found');
  const orgPath = await getOrgPath(orgId);
  if (!orgPath) throw new HttpError(404, 'not_found', 'project not found');
  if (isManagerOfOrg(user, orgPath)) return;
  const assignmentRows = await db
    .select({ id: projectAssignments.id })
    .from(projectAssignments)
    .where(eq(projectAssignments.projectId, projectId));
  if (!assignmentRows.length) throw new HttpError(404, 'not_found', 'project not found');
  const membershipRows = await db
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, user.userId));
  const visibleOrgIds = new Set<string>();
  for (const p of user.managerOrgPaths) {
    if (!p) continue;
    for (const id of await subtreeOrgIds(p)) visibleOrgIds.add(id);
  }
  for (const m of membershipRows) visibleOrgIds.add(m.organizationId);
  // The assignment snapshot (project_assignments.organization_id) is the org at assignment time; after rehoming it drifts from the project's current org;
  // visibility only looks at the project's current org (orgId, computed above) — it just needs to fall in the caller's visible set.
  if (!visibleOrgIds.has(orgId)) throw new HttpError(404, 'not_found', 'project not found');
}

export const assignmentsService = {
  /** Assigned users (paginated + fuzzy search on username/displayName) */
  async list(projectId: string, opts: { q?: string; page: number; limit: number }): Promise<{ items: Array<{ id: string; userId: string; username: string; displayName: string; assignedAt: string }>; total: number; page: number; limit: number }> {
    const page = Math.min(Math.max(1, Math.trunc(opts.page)), 1_000_000);
    const limit = Math.min(Math.max(1, Math.trunc(opts.limit)), 100);
    const pattern = opts.q && opts.q.trim() ? `%${opts.q.trim()}%` : null;
    const where = pattern
      ? sql`${projectAssignments.projectId} = ${projectId} AND (${users.username} ILIKE ${pattern} OR ${users.displayName} ILIKE ${pattern})`
      : eq(projectAssignments.projectId, projectId);
    const [items, totalRows] = await Promise.all([
      db
        .select({
          id: projectAssignments.id,
          userId: projectAssignments.userId,
          username: users.username,
          displayName: users.displayName,
          assignedAt: projectAssignments.assignedAt,
        })
        .from(projectAssignments)
        .innerJoin(users, eq(users.id, projectAssignments.userId))
        .where(where)
        .orderBy(users.username)
        .limit(limit)
        .offset((page - 1) * limit),
      db
        .select({ count: sql<number>`count(*)` })
        .from(projectAssignments)
        .innerJoin(users, eq(users.id, projectAssignments.userId))
        .where(where),
    ]);
    return {
      items: items.map((it) => ({
        id: it.id,
        userId: it.userId,
        username: it.username,
        displayName: it.displayName,
        assignedAt: (it.assignedAt as Date).toISOString(),
      })),
      total: Number(totalRows[0]?.count ?? 0),
      page,
      limit,
    };
  },

  /** Bulk assign: dedupe userIds + skip existing; returns the final full set of assignments. */
  async assignMany(projectId: string, userIds: string[], organizationId: string): Promise<{ added: number; total: number }> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) {
      const totalRows = await db
        .select({ count: sql<number>`count(*)` })
        .from(projectAssignments)
        .where(eq(projectAssignments.projectId, projectId));
      return { added: 0, total: Number(totalRows[0]?.count ?? 0) };
    }
    // Exclude already-existing ones
    const existing = await db
      .select({ userId: projectAssignments.userId })
      .from(projectAssignments)
      .where(eq(projectAssignments.projectId, projectId));
    const existingSet = new Set(existing.map((e) => e.userId));
    const toAdd = unique.filter((u) => !existingSet.has(u));
    if (toAdd.length > 0) {
      await db.insert(projectAssignments).values(
        toAdd.map((userId) => ({
          projectId,
          userId,
          organizationId,
        })),
      );
    }
    const totalRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(projectAssignments)
      .where(eq(projectAssignments.projectId, projectId));
    return { added: toAdd.length, total: Number(totalRows[0]?.count ?? 0) };
  },

  async unassign(projectId: string, userId: string): Promise<void> {
    await db
      .delete(projectAssignments)
      .where(sql`${projectAssignments.projectId} = ${projectId} AND ${projectAssignments.userId} = ${userId}`);
  },
};