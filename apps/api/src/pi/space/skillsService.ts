/**
 * assistant_skills 全局共享 CRUD（校验 + 落库共用层）。
 * 由 skillsRoute.ts（REST /api/assistant/skills，router.ts requireManager 保护）与
 * 空间助手 manage_skill 工具共同调用——两类写入面必须是同一套规则
 * （name slug 校验 / name 唯一 / scripts normalize / enabled 语义），不再各写一遍。
 *
 * 无 scope：skills 是平台级全局共享（所有项目同一个技能库），DB 无归属列。
 * scripts 每条含 filename/runtime/content（runtime ∈ node|python3|bash|sh）。
 */
import { randomUUID } from 'node:crypto';
import { asc, and, eq, ne } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantSkills } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { isSafeScriptFilename, isSafeSkillName, isScriptRuntime, SCRIPT_RUNTIMES } from './skillsStore.js';

export type SkillScriptInput = { filename?: unknown; runtime?: unknown; content?: unknown };

/** 校验并归一化 scripts 数组；脏项 → 400。空数组合法（纯知识 skill）。 */
export function normalizeScripts(raw: unknown): Array<{ filename: string; runtime: string; content: string }> {
  const arr = Array.isArray(raw) ? raw : undefined;
  if (arr === undefined) throw new HttpError(400, 'bad_request', 'scripts 必须是数组');
  const out: Array<{ filename: string; runtime: string; content: string }> = [];
  for (const item of arr) {
    const s = item as SkillScriptInput | null;
    if (!s || typeof s !== 'object') throw new HttpError(400, 'bad_request', 'scripts 元素必须是对象');
    const filename = typeof s.filename === 'string' ? s.filename : '';
    const runtime = typeof s.runtime === 'string' ? s.runtime : '';
    const content = typeof s.content === 'string' ? s.content : '';
    if (!isSafeScriptFilename(filename)) throw new HttpError(400, 'bad_request', `scripts 文件名非法: ${filename}`);
    if (!isScriptRuntime(runtime)) throw new HttpError(400, 'bad_request', `scripts runtime 必须是 ${SCRIPT_RUNTIMES.join('|')}: ${runtime}`);
    out.push({ filename, runtime, content });
  }
  return out;
}

export function assertSkillName(name: unknown): string {
  if (typeof name !== 'string') throw new HttpError(400, 'bad_request', 'name 必填');
  const n = name.trim();
  if (!isSafeSkillName(n)) throw new HttpError(400, 'bad_request', 'name 必须是小写 slug（仅字母/数字/-，不以 - 开头/结尾且无连续 --；skills loader 兼容）');
  return n;
}

/** name 唯一性检查（跨全库，全局共享无归属）；冲突 → 409。 */
export async function assertSkillNameUnique(name: string, excludeId?: string): Promise<void> {
  const conds: SQL[] = [eq(assistantSkills.name, name)];
  if (excludeId) conds.push(ne(assistantSkills.id, excludeId));
  const dup = (await db.select({ id: assistantSkills.id }).from(assistantSkills).where(and(...conds)).limit(1))[0];
  if (dup) throw new HttpError(409, 'conflict', 'skill 名称已存在');
}

/** 列表（可选 enabled 过滤），按 name 排序。GET / 与工具 list 共用。 */
export function listSkills(enabled?: boolean) {
  const conds: SQL[] = [];
  if (enabled !== undefined) conds.push(eq(assistantSkills.enabled, enabled));
  return db.select().from(assistantSkills).where(and(...conds)).orderBy(asc(assistantSkills.name));
}

/** POST 语义：全量校验 + 插入；冲突 → 409。 */
export async function createSkill(raw: Record<string, unknown>) {
  const name = assertSkillName(raw.name);
  await assertSkillNameUnique(name);
  const description = typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : '';
  if (!description) throw new HttpError(400, 'bad_request', 'description 必填');
  if (description.length > 500) throw new HttpError(400, 'bad_request', 'description 最长 500 字符');
  const body = typeof raw.body === 'string' && raw.body.trim() ? raw.body.trim() : '';
  if (!body) throw new HttpError(400, 'bad_request', 'body(SKILL.md) 必填');
  const scripts = normalizeScripts(raw.scripts ?? []);
  const rows = await db.insert(assistantSkills).values({
    id: randomUUID(),
    name,
    description,
    body,
    scripts,
    enabled: raw.enabled === false ? false : true,
  }).returning();
  return rows[0]!;
}

/** PATCH 语义：载旧行（404）→ 逐字段 diff 校验 → 更新。 */
export async function updateSkill(id: string, raw: Record<string, unknown>) {
  const existing = (await db.select().from(assistantSkills).where(eq(assistantSkills.id, id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'skill 不存在');
  const patch: Partial<typeof assistantSkills.$inferInsert> = {};
  const p = raw;
  if ('name' in p) {
    const name = assertSkillName(p.name);
    await assertSkillNameUnique(name, existing.id);
    patch.name = name;
  }
  if ('description' in p) {
    const description = typeof p.description === 'string' && p.description.trim() ? p.description.trim() : '';
    if (!description) throw new HttpError(400, 'bad_request', 'description 必填');
    if (description.length > 500) throw new HttpError(400, 'bad_request', 'description 最长 500 字符');
    patch.description = description;
  }
  if ('body' in p) {
    const body = typeof p.body === 'string' && p.body.trim() ? p.body.trim() : '';
    if (!body) throw new HttpError(400, 'bad_request', 'body(SKILL.md) 必填');
    patch.body = body;
  }
  if ('scripts' in p) patch.scripts = normalizeScripts(p.scripts ?? []);
  if ('enabled' in p) patch.enabled = p.enabled === false ? false : true;
  const updated = await db.update(assistantSkills)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(assistantSkills.id, id))
    .returning();
  if (updated.length === 0) throw new HttpError(404, 'not_found', 'skill 不存在');
  return updated[0]!;
}

/** DELETE 语义：载旧行（404）→ 删除。 */
export async function deleteSkill(id: string): Promise<void> {
  const existing = (await db.select().from(assistantSkills).where(eq(assistantSkills.id, id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'skill 不存在');
  const deleted = await db.delete(assistantSkills)
    .where(eq(assistantSkills.id, id))
    .returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'skill 不存在');
}