/**
 * assistant_guides minimal CRUD (admin side, no UI; admin UI belongs to a later requirement).
 * Mounted at /api/assistant/guides, protected by requireManager at router.ts.
 *
 * Visibility (consistent with the rest of the space routes, asserted via projectAccess.ts):
 *  - scope=global guides are instance-level shared (seed rows, global ops instructions), visible/manageable by any manager;
 *  - scope=project/version guides belong to a specific org, visible/manageable only by that org's (subtree) users,
 *    cross-org access always 404 (no distinction between "not found" and "invisible", preventing existence probing).
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

/** guide-row visibility assertion: global shared; project/version org-owned, cross-org 404. */
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
  // and(...[]) returns undefined = no filter (drizzle semantics)
  const rows = await db.select().from(assistantGuides)
    .where(and(...conds))
    .orderBy(asc(assistantGuides.sort), desc(assistantGuides.createdAt));
  // Visibility filter: global returned in full; project/version returned only within visible projects (one visible-projects query + one version→project merge, avoiding per-row assertions)
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
    return true; // global: instance-level shared
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
    // Switching scope to project/version must supply the corresponding id in the same PATCH, otherwise a stale id remains (same semantics as POST)
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
  // Post-change scope visibility: newly supplied or carried-over project/version ids must both point at visible projects
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