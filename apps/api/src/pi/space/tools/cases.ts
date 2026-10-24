/**
 * manage_cases:读 + 分组创建/改名/删除 + 跨版本复制。
 * 归属校验(实体 ∈ ctx.projectId;版本读写面见各 action)在这里;per-user 可见性在 HTTP 边界。
 *
 * 设计变更:用例/步骤的一切修改统一走 stage_case_op 暂存 → StagePanel 勾选 → 落库。
 * 本工具七类：
 *   - search:版本内检索(可传 versionId 检索同项目其它版本,为跨版本复制找源)
 *   - get:caseId 拿完整详情(同项目内可跨版本读,复制前核对源用例;绑定了数据集时附 dataset 结构)
 *   - list_versions:项目版本列表(拿源/目标 versionId)
 *   - copy_to_version:复制用例到目标分组(可跨版本,实时写——与 create_group 同级的容器类操作)
 *   - create_group:分组容器创建仍实时写(分组是用例的容器,不属于"对用例的修改")
 *   - rename_group / delete_group:分组改名/删除(删除仅限空分组,走确认卡)
 *
 * 旧 action 迁移：
 *   - create          → stage_case(payload 带 groupId,落库时 stageRoute 校验 groupId 归属)
 *   - update          → stage_case_op(action=update_case)
 *   - delete          → stage_case_op(action=delete_case)
 *   - move_group      → stage_case_op(action=move_case)
 *   - 一切步骤级操作   → stage_case_op(update_step/insert_step/delete_step/move_step)
 *   - list_datasets   → manage_datasets(数据集读/改/删独立工具)
 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import * as svc from '../../../services/cases.service.js';
import { resolveCaseProjectId, resolveVersionProjectId } from '../../../services/projectAccess.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import { db } from '../../../db/client.js';
import { datasets } from '../../../db/schema.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';
import { diffText } from './diff.js';
import { requestConfirmation } from '../confirm.js';
import { st, type StLang } from '../../../i18n.js';
import { aiLangFrom } from '../../../agent/langDirective.js';

const Actions = z.object({
  action: z.enum(['search', 'get', 'list_versions', 'copy_to_version', 'create_group', 'rename_group', 'delete_group']),
  caseId: z.string().uuid().optional(),
  keyword: z.string().max(200).optional(),
  groupId: z.string().uuid().optional(),
  groupName: z.string().min(1).max(200).optional(),
  groupDefaultUrl: z.string().max(2000).optional(),
  /** search:源版本(缺省当前版本);copy_to_version:目标版本(缺省当前线程版本)。 */
  versionId: z.string().uuid().optional(),
  targetGroupId: z.string().uuid().optional(),
});

