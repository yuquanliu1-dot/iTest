/** manage_plans:计划列表/详情/创建/更新/加用例/移用例/调度 CRUD。创建自动执行;update/add_cases/remove_cases/_schedule 走阻塞确认,变更走 stage 事件。 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import * as svc from '../../../services/plans.service.js';
import * as sched from '../../../services/planSchedules.service.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';
import { diffText } from './diff.js';
import { requestConfirmation } from '../confirm.js';
import { st, type StLang } from '../../../i18n.js';
import { aiLangFrom } from '../../../agent/langDirective.js';

const Actions = z.object({
  action: z.enum(['list', 'get', 'create', 'update', 'add_cases', 'remove_cases', 'list_schedules', 'create_schedule', 'update_schedule', 'delete_schedule']),
  planId: z.string().uuid().optional(),
  scheduleId: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  environmentId: z.string().uuid().nullable().optional(),
  strategy: z.enum(['run_all', 'fail_fast']).optional(),
  caseIds: z.array(z.string().uuid()).max(200).optional(),
  cronExpr: z.string().min(1).max(120).optional(),
  timezone: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
});

/** update_schedule 字段未变化时短路,生成 diff 文本(不依赖 diffText,因为 schedule 行带 updatedAt/nextRunAt 等列)。 */
function scheduleDiff(before: { cronExpr: string; timezone: string; enabled: boolean }, patch: { cronExpr?: string; timezone?: string; enabled?: boolean }): string | undefined {
  const lines: string[] = [];
  if (patch.cronExpr !== undefined && patch.cronExpr !== before.cronExpr) lines.push(`cron: ${before.cronExpr} → ${patch.cronExpr}`);
  if (patch.timezone !== undefined && patch.timezone !== before.timezone) lines.push(`tz: ${before.timezone} → ${patch.timezone}`);
  if (patch.enabled !== undefined && patch.enabled !== before.enabled) lines.push(`enabled: ${before.enabled} → ${patch.enabled}`);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

export function buildPlansTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'manage_plans',
      description:
        '执行计划管理。action=list(本版本计划,含 caseCount)| get(planId,含有序用例)| create(name 必填,可带 environmentId/strategy/caseIds)| update(planId + name/environmentId/strategy)| add_cases(planId+caseIds,追加到队尾,重复跳过)| remove_cases(planId+caseIds,余量重排)| list_schedules(planId)| create_schedule(planId + cronExpr,可选 timezone/enabled)| update_schedule(scheduleId,可选 cronExpr/timezone/enabled,至少一个)| delete_schedule(scheduleId)。',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('list'), Type.Literal('get'), Type.Literal('create'), Type.Literal('update'),
          Type.Literal('add_cases'), Type.Literal('remove_cases'),
          Type.Literal('list_schedules'), Type.Literal('create_schedule'), Type.Literal('update_schedule'), Type.Literal('delete_schedule'),
        ]),
        planId: Type.Optional(Type.String()),
        scheduleId: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        environmentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        strategy: Type.Optional(Type.Union([Type.Literal('run_all'), Type.Literal('fail_fast')])),
        caseIds: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
        cronExpr: Type.Optional(Type.String()),
        timezone: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
      }),
      promptGuidelines: [
        'caseIds 必须来自 manage_cases 的 search/get 结果,禁止臆造;加入计划的用例必须属于当前项目。',
        '本工具不会执行计划,只做配置;需要执行时告知用户去执行页操作。',
        'create 时若用例编排失败(如 caseIds 跨项目),已建的计划不会回滚:按错误信息中的 planId 用 add_cases 补齐,勿重复 create。',
        'schedule 操作(action=list_schedules/create_schedule/update_schedule/delete_schedule)需走阻塞确认卡,新建/修改前先在自然语言里讲清 cron 含义(例如 `0 9 * * *` = 每天 09:00)。',
        'create_schedule 允许同 plan 多条并存;若要替换已有调度,先 delete_schedule 再 create_schedule。',
        'update_schedule 仅改启用/关闭时只传 enabled 字段;改 cron 或 timezone 时显式带新值。',
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
              }, ctx.createdByUserId);
              let added = 0;
              if (v.caseIds?.length) {
                try {
                  added = await svc.replacePlanCases(plan.id, v.caseIds);
                } catch (e) {
                  const reason = e instanceof HttpError ? e.message : `操作失败:${e instanceof Error ? e.message : String(e)}`;
                  return { ok: false, error: `计划已创建但用例编排失败(计划 ${plan.id}):${reason};可对该 planId 调 add_cases 补齐,勿重复 create` };
                }
              }
              emitStage(ctx, { kind: 'plan', id: plan.id, action: 'create' });
              return { ok: true, data: `已创建计划「${plan.name}」(${plan.id})${added > 0 ? `,含 ${added} 个用例` : ''}` };
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
              // 挂起前预计算 diff(旧值 vs 合成新值),确认卡与实际执行共用一份数据
              const diff = diffText(before ?? {}, { ...(before ?? {}), ...patch });
              if (diff !== undefined) {
                const approved = await requestConfirmation(
                  { threadId: ctx.threadId, toolName: 'manage_plans', action: 'update', summary: st(lang, 'plan.updated', { name: before?.name ?? v.planId }), risk: 'update', diff },
                  ctx.emit,
                );
                if (!approved) return { ok: false, error: '用户取消了该操作' };
              }
              await svc.updatePlan(v.planId, patch);
              const after = await svc.getPlanDetail(v.planId);
              emitStage(ctx, { kind: 'plan', id: v.planId, action: 'update', diff });
              return { ok: true, data: `已更新计划「${after?.name ?? v.planId}」` };
            }
            case 'add_cases': {
              if (!v.planId || !v.caseIds?.length) return { ok: false, error: 'add_cases 需要 planId 与 caseIds' };
              const pid = await svc.planProjectId(v.planId);
              if (pid !== ctx.projectId) return { ok: false, error: '计划不存在或不属于当前项目' };
              // 门控前校验用例归属:跨项目用例直接报错并点名,不弹确认卡(否则用户确认的是必然失败的操作)
              const outside = await svc.caseIdsOutsideProject(ctx.projectId, v.caseIds);
              if (outside.length > 0) return { ok: false, error: `用例不属于当前项目:${outside.join('、')}` };
              // 挂起前算精确增量(重复 id 去重、已在计划中的跳过);N=0 短路不执行
              const detail = await svc.getPlanDetail(v.planId);
              const have = new Set((detail?.cases ?? []).map((c) => c.id));
              const pendingCount = [...new Set(v.caseIds)].filter((c) => !have.has(c)).length;
              if (pendingCount === 0) return { ok: true, data: '所列用例均已在计划中,无需追加' };
              const diff = `cases: +${pendingCount}`;
              const approved = await requestConfirmation(
                {
                  threadId: ctx.threadId, toolName: 'manage_plans', action: 'add_cases',
                  summary: st(lang, 'plan.casesAdded', { name: detail?.name ?? v.planId, count: pendingCount }), risk: 'update', diff,
                },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              await svc.addPlanCases(v.planId, v.caseIds);
              emitStage(ctx, { kind: 'plan', id: v.planId, action: 'add_cases', diff });
              return { ok: true, data: `已向计划追加 ${pendingCount} 个用例` };
            }
            case 'remove_cases': {
              if (!v.planId || !v.caseIds?.length) return { ok: false, error: 'remove_cases 需要 planId 与 caseIds' };
              const pid = await svc.planProjectId(v.planId);
              if (pid !== ctx.projectId) return { ok: false, error: '计划不存在或不属于当前项目' };
              // 挂起前算精确增量(重复 id 去重、只计在计划中的);N=0 短路不执行
              const detail = await svc.getPlanDetail(v.planId);
              const have = new Set((detail?.cases ?? []).map((c) => c.id));
              const pendingCount = [...new Set(v.caseIds)].filter((c) => have.has(c)).length;
              if (pendingCount === 0) return { ok: true, data: '所列用例均不在计划中,无需移除' };
              const diff = `cases: -${pendingCount}`;
              const approved = await requestConfirmation(
                {
                  threadId: ctx.threadId, toolName: 'manage_plans', action: 'remove_cases',
                  summary: st(lang, 'plan.casesRemoved', { name: detail?.name ?? v.planId, count: pendingCount }), risk: 'update', diff,
                },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              await svc.removePlanCases(v.planId, v.caseIds);
              emitStage(ctx, { kind: 'plan', id: v.planId, action: 'remove_cases', diff });
              return { ok: true, data: `已从计划移除 ${pendingCount} 个用例` };
            }
            case 'list_schedules': {
              if (!v.planId) return { ok: false, error: 'list_schedules 需要 planId' };
              const pid = await svc.planProjectId(v.planId);
              if (pid !== ctx.projectId) return { ok: false, error: '计划不存在或不属于当前项目' };
              const rows = await sched.listPlanSchedules(v.planId);
              return { ok: true, data: JSON.stringify(rows, null, 2) };
            }
            case 'create_schedule': {
              if (!v.planId || !v.cronExpr) return { ok: false, error: 'create_schedule 需要 planId 与 cronExpr' };
              const pid = await svc.planProjectId(v.planId);
              if (pid !== ctx.projectId) return { ok: false, error: '计划不存在或不属于当前项目' };
              // 门控前先跑一遍 cron 校验：非法 cron 直接报错,不弹卡(同 update/add_cases 一致)
              try {
                sched.validateCron(v.cronExpr, v.timezone ?? 'Asia/Shanghai');
              } catch (e) {
                const msg = e instanceof HttpError ? e.message : `参数不合法:${e instanceof Error ? e.message : String(e)}`;
                return { ok: false, error: msg };
              }
              const detail = await svc.getPlanDetail(v.planId);
              const planName = detail?.name ?? v.planId;
              const tz = v.timezone ?? 'Asia/Shanghai';
              const summary = `为计划「${planName}」新建调度(cron=${v.cronExpr}, tz=${tz}, enabled=${v.enabled ?? true})`;
              const approved = await requestConfirmation(
                { threadId: ctx.threadId, toolName: 'manage_plans', action: 'create_schedule', summary, risk: 'update' },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              const row = await sched.createPlanSchedule(v.planId, {
                cronExpr: v.cronExpr,
                timezone: tz,
                enabled: v.enabled,
                // createdByUserId 是 FK；工具上下文无 userId → 暂留 null，由 DB on delete set null 兜底。
                // 这里用 createdByUserId 字段（service 接受 null）；若 FK 不允许 null 则 FK 设计本身就需要 NULLABLE。
                createdByUserId: null,
              });
              emitStage(ctx, { kind: 'plan', id: v.planId, action: 'create_schedule' });
              return { ok: true, data: `已为计划「${planName}」新建调度(cron=${row.cronExpr}, tz=${row.timezone}, enabled=${row.enabled});下次执行 ${row.nextRunAt?.toISOString()}` };
            }
            case 'update_schedule': {
              if (!v.scheduleId) return { ok: false, error: 'update_schedule 需要 scheduleId' };
              // 不存在 scheduleId → 短路,不弹卡(同 delete_schedule 的语义)
              const existing0 = await sched.getPlanSchedule(v.scheduleId);
              if (!existing0) return { ok: true, data: '调度不存在或已删除' };
              if (v.cronExpr === undefined && v.timezone === undefined && v.enabled === undefined) {
                return { ok: false, error: 'update_schedule 至少需要 cronExpr / timezone / enabled 中的一项' };
              }
              const pid = await svc.planProjectId(existing0.planId);
              if (pid !== ctx.projectId) return { ok: false, error: '计划不存在或不属于当前项目' };
              const diff = scheduleDiff(existing0, { cronExpr: v.cronExpr, timezone: v.timezone, enabled: v.enabled });
              if (diff === undefined) return { ok: true, data: '调度无需更新' };
              const planName = (await svc.getPlanDetail(existing0.planId))?.name ?? existing0.planId;
              const summary = `更新计划「${planName}」的调度`;
              const approved = await requestConfirmation(
                { threadId: ctx.threadId, toolName: 'manage_plans', action: 'update_schedule', summary, risk: 'update', diff },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              const row = await sched.updatePlanSchedule(v.scheduleId, {
                cronExpr: v.cronExpr,
                timezone: v.timezone,
                enabled: v.enabled,
              });
              emitStage(ctx, { kind: 'plan', id: v.scheduleId, action: 'update_schedule', diff });
              return { ok: true, data: `已更新调度(cron=${row.cronExpr}, tz=${row.timezone}, enabled=${row.enabled});下次执行 ${row.nextRunAt?.toISOString()}` };
            }
            case 'delete_schedule': {
              if (!v.scheduleId) return { ok: false, error: 'delete_schedule 需要 scheduleId' };
              const existing = await sched.getPlanSchedule(v.scheduleId);
              if (!existing) return { ok: true, data: '调度不存在或已删除' };
              const pid = await svc.planProjectId(existing.planId);
              if (pid !== ctx.projectId) return { ok: false, error: '计划不存在或不属于当前项目' };
              const planName = (await svc.getPlanDetail(existing.planId))?.name ?? existing.planId;
              const summary = `删除计划「${planName}」的调度(cron=${existing.cronExpr})`;
              const approved = await requestConfirmation(
                { threadId: ctx.threadId, toolName: 'manage_plans', action: 'delete_schedule', summary, risk: 'delete' },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              const r = await sched.deletePlanSchedule(v.scheduleId);
              if (!r.deleted) return { ok: true, data: '调度不存在或已删除' };
              emitStage(ctx, { kind: 'plan', id: v.scheduleId, action: 'delete_schedule' });
              return { ok: true, data: `已删除计划「${planName}」的调度` };
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
