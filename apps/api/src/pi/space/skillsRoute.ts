/**
 * assistant_skills globally-shared CRUD + file tree API (managed by the system settings page; every space thread loads all enabled skills).
 * Mounted at /api/assistant/skills, protected by requireManager in router.ts.
 *
 * Always delegates to skillsService (the shared validation + persistence layer), same rules as the space assistant's manage_skill tool.
 * No scope: skills are platform-level globally shared (all projects share one skill library); the DB has no ownership column.
 *
 * The file tree API always locates by **skill id**, with the server resolving the name from the DB row — the top-level path segment is
 * always a slug that passed isSafeSkillName, and the client cannot specify directory names. Per-file reads/writes all go through the resolveInSkill guard
 * (realpath resolution + per-segment rejection of .git/node_modules/hidden files + optionally requiring the parent directory to exist).
 */
import fs from 'node:fs';
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantSkills } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import {
  createSkill,
  deleteSkill,
  listSkills,
  updateSkill,
} from './skillsService.js';
import { isSafeSkillName, listSkillTree, SKILLS_ROOT, skillDirOf } from './skillsStore.js';
import { removeSkillDir, resolveInSkill, writeSkillFileAtomic } from './skillPaths.js';

export const skillsRoute = Router();

const MAX_FILE_READ_CHARS = 60_000;
const MAX_FILE_WRITE_BYTES = 1_000_000;
const MAX_UPLOAD_FILES = 20;

/** :id → { name, dir }; 404 when no DB row. id is the only entry parameter; name is always resolved server-side. */
async function dirOfSkill(id: string): Promise<{ name: string; dir: string }> {
  const row = (await db.select({ name: assistantSkills.name }).from(assistantSkills)
    .where(eq(assistantSkills.id, id)).limit(1))[0];
  if (!row) throw new HttpError(404, 'not_found', 'skill 不存在');
  return { name: row.name, dir: skillDirOf(row.name) };
}

skillsRoute.get('/', async (req, res) => {
  const q = req.query;
  const enabled = q.enabled === 'true' ? true : q.enabled === 'false' ? false : undefined;
  res.json(await listSkills(enabled));
});

skillsRoute.post('/', async (req, res) => {
  res.status(201).json(await createSkill(req.body as Record<string, unknown>));
});

skillsRoute.patch('/:id', async (req, res) => {
  res.json(await updateSkill(req.params.id, req.body as Record<string, unknown>));
});

skillsRoute.delete('/:id', async (req, res) => {
  await deleteSkill(req.params.id);
  res.status(204).end();
});

/** Delete orphan directories: a directory exists on disk but has no DB row (id=null, so the :id endpoints can never reach it).
 *  Such directories cannot be loaded by any session (the catalog only recognizes DB rows); keeping them just leaves a permanent dangling entry in the settings page list.
 *  name passes the double guard of isSafeSkillName + removeSkillDir, so what gets deleted is always a direct child of SKILLS_ROOT. */
skillsRoute.delete('/orphan/:name', async (req, res) => {
  const name = String(req.params.name ?? '');
  if (!isSafeSkillName(name)) throw new HttpError(400, 'bad_request', `skill 名称非法: ${name}`);
  const row = (await db.select({ id: assistantSkills.id }).from(assistantSkills)
    .where(eq(assistantSkills.name, name)).limit(1))[0];
  // Registered skills go through DELETE /:id (deleting the DB row too); this route only handles unregistered orphans.
  if (row) throw new HttpError(409, 'conflict', `「${name}」已登记，请用常规删除`);
  if (!fs.existsSync(skillDirOf(name))) throw new HttpError(404, 'not_found', `skill 目录不存在: ${name}`);
  removeSkillDir(SKILLS_ROOT, name);
  res.status(204).end();
});

skillsRoute.get('/:id/tree', async (req, res) => {
  const { dir } = await dirOfSkill(req.params.id);
  if (!fs.existsSync(dir)) throw new HttpError(404, 'not_found', 'skill 目录缺失');
  res.json(listSkillTree(dir));
});

skillsRoute.get('/:id/file', async (req, res) => {
  const { dir } = await dirOfSkill(req.params.id);
  const rel = String(req.query.path ?? '');
  const abs = resolveInSkill(dir, rel);
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new HttpError(400, 'bad_request', `路径非法或不存在: ${rel}`);
  }
  const raw = fs.readFileSync(abs, 'utf8');
  res.json({ path: rel, content: raw.slice(0, MAX_FILE_READ_CHARS), truncated: raw.length > MAX_FILE_READ_CHARS });
});

skillsRoute.put('/:id/file', async (req, res) => {
  const { dir } = await dirOfSkill(req.params.id);
  const rel = String(req.body?.path ?? '');
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const abs = resolveInSkill(dir, rel, { requireParentExisting: true });
  if (!abs) throw new HttpError(400, 'bad_request', `路径非法或父目录不存在: ${rel}`);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_FILE_WRITE_BYTES) throw new HttpError(400, 'bad_request', `单文件上限 1MB，当前 ${bytes} 字节`);
  writeSkillFileAtomic(abs, content);
  res.json({ ok: true, path: rel });
});

skillsRoute.delete('/:id/file', async (req, res) => {
  const { dir } = await dirOfSkill(req.params.id);
  const rel = String(req.query.path ?? '');
  const abs = resolveInSkill(dir, rel);
  if (!abs || !fs.existsSync(abs)) throw new HttpError(400, 'bad_request', `路径非法或不存在: ${rel}`);
  if (!fs.statSync(abs).isFile()) {
    throw new HttpError(400, 'bad_request', `只能删文件，删整个技能请用 DELETE /skills/:id: ${rel}`);
  }
  fs.rmSync(abs, { force: true });
  res.status(204).end();
});

skillsRoute.post('/:id/files', async (req, res) => {
  const { dir } = await dirOfSkill(req.params.id);
  const sub = typeof req.body?.dir === 'string' && req.body.dir ? req.body.dir : '.';
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (files.length === 0) throw new HttpError(400, 'bad_request', 'files 不能为空');
  if (files.length > MAX_UPLOAD_FILES) throw new HttpError(400, 'bad_request', `单次最多 ${MAX_UPLOAD_FILES} 个文件`);
  const written: string[] = [];
  for (const f of files) {
    const name = String((f as { path?: unknown })?.path ?? '');
    const rel = sub === '.' ? name : `${sub}/${name}`;
    const content = typeof (f as { content?: unknown })?.content === 'string' ? String((f as { content: string }).content) : '';
    const abs = resolveInSkill(dir, rel, { requireParentExisting: true });
    if (!abs) throw new HttpError(400, 'bad_request', `路径非法或父目录不存在: ${rel}`);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_WRITE_BYTES) throw new HttpError(400, 'bad_request', `单文件上限 1MB: ${rel}`);
    writeSkillFileAtomic(abs, content);
    written.push(rel);
  }
  res.json({ ok: true, written });
});
