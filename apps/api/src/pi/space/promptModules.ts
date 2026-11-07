/**
 * R3 prompt 可编辑化：模块注册表 + DB 值存储解析 + 渲染覆盖。
 *
 * 存储模型：代码是模块注册表（有哪些模块、默认值是什么），DB 是值存储
 * （assistant_prompt_module_versions append-only 版本链）。无行=代码默认；
 * value=NULL=跟随代码默认；当前值=每 module_key 取 seq 最大行；回滚=复制历史行。
 *
 * 渲染红线：DB 零版本数据时 system prompt 与工具文案与现状逐字节一致
 * （test/prompt-override.test.ts 硬拷贝锚点）。
 *
 * 循环依赖：session.ts 静态 import 本模块的默认值常量；本模块枚举工具文案需要
 * buildSpaceTools（tools/index.js 的导出，session.ts 并未再导出）→ 动态 import
 * 引用（调用时模块已就绪，不形成静态环；tools/index 也不回引本模块）。
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { db } from '../../db/client.js';
import { assistantPromptModuleVersions, assistantSkills } from '../../db/schema.js';
import { skillDirOf } from './skillsStore.js';
import { emptyRepoState, type SpaceToolsContext } from './tools/context.js';

// ── 主 prompt 三段默认值（自 session.ts :650-652 原样迁来；迁移零行为变化，由
// prompt-override.test.ts 的独立硬拷贝锚定）──

export const STYLE_ZH_DEFAULT = '## 输出风格\n- 用户使用简体中文提问,全部回复一律用简体中文(代码、命令、英文术语可保留原文)。这条约束覆盖**每一条**用户可见文本,包括最终答复、调用工具前的过程说明、以及思考/推理独白——不要出现「Let me check」「I found that」「I should」这类英文句子,想查什么直接调工具即可。\n- 不要使用 emoji;强调用 markdown 加粗,列举用列表/表格。\n- 以资深测试专家的标准要求自己:简洁专业、结论先行。默认每条回复不超过 5 行(汇报步骤结果时用短列表);不复述工具动作过程、不复述页面结构、不把元素清单原文贴给用户、不输出超过 4 行的大表格——用一句话概括。\n- 杜绝胡编乱造:对被测系统的任何断言(页面上有哪些控件/筛选项/按钮、系统行为如何)必须有证据——verify_case 返回的实测元素清单(page/failure.page)、执行结果、代码/配置/数据库查证(repo_*/dbQuery 等取证结果)、或用户告知;清单里没有的控件一律当作不存在,不得提议、不得写进步骤。不确定就自己查证,渠道穷尽仍定不了再问用户。';
export const STYLE_EN_DEFAULT = '## Output style\n- The user writes in English. All replies MUST be in English (code, commands, and English terms may stay). This constraint covers every piece of user-visible text, including final replies, process explanations before tool calls, and reasoning monologues — do not write Chinese sentences like 「让我检查一下」, if you need to check something just call a tool.\n- Do not use emoji; emphasize with markdown bold, and enumerate with lists/tables.\n- Be a senior test expert: concise and professional. Lead with the conclusion; default to ≤5 lines per reply (a short list is fine when reporting step results). Do not narrate tool actions, do not restate page structure or paste element inventories back to the user, and do not dump tables longer than 4 rows — summarize instead.\n- Never fabricate. Claims about the system under test (which controls/filters/buttons a page has, how it behaves) must come from verify_case evidence (page / failure.page element lists), execution results, code/config/database lookups (repo_* / dbQuery probes), or the user — never from assumption. If you are not sure, verify it yourself first; ask the user only when the channels are exhausted.';
export const WORKSPACE_DEFAULT = '## 工作空间\n- 当前目录是版本专属工作空间，项目仓库已检出到 ./repo 子目录。\n- repo_ls / repo_read / repo_grep 是你的取证渠道：页面事实(字段规则/选项/文案/路由/实现)缺证据时自主查证，查到即回流程，不要无限考古；它们回答「代码里是什么」，不替代 verify_case 的实测判定——元素与页面问题以实测反馈为证据，实测与代码推断冲突时以实测为准。';

export const STYLE_ZH_KEY = 'space.style.zh';
export const STYLE_EN_KEY = 'space.style.en';
export const WORKSPACE_KEY = 'space.workspace';

