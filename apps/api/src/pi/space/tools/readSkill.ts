/**
 * S2 按需技能（workspace/.pi/skills 目录）：
 *  - readSkillDir：SKILL.md 正文 + scripts 清单（路径双守卫）
 *  - buildReadSkillTool：read_skill 工具（补 catalog-only 缺的「取正文」能力）
 *  - buildSkillsSectionContent：skills 段自渲染 XML（identity 的 forceSystemPrompt 之前必须就位）
 *
 * 双守卫（关键事实 §6）：path.join(root, '/abs/x') 会把第二参当绝对路径丢弃 root →
 * 先拒 path.isAbsolute(skillName)，再 normalize(join(...)) 查 .startsWith(root + path.sep)。缺任一都逃逸。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { SpaceToolsContext } from './context.js';
import type { ToolExecutor } from '../../tools.js';

const SKILL_DIR_NAME = '.pi/skills';
const MAX_BODY_CHARS = 60_000;
const MAX_SCRIPT_LIST = 50;

export function skillsRootOf(workspaceDir: string): string {
  return path.join(workspaceDir, SKILL_DIR_NAME);
}

/** 读 skill 目录 SKILL.md + scripts 清单；目录/文件缺失或越界 → null。
 *  边界是「词法」的：normalize+startsWith 只挡 ../ 与绝对路径逃逸。skill 目录若为指到 root 外的
 *  符号链接，readFileSync/readdirSync 会跟随——但 .pi/skills 由宿主/项目挂载（非不可信用户），可接受。 */
export function readSkillDir(root: string, skillName: string): { body: string; scripts: string[] } | null {
  if (path.isAbsolute(skillName)) return null;
  const normalizedRoot = path.normalize(root);
  const skillRoot = path.normalize(path.join(normalizedRoot, skillName));
  if (!skillRoot.startsWith(normalizedRoot + path.sep)) return null;
  const mdPath = path.join(skillRoot, 'SKILL.md');
  if (!fs.existsSync(mdPath)) return null;
  const body = fs.readFileSync(mdPath, 'utf8').slice(0, MAX_BODY_CHARS);
  const scriptsDir = path.join(skillRoot, 'scripts');
  let scripts: string[] = [];
  if (fs.existsSync(scriptsDir)) {
    scripts = fs.readdirSync(scriptsDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .slice(0, MAX_SCRIPT_LIST);
  }
  return { body, scripts };
}

export function buildReadSkillTool(ctx: SpaceToolsContext): ToolExecutor {
  const root = skillsRootOf(ctx.workspaceDir ?? process.cwd());
  return {
    name: 'read_skill',
    description: '读取 .pi/skills 目录下某个 skill 的 SKILL.md 正文与 scripts 清单（按需查阅；只能读当前版本工作空间内 .pi/skills 下的 skill，禁止越界）。',
    parameters: Type.Object({
      skillName: Type.String({ minLength: 1 }),
    }),
    execute: async (input) => {
      const { skillName } = input as { skillName: string };
      const hit = readSkillDir(root, skillName);
      if (!hit) return { ok: false, error: `skill 不存在: ${skillName}（.pi/skills 下没有该目录或越界）` };
      return { ok: true, data: JSON.stringify({ name: skillName, ...hit }) };
    },
  };
}

/** skills 段自渲染（agentskills.io 风格 XML）：name/description/location + read_skill 用法。
 *  只列 catalog 与一句使用说明，不含正文——正文由模型需要时调 read_skill 取（pi 原语义）。 */
export function buildSkillsSectionContent(
  skills: Array<{ name: string; description: string; location: string }>,
): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = skills.map((s) =>
    `  <skill name="${esc(s.name)}" description="${esc(s.description)}" location="${esc(s.location)}" />`,
  );
  return `<available_skills>\n${lines.join('\n')}\n</available_skills>\n\n按需查阅技能内容时调用 read_skill 工具（入参 skillName）；skill 正文不会自动进入本提示词，要靠 read_skill 取。`;
}
