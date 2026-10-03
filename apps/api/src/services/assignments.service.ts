/**
 * 项目 ACL：assignments（user ⇄ project 分配）。鉴权模型：
 *   - manager：要求 caller 是项目所属组织（或其祖先）的管理员
 *   - user：要求 caller 在 project_assignments 里有该项目的分配
 *
 * 与 assertProjectVisible 的差别：assignments 允许 user 在跨组织时被分配到项目。
 * 当前 iTest 已用 assertProjectVisible 做「项目可见性」，assignments 仅作为
 * 「user 在该项目下的额外身份」使用；读取仍走 projectAccess 的子树 + 跨组织 assignment。
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { organizationMembers, organizations, projectAssignments, projects, users } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { subtreeOrgIds } from './orgTree.js';
import { isManagerOfOrg } from '../middleware/auth.js';
import type { AuthUser } from './auth.service.js';
import { isPathInSubtree } from './org-path.js';

async function projectOrgPath(projectId: string): Promise<string | null> {
  const rows = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!rows[0]) return null;
  const orgRows = await db
    .select({ path: organizations.path })
    .from(organizations)
    .where(eq(organizations.id, rows[0].organizationId))
    .limit(1);
  return orgRows[0]?.path ?? null;
}

/**
 * 是否可见该项目。manager 走子树判定；user 走「我有该项目的 assignment」。
 * 跨组织 assignment 允许 user 看不属于自己激活组织的项目（与 iDO 一致）。
 */
export async function assertProjectVisibleForAssignments(projectId: string, user: AuthUser): Promise<void> {
  const orgPath = await projectOrgPath(projectId);
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
  // 至少有一个分配项的 organizationId 落在调用者可见组织集合
  const orgIds = Array.from(new Set((await db
    .select({ organizationId: projectAssignments.organizationId })
    .from(projectAssignments)
    .where(eq(projectAssignments.projectId, projectId))).map((r) => r.organizationId)));
  if (!orgIds.some((id) => visibleOrgIds.has(id))) throw new HttpError(404, 'not_found', 'project not found');
}

export const assignmentsService = {
  /** 已分配用户（分页 + 模糊搜索 username/displayName） */
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

  /** 批量分配：userIds 去重 + 跳过已存在；返回最终的全部 assignments。 */
  async assignMany(projectId: string, userIds: string[], organizationId: string): Promise<{ added: number; total: number }> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) {
      const totalRows = await db
        .select({ count: sql<number>`count(*)` })
        .from(projectAssignments)
        .where(eq(projectAssignments.projectId, projectId));
      return { added: 0, total: Number(totalRows[0]?.count ?? 0) };
    }
    // 排除已存在的
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