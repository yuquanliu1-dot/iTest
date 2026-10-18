/**
 * Skills 按需阅读（全局共享库 .data/skills 目录树）：
 *  - readSkillDir：SKILL.md 正文 + **递归文件树清单**（路径走 skillPaths 守卫）
 *  - readSkillFile：读树里任意单个文件（模型无内置 read 工具，这是它读 references/agents 的唯一途径）
 *  - buildReadSkillTool：read_skill 工具（补 catalog-only 缺的「取正文」能力）
 *  - buildSkillsSectionContent：skills 段自渲染 XML（identity 的 forceSystemPrompt 之前必须就位）
 *
 * 为什么必须有 file 参数：session.ts 是 noTools:'builtin'，没有内置 read/bash。
 * SKILL.md 正文里会引用 references/ agents/ assets/ 下的文件，模型只能靠本工具打开它们。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { ToolExecutor } from '../../tools.js';
import { SKILLS_ROOT, assertSkillEnabled, listSkillTree } from '../skillsStore.js';
import { resolveInSkill } from '../skillPaths.js';

const MAX_BODY_CHARS = 60_000;

/** 脚本 runtime 推断：优先 shebang（#!/usr/bin/env python3 等），回退扩展名，缺省 node。 */
export function runtimeOfFirstLine(filename: string): string {
  if (/\.py/i.test(filename)) return 'python3';
  if (/\.sh/i.test(filename)) return 'bash';
  if (/\.(js|mjs|cjs)$/i.test(filename)) return 'node';
  return 'node';
}

/** 去 SKILL.md 前置 YAML 前言（import 时写入的 name/description）；无/残缺直接原样返回。
 *  读出的 body 不含前言——catalog 已有 name/description，把 YAML 塞给模型是噪音。 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---');
  if (end === -1) return content;
  return content.slice(end + 4).replace(/^\n+/, '');
}

export interface ReadSkillHit {
  body: string;
  files: ReturnType<typeof listSkillTree>;
  truncated: boolean;
}

/** 读 skill 目录：SKILL.md 正文（剥 frontmatter，60k 上限）+ 递归文件树清单。
 *  skillName 走 resolveInSkill（逐段校验 + realpath），软链/隐藏文件/越界一律 null。 */
export function readSkillDir(root: string, skillName: string): ReadSkillHit | null {
  const skillDir = resolveInSkill(root, skillName);
  if (!skillDir) return null;
  const mdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(mdPath)) return null;
  const body = stripFrontmatter(fs.readFileSync(mdPath, 'utf8')).slice(0, MAX_BODY_CHARS);
  const files = listSkillTree(skillDir);
  return { body, files, truncated: files.length >= 200 };
}

/** 单文件读取（模型要读 SKILL.md 里提到的 references/ agents/ assets/ 时用）；越界/不存在 → null。 */
export function readSkillFile(root: string, skillName: string, rel: string): string | null {
  const skillDir = resolveInSkill(root, skillName);
  if (!skillDir) return null;
  const abs = resolveInSkill(skillDir, rel);
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return fs.readFileSync(abs, 'utf8').slice(0, MAX_BODY_CHARS);
}

export function buildReadSkillTool(): ToolExecutor {
  const root = SKILLS_ROOT;
  return {
    name: 'read_skill',
    description: '读取全局 skills 库中某个 skill 的 SKILL.md 正文与完整文件树清单。skill 正文按需查阅，不会自动进入提示词。files 里的其他文件（references/ agents/ assets/ eval-viewer/ scripts/ 等）用本工具的 file 参数单独读取（如 file="references/schemas.md"）。需要执行脚本时用 run_skill_script（script 用相对技能根的路径，如 "scripts/xxx.py"）。',
    parameters: Type.Object({
      skillName: Type.String({ minLength: 1 }),
      file: Type.Optional(Type.String({ minLength: 1 })),
    }),
    execute: async (input) => {
      const { skillName, file } = input as { skillName: string; file?: string };
      // 停用/不存在的技能一律不可达——否则 enabled 只是个 UI 装饰。
      const gate = await assertSkillEnabled(skillName);
      if (gate) return { ok: false, error: gate };
      if (file) {
        const content = readSkillFile(root, skillName, file);
        if (content === null) return { ok: false, error: `文件不存在或路径非法: ${skillName}/${file}（先 read_skill(skillName) 看文件树清单）` };
        return { ok: true, data: JSON.stringify({ name: skillName, file, content }) };
      }
      const hit = readSkillDir(root, skillName);
      if (!hit) return { ok: false, error: `skill 不存在: ${skillName}（库下没有该目录或越界）` };
      return { ok: true, data: JSON.stringify({ name: skillName, ...hit }) };
    },
  };
}

/** skills 段自渲染（agentskills.io 风格 XML）：name/description/location + 使用方法。
 *  只列 catalog 与一句使用说明，不含正文——正文由模型需要时调 read_skill 取（pi 原语义）。 */
export function buildSkillsSectionContent(
  skills: Array<{ name: string; description: string; location: string }>,
): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = skills.map((s) =>
    `  <skill name="${esc(s.name)}" description="${esc(s.description)}" location="${esc(s.location)}" />`,
  );
  return `<available_skills>\n${lines.join('\n')}\n</available_skills>\n\n`
    + '按需查阅技能内容时调用 read_skill(skillName) 取 SKILL.md 正文与完整文件树；'
    + '读文件树里的其他文件（references/ agents/ assets/ 等）用 read_skill(skillName, file="references/xxx.md")。'
    + '执行附带脚本用 run_skill_script(skillName, script="scripts/xxx.py")。skill 正文不会自动进入本提示词。';
}
