/**
 * assistant_guides 最小 CRUD（管理端，无 UI；管理 UI 归后续需求）。
 * 挂载于 /api/assistant/guides，router.ts 处 requireManager 保护。
 *
 * 可见性（与空间其余路由一致，经 projectAccess.ts 断言）：
 *  - scope=global 的 guide 实例级共享（seed 行、全局运营指令），任意 manager 可见/可管理；
 *  - scope=project/version 的 guide 归属于具体组织，仅该组织（子树）用户可见/可管理，
 *    跨组织访问一律 404（不区分「不存在」与「不可见」，防存在性探测）。
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantGuides, projectVersions } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AuthUser } from '../../services/auth.service.js';
import { assertProjectVisible, assertVersionVisible, visibleProjectIds } from '../../services/projectAccess.js';

export const guidesRoute = Router();

const SCOPE = ['global', 'project', 'version'] as const;
const KIND = ['flow', 'reference'] as const;
const LANG = ['zh', 'en', 'any'] as const;

/** guide 行可见性断言：global 共享；project/version 归属组织，跨组织 404。 */
async function assertGuideVisible(
  row: Pick<typeof assistantGuides.$inferSelect, 'scope' | 'projectId' | 'versionId'>,
  user: AuthUser,
): Promise<void> {
  if (row.scope === 'project') {
    if (!row.projectId) throw new HttpError(404, 'not_found', 'guide 不存在');
    await assertProjectVisible(row.projectId, user);
  } else if (row.scope === 'version') {
    if (!row.versionId) throw new HttpError(404, 'not_found', 'guide 不存在');
    await assertVersionVisible(row.versionId, user);
  }
}

guidesRoute.get('/', async (req, res) => {
  const user = req.user as AuthUser;
  const q = req.query;
  const conds: SQL[] = [];
  if (typeof q.scope === 'string' && q.scope) conds.push(eq(assistantGuides.scope, q.scope));
  if (typeof q.projectId === 'string' && q.projectId) conds.push(eq(assistantGuides.projectId, q.projectId));
  if (typeof q.versionId === 'string' && q.versionId) conds.push(eq(assistantGuides.versionId, q.versionId));
  if (typeof q.kind === 'string' && q.kind) conds.push(eq(assistantGuides.kind, q.kind));
  if (typeof q.lang === 'string' && q.lang) conds.push(eq(assistantGuides.lang, q.lang));
  // and(...[]) 返回 undefined = 无过滤（drizzle 语义）
  const rows = await db.select().from(assistantGuides)
    .where(and(...conds))
    .orderBy(asc(assistantGuides.sort), desc(assistantGuides.createdAt));
  // 可见性过滤：global 全量返回；project/version 只在可见项目内返回（一次查可见项目 + 一次 version→project 归并，避免逐行断言）
  const visible = new Set(await visibleProjectIds(user));
  const versionRows = rows.filter((r) => r.scope === 'version' && r.versionId != null);
  const versionProject = new Map<string, string>();
  if (versionRows.length > 0) {
    const vp = await db
      .select({ versionId: projectVersions.id, projectId: projectVersions.projectId })
      .from(projectVersions)
      .where(inArray(projectVersions.id, versionRows.map((r) => r.versionId as string)));
    for (const v of vp) versionProject.set(v.versionId, v.projectId);
  }
  const filtered = rows.filter((r) => {
    if (r.scope === 'project') return r.projectId != null && visible.has(r.projectId);
    if (r.scope === 'version') {
      const pid = r.versionId ? versionProject.get(r.versionId) : undefined;
      return pid != null && visible.has(pid);
    }
    return true; // global：实例级共享
  });
  res.json(filtered);
});

