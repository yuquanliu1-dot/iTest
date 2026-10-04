/** manage_plans:计划列表/详情/创建/更新/加用例/移用例。无阻塞确认(改组合是可逆更新),变更走 stage 事件。 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import * as svc from '../../../services/plans.service.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';
import { diffText } from './diff.js';

const Actions = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'add_cases', 'remove_cases']),
  planId: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  environmentId: z.string().uuid().nullable().optional(),
  strategy: z.enum(['run_all', 'fail_fast']).optional(),
  caseIds: z.array(z.string().uuid()).max(200).optional(),
});

export function buildPlansTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'manage_plans',
      description:
        '执行计划管理。action=list(本版本计划,含 caseCount)| get(planId,含有序用例)| create(name 必填,可带 environmentId/strategy/caseIds)| update(planId + name/environmentId/strategy)| add_cases(planId+caseIds,追加到队尾,重复跳过)| remove_cases(planId+caseIds,余量重排)。',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('list'), Type.Literal('get'), Type.Literal('create'), Type.Literal('update'), Type.Literal('add_cases'), Type.Literal('remove_cases')]),
        planId: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        environmentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        strategy: Type.Optional(Type.Union([Type.Literal('run_all'), Type.Literal('fail_fast')])),
        caseIds: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
      }),
      promptGuidelines: [
        'caseIds 必须来自 manage_cases 的 search/get 结果,禁止臆造;加入计划的用例必须属于当前项目。',
        '本工具不会执行计划,只做配置;需要执行时告知用户去执行页操作。',
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
            case 'list': {
              return { ok: true, data: JSON.stringify(await svc.listPlansByVersion(ctx.versionId), null, 2) };
            }
            case 'get': {
              if (!v.planId) return { ok: false, error: 'get 需要 planId' };
              const pid = await svc.planProjectId(v.planId);
              if (pid !== ctx.projectId) return { ok: false, error: '计划不存在或不属于当前项目' };
              const detail = await svc.getPlanDetail(v.planId);
              if (!detail) return { ok: false, error: '计划不存在或不属于当前项目' };
              return { ok: true, data: JSON.stringify(detail, null, 2) };
            }
            case 'create': {
              if (!v.name) return { ok: false, error: 'create 需要 name' };
              const plan = await svc.createPlan(ctx.projectId, {
                name: v.name,
                versionId: ctx.versionId,
                environmentId: v.environmentId ?? undefined,
                strategy: v.strategy,
              });
              if (v.caseIds?.length) await svc.replacePlanCases(plan.id, v.caseIds);
              emitStage(ctx, { kind: 'plan', id: plan.id, action: 'create' });
              return { ok: true, data: `已创建计划「${plan.name}」(${plan.id})${v.caseIds?.length ? `,含 ${v.caseIds.length} 个用例` : ''}` };
            }
            case 'update': {
              if (!v.planId) return { ok: false, error: 'update 需要 planId' };
              const pid = await svc.planProjectId(v.planId);
              if (pid !== ctx.projectId) return { ok: false, error: '计划不存在或不属于当前项目' };
              const before = await svc.getPlanDetail(v.planId);
              const patch: { name?: string; environmentId?: string | null; strategy?: string } = {};
              if (v.name !== undefined) patch.name = v.name;
              if (v.environmentId !== undefined) patch.environmentId = v.environmentId;
              if (v.strategy !== undefined) patch.strategy = v.strategy;
              if (Object.keys(patch).length === 0) return { ok: false, error: 'update 未提供任何要修改的字段(name/environmentId/strategy)' };
              await svc.updatePlan(v.planId, patch);
              const after = await svc.getPlanDetail(v.planId);
              emitStage(ctx, { kind: 'plan', id: v.planId, action: 'update', diff: diffText(before ?? {}, after ?? {}) });
              return { ok: true, data: `已更新计划「${after?.name ?? v.planId}」` };
            }
            case 'add_cases': {
              if (!v.planId || !v.caseIds?.length) return { ok: false, error: 'add_cases 需要 planId 与 caseIds' };
              const pid = await svc.planProjectId(v.planId);
              if (pid !== ctx.projectId) return { ok: false, error: '计划不存在或不属于当前项目' };
              const added = await svc.addPlanCases(v.planId, v.caseIds);
              emitStage(ctx, { kind: 'plan', id: v.planId, action: 'add_cases', diff: `cases: +${added}` });
              return { ok: true, data: `已向计划追加 ${added} 个用例` };
            }
            case 'remove_cases': {
              if (!v.planId || !v.caseIds?.length) return { ok: false, error: 'remove_cases 需要 planId 与 caseIds' };
              const pid = await svc.planProjectId(v.planId);
              if (pid !== ctx.projectId) return { ok: false, error: '计划不存在或不属于当前项目' };
              const removed = await svc.removePlanCases(v.planId, v.caseIds);
              emitStage(ctx, { kind: 'plan', id: v.planId, action: 'remove_cases', diff: `cases: -${removed}` });
              return { ok: true, data: `已从计划移除 ${removed} 个用例` };
            }
          }
        } catch (e) {
          if (e instanceof HttpError) return { ok: false, error: e.message };
          return { ok: false, error: `操作失败:${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },
  ];
}
