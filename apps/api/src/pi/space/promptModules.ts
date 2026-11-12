/**
 * R3 prompt editability: module registry + DB value-store resolution + render overrides.
 *
 * Storage model: code is the module registry (which modules exist, what the defaults are), DB is the value store
 * (assistant_prompt_module_versions append-only version chain). No row = code default;
 * value=NULL = follow the code default; current value = per module_key the max-seq row; rollback = copy a historical row.
 *
 * Rendering red line: with zero DB version data, the system prompt and tool copy are byte-for-byte identical with the status quo
 * (test/prompt-override.test.ts hard-copy anchor).
 *
 * Import cycle: session.ts statically imports this module's default-value constants; this module's tool-copy enumeration needs
 * buildSpaceTools (exported from tools/index.js, not re-exported by session.ts) → dynamic import
 * (by call time the module is ready, so no static cycle; tools/index does not import this module back either).
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { db } from '../../db/client.js';
import { assistantPromptModuleVersions, assistantSkills } from '../../db/schema.js';
import { skillDirOf } from './skillsStore.js';
import { emptyRepoState, type SpaceToolsContext } from './tools/context.js';

// ── Main prompt three-section defaults (migrated verbatim from session.ts :650-652; zero behavior change in the move, anchored by
// prompt-override.test.ts's independent hard copy) ──

export const STYLE_ZH_DEFAULT = '## 输出风格\n- 用户使用简体中文提问,全部回复一律用简体中文(代码、命令、英文术语可保留原文)。这条约束覆盖**每一条**用户可见文本,包括最终答复、调用工具前的过程说明、以及思考/推理独白——不要出现「Let me check」「I found that」「I should」这类英文句子,想查什么直接调工具即可。\n- 不要使用 emoji;强调用 markdown 加粗,列举用列表/表格。\n- 以资深测试专家的标准要求自己:简洁专业、结论先行。默认每条回复不超过 5 行(汇报步骤结果时用短列表);不复述工具动作过程、不复述页面结构、不把元素清单原文贴给用户、不输出超过 4 行的大表格——用一句话概括。\n- 杜绝胡编乱造:对被测系统的任何断言(页面上有哪些控件/筛选项/按钮、系统行为如何)必须有证据——verify_case 返回的实测元素清单(page/failure.page)、执行结果、代码/配置/数据库查证(repo_*/manage_environments/manage_datasets 等取证结果)、或用户告知;清单里没有的控件一律当作不存在,不得提议、不得写进步骤。不确定就自己查证,渠道穷尽仍定不了再问用户。';
export const STYLE_EN_DEFAULT = '## Output style\n- The user writes in English. All replies MUST be in English (code, commands, and English terms may stay). This constraint covers every piece of user-visible text, including final replies, process explanations before tool calls, and reasoning monologues — do not write Chinese sentences like 「让我检查一下」, if you need to check something just call a tool.\n- Do not use emoji; emphasize with markdown bold, and enumerate with lists/tables.\n- Be a senior test expert: concise and professional. Lead with the conclusion; default to ≤5 lines per reply (a short list is fine when reporting step results). Do not narrate tool actions, do not restate page structure or paste element inventories back to the user, and do not dump tables longer than 4 rows — summarize instead.\n- Never fabricate. Claims about the system under test (which controls/filters/buttons a page has, how it behaves) must come from verify_case evidence (page / failure.page element lists), execution results, code/config/database lookups (repo_* / manage_environments / manage_datasets probes), or the user — never from assumption. If you are not sure, verify it yourself first; ask the user only when the channels are exhausted.';
export const WORKSPACE_DEFAULT = '## 工作空间\n- 当前目录是版本专属工作空间，项目仓库已检出到 ./repo 子目录。\n- repo_ls / repo_read / repo_grep 是你的取证渠道：页面事实(字段规则/选项/文案/路由/实现)缺证据时自主查证，查到即回流程，不要无限考古；它们回答「代码里是什么」，不替代 verify_case 的实测判定——元素与页面问题以实测反馈为证据，实测与代码推断冲突时以实测为准。';

