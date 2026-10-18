/**
 * assistant_skills 全局共享 CRUD + 文件树接口（系统设置页管理；所有空间线程加载全量启用 skills）。
 * 挂载于 /api/assistant/skills，router.ts 处 requireManager 保护。
 *
 * 一律委托 skillsService（校验 + 落库共用层），与空间助手 manage_skill 工具同规则。
 * 无 scope：skills 是平台级全局共享（所有项目同一个技能库），DB 无归属列。
 *
 * 文件树接口一律用 **skill id** 定位，服务端从 DB 行解析 name——顶层路径段永远是过了
 * isSafeSkillName 的 slug，客户端无法指定目录名。逐文件读写全走 resolveInSkill 守卫
 * （realpath 解析 + 逐段拒 .git/node_modules/隐藏文件 + 可选要求父目录存在）。
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
import { listSkillTree, skillDirOf } from './skillsStore.js';
import { resolveInSkill, writeSkillFileAtomic } from './skillPaths.js';

export const skillsRoute = Router();

const MAX_FILE_READ_CHARS = 60_000;
const MAX_FILE_WRITE_BYTES = 1_000_000;
const MAX_UPLOAD_FILES = 20;

/** :id → { name, dir }；DB 无行 404。id 是唯一入口参数，name 一律服务端解析。 */
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
