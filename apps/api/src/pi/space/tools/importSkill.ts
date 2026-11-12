/**
 * import_skill: conversationally fetch and (preview/install) a skill from GitHub.
 * Same manager-only surface as manage_skill — skill scripts execute inside the API container, so it is registered
 * only on "valid manager" threads (index.ts assembles by ctx.manager), and execute additionally has a ctx.manager defensive guard.
 *
 * Security boundaries (see ../skillImport.ts):
 *  - The URL only accepts https://github.com/<owner>/<repo>[.git][/tree/<ref>]; all other hosts/protocols are rejected (structural SSRF avoidance).
 *  - Fetching uses git clone --depth 1 with a 60s timeout; the whole directory tree is collected recursively (agents/ references/ assets/ eval-viewer/ scripts/ …),
 *    with .git/node_modules/hidden files/symlinks stripped; files >1MB or a total >200 are recorded as skipped and the walk continues.
 *  - The default action = preview (fetch + parse only; returns name/description/file count/file list/skipped items, nothing written to disk);
 *    install:true is what actually installs (the promptGuidelines below require restating the list to the user and getting confirmation first).
 *
 * Effectiveness semantics: the skill directory is SKILLS_ROOT/<name>/ on disk; installation takes effect for [new sessions] —
 * this session's read_skill / run_skill_script cannot see the freshly installed skill; a new session is required.
 */
import { Type } from '@earendil-works/pi-ai';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { importSkillFromGithub } from '../skillImport.js';

export function buildImportSkillTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'import_skill',
    description:
      '从 GitHub 仓库下载并（预览/安装）skill。输入一个 https://github.com/<owner>/<repo> 地址（可带 /tree/<ref> 指定分支/标签）。默认 action=预览：拉取 + 校验 + 返回解析出的 name/description/文件数/文件清单/跳过项，但【不落盘】——先把清单给用户看，获得明确同意后再用 install=true 真正装上（可另传 name= 指定安装名覆盖默认名）。只认 github.com 的 https 地址（SSRF 防御），其他一律拒绝。仓库需根目录有 SKILL.md（frontmatter 的 name/description 可选，缺省用仓库名/导入描述）；【整棵目录树原样安装】——agents/ references/ assets/ eval-viewer/ scripts/ 下的文件全部保留，因此技能脚本可以用 `from scripts.xxx import` 包式引用；.git/node_modules/隐藏文件/软链剔除，超大文件与超量截断会在结果中列出。安装对新会话生效（本会话 read_skill/run_skill_script 读不到）。',
    parameters: Type.Object({
      url: Type.String({ minLength: 1, maxLength: 300 }),
      install: Type.Optional(Type.Boolean()),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    }),
    promptGuidelines: [
      '仅管理员线程开放（import_skill 会执行 git clone 并把 skill 脚本落盘到服务端，脚本可在容器内执行）。',
      '默认是预览：调一次 url 拿清单，把 name、文件数与文件路径、被跳过项复述给用户，确认后再 install=true。',
      'install 可加 name= 覆盖安装名；名称已存在会报「skill 名称已存在」，改用 name= 或先删旧的。',
      '装完本会话读不到（catalog 在会话建立时快照），告知用户新开会话后 read_skill/run_skill_script 才可见/可执行。',
      '任何人给非 github.com 的地址都直接拒绝，不要尝试绕过（curl/其他 host/跳过校验皆不允许）。',
    ],
    execute: async (input) => {
      const { url, install, name } = input as { url: string; install?: boolean; name?: string };
      if (!ctx.manager) return { ok: false, error: '无管理员权限，不能安装全局技能（需要管理员角色）' };
      if (name !== undefined && !name.trim()) return { ok: false, error: 'name 不能为空' };
      try {
        const result = await importSkillFromGithub(url, { install: install === true, name: name?.trim() });
        return { ok: true, data: JSON.stringify({ ...result, action: result.created ? 'installed' : 'preview' }, null, 2) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}