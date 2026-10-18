/**
 * AI 助手 Skills 全局共享存储（系统设置页管理；所有 space 线程加载全量启用 skills）。
 *  - DB 是唯一真相源（assistant_skills，多副本无共享文件系统，正文/脚本必须落库而非文件）。
 *  - 会话建立时把 DB 快照物化到全局目录 SKILLS_ROOT（.data/skills）：每个 skill →
 *    <SKILLS_ROOT>/<name>/SKILL.md + scripts/<filename>。此后 loadSkills / read_skill /
 *    run_skill_script 全部走物化目录（与之前逐版本 .pi/skills 挂载目录的读路径一致）。
 *  - 物化语义 = 快照覆盖：先清空再全量重写，删改/停用的 skill 不残留。
 *    并发建会话的 rm→write 互全覆盖最后写入者胜，内容同源可接受（read_skill 瞬时 miss 返回
 *    "skill 不存在"，模型可重试；读发生在会话建立后的模型轮次，远晚于物化完成）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantSkills } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { WORKSPACES_ROOT } from '../repo.js';

/** 脚本允许的 runtime（与系统执行器对映；容器镜像装了 node/python3/bash/sh）。 */
export const SCRIPT_RUNTIMES = ['node', 'python3', 'bash', 'sh'] as const;
export type ScriptRuntime = (typeof SCRIPT_RUNTIMES)[number];

/** scripts JSONB 单条：filename 为 scripts/ 下的文件名，content 为脚本正文。 */
export interface SkillScriptDef {
  filename: string;
  runtime: ScriptRuntime;
  content: string;
}

export interface StoredSkill {
  name: string;
  description: string;
  body: string;
  scripts: SkillScriptDef[];
}

/** 全局 skills 物化根：.data/skills（WORKSPACES_ROOT=.data/workspaces 的兄弟目录）。 */
export const SKILLS_ROOT = path.join(path.dirname(WORKSPACES_ROOT), 'skills');

/** 脚本文件名守卫（物化地址 + CLI 参数）：只允许安全标识符，拒目录穿越/绝对路径/隐藏文件。 */
export function isSafeScriptFilename(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.startsWith('.');
}

/** skill 名称（slug）守卫：与 pi-coding-agent loadSkills validateName 同源（名称=物化目录名 +
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

/** 从 DB 读启用 skills（全局共享，无 scope）。scripts 含脏值（非法 runtime/文件名/非字符串）防御性丢弃。 */
export async function loadEnabledSkills(): Promise<StoredSkill[]> {
  const rows = await db.select().from(assistantSkills).where(eq(assistantSkills.enabled, true));
  return rows.map((r) => {
    const raw = Array.isArray(r.scripts) ? r.scripts : [];
    const scripts = raw.filter(
      (s): s is SkillScriptDef =>
        !!s && isScriptRuntime(String((s as { runtime?: unknown }).runtime))
        && isSafeScriptFilename(String((s as { filename?: unknown }).filename))
        && typeof (s as { content?: unknown }).content === 'string',
    );
    return { name: r.name, description: r.description, body: r.body, scripts };
  });
}

/** SKILL.md 前置 YAML 前言（loadSkills 要求 name/description 字段；pi 的 frontmatter 用 yaml 包，
 *  JSON.stringify 的转义是合法 YAML 双引号标量超集，正文/描述里的引号反斜杠都安全）。 */
function skillFrontmatter(s: StoredSkill): string {
  return `---\nname: ${JSON.stringify(s.name)}\ndescription: ${JSON.stringify(s.description)}\n---\n\n`;
}

/** 把全局 skills 快照物化到 SKILLS_ROOT（先清空再全量重写）。写失败抛错给调用方（会话工厂降级为无 skills 段）。 */
export async function materializeSkills(skills: StoredSkill[]): Promise<void> {
  await fs.rm(SKILLS_ROOT, { recursive: true, force: true });
  await fs.mkdir(SKILLS_ROOT, { recursive: true });
  for (const s of skills) {
    const skillDir = path.join(SKILLS_ROOT, s.name);
    await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillFrontmatter(s) + s.body, 'utf8');
    for (const sc of s.scripts) {
      await fs.writeFile(path.join(skillDir, 'scripts', sc.filename), sc.content, 'utf8');
    }
  }
}