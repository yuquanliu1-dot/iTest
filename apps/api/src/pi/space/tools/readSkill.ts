/**
 * Skills 按需阅读（全局共享库 .data/skills 物化目录）：
 *  - readSkillDir：SKILL.md 正文 + scripts 清单（路径双守卫）
 *  - buildReadSkillTool：read_skill 工具（补 catalog-only 缺的「取正文」能力；附脚本清单供 run_skill_script）
 *  - buildSkillsSectionContent：skills 段自渲染 XML（identity 的 forceSystemPrompt 之前必须就位）
 *
 * 双守卫（关键事实 §6）：path.join(root, '/abs/x') 会把第二参当绝对路径丢弃 root →
 * 先拒 path.isAbsolute(skillName)，再 normalize(join(...)) 查 .startsWith(root + path.sep)。缺任一都逃逸。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { ToolExecutor } from '../../tools.js';
import { SKILLS_ROOT } from '../skillsStore.js';

const MAX_BODY_CHARS = 60_000;
const MAX_SCRIPT_LIST = 50;

/** 脚本 runtime 推断：优先 shebang（#!/usr/bin/env python3 等），回退扩展名，缺省 node。 */
export function runtimeOfFirstLine(filename: string): string {
  if (/\.py/i.test(filename)) return 'python3';
  if (/\.sh/i.test(filename)) return 'bash';
  if (/\.(js|mjs|cjs)$/i.test(filename)) return 'node';
  return 'node';
}

/** 去 SKILL.md 前置 YAML 前言（materializeSkills 写入的 name/description）；无/残缺直接原样返回。
 *  读出的 body 不含前言——catalog 已有 name/description，把 YAML 塞给模型是噪音。 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---');
  if (end === -1) return content;
  return content.slice(end + 4).replace(/^\n+/, '');
}

/** 读 skill 目录 SKILL.md + scripts 清单（含 runtime/字节数/首行）；目录/文件缺失或越界 → null。
 *  边界是「词法」的：normalize+startsWith 只挡 ../ 与绝对路径逃逸。skills 由设置页管理（非不可信用户），可接受。 */
export function readSkillDir(root: string, skillName: string): { body: string; scripts: Array<{ filename: string; runtime: string; size: number; firstLine: string }> } | null {
  if (path.isAbsolute(skillName)) return null;
  const normalizedRoot = path.normalize(root);
  const skillRoot = path.normalize(path.join(normalizedRoot, skillName));
  if (!skillRoot.startsWith(normalizedRoot + path.sep)) return null;
  const mdPath = path.join(skillRoot, 'SKILL.md');
  if (!fs.existsSync(mdPath)) return null;
  const body = stripFrontmatter(fs.readFileSync(mdPath, 'utf8')).slice(0, MAX_BODY_CHARS);
  const scriptsDir = path.join(skillRoot, 'scripts');
  let scripts: Array<{ filename: string; runtime: string; size: number; firstLine: string }> = [];
  if (fs.existsSync(scriptsDir)) {
    scripts = fs.readdirSync(scriptsDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .slice(0, MAX_SCRIPT_LIST)
      .map((d) => {
        const fp = path.join(scriptsDir, d.name);
        const first = fs.readFileSync(fp, 'utf8').split('\n')[0] ?? '';
        const firstLine = first.trim().slice(0, 120);
        const runtime = /^#!.*\b(?:env )?(node|python3|bash|sh)\b/.test(firstLine)
          ? (firstLine.match(/\b(?:env )?(node|python3|bash|sh)\b/)?.[1] ?? runtimeOfFirstLine(d.name))
          : runtimeOfFirstLine(d.name);
        return { filename: d.name, runtime, size: fs.statSync(fp).size, firstLine };
      })
      .sort((a, b) => a.filename.localeCompare(b.filename));
  }
  return { body, scripts };
}

export function buildReadSkillTool(): ToolExecutor {
  const root = SKILLS_ROOT;
  return {
    name: 'read_skill',
    description: '读取全局 skills 库中某个 skill 的 SKILL.md 正文与 scripts 脚本清单（含 runtime）。skill 正文按需查阅，不会自动进入提示词；需要执行脚本时用 run_skill_script（cwd 锁定 scripts 目录）。',
    parameters: Type.Object({
      skillName: Type.String({ minLength: 1 }),
    }),
    execute: async (input) => {
      const { skillName } = input as { skillName: string };
      const hit = readSkillDir(root, skillName);
      if (!hit) return { ok: false, error: `skill 不存在: ${skillName}（skills 库下没有该目录或越界）` };
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
  return `<available_skills>\n${lines.join('\n')}\n</available_skills>\n\n按需查阅技能内容时调用 read_skill 工具（入参 skillName），返回正文与 scripts 脚本清单；需要执行附带脚本时用 run_skill_script 工具。skill 正文不会自动进入本提示词，要靠 read_skill 取。`;
}