export type PromptModuleGroup = 'main' | 'tool' | 'skill';

export interface PromptModuleDef {
  key: string;
  group: PromptModuleGroup;
  label: string;
  /** skill 组只读：设置页只展示+回滚，不提供直接编辑（修订走固化管线/skill-creator）。 */
  readonly: boolean;
  defaultValue(): Promise<string>;
}

/** SKILL.md 正文去 frontmatter；无/坏 frontmatter 原样返回。 */
export function stripSkillFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\n+/, '');
}

/** 读 skill 磁盘正文（去 frontmatter）。文件缺失抛错，由调用方决定语义。 */
export async function readSkillBody(slug: string): Promise<string> {
  const md = await readFile(join(skillDirOf(slug), 'SKILL.md'), 'utf8');
  return stripSkillFrontmatter(md);
}

/** 工具文案枚举的 stub 上下文——与 test/space-tools-basic.test.ts 的 makeCtx 同款
 *  （buildSpaceTools 是同步纯注册，随机 uuid + 空 repo 即可；字段以该测试为准）。 */
function stubToolsCtx(): SpaceToolsContext {
  return {
    threadId: randomUUID(),
    versionId: randomUUID(),
    projectId: randomUUID(),
    repo: emptyRepoState(),
    emit: () => {},
    createdByUserId: null,
    manager: true,
  };
}

type ToolTextRaw = { name: string; description: string; promptGuidelines?: string[] };

/** 工具文案枚举：chat + rca 两种 purpose 的并集（防 purpose 过滤漏工具）。 */
export async function listRawToolsMerged(): Promise<ToolTextRaw[]> {
  // buildSpaceTools 实际导出于 ./tools/index.js（session.ts 只 import 未再导出），
  // 保持动态 import：不形成静态环，与 session.ts 注入的是同一注册表。
  const { buildSpaceTools } = await import('./tools/index.js');
  const base = stubToolsCtx();
  const merged = new Map<string, ToolTextRaw>();
  for (const list of [buildSpaceTools(base), buildSpaceTools({ ...base, purpose: 'rca' })]) {
    for (const t of list as unknown as ToolTextRaw[]) merged.set(t.name, t);
  }
  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function listSkillDefs(): Promise<Array<{ slug: string; body: string }>> {
  const rows = await db.select({ name: assistantSkills.name }).from(assistantSkills)
    .where(eq(assistantSkills.enabled, true));
  const out: Array<{ slug: string; body: string }> = [];
  for (const r of rows) {
    const body = await readSkillBody(r.name).catch(() => null);
    if (body != null) out.push({ slug: r.name, body });
  }
  return out;
}

/** 注册表全量：主 prompt 三段（静态）+ 工具文案（运行时枚举）+ skill 正文（磁盘只读组）。 */
export async function listPromptModuleDefs(): Promise<PromptModuleDef[]> {
  const defs: PromptModuleDef[] = [
    { key: STYLE_ZH_KEY, group: 'main', label: '主提示词 · 输出风格（中文）', readonly: false, defaultValue: async () => STYLE_ZH_DEFAULT },
    { key: STYLE_EN_KEY, group: 'main', label: '主提示词 · 输出风格（英文）', readonly: false, defaultValue: async () => STYLE_EN_DEFAULT },
    { key: WORKSPACE_KEY, group: 'main', label: '主提示词 · 工作空间', readonly: false, defaultValue: async () => WORKSPACE_DEFAULT },
  ];
  for (const t of await listRawToolsMerged()) {
    defs.push({ key: `tool.${t.name}.description`, group: 'tool', label: `工具 ${t.name} · description`, readonly: false, defaultValue: async () => t.description });
    defs.push({ key: `tool.${t.name}.guidelines`, group: 'tool', label: `工具 ${t.name} · 提示规范`, readonly: false, defaultValue: async () => (t.promptGuidelines ?? []).join('\n') });
  }
  for (const s of await listSkillDefs()) {
    defs.push({ key: `skill.${s.slug}`, group: 'skill', label: `skill · ${s.slug}`, readonly: true, defaultValue: async () => s.body });
  }
  return defs;
}

// ── 值解析 ──

export interface PromptModuleVersionRow {
  seq: number;
  moduleKey: string;
  value: string | null;
  source: string;
  sourceRef: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

/** 当前值索引：全表 seq 降序，首见即当前（表只被人工低频写，量级小）。 */
export async function loadPromptModuleOverrides(): Promise<Map<string, PromptModuleVersionRow>> {
  const rows = await db.select().from(assistantPromptModuleVersions)
    .orderBy(desc(assistantPromptModuleVersions.seq));
  const map = new Map<string, PromptModuleVersionRow>();
  for (const r of rows) if (!map.has(r.moduleKey)) map.set(r.moduleKey, r);
  return map;
}

/** 容错版：查询失败回落空表（渲染用代码默认）——prompt 可用性不能拖垮会话（guides 同款）。 */
export async function loadPromptModuleOverridesSafe(): Promise<Map<string, PromptModuleVersionRow>> {
  try {
    return await loadPromptModuleOverrides();
  } catch (e) {
    logger.warn({ err: e }, 'prompt module overrides 加载失败;回落代码默认');
    return new Map();
  }
}

/** 覆盖值语义：NULL=跟随代码默认 → 视为无覆盖。 */
export function textOverrideOf(overrides: Map<string, PromptModuleVersionRow>, key: string): string | undefined {
  const v = overrides.get(key)?.value;
  return v != null && v !== '' ? v : undefined;
}

/** 工具文案覆盖：原地改 rawTools（工厂局部数组，改动即生效于 defineTool 注册）。
 *  guidelines 覆盖值按行拆（默认值是 string[] 按 \n join 的形态反解析）。 */
export function applyToolTextOverrides(
  tools: Array<{ name: string; description: string; promptGuidelines?: string[] }>,
  overrides: Map<string, PromptModuleVersionRow>,
): void {
  for (const t of tools) {
    const d = textOverrideOf(overrides, `tool.${t.name}.description`);
    if (d != null) t.description = d;
    const g = overrides.get(`tool.${t.name}.guidelines`)?.value;
    if (g != null && g.trim() !== '') {
      const lines = g.split('\n').map((s) => s.trim()).filter(Boolean);
      if (lines.length > 0) t.promptGuidelines = lines;
    }
  }
}

/** 追加版本行。sourceRef 命中 partial unique（重放）→ 不落行，返回 null。 */
export async function insertPromptModuleVersion(row: {
  moduleKey: string;
  value: string | null;
  source: string;
  sourceRef?: string | null;
  createdByUserId?: string | null;
}): Promise<number | null> {
  const r = await db.insert(assistantPromptModuleVersions).values({
    moduleKey: row.moduleKey,
    value: row.value,
    source: row.source,
    ...(row.sourceRef != null ? { sourceRef: row.sourceRef } : {}),
    ...(row.createdByUserId != null ? { createdByUserId: row.createdByUserId } : {}),
  }).onConflictDoNothing().returning({ seq: assistantPromptModuleVersions.seq });
  return r[0]?.seq ?? null;
}

/** 单模块解析：注册表定义 + 当前版本行 + 生效文本（无行/NULL 行 → 代码默认）。 */
export async function resolvePromptModule(key: string): Promise<{
  def: PromptModuleDef;
  hasRow: boolean;
  seq: number | null;
  source: string | null;
  value: string | null;
  text: string;
} | null> {
  const def = (await listPromptModuleDefs()).find((d) => d.key === key);
  if (!def) return null;
  const ov = (await loadPromptModuleOverrides()).get(key);
  const text = ov?.value ?? await def.defaultValue();
  return { def, hasRow: ov != null, seq: ov?.seq ?? null, source: ov?.source ?? null, value: ov?.value ?? null, text };
}

/** skill 元数据（写盘时 frontmatter 从 DB 重拼，防文件/DB 漂移）。 */
export async function readSkillMeta(slug: string): Promise<{ name: string; description: string } | null> {
  const r = (await db.select({ name: assistantSkills.name, description: assistantSkills.description })
    .from(assistantSkills)
    .where(and(eq(assistantSkills.name, slug), eq(assistantSkills.enabled, true)))
    .limit(1))[0];
  return r ?? null;
}

/** 用 DB 元数据 + 正文重建 SKILL.md（frontmatter 重拼；body 为完整正文不含 frontmatter）。 */
export async function writeSkillBodyFromDb(name: string, description: string, body: string): Promise<void> {
  const { writeSkillMd } = await import('./skillsService.js');
  writeSkillMd(skillDirOf(name), name, description, body);
}
