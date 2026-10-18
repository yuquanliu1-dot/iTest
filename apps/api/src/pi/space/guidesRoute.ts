/**
 * assistant_guides 最小 CRUD（管理端，无 UI；管理 UI 归后续需求）。
 * 挂载于 /api/assistant/guides，router.ts 处 requireManager 保护。
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantGuides } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';

export const guidesRoute = Router();

const SCOPE = ['global', 'project', 'version'] as const;
const KIND = ['flow', 'reference'] as const;
const LANG = ['zh', 'en', 'any'] as const;

guidesRoute.get('/', async (req, res) => {
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
  res.json(rows);
});

guidesRoute.post('/', async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const scope = b.scope as string;
  if (!SCOPE.includes(scope as never)) throw new HttpError(400, 'bad_request', 'scope 必须是 global|project|version');
  if (scope === 'project' && typeof b.projectId !== 'string') throw new HttpError(400, 'bad_request', 'scope=project 需要 projectId');
  if (scope === 'version' && typeof b.versionId !== 'string') throw new HttpError(400, 'bad_request', 'scope=version 需要 versionId');
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
  const patch: Partial<typeof assistantGuides.$inferInsert> = {};
  const p = req.body as Record<string, unknown>;
  if ('kind' in p) {
    if (!KIND.includes(p.kind as never)) throw new HttpError(400, 'bad_request', 'kind 必须是 flow|reference');
    patch.kind = p.kind as string;
  }
  if ('scope' in p) {
    const scope = p.scope as string;
    if (!SCOPE.includes(scope as never)) throw new HttpError(400, 'bad_request', 'scope 必须是 global|project|version');
    patch.scope = scope;
    patch.projectId = scope === 'project' ? (p.projectId as string | null) : null;
    patch.versionId = scope === 'version' ? (p.versionId as string | null) : null;
  } else {
    if ('projectId' in p) patch.projectId = p.projectId as string | null;
    if ('versionId' in p) patch.versionId = p.versionId as string | null;
  }
  if ('body' in p) patch.body = typeof p.body === 'string' ? p.body.trim() : (p.body as string);
  if ('lang' in p) {
    if (!LANG.includes(p.lang as never)) throw new HttpError(400, 'bad_request', 'lang 必须是 zh|en|any');
    patch.lang = p.lang as string;
  }
  if ('sort' in p) patch.sort = typeof p.sort === 'number' ? p.sort : undefined;
  if ('enabled' in p) patch.enabled = p.enabled === false ? false : true;
  const updated = await db.update(assistantGuides)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(assistantGuides.id, req.params.id))
    .returning();
  if (updated.length === 0) throw new HttpError(404, 'not_found', 'guide 不存在');
  res.json(updated[0]);
});

guidesRoute.delete('/:id', async (req, res) => {
  const deleted = await db.delete(assistantGuides)
    .where(eq(assistantGuides.id, req.params.id))
    .returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'guide 不存在');
  res.status(204).end();
});