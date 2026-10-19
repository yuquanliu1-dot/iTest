/**
 * AI 助手 Skills 全局共享存储（系统设置页管理；所有 space 线程加载全量启用 skills）。
 *
 *  **文件系统是真源**：技能正文与全部目录树在 SKILLS_ROOT/<slug>/ 下（.data/skills），
 *  DB（assistant_skills）只存 name/description/enabled 三项元数据。2026-10-19 存储翻转：
 *  旧模型把正文与脚本扁平化存 body/scripts 两列，agents/ references/ assets/ eval-viewer/
 *  这类目录全部丢弃，且脚本只能是平级的 scripts/<filename>——官方 skill-creator 的包式
 *  python import 因此无法工作。
 *
 *  .data 是 docker 卷（docker-compose.yml 挂 itest-data:/repo/apps/api/.data），所有 api 副本
 *  共见同一份文件——旧注释「多副本无共享文件系统」是错的，纠正至此。**代价**：该卷是宿主本地
 *  的，将来多机部署会让技能库静默割裂，迁移前需换成对象存储。
 *
 *  任何时候不得整体 rm SKILLS_ROOT——那是唯一的技能正文。
 */
import fs from 'node:fs';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantSkills } from '../../db/schema.js';
import { WORKSPACES_ROOT } from '../repo.js';

/** 脚本允许的 runtime（与系统执行器对映；容器镜像装了 node/python3/bash/sh）。 */
export const SCRIPT_RUNTIMES = ['node', 'python3', 'bash', 'sh'] as const;
export type ScriptRuntime = (typeof SCRIPT_RUNTIMES)[number];

/** 全局 skills 根：.data/skills（WORKSPACES_ROOT=.data/workspaces 的兄弟目录）。 */
export const SKILLS_ROOT = path.join(path.dirname(WORKSPACES_ROOT), 'skills');

/** skill 名称（slug）守卫：与 pi-coding-agent loadSkills validateName 同源（名称=目录名 +
 *  read_skill/run_skill_script 入参，必须能被 skills loader 装进 catalog）。
 *  仅小写 a-z/数字/连字符；不以 - 开头/结尾，无连续 --，≤64。 */
export function isSafeSkillName(name: string): boolean {
  return (
    /^[a-z0-9-]+$/.test(name)
    && name.length <= 64
    && !name.startsWith('-')
    && !name.endsWith('-')
    && !name.includes('--')
  );
}

export function isScriptRuntime(r: string): r is ScriptRuntime {
  return (SCRIPT_RUNTIMES as readonly string[]).includes(r);
}

/** 单个技能目录的绝对路径（name 必须是已过 isSafeSkillName 的 DB slug）。 */
export function skillDirOf(name: string): string {
  return path.join(SKILLS_ROOT, name);
}

/** enabled=true 的技能目录绝对路径数组，直接喂 pi loader。
 *  传逐技能目录而非 SKILLS_ROOT：pi 的 loadSkillsFromDirInternal 见到 SKILL.md 即停，不再下钻，
 *  故停用技能与孤儿目录天然不可见。 */
export async function loadEnabledSkillDirs(): Promise<string[]> {
  const rows = await db.select({ name: assistantSkills.name })
    .from(assistantSkills)
    .where(eq(assistantSkills.enabled, true))
    .orderBy(asc(assistantSkills.name));
  return rows.map((r) => skillDirOf(r.name));
}

/** read_skill / run_skill_script 的准入闸门：技能必须存在且 DB enabled=true，否则不可达。 */
export async function assertSkillEnabled(name: string): Promise<string | null> {
  const row = (await db.select({ enabled: assistantSkills.enabled })
    .from(assistantSkills)
    .where(eq(assistantSkills.name, name))
    .limit(1))[0];
  if (!row) return `skill 不存在: ${name}`;
  if (!row.enabled) return `skill 已停用: ${name}`;
  return null;
}

export interface SkillTreeNode {
  /** 相对技能根的 posix 路径。 */
  path: string;
  kind: 'file' | 'dir';
  size: number;
  runtime?: string;
}

const MAX_TREE_ENTRIES = 200;
const MAX_TREE_DEPTH = 8;

/**
 * 列树时跳过的目录名。
 *
 * node_modules：依赖目录，不是技能内容。
 * __pycache__：Python 跑一次脚本就自动生成的字节码缓存。技能脚本被
 *   run_skill_script 执行时，Python 会在脚本所在目录写 .pyc——这让「文件树」
 *   在跑过一次之后凭空多出几个二进制条目（实测 skill-creator 18 文件 → 24），
 *   模型看到的是一堆与技能语义无关的噪声。内容是真源，字节码不是。
 */
const SKIP_DIR_NAMES = new Set(['node_modules', '__pycache__']);

/** 递归列树。.git/node_modules/隐藏文件/软链一律跳过；超量或超深则截断。
 *  列表页每轮都要调，故必须只 readdir/stat、不读内容。 */
export function listSkillTree(skillDir: string): SkillTreeNode[] {
  const out: SkillTreeNode[] = [];
  const state = { truncated: false };
  walk(skillDir, '', 0);
  return out;

  function walk(abs: string, rel: string, depth: number): void {
    if (state.truncated) return;
    if (depth > MAX_TREE_DEPTH) { state.truncated = true; return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || SKIP_DIR_NAMES.has(e.name)) continue;
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        // 软链不进树：即便指向树内也会在文件树与实际读取间产生两套视图，且易成逃逸面。
        continue;
      }
      if (isDir) {
        out.push({ path: childRel, kind: 'dir', size: 0 });
        walk(childAbs, childRel, depth + 1);
      } else if (isFile) {
        let size = 0;
        try { size = fs.statSync(childAbs).size; } catch { /* 忽略取不到大小的 */ }
        out.push({ path: childRel, kind: 'file', size, runtime: runtimeOfPath(childRel) });
      }
      if (out.length >= MAX_TREE_ENTRIES) { state.truncated = true; return; }
    }
  }
}

/** runtime 只给可执行扩展名，不给 assets/*.html 之类误标 node。 */
function runtimeOfPath(rel: string): string | undefined {
  if (/\.py$/i.test(rel)) return 'python3';
  if (/\.sh$/i.test(rel)) return 'bash';
  if (/\.(js|mjs|cjs)$/i.test(rel)) return 'node';
  return undefined;
}

/** 列表页统计：只数数量与字节，不读内容。 */
export function countSkillFiles(skillDir: string): { fileCount: number; totalBytes: number } {
  let fileCount = 0;
  let totalBytes = 0;
  for (const n of listSkillTree(skillDir)) {
    if (n.kind === 'file') { fileCount++; totalBytes += n.size; }
  }
  return { fileCount, totalBytes };
}

/** 磁盘上存在但 DB 无登记行的孤儿目录名（设置页展示为「未登记」，绝不入 catalog、不自动收养）。 */
export function listOrphanSkillDirs(registeredNames: string[]): string[] {
  const known = new Set(registeredNames);
  try {
    return fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isSafeSkillName(e.name) && !known.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