export const STYLE_ZH_KEY = 'space.style.zh';
export const STYLE_EN_KEY = 'space.style.en';
export const WORKSPACE_KEY = 'space.workspace';

export type PromptModuleGroup = 'main' | 'tool' | 'skill';

export interface PromptModuleDef {
  key: string;
  group: PromptModuleGroup;
  label: string;
  /** skill group read-only: the settings page only shows + rolls back, no direct editing (revisions go through the solidify pipeline/skill-creator). */
  readonly: boolean;
  defaultValue(): Promise<string>;
}

/** SKILL.md body minus frontmatter; missing/bad frontmatter returns as-is. */
export function stripSkillFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\n+/, '');
}

/** Reads a skill's disk body (frontmatter stripped). Missing file throws; the caller decides the semantics. */
export async function readSkillBody(slug: string): Promise<string> {
  const md = await readFile(join(skillDirOf(slug), 'SKILL.md'), 'utf8');
  return stripSkillFrontmatter(md);
}

/** Stub context for the tool-copy enumeration — same shape as test/space-tools-basic.test.ts's makeCtx
 *  (buildSpaceTools is synchronous pure registration; a random uuid + empty repo suffices; fields follow that test). */
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

/** Tool-copy enumeration: the union of the chat and rca purposes (guarding against the purpose filter dropping tools). */
export async function listRawToolsMerged(): Promise<ToolTextRaw[]> {
  // buildSpaceTools is actually exported from ./tools/index.js (session.ts only imports it, without re-exporting);
  // keep the dynamic import: no static cycle, and it is the same registry session.ts injects.
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

/** Registry in full: the main prompt's three sections (static) + tool copy (runtime enumeration) + skill bodies (disk, read-only group). */
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

// ── Value resolution ──

export interface PromptModuleVersionRow {
  seq: number;
  moduleKey: string;
  value: string | null;
  source: string;
  sourceRef: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  /** Code-default baseline fingerprint at the time the row was written; null = written by an older version, no fingerprint (drift detection judges unknown). */
  baseHash: string | null;
}

/** Current-value index: whole table seq descending, first seen is current (the table is only written by humans at low frequency — small volume). */
export async function loadPromptModuleOverrides(): Promise<Map<string, PromptModuleVersionRow>> {
  const rows = await db.select().from(assistantPromptModuleVersions)
    .orderBy(desc(assistantPromptModuleVersions.seq));
  const map = new Map<string, PromptModuleVersionRow>();
  for (const r of rows) if (!map.has(r.moduleKey)) map.set(r.moduleKey, r);
  return map;
}

/** Fault-tolerant version: on query failure falls back to an empty map (rendering uses code defaults) — prompt availability must not drag down the session (same as guides). */
export async function loadPromptModuleOverridesSafe(): Promise<Map<string, PromptModuleVersionRow>> {
  try {
    return await loadPromptModuleOverrides();
  } catch (e) {
    logger.warn({ err: e }, 'prompt module overrides 加载失败;回落代码默认');
    return new Map();
  }
}

/** Override-value semantics: NULL = follow the code default → treated as no override. */
export function textOverrideOf(overrides: Map<string, PromptModuleVersionRow>, key: string): string | undefined {
  const v = overrides.get(key)?.value;
  return v != null && v !== '' ? v : undefined;
}

/** Tool-copy overrides: mutates rawTools in place (the factory's local array — changes take effect right in the defineTool registration).
 *  guidelines override values are split by line (reverse-parsed from the default's string[]-joined-with-\n shape). */
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

/** Code-default baseline fingerprint (sha256 hex): recorded when a version row is written; drift detection uses it to judge "the override value is based on an old baseline". */
export function hashBaseline(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Appends a version row. A sourceRef hitting the partial unique (replay) → no row written, returns null.
 *  baseHash (code baseline fingerprint at write time): undefined = unspecified → automatically takes the current code default's fingerprint
 *  (manual_edit / solidify_apply / baseline snapshots all carry "reassertion against the current baseline" semantics);
 *  explicitly passing null = no fingerprint (e.g. a fingerprint-less historical row inherited by a rollback), not auto-filled. */
export async function insertPromptModuleVersion(row: {
  moduleKey: string;
  value: string | null;
  source: string;
  sourceRef?: string | null;
  createdByUserId?: string | null;
  baseHash?: string | null;
}): Promise<number | null> {
  let baseHash: string | null;
  if (row.baseHash !== undefined) {
    baseHash = row.baseHash;
  } else if (row.value != null) {
    const def = (await listPromptModuleDefs()).find((d) => d.key === row.moduleKey);
    baseHash = def ? hashBaseline(await def.defaultValue()) : null;
  } else {
    baseHash = null;
  }
  const r = await db.insert(assistantPromptModuleVersions).values({
    moduleKey: row.moduleKey,
    value: row.value,
    source: row.source,
    ...(row.sourceRef != null ? { sourceRef: row.sourceRef } : {}),
    ...(row.createdByUserId != null ? { createdByUserId: row.createdByUserId } : {}),
    ...(baseHash != null ? { baseHash } : {}),
  }).onConflictDoNothing().returning({ seq: assistantPromptModuleVersions.seq });
  return r[0]?.seq ?? null;
}

/** Single-module resolution: registry def + current version row + effective text (no row / NULL row → code default). */
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

/** Skill metadata (when writing to disk the frontmatter is reassembled from DB, preventing file/DB drift). */
export async function readSkillMeta(slug: string): Promise<{ name: string; description: string } | null> {
  const r = (await db.select({ name: assistantSkills.name, description: assistantSkills.description })
    .from(assistantSkills)
    .where(and(eq(assistantSkills.name, slug), eq(assistantSkills.enabled, true)))
    .limit(1))[0];
  return r ?? null;
}

/** Rebuilds SKILL.md from DB metadata + body (frontmatter reassembled; body is the full body without frontmatter). */
export async function writeSkillBodyFromDb(name: string, description: string, body: string): Promise<void> {
  const { writeSkillMd } = await import('./skillsService.js');
  writeSkillMd(skillDirOf(name), name, description, body);
}

// ── Baseline drift detection ──
// Motivation: an override row shadows the code default — after the code baseline evolves, the old row keeps taking effect and nobody knows
// (the hidden gotcha of "changed the code default but the release doesn't take effect"). Criterion = the row's recorded base_hash at write time ≠ the current code default fingerprint.

export type PromptDriftStatus = 'drift' | 'unknown';

export interface PromptDrift {
  key: string;
  label: string;
  group: PromptModuleGroup;
  /** Override row's seq with write source/time (for tracing). */
  seq: number;
  source: string;
  writtenAt: string;
  status: PromptDriftStatus;
  /** Baseline fingerprint at row-write time; null in the unknown status. */
  baseHash: string | null;
  currentHash: string;
}

/** Baseline drift detection: an override row (value non-NULL) whose base_hash ≠ the current code default fingerprint → drift;
 *  no fingerprint (row written by an older version) → unknown (drift cannot be judged, but not hidden). Only the main/tool groups participate —
 *  skill row values and disk bodies are kept in sync by the solidify pipeline, so there is no "old row shadows new default" semantics.
 *  Consumed by the ops panel (settings-page alerting), never called on the session hot path. */
export async function computePromptDrifts(defs?: PromptModuleDef[]): Promise<PromptDrift[]> {
  const list = defs ?? await listPromptModuleDefs();
  const overrides = await loadPromptModuleOverrides();
  const out: PromptDrift[] = [];
  for (const def of list) {
    if (def.group === 'skill') continue;
    const row = overrides.get(def.key);
    if (!row || row.value == null) continue;
    const currentHash = hashBaseline(await def.defaultValue());
    if (row.baseHash != null && row.baseHash === currentHash) continue;
    out.push({
      key: def.key,
      label: def.label,
      group: def.group,
      seq: row.seq,
      source: row.source,
      writtenAt: row.createdAt.toISOString(),
      status: row.baseHash == null ? 'unknown' : 'drift',
      baseHash: row.baseHash,
      currentHash,
    });
  }
  return out;
}