export function buildCasesTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'manage_cases',
      description:
        '用例只读操作 + 分组管理 + 跨版本复制。action=search(检索用例,缺省当前版本,可传 versionId 检索同项目其它版本)| get(caseId,含步骤与标签,同项目内可跨版本读)| list_versions(项目版本列表,标出当前版本)| copy_to_version(caseId + targetGroupId,可传 versionId 指定目标版本,缺省复制到当前版本;实时落库)| create_group(groupName,可带 groupDefaultUrl)| rename_group(groupId+name,需用户确认)| delete_group(groupId,仅空分组可删,需用户确认)。数据集的读/改/删走 manage_datasets(行值敏感格脱敏)。用例/步骤的增删改一律走 stage_case(全新用例)或 stage_case_op(已有用例)—— 用户在右侧 StagePanel 勾选 → 落库。',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('search'),
          Type.Literal('get'),
          Type.Literal('list_versions'),
          Type.Literal('copy_to_version'),
          Type.Literal('create_group'),
          Type.Literal('rename_group'),
          Type.Literal('delete_group'),
        ]),
        caseId: Type.Optional(Type.String()),
        keyword: Type.Optional(Type.String()),
        groupId: Type.Optional(Type.String()),
        groupName: Type.Optional(Type.String()),
        groupDefaultUrl: Type.Optional(Type.String()),
        versionId: Type.Optional(Type.String()),
        targetGroupId: Type.Optional(Type.String()),
      }),
      promptGuidelines: [
        '用例/步骤的增删改一律走 stage_case(创建全新用例)或 stage_case_op(修改已有用例/步骤)。本工具不支持任何用例写动作(copy_to_version 与 create_group/rename_group 除外)。',
        '修改用例元数据(标题/描述/优先级/status/expectedOutcome 等)请改用 stage_case_op(action=update_case,patch={...})；删除走 stage_case_op(action=delete_case)；移动分组走 stage_case_op(action=move_case)。',
        '编辑步骤(重编译 instruction、改 compiled、插入/删除/排序)走 stage_case_op(action=update_step/insert_step/delete_step/move_step)。',
        '跨版本复制用例的标准流程:list_versions 拿版本 id → search(versionId=源版本, keyword=...) 找到源 caseId(可 get 核对步骤) → 确认目标分组存在(不存在先 create_group) → copy_to_version(caseId, targetGroupId, versionId=目标版本)。目标版本缺省为当前版本。',
        '创建 group 后返回 groupId；下一步创建用例时把 groupId 喂给 stage_case。delete_group 仅限空分组(分组下还有用例会被拒绝)。',
        'search 返回的列表项不含步骤全文,要看完整步骤/expectedOutcome 用 get。',
        '数据集列名即回放初始变量 {{列名}}：看项目数据集(含行值,敏感格脱敏)用 manage_datasets get;看某用例可用变量用 get 返回的 dataset.columns。行间差异（输入值/断言文本/预期描述）应写成 {{var}}，让每行数据驱动出不同验证。项目里没有合适数据集时用 stage_dataset 生成（配套新用例用 stage_case 的 datasetLocalId 绑定）；给已有用例绑定/解绑已落库数据集走 stage_case_op update_case(patch.datasetId)。修改已有数据集走 manage_datasets update。',
      ],
      execute: async (input) => {
        const lang: StLang = aiLangFrom(ctx.lang);
        let v: z.infer<typeof Actions>;
        try {
          v = Actions.parse(input);
        } catch (e) {
          if (e instanceof z.ZodError) {
            return { ok: false, error: `参数不合法:${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
          }
          throw e;
        }
        try {
          switch (v.action) {
            case 'search': {
              // 缺省检索当前版本;传 versionId 时可检索同项目其它版本(跨版本复制找源用例)
              let versionId = ctx.versionId;
              if (v.versionId) {
                const vp = await resolveVersionProjectId(v.versionId);
                if (vp !== ctx.projectId) return { ok: false, error: '版本不存在或不属于当前项目' };
                versionId = v.versionId;
              }
              if (v.groupId) {
                const pid = await svc.groupProjectId(v.groupId);
                if (pid !== ctx.projectId) return { ok: false, error: '分组不存在或不属于当前项目' };
              }
              const rows = await svc.searchCasesInVersion(versionId, { keyword: v.keyword, groupId: v.groupId });
              return { ok: true, data: JSON.stringify(rows, null, 2) };
            }
            case 'get': {
              if (!v.caseId) return { ok: false, error: 'get 需要 caseId' };
              const detail = await svc.getCaseDetail(v.caseId);
              if (!detail) return { ok: false, error: '用例不存在' };
              // 同项目内可跨版本读(复制前核对源用例);跨项目拒绝
              const pid = await resolveCaseProjectId(v.caseId);
              if (pid !== ctx.projectId) return { ok: false, error: '用例不存在或不属于当前项目' };
              // 绑定数据集 → 附结构(列名即回放初始变量);仅结构,行值/敏感值永不外泄
              let dataset: { id: string; name: string; columns: Array<{ name: string; sensitive: boolean }>; enabledRowCount: number } | null = null;
              if (detail.datasetId) {
                const ds = (await db.select().from(datasets).where(eq(datasets.id, detail.datasetId)).limit(1))[0];
                if (ds) dataset = { id: ds.id, name: ds.name, columns: ds.columns, enabledRowCount: ds.rows.filter((r) => !r.disabled).length };
              }
              return { ok: true, data: JSON.stringify({ ...detail, dataset }, null, 2) };
            }
            case 'list_versions': {
              const rows = await svc.listVersionsForProject(ctx.projectId);
              return { ok: true, data: JSON.stringify(rows.map((r) => ({ ...r, isCurrent: r.id === ctx.versionId })), null, 2) };
            }
            case 'copy_to_version': {
              if (!v.caseId || !v.targetGroupId) return { ok: false, error: 'copy_to_version 需要 caseId 与 targetGroupId' };
              const srcPid = await resolveCaseProjectId(v.caseId);
              if (srcPid !== ctx.projectId) return { ok: false, error: '源用例不存在或不属于当前项目' };
              const gPid = await svc.groupProjectId(v.targetGroupId);
              if (gPid !== ctx.projectId) return { ok: false, error: '目标分组不存在或不属于当前项目' };
              // 缺省复制到当前线程版本;显式传 versionId 时也必须 ∈ 当前项目
              let targetVersionId = ctx.versionId;
              if (v.versionId) {
                const vp = await resolveVersionProjectId(v.versionId);
                if (vp !== ctx.projectId) return { ok: false, error: '目标版本不存在或不属于当前项目' };
                targetVersionId = v.versionId;
              }
              const c = await svc.copyCaseCore({ caseId: v.caseId, targetGroupId: v.targetGroupId, targetVersionId });
              return { ok: true, data: `已复制用例为「${c.title}」(caseId=${c.id}, versionId=${c.versionId ?? ''})` };
            }
            case 'create_group': {
              if (!v.groupName) return { ok: false, error: 'create_group 需要 groupName' };
              const g = await svc.createGroup(ctx.projectId, {
                name: v.groupName,
              });
              emitStage(ctx, { kind: 'group', id: g.id, action: 'create' });
              return { ok: true, data: `已创建分组「${g.name}」(${g.id})` };
            }
            case 'rename_group': {
              if (!v.groupId || !v.groupName) return { ok: false, error: 'rename_group 需要 groupId 与 groupName' };
              const pid = await svc.groupProjectId(v.groupId);
              if (pid !== ctx.projectId) return { ok: false, error: '分组不存在或不属于当前项目' };
              const before = await svc.getGroup(v.groupId);
              const approved = await requestConfirmation(
                {
                  threadId: ctx.threadId, toolName: 'manage_cases', action: 'rename_group',
                  summary: st(lang, 'group.updated', { old: before?.name ?? v.groupId, name: v.groupName }),
                  risk: 'update',
                  diff: diffText({ name: before?.name ?? '' }, { name: v.groupName }),
                },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              await svc.updateGroup(v.groupId, { name: v.groupName });
              emitStage(ctx, { kind: 'group', id: v.groupId, action: 'update' });
              return { ok: true, data: `分组「${before?.name ?? v.groupId}」已改名为「${v.groupName}」` };
            }
            case 'delete_group': {
              if (!v.groupId) return { ok: false, error: 'delete_group 需要 groupId' };
              const pid = await svc.groupProjectId(v.groupId);
              if (pid !== ctx.projectId) return { ok: false, error: '分组不存在或不属于当前项目' };
              // 对齐 web 端 not_empty 409 语义:非空分组直接拒绝,不发确认卡
              const caseCount = await svc.countGroupCases(v.groupId);
              if (caseCount > 0) return { ok: false, error: `分组下还有 ${caseCount} 条用例,禁止删除;请先移动或删除这些用例` };
              const before = await svc.getGroup(v.groupId);
              const approved = await requestConfirmation(
                {
                  threadId: ctx.threadId, toolName: 'manage_cases', action: 'delete_group',
                  summary: st(lang, 'group.deleted', { name: before?.name ?? v.groupId }),
                  risk: 'delete',
                },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              await svc.deleteGroup(v.groupId);
              emitStage(ctx, { kind: 'group', id: v.groupId, action: 'delete' });
              return { ok: true, data: `已删除分组「${before?.name ?? v.groupId}」` };
            }
            default:
              return { ok: false, error: `unknown action ${(v as { action: string }).action}` };
          }
        } catch (e) {
          if (e instanceof HttpError) return { ok: false, error: e.message };
          return { ok: false, error: `操作失败:${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },
  ];
}