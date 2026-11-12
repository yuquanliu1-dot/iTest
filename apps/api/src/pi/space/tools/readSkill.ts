/**
 * Skills on-demand reading (global shared library .data/skills directory tree):
 *  - readSkillDir: SKILL.md body + **recursive file-tree listing** (paths go through the skillPaths guard)
 *  - readSkillFile: read any single file in the tree (the model has no built-in read tool; this is its only way to open references/agents files)
 *  - buildReadSkillTool: the read_skill tool (fills the "fetch body" gap the catalog-only list lacks)
 *  - buildSkillsSectionContent: renders the skills section itself as XML (must be in place before identity's forceSystemPrompt)
 *
 * Why the file parameter must exist: session.ts is noTools:'builtin', so there is no built-in read/bash.
 * The SKILL.md body references files under references/ agents/ assets/, and the model can only open them through this tool.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { ToolExecutor } from '../../tools.js';
import { SKILLS_ROOT, assertSkillEnabled, listSkillTree } from '../skillsStore.js';
import { resolveInSkill } from '../skillPaths.js';

const MAX_BODY_CHARS = 60_000;

/** Script runtime inference: prefer the shebang (#!/usr/bin/env python3 etc.), fall back to the extension, default node. */
export function runtimeOfFirstLine(filename: string): string {
  if (/\.py/i.test(filename)) return 'python3';
  if (/\.sh/i.test(filename)) return 'bash';
  if (/\.(js|mjs|cjs)$/i.test(filename)) return 'node';
  return 'node';
}

/** Strips the SKILL.md leading YAML preface (the name/description written at import time); missing/malformed → returned as-is.
 *  The extracted body excludes the preface — the catalog already has name/description; feeding the YAML to the model is noise. */
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

/** Reads a skill directory: the SKILL.md body (frontmatter stripped, 60k cap) + a recursive file-tree listing.
 *  skillName goes through resolveInSkill (per-segment validation + realpath); symlinks/hidden files/out-of-bounds all yield null. */
export function readSkillDir(root: string, skillName: string): ReadSkillHit | null {
  const skillDir = resolveInSkill(root, skillName);
  if (!skillDir) return null;
  const mdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(mdPath)) return null;
  const body = stripFrontmatter(fs.readFileSync(mdPath, 'utf8')).slice(0, MAX_BODY_CHARS);
  const files = listSkillTree(skillDir);
  return { body, files, truncated: files.length >= 200 };
}

/** Single-file read (for when the model needs to open references/ agents/ assets/ files mentioned in SKILL.md); out-of-bounds/nonexistent → null. */
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
      // Disabled/nonexistent skills are unreachable outright — otherwise enabled would be mere UI decoration.
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

/** Renders the skills section itself (agentskills.io-style XML): name/description/location + usage.
 *  Only the catalog and one usage line, not the bodies — bodies are fetched by read_skill when the model needs them (pi's original semantics). */
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
    + '执行附带脚本用 run_skill_script(skillName, script="scripts/xxx.py")。skill 正文不会自动进入本提示词。\n'
    + '脚本产出文件给用户时：把文件写到该技能的 .out/ 目录，并在 stdout 打印一行 '
    + '__ITEST_ARTIFACTS__ [{"name":"文件名.docx","path":".out/文件名.docx"}]；'
    + '平台会把它落库并生成下载卡，用户点击即可下载（格式不限：docx/xlsx/pdf/png/csv 皆可）。';
}
