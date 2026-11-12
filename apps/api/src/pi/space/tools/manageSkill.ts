/**
 * manage_skill: conversationally manage global skills (metadata) from the space assistant.
 * Goes through the same `skillsService` as the system settings page (shared validation/persistence layer), so the rules are identical.
 *
 * After the 2026-10-19 storage flip, the content source of truth lives in SKILLS_ROOT/<name>/. create supports files[] to write
 * the full directory tree in one shot (the model writes the SKILL.md body per the user's request); without files it is still an empty skeleton.
 * Other write surfaces: import_skill (an entire GitHub tree) and the settings-page file-tree editor.
 *
 * Registered only on "valid manager" threads (index.ts assembles by ctx.manager); historical/non-manager threads lack this tool.
 * Action semantics:
 *   - list   : global skill list (name/description/enabled/fileCount; includes id for verification)
 *   - create : create a skeleton (name/description/enabled?)
 *   - update : located by the unique name; changes description/enabled (renameTo = rename; the directory moves with it)
 *   - delete : delete by the unique name (directory included)
 *
 * Effectiveness semantics: changes take effect for [new sessions]; disabled skills neither enter the catalog in a new session,
 * nor will read_skill / run_skill_script accept them (both refuse outright).
 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { assistantSkills } from '../../../db/schema.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { createSkill, deleteSkill, listSkills, updateSkill } from '../skillsService.js';

const Actions = z.object({
  action: z.enum(['list', 'create', 'update', 'delete']),
  /** The slug for create; update/delete use it to locate the target skill. */
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  /** update: the new slug after renaming (the original name remains the location key). */
  renameTo: z.string().min(1).max(120).optional(),
  /** create: the skill's full content (relative path + body), at least SKILL.md; omitted → only a skeleton is created. */
  files: z.array(z.object({ path: z.string().min(1), content: z.string() })).max(20).optional(),
});

async function skillIdByName(name: string): Promise<string> {
  const row = (await db.select({ id: assistantSkills.id }).from(assistantSkills).where(eq(assistantSkills.name, name)).limit(1))[0];
  return row?.id ?? '';
}

export function buildManageSkillTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'manage_skill',
    description:
      '对话式管理全局技能库。action=list(清单:name/description/enabled/fileCount)| create(name,description,可选 enabled,可选 files[] 一次写入完整内容)| update(name + 可选 description/enabled/renameTo 改名)| delete(name)。name 须为小写 slug(字母/数字/连字符,不以-开头结尾、无连续--)。create 建议带 files[]：[{path:"SKILL.md",content:"正文"},{path:"scripts/x.py",content:"…"}]，最多 20 个文件、单文件 ≤1MB、必须含 SKILL.md（缺 frontmatter 会自动按 name/description 补）；不带 files 只建空骨架。改正文的其余途径：import_skill 从 GitHub 装整棵树，或让用户在设置页文件树编辑器里改。改动对【新会话】生效；停用的技能在新会话里不进 catalog，read_skill/run_skill_script 也会拒绝。',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('list'),
        Type.Literal('create'),
        Type.Literal('update'),
        Type.Literal('delete'),
      ]),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      description: Type.Optional(Type.String({ maxLength: 500 })),
      enabled: Type.Optional(Type.Boolean()),
      renameTo: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      files: Type.Optional(Type.Array(
        Type.Object({ path: Type.String({ minLength: 1 }), content: Type.String() }),
        { minItems: 1, maxItems: 20 },
      )),
    }),
    promptGuidelines: [
      '本工具仅对管理员线程开放。',
      'create 带 files[] 才算真正创建：SKILL.md 正文由你按用户需求撰写（写清楚何时触发、步骤、示例）；附属文件（scripts/、references/）用相对路径放同一次调用里，别拆成多次。',
      '不带 files 的 create 只产出空骨架，用户会得到一个不可用的技能——除非用户明确只要骨架，否则必须带 files[]。',
      '改动对新会话生效：创建/改名后本会话 read_skill 仍可能读不到，告知用户需新开会话加载。',
      'delete 不可逆（连磁盘目录一起删），确认用户意图后再执行，并复述被删技能名。',
    ],
    execute: async (input) => {
      let v: z.infer<typeof Actions>;
      try {
        v = Actions.parse(input);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { ok: false, error: `参数不合法:${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
        }
        throw e;
      }
      // The registration gate already filtered by admin; this is a defensive backstop (against in-session downgrade/hijacking reaching an unregistered tool).
      if (!ctx.manager) return { ok: false, error: '无管理员权限，不能管理全局技能（需要管理员角色）' };
      try {
        switch (v.action) {
          case 'list': {
            const rows = await listSkills();
            return { ok: true, data: JSON.stringify(rows.map((r) => ({
              id: r.id, name: r.name, description: r.description, enabled: r.enabled,
              fileCount: r.fileCount, onDisk: r.onDisk, unregistered: r.unregistered,
            })), null, 2) };
          }
          case 'create': {
            if (!v.name || !v.description) {
              return { ok: false, error: 'create 需要 name、description' };
            }
            const created = await createSkill({
              name: v.name, description: v.description, enabled: v.enabled, files: v.files,
            });
            return {
              ok: true,
              data: JSON.stringify({
                created: created.name,
                fileCount: created.fileCount,
                note: created.fileCount > 1 || v.files
                  ? '内容已落盘，新开会话后 read_skill 可读、进 catalog'
                  : '仅创建了 SKILL.md 骨架（未传 files[]），需补正文才可用',
              }, null, 2),
            };
          }
          case 'update': {
            if (!v.name) return { ok: false, error: 'update 需要 name(目标技能)' };
            const id = await skillIdByName(v.name);
            if (!id) return { ok: false, error: `技能不存在: ${v.name}` };
            const patch: Record<string, unknown> = {};
            if (v.renameTo) patch.name = v.renameTo;
            if (v.description !== undefined) patch.description = v.description;
            if (v.enabled !== undefined) patch.enabled = v.enabled;
            if (Object.keys(patch).length === 0) return { ok: false, error: 'update 至少给一项要改的字段(description/enabled/renameTo)' };
            const updated = await updateSkill(id, patch);
            return { ok: true, data: JSON.stringify({ updated: updated.name }, null, 2) };
          }
          case 'delete': {
            if (!v.name) return { ok: false, error: 'delete 需要 name' };
            const id = await skillIdByName(v.name);
            if (!id) return { ok: false, error: `技能不存在: ${v.name}` };
            await deleteSkill(id);
            return { ok: true, data: JSON.stringify({ deleted: v.name }) };
          }
          default:
            return { ok: false, error: `unknown action ${(v as { action: string }).action}` };
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
