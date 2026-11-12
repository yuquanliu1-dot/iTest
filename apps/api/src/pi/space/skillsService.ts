/**
 * assistant_skills globally-shared CRUD (the shared validation + persistence layer).
 * Called by both skillsRoute.ts (REST /api/assistant/skills, protected by requireManager in router.ts) and
 * the space assistant's manage_skill tool — the two write surfaces must follow one and the same rule set.
 *
 * 2026-10-19 storage flip: **this layer only manages metadata + create's disk writes**. The body and directory tree live in SKILLS_ROOT/<name>/;
 * create with files[] writes the full content in one shot, without it writes a skeleton; import_skill / settings-page file tree editor write the rest;
 * delete removes the directory along with the row.
 *
 * No scope: skills are platform-level globally shared (all projects share one skill library); the DB has no ownership column.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { asc, and, eq, ne } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantSkills } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { removeSkillDir, resolveInSkill, writeSkillFileAtomic } from './skillPaths.js';
import {
  SKILLS_ROOT,
  countSkillFiles,
  isSafeSkillName,
  listOrphanSkillDirs,
  skillDirOf,
} from './skillsStore.js';

export function assertSkillName(name: unknown): string {
  if (typeof name !== 'string') throw new HttpError(400, 'bad_request', 'name 必填');
  const n = name.trim();
  if (!isSafeSkillName(n)) throw new HttpError(400, 'bad_request', 'name 必须是小写 slug（仅字母/数字/-，不以 - 开头/结尾且无连续 --；skills loader 兼容）');
  return n;
}

function assertDescription(v: unknown): string {
  const d = typeof v === 'string' ? v.trim() : '';
  if (!d) throw new HttpError(400, 'bad_request', 'description 必填');
  if (d.length > 500) throw new HttpError(400, 'bad_request', 'description 最长 500 字符');
  return d;
}

/** name uniqueness check (repo-wide, globally shared with no ownership); conflict → 409. */
export async function assertSkillNameUnique(name: string, excludeId?: string): Promise<void> {
  const conds: SQL[] = [eq(assistantSkills.name, name)];
  if (excludeId) conds.push(ne(assistantSkills.id, excludeId));
  const dup = (await db.select({ id: assistantSkills.id }).from(assistantSkills).where(and(...conds)).limit(1))[0];
  if (dup) throw new HttpError(409, 'conflict', 'skill 名称已存在');
}

/** Write the SKILL.md skeleton: frontmatter name/description are backfilled from DB values (the on-disk body is the real thing; the preamble is the index). */
export function writeSkillMd(dir: string, name: string, description: string, body = ''): void {
  writeSkillFileAtomic(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`,
  );
}

export interface SkillFileInput { path: string; content: string }

const MAX_CREATE_FILES = 20;
const MAX_CREATE_FILE_BYTES = 1_000_000; // same amount as skillsRoute's MAX_FILE_WRITE_BYTES.

/** Validate files[] (at the shape level); the path-level guard goes through resolveInSkill in the persistence loop. */
function assertSkillFiles(raw: unknown): SkillFileInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, 'bad_request', `files 须为非空数组（每项 {path, content}）`);
  }
  if (raw.length > MAX_CREATE_FILES) throw new HttpError(400, 'bad_request', `files 最多 ${MAX_CREATE_FILES} 个`);
  if (!raw.some((f) => (f as SkillFileInput)?.path === 'SKILL.md')) {
    throw new HttpError(400, 'bad_request', 'files 必须包含 SKILL.md（技能正文入口）');
  }
  const seen = new Set<string>();
  return raw.map((f, i) => {
    const p = typeof (f as SkillFileInput)?.path === 'string' ? (f as SkillFileInput).path.trim() : '';
    const c = typeof (f as SkillFileInput)?.content === 'string' ? (f as SkillFileInput).content : '';
    if (!p) throw new HttpError(400, 'bad_request', `files[${i}].path 必填`);
    if (seen.has(p)) throw new HttpError(400, 'bad_request', `files 路径重复: ${p}`);
    seen.add(p);
    if (Buffer.byteLength(c, 'utf8') > MAX_CREATE_FILE_BYTES) {
      throw new HttpError(400, 'bad_request', `单文件上限 1MB: ${p}`);
    }
    return { path: p, content: c };
  });
}

/** Persist files[] into the skill directory. When SKILL.md lacks frontmatter it is auto-prepended (catalog/loader depend on the name/description preamble).
 *  Two-phase: run resolveInSkill on all paths first; only when everything is green, mkdirSync the parent directories —
 *  otherwise paths like '../x' would create directories outside the skill directory【before】validation rejects them. */
function writeSkillFiles(dir: string, name: string, description: string, files: SkillFileInput[]): void {
  const absOf = files.map((f) => {
    const abs = resolveInSkill(dir, f.path);
    if (!abs) throw new HttpError(400, 'bad_request', `路径非法: ${f.path}`);
    return abs;
  });
  absOf.forEach((abs, i) => {
    if (path.dirname(abs) !== dir) fs.mkdirSync(path.dirname(abs), { recursive: true });
    let content = files[i]!.content;
    if (files[i]!.path === 'SKILL.md' && !content.startsWith('---\n')) {
      content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${content}`;
    }
    writeSkillFileAtomic(abs, content);
  });
}

