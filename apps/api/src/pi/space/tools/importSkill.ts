/**
 * import_skill：对话式从 GitHub 拉取并（预览/安装）skill。
 * 与 manage_skill 同属管理员面——skill 脚本会在 API 容器执行，仅「有效管理员」线程注册（index.ts
 * 按 ctx.manager 装配），execute 另有 ctx.manager 防御兜底。
 *
 * 安全边界（见 ../skillImport.ts）：
 *  - URL 只认 https://github.com/<owner>/<repo>[.git][/tree/<ref>]，其他 host/协议一律拒绝（SSRF 结构性规避）。
 *  - 拉取走 git clone --depth 1，超时 60s；解析出的 name/description/body/scripts 全部过既有校验
 *    （slug / isSafeScriptFilename / isScriptRuntime），异常项 skip 并呈现在结果里。
 *  - 默认动作 = 预览（只 fetch + 解析，返回 name/body 大小/脚本清单/skipped，不落库）；
 *    install:true 才是装上（此后的 promptGuidelines 要求先向用户复述清单并获得确认）。
 *
 * 生效口径：skill 目录在会话构建时从 DB 物化，安装对【新会话】生效——本会话 read_skill /
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
      '从 GitHub 仓库下载并（预览/安装）skill。输入一个 https://github.com/<owner>/<repo> 地址（可带 /tree/<ref> 指定分支/标签）。默认 action=预览：拉取 + 校验 + 返回解析出的 name/description/body 大小/scripts 清单/跳过项，但【不落库】——先把清单给用户看，获得明确同意后再用 install=true 真正装上（可另传 name= 指定安装名覆盖默认名）。只认 github.com 的 https 地址（SSRF 防御），其他一律拒绝。仓库需根目录有 SKILL.md（frontmatter 的 name/description 可选，缺省用仓库名/导入描述）；scripts/ 子目录下脚本（缺失时退根目录脚本），runtime 按 shebang/扩展名推断，非法项会跳过并在结果中列出。安装对新会话生效（本会话 read_skill/run_skill_script 读不到）。',
    parameters: Type.Object({
      url: Type.String({ minLength: 1, maxLength: 300 }),
      install: Type.Optional(Type.Boolean()),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    }),
    promptGuidelines: [
      '仅管理员线程开放（import_skill 会执行 git clone 并落库 skill 脚本）。',
      '默认是预览：调一次 url 拿清单，把 name、脚本数量与文件名、body 大小、被跳过项复述给用户，确认后再 install=true。',
      'install 可加 name= 覆盖安装名；名称已存在会报「skill 名称已存在」，改用 name= 或先删旧的。',
      '装完本会话读不到（物化在新会话），告知用户新开会话后 read_skill/run_skill_script 才可见/可执行。',
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