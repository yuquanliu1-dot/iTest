/**
 * manage_skill：空间助手对话式管理全局技能（assistant_skills）。
 * 与系统设置页走同一 `skillsService`（校验/落库共用层），故规则完全一致
 * （name slug 校验 / 唯一 / scripts normalize / enabled 语义）。
 *
 * 仅对「有效管理员」线程注册（index.ts 按 ctx.manager 装配）；历史/非管理员线程无此工具。
 * action 语义：
 *   - list   ：全局技能清单（name/description/enabled/scripts 计数；含 id 供核对）
 *   - create ：新建（name/description/body/scripts?/enabled?）
 *   - update ：按唯一 name 定位，改 description/body/scripts/enabled/（renameTo=改名）
 *   - delete ：按唯一 name 删除
 *
 * 生效口径：skill 目录在会话构建时从 DB 物化，改动对【新会话】生效；
 * 当前会话内 read_skill / run_skill_script 仍按构建时的快照（新技能不可见，旧技能未下架）。
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
  /** create 的 slug；update/delete 用它定位目标技能。 */
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  body: z.string().optional(),
  scripts: z.array(z.object({ filename: z.string(), runtime: z.string(), content: z.string() })).optional(),
  enabled: z.boolean().optional(),
  /** update：改名后的新 slug（原 name 仍作定位键）。 */
  renameTo: z.string().min(1).max(120).optional(),
});

async function skillIdByName(name: string): Promise<string> {
  const row = (await db.select({ id: assistantSkills.id }).from(assistantSkills).where(eq(assistantSkills.name, name)).limit(1))[0];
  return row?.id ?? '';
}

export function buildManageSkillTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'manage_skill',
    description:
      '对话式管理全局技能库（assistant_skills）。action=list(清单:name/description/enabled/scripts 数)| create(name,description,body,可选 scripts 数组[{filename,runtime,content}],可选 enabled)| update(name + 可选 description/body/scripts/enabled/renameTo 改名)| delete(name)。name 须为小写 slug(字母/数字/连字符,不以-开头结尾、无连续--);scripts 的 runtime ∈ node|python3|bash|sh。改动对【新会话】生效(技能目录在会话构建时从 DB 物化)——本会话内 read_skill/run_skill_script 仍按构建时快照,新建的技能要新会话才可见、删掉的仍可读到旧目录。',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('list'),
        Type.Literal('create'),
        Type.Literal('update'),
        Type.Literal('delete'),
      ]),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      description: Type.Optional(Type.String({ maxLength: 500 })),
      body: Type.Optional(Type.String()),
      scripts: Type.Optional(Type.Array(Type.Object({
        filename: Type.String(),
        runtime: Type.String(),
        content: Type.String(),
      }))),
      enabled: Type.Optional(Type.Boolean()),
      renameTo: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    }),
    promptGuidelines: [
      '本工具仅对管理员线程开放；每个 action 都会点名当前生效口径。',
      'create 必须给 name/description/body；name 是唯一键(slug),改名用 update 的 renameTo 而非重建。',
      '改动对新会话生效：创建/改名后本会话 read_skill 仍可能读不到,告知用户需新开会话加载。',
      'delete 不可逆,确认用户意图后再执行,并复述被删技能名。',
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
      // 注册闸门已按 admin 过滤;此处兜底(防会话内降级/骇入拿到未注册工具)。
      if (!ctx.manager) return { ok: false, error: '无管理员权限，不能管理全局技能（需要管理员角色）' };
      try {
        switch (v.action) {
          case 'list': {
            const rows = await listSkills();
            return { ok: true, data: JSON.stringify(rows.map((r) => ({ ...r, scriptCount: r.scripts.length })), null, 2) };
          }
          case 'create': {
            if (!v.name || !v.description || v.body === undefined) {
              return { ok: false, error: 'create 需要 name、description、body' };
            }
            const created = await createSkill({ name: v.name, description: v.description, body: v.body, scripts: v.scripts ?? [], enabled: v.enabled });
            return { ok: true, data: JSON.stringify({ created: created.name, scriptCount: created.scripts.length }, null, 2) };
          }
          case 'update': {
            if (!v.name) return { ok: false, error: 'update 需要 name(目标技能)' };
            const id = await skillIdByName(v.name);
            if (!id) return { ok: false, error: `技能不存在: ${v.name}` };
            const patch: Record<string, unknown> = {};
            if (v.renameTo) patch.name = v.renameTo;
            if (v.description !== undefined) patch.description = v.description;
            if (v.body !== undefined) patch.body = v.body;
            if (v.scripts !== undefined) patch.scripts = v.scripts;
            if (v.enabled !== undefined) patch.enabled = v.enabled;
            if (Object.keys(patch).length === 0) return { ok: false, error: 'update 至少给一项要改的字段(description/body/scripts/enabled/renameTo)' };
            const updated = await updateSkill(id, patch);
            return { ok: true, data: JSON.stringify({ updated: updated.name, scriptCount: updated.scripts.length }, null, 2) };
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