guidesRoute.post('/', async (req, res) => {
  const user = req.user as AuthUser;
  const b = req.body as Record<string, unknown>;
  const scope = b.scope as string;
  if (!SCOPE.includes(scope as never)) throw new HttpError(400, 'bad_request', 'scope 必须是 global|project|version');
  if (scope === 'project') {
    if (typeof b.projectId !== 'string') throw new HttpError(400, 'bad_request', 'scope=project 需要 projectId');
    await assertProjectVisible(b.projectId, user);
  }
  if (scope === 'version') {
    if (typeof b.versionId !== 'string') throw new HttpError(400, 'bad_request', 'scope=version 需要 versionId');
    await assertVersionVisible(b.versionId, user);
  }
  const kind = b.kind as string;
  if (!KIND.includes(kind as never)) throw new HttpError(400, 'bad_request', 'kind 必须是 flow|reference');
  if (typeof b.body !== 'string' || !b.body.trim()) throw new HttpError(400, 'bad_request', 'body 必填');
  const lang = (b.lang as string) ?? 'any';
  if (!LANG.includes(lang as never)) throw new HttpError(400, 'bad_request', 'lang 必须是 zh|en|any');
  const rows = await db.insert(assistantGuides).values({
    id: randomUUID(),
    scope,
    projectId: scope === 'project' ? (b.projectId as string) : null,
    versionId: scope === 'version' ? (b.versionId as string) : null,
    kind,
    body: (b.body as string).trim(),
    lang,
    sort: typeof b.sort === 'number' ? b.sort : 0,
    enabled: b.enabled === false ? false : true,
  }).returning();
  res.status(201).json(rows[0]);
});

guidesRoute.patch('/:id', async (req, res) => {
  const user = req.user as AuthUser;
  const existing = (await db.select().from(assistantGuides).where(eq(assistantGuides.id, req.params.id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'guide 不存在');
  await assertGuideVisible(existing, user);
  const patch: Partial<typeof assistantGuides.$inferInsert> = {};
  const p = req.body as Record<string, unknown>;
  if ('kind' in p) {
    if (!KIND.includes(p.kind as never)) throw new HttpError(400, 'bad_request', 'kind 必须是 flow|reference');
    patch.kind = p.kind as string;
  }
  if ('scope' in p) {
    const scope = p.scope as string;
    if (!SCOPE.includes(scope as never)) throw new HttpError(400, 'bad_request', 'scope 必须是 global|project|version');
    // 改 scope 到 project/version 必须在同一次 PATCH 里给对应 id，否则落入陈旧 id（POST 语义一致）
    if (scope === 'project' && typeof p.projectId !== 'string') throw new HttpError(400, 'bad_request', '改 scope=project 需要同时给 projectId');
    if (scope === 'version' && typeof p.versionId !== 'string') throw new HttpError(400, 'bad_request', '改 scope=version 需要同时给 versionId');
    patch.scope = scope;
    patch.projectId = scope === 'project' ? (p.projectId as string) : null;
    patch.versionId = scope === 'version' ? (p.versionId as string) : null;
  } else {
    if ('projectId' in p) patch.projectId = p.projectId as string | null;
    if ('versionId' in p) patch.versionId = p.versionId as string | null;
  }
  if ('body' in p) {
    if (typeof p.body !== 'string' || !p.body.trim()) throw new HttpError(400, 'bad_request', 'body 必填');
    patch.body = p.body.trim();
  }
  if ('lang' in p) {
    if (!LANG.includes(p.lang as never)) throw new HttpError(400, 'bad_request', 'lang 必须是 zh|en|any');
    patch.lang = p.lang as string;
  }
  if ('sort' in p) patch.sort = typeof p.sort === 'number' ? p.sort : undefined;
  if ('enabled' in p) patch.enabled = p.enabled === false ? false : true;
  // 生效后 scope 的可见性：新给/沿用的 project/version id 都必须指向可见项目
  const effScope = (patch.scope as string | undefined) ?? existing.scope;
  if (effScope === 'project') {
    const pid = patch.projectId !== undefined ? (patch.projectId as string | null) : existing.projectId;
    if (!pid) throw new HttpError(400, 'bad_request', 'scope=project 需要 projectId');
    await assertProjectVisible(pid, user);
  } else if (effScope === 'version') {
    const vid = patch.versionId !== undefined ? (patch.versionId as string | null) : existing.versionId;
    if (!vid) throw new HttpError(400, 'bad_request', 'scope=version 需要 versionId');
    await assertVersionVisible(vid, user);
  }
  const updated = await db.update(assistantGuides)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(assistantGuides.id, req.params.id))
    .returning();
  res.json(updated[0]);
});

guidesRoute.delete('/:id', async (req, res) => {
  const user = req.user as AuthUser;
  const existing = (await db.select().from(assistantGuides).where(eq(assistantGuides.id, req.params.id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'guide 不存在');
  await assertGuideVisible(existing, user);
  const deleted = await db.delete(assistantGuides)
    .where(eq(assistantGuides.id, req.params.id))
    .returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'guide 不存在');
  res.status(204).end();
});