/**
 * manage_cases: read + group create/rename/delete + cross-version copy.
 * Ownership validation (entity ∈ ctx.projectId; per-action version read/write surfaces) lives here; per-user visibility lives at the HTTP boundary.
 *
 * Design change: every modification of cases/steps goes uniformly through stage_case_op staging → StagePanel check-off → persistence.
 * This tool has seven actions:
 *   - search: in-version search (versionId can search other versions of the same project, finding a source for cross-version copy)
 *   - get: caseId → full detail (cross-version reads within the same project, verifying the source case before copying; attaches the dataset structure when one is bound)
 *   - list_versions: project version list (get source/target versionIds)
 *   - copy_to_version: copy a case into a target group (cross-version allowed, writes in real time — a container-level operation on par with create_group)
 *   - create_group: group container creation still writes in real time (groups are cases' containers, not "modifications of a case")
 *   - rename_group / delete_group: group rename/delete (delete restricted to empty groups, goes through the confirmation card)
 *
 * Old-action migration:
 *   - create          → stage_case (payload carries groupId; stageRoute validates group ownership at persistence time)
 *   - update          → stage_case_op (action=update_case)
 *   - delete          → stage_case_op (action=delete_case)
 *   - move_group      → stage_case_op (action=move_case)
 *   - all step-level operations   → stage_case_op (update_step/insert_step/delete_step/move_step)
 *   - list_datasets   → manage_datasets (datasets read/write/delete as an independent tool)
 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import * as svc from '../../../services/cases.service.js';
import { resolveCaseProjectId, resolveVersionProjectId } from '../../../services/projectAccess.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import { db } from '../../../db/client.js';
import { datasets } from '../../../db/schema.js';
import { countEnabledRows } from '../../../services/datasets.service.js';
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
  /** search: source version (default: current version); copy_to_version: target version (default: the current thread's version). */
  versionId: z.string().uuid().optional(),
  targetGroupId: z.string().uuid().optional(),
});

export function buildCasesTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'manage_cases',
      description:
        '用例只读操作 + 分组管理 + 跨版本复制。action=search(关键词检索用例,匹配标题/描述/预期结果/步骤文本/标签名;缺省当前版本,可传 versionId 检索同项目其它版本)| get(caseId,含步骤与标签,同项目内可跨版本读)| list_versions(项目版本列表,标出当前版本)| copy_to_version(caseId + targetGroupId,可传 versionId 指定目标版本,缺省复制到当前版本;实时落库)| create_group(groupName,可带 groupDefaultUrl)| rename_group(groupId+name,需用户确认)| delete_group(groupId,仅空分组可删,需用户确认)。数据集的读/改/删走 manage_datasets(行值敏感格脱敏)。用例/步骤的增删改一律走 stage_case(全新用例)或 stage_case_op(已有用例)—— 用户在右侧 StagePanel 勾选 → 落库。',
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
        '设计新用例前先检索同类已有用例：用 search 按业务对象/动作词检索(关键词可多试几个:功能名、页面名、操作动词),对最相关的 1~3 条 get 看步骤与断言——参考其覆盖点、步骤写法与命名风格;与本次需求重叠的覆盖点要点明「已由哪条已有用例覆盖」。已有用例的锚点/URL/账号等线内事实不得照抄,一律以当前应用实测为准。',
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
              // Defaults to searching the current version; with versionId, other versions of the same project are searchable (finding the source case for cross-version copy)
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
              // Cross-version reads within the same project (verify the source case before copying); cross-project is rejected
              const pid = await resolveCaseProjectId(v.caseId);
              if (pid !== ctx.projectId) return { ok: false, error: '用例不存在或不属于当前项目' };
              // Bound dataset → attach the structure (column names are the replay initial variables); structure only, row values/sensitive values never leak out
              // rowIndexes = the case's current dataset row selection (enabled-row indexes); [] = all enabled rows
              let dataset: { id: string; name: string; columns: Array<{ name: string; sensitive: boolean }>; enabledRowCount: number; rowIndexes: number[] } | null = null;
              if (detail.datasetId) {
                const ds = (await db.select().from(datasets).where(eq(datasets.id, detail.datasetId)).limit(1))[0];
                if (ds) dataset = { id: ds.id, name: ds.name, columns: ds.columns, enabledRowCount: countEnabledRows(ds.rows), rowIndexes: detail.datasetRowIndexes ?? [] };
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
              // Defaults to copying into the current thread's version; an explicit versionId must also ∈ the current project
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
              // Aligned with the web side's not_empty 409 semantics: reject non-empty groups outright, no confirmation card
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