/** Insert only the DB row, no directory (reused by import_skill: the directory tree was already written by the import flow). */
export async function registerSkill(name: string, description: string, enabled = true) {
  await assertSkillNameUnique(name);
  const rows = await db.insert(assistantSkills)
    .values({ id: randomUUID(), name, description, enabled })
    .returning();
  return rows[0]!;
}

export type SkillRow = Awaited<ReturnType<typeof registerSkill>>;
export type SkillWithDisk = SkillRow & {
  fileCount: number;
  totalBytes: number;
  onDisk: boolean;
  unregistered: boolean;
};

function withDisk(row: SkillRow): SkillWithDisk {
  const dir = skillDirOf(row.name);
  return { ...row, ...countSkillFiles(dir), onDisk: fs.existsSync(dir), unregistered: false };
}

/** POST semantics: create the directory + insert the row. With files[], the full content is written in one shot (at least SKILL.md); without it, only the skeleton.
 *  An existing same-named directory on disk is also a conflict — otherwise the orphan directory would be silently taken over. */
export async function createSkill(raw: Record<string, unknown>): Promise<SkillWithDisk> {
  const name = assertSkillName(raw.name);
  const description = assertDescription(raw.description);
  await assertSkillNameUnique(name);
  const dir = skillDirOf(name);
  if (fs.existsSync(dir)) throw new HttpError(409, 'conflict', `磁盘上已存在同名目录: ${name}`);
  const files = raw.files === undefined ? null : assertSkillFiles(raw.files);
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (files) writeSkillFiles(dir, name, description, files);
    else writeSkillMd(dir, name, description);
    const row = await registerSkill(name, description, raw.enabled === false ? false : true);
    return withDisk(row);
  } catch (e) {
    // A DB/disk-write failure must not leave a half-built directory on disk.
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** PATCH: description/enabled only touch the DB; renaming moves the directory (target exists → 409; DB write failure → move back). */
export async function updateSkill(id: string, raw: Record<string, unknown>): Promise<SkillWithDisk> {
  const existing = (await db.select().from(assistantSkills).where(eq(assistantSkills.id, id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'skill 不存在');
  const patch: Partial<typeof assistantSkills.$inferInsert> = {};
  if ('description' in raw) patch.description = assertDescription(raw.description);
  if ('enabled' in raw) patch.enabled = raw.enabled === false ? false : true;

  let renamedFrom: string | null = null;
  if ('name' in raw && raw.name !== existing.name) {
    const name = assertSkillName(raw.name);
    await assertSkillNameUnique(name, existing.id);
    const from = skillDirOf(existing.name);
    const to = skillDirOf(name);
    if (fs.existsSync(to)) throw new HttpError(409, 'conflict', `磁盘上已存在同名目录: ${name}`);
    if (fs.existsSync(from)) { fs.renameSync(from, to); renamedFrom = existing.name; }
    patch.name = name;
  }
  const updated = await db.update(assistantSkills)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(assistantSkills.id, id))
    .returning();
  if (updated.length === 0) {
    if (renamedFrom) {
      try { fs.renameSync(skillDirOf(patch.name as string), skillDirOf(renamedFrom)); } catch { /* a rollback failure can only be fixed manually */ }
    }
    throw new HttpError(404, 'not_found', 'skill 不存在');
  }
  return withDisk(updated[0]!);
}

/** DELETE: delete the row + the directory (directory deletion goes through removeSkillDir, which validates the parent is exactly SKILLS_ROOT). */
export async function deleteSkill(id: string): Promise<void> {
  const existing = (await db.select().from(assistantSkills).where(eq(assistantSkills.id, id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'skill 不存在');
  const deleted = await db.delete(assistantSkills).where(eq(assistantSkills.id, id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'skill 不存在');
  removeSkillDir(SKILLS_ROOT, existing.name);
}

/** List = DB rows (joined with disk stats) + synthesized rows for orphan directories. With the enabled filter, orphans are excluded (orphans carry no enabled semantics). */
export async function listSkills(enabled?: boolean): Promise<SkillWithDisk[]> {
  const rows = enabled === undefined
    ? await db.select().from(assistantSkills).orderBy(asc(assistantSkills.name))
    : await db.select().from(assistantSkills).where(eq(assistantSkills.enabled, enabled)).orderBy(asc(assistantSkills.name));
  const withDisks = rows.map(withDisk);
  if (enabled !== undefined) return withDisks;
  const orphans: SkillWithDisk[] = listOrphanSkillDirs(rows.map((r) => r.name)).map((name) => ({
    id: null as unknown as SkillRow['id'],
    name,
    description: '',
    enabled: false,
    createdAt: null as unknown as SkillRow['createdAt'],
    updatedAt: null as unknown as SkillRow['updatedAt'],
    ...countSkillFiles(skillDirOf(name)),
    onDisk: true,
    unregistered: true,
  }));
  return [...withDisks, ...orphans];
}
