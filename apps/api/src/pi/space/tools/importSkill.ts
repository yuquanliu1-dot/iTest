/**
 * import_skill：对话式从 GitHub 拉取并（预览/安装）skill。
 * 与 manage_skill 同属管理员面——skill 脚本会在 API 容器执行，仅「有效管理员」线程注册（index.ts
 * 按 ctx.manager 装配），execute 另有 ctx.manager 防御兜底。
 *
 * 安全边界（见 ../skillImport.ts）：
 *  - URL 只认 https://github.com/<owner>/<repo>[.git][/tree/<ref>]，其他 host/协议一律拒绝（SSRF 结构性规避）。
 *  - 拉取走 git clone --depth 1，超时 60s；整棵目录树递归收（agents/ references/ assets/ eval-viewer/ scripts/ …），
 *    剔除 .git/node_modules/隐藏文件/软链，单文件 >1MB 或总数 >200 记 skipped 后继续。
 *  - 默认动作 = 预览（只 fetch + 解析，返回 name/description/文件数/文件清单/跳过项，不落盘）；
 *    install:true 才是装上（此后的 promptGuidelines 要求先向用户复述清单并获得确认）。
 *
 * 生效口径：技能目录就是磁盘上的 SKILLS_ROOT/<name>/，安装对【新会话】生效——本会话 read_skill /
 * run_skill_script 读不到刚装的 skill，需新开会话。
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