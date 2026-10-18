/**
 * assistant_skills 全局共享 CRUD（校验 + 落库共用层）。
 * 由 skillsRoute.ts（REST /api/assistant/skills，router.ts requireManager 保护）与
 * 空间助手 manage_skill 工具共同调用——两类写入面必须是同一套规则。
 *
 * 2026-10-19 存储翻转：**本层只管元数据**。正文与目录树在 SKILLS_ROOT/<name>/，
 * 由 import_skill / 设置页文件树编辑器写入；create 建骨架目录，delete 连目录一起删。
 *
 * 无 scope：skills 是平台级全局共享（所有项目同一个技能库），DB 无归属列。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { asc, and, eq, ne } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantSkills } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { removeSkillDir, writeSkillFileAtomic } from './skillPaths.js';
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

/** name 唯一性检查（跨全库，全局共享无归属）；冲突 → 409。 */
export async function assertSkillNameUnique(name: string, excludeId?: string): Promise<void> {
  const conds: SQL[] = [eq(assistantSkills.name, name)];
  if (excludeId) conds.push(ne(assistantSkills.id, excludeId));
  const dup = (await db.select({ id: assistantSkills.id }).from(assistantSkills).where(and(...conds)).limit(1))[0];
  if (dup) throw new HttpError(409, 'conflict', 'skill 名称已存在');
}

/** 写 SKILL.md 骨架：frontmatter 的 name/description 由 DB 值回填（磁盘正文是真身，前言是索引）。 */
function writeSkillMd(dir: string, name: string, description: string, body = ''): void {
  writeSkillFileAtomic(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`,
  );
}

/** 只插 DB 行不建目录（import_skill 复用：目录树已由导入流程写好）。 */
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

/** POST 语义：建目录 + SKILL.md 骨架 + 插行。磁盘上已有同名目录也判冲突——否则会静默接管孤儿目录。 */
export async function createSkill(raw: Record<string, unknown>): Promise<SkillWithDisk> {
  const name = assertSkillName(raw.name);
  const description = assertDescription(raw.description);
  await assertSkillNameUnique(name);
  const dir = skillDirOf(name);
  if (fs.existsSync(dir)) throw new HttpError(409, 'conflict', `磁盘上已存在同名目录: ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    writeSkillMd(dir, name, description);
    const row = await registerSkill(name, description, raw.enabled === false ? false : true);
    return withDisk(row);
  } catch (e) {
    // DB 失败不留空目录在盘上。
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** PATCH：description/enabled 只动 DB；改名要搬目录（目标已存在 → 409；DB 写失败 → 搬回去）。 */
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
      try { fs.renameSync(skillDirOf(patch.name as string), skillDirOf(renamedFrom)); } catch { /* 回滚失败只能靠人工 */ }
    }
    throw new HttpError(404, 'not_found', 'skill 不存在');
  }
  return withDisk(updated[0]!);
}

/** DELETE：删行 + 删目录（目录删除走 removeSkillDir，校验父目录恰为 SKILLS_ROOT）。 */
export async function deleteSkill(id: string): Promise<void> {
  const existing = (await db.select().from(assistantSkills).where(eq(assistantSkills.id, id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'skill 不存在');
  const deleted = await db.delete(assistantSkills).where(eq(assistantSkills.id, id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'skill 不存在');
  removeSkillDir(SKILLS_ROOT, existing.name);
}

/** 列表 = DB 行（拼磁盘统计）+ 孤儿目录合成行。enabled 过滤时不含孤儿（孤儿没有 enabled 语义）。 */
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
