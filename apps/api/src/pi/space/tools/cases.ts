/**
 * manage_cases(2026-10-07 简化版):仅保留读 + 分组创建。
 * 归属校验(实体 ∈ ctx.projectId / ctx.versionId)在这里;per-user 可见性在 HTTP 边界。
 *
 * 设计变更:用例/步骤的一切修改统一走 stage_case_op 暂存 → StagePanel 勾选 → 落库。
 * 本工具只剩三类：
 *   - search:版本内检索
 *   - get:caseId 拿完整详情(含步骤/expectedOutcome/tags)
 *   - create_group:分组容器创建仍实时写(分组是用例的容器,不属于"对用例的修改")
 *
 * 旧 action 迁移：
 *   - create          → stage_case(payload 带 groupId,落库时 stageRoute 校验 groupId 归属)
 *   - update          → stage_case_op(action=update_case)
 *   - delete          → stage_case_op(action=delete_case)
 *   - move_group      → stage_case_op(action=move_case)
 *   - 一切步骤级操作   → stage_case_op(update_step/insert_step/delete_step/move_step)
 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import * as svc from '../../../services/cases.service.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';

const Actions = z.object({
  action: z.enum(['search', 'get', 'create_group']),
  caseId: z.string().uuid().optional(),
  keyword: z.string().max(200).optional(),
  groupId: z.string().uuid().optional(),
  groupName: z.string().min(1).max(200).optional(),
  groupDefaultUrl: z.string().max(2000).optional(),
});

export function buildCasesTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'manage_cases',
      description:
        '用例只读操作 + 分组创建。action=search(版本内检索,可带 keyword/groupId)| get(caseId,含步骤与标签)| create_group(groupName,可带 groupDefaultUrl 作为用例默认入口 URL)。用例/步骤的增删改一律走 stage_case(全新用例)或 stage_case_op(已有用例)—— 用户在右侧 StagePanel 勾选 → 落库。',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('search'), Type.Literal('get'), Type.Literal('create_group')]),
        caseId: Type.Optional(Type.String()),
        keyword: Type.Optional(Type.String()),
        groupId: Type.Optional(Type.String()),
        groupName: Type.Optional(Type.String()),
        groupDefaultUrl: Type.Optional(Type.String()),
      }),
      promptGuidelines: [
        '用例/步骤的增删改一律走 stage_case(创建全新用例)或 stage_case_op(修改已有用例/步骤)。本工具不再支持任何用例写动作。',
        '修改用例元数据(标题/描述/优先级/status/expectedOutcome 等)请改用 stage_case_op(action=update_case,patch={...})；删除走 stage_case_op(action=delete_case)；移动分组走 stage_case_op(action=move_case)。',
        '编辑步骤(重编译 instruction、改 compiled、插入/删除/排序)走 stage_case_op(action=update_step/insert_step/delete_step/move_step)。',
        '创建 group 后返回 groupId；下一步创建用例时把 groupId 喂给 stage_case。',
        'search 返回的列表项不含步骤全文,要看完整步骤/expectedOutcome 用 get。',
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
        try {
          switch (v.action) {
            case 'search': {
              if (v.groupId) {
                const pid = await svc.groupProjectId(v.groupId);
                if (pid !== ctx.projectId) return { ok: false, error: '分组不存在或不属于当前项目' };
              }
              const rows = await svc.searchCasesInVersion(ctx.versionId, { keyword: v.keyword, groupId: v.groupId });
              return { ok: true, data: JSON.stringify(rows, null, 2) };
            }
            case 'get': {
              if (!v.caseId) return { ok: false, error: 'get 需要 caseId' };
              const detail = await svc.getCaseDetail(v.caseId);
              if (!detail || detail.versionId !== ctx.versionId) return { ok: false, error: '用例不存在或不属于当前版本' };
              return { ok: true, data: JSON.stringify(detail, null, 2) };
            }
            case 'create_group': {
              if (!v.groupName) return { ok: false, error: 'create_group 需要 groupName' };
              const g = await svc.createGroup(ctx.projectId, {
                name: v.groupName,
                ...(v.groupDefaultUrl !== undefined ? { defaultUrl: v.groupDefaultUrl } : {}),
              });
              emitStage(ctx, { kind: 'group', id: g.id, action: 'create' });
              return { ok: true, data: `已创建分组「${g.name}」(${g.id})` };
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