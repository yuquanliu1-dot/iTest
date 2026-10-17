/** manage_scenarios:场景列表/创建/改名删述/删除。场景从属需求(requirementId 必填,归属经需求解析)。 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import * as svc from '../../../services/scenarios.service.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';
import { diffText } from './diff.js';
import { requestConfirmation } from '../confirm.js';
import { st, type StLang } from '../../../i18n.js';
import { aiLangFrom } from '../../../agent/langDirective.js';

const Actions = z.object({
  action: z.enum(['list', 'create', 'update', 'delete']),
  scenarioId: z.string().uuid().optional(),
  requirementId: z.string().uuid().optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
});

export function buildScenariosTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'manage_scenarios',
      description:
        '场景管理(场景从属需求,用例可绑定场景)。action=list(项目内场景全集,含 requirementId)| create(requirementId+title 必填;requirementId 取自上下文摘要)| update(scenarioId + title/description)| delete(scenarioId,需用户确认)。',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('list'), Type.Literal('create'), Type.Literal('update'), Type.Literal('delete')]),
        scenarioId: Type.Optional(Type.String()),
        requirementId: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
      promptGuidelines: [
        '创建场景前先 list 确认是否已存在同名场景;requirementId 必须来自上下文摘要或 list 结果,禁止臆造。',
        'delete 会向用户发确认卡;被拒或超时视为放弃,不要重试。',
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
              const rows = await svc.listScenariosByProject(ctx.projectId);
              return { ok: true, data: JSON.stringify(rows, null, 2) };
            }
            case 'create': {
              if (!v.requirementId || !v.title) return { ok: false, error: 'create 需要 requirementId 与 title' };
              const pid = await svc.requirementProjectId(v.requirementId);
              if (pid !== ctx.projectId) return { ok: false, error: '需求不存在或不属于当前项目' };
              const sc = await svc.createScenario(v.requirementId, { title: v.title, description: v.description });
              emitStage(ctx, { kind: 'scenario', id: sc.id, action: 'create' });
              return { ok: true, data: `已创建场景「${sc.title}」(${sc.id})` };
            }
            case 'update': {
              if (!v.scenarioId) return { ok: false, error: 'update 需要 scenarioId' };
              const pid = await svc.scenarioProjectId(v.scenarioId);
              if (pid !== ctx.projectId) return { ok: false, error: '场景不存在或不属于当前项目' };
              const patch: { title?: string; description?: string | null } = {};
              if (v.title !== undefined) patch.title = v.title;
              if (v.description !== undefined) patch.description = v.description;
              if (Object.keys(patch).length === 0) return { ok: false, error: 'update 未提供任何要修改的字段(title/description)' };
              const before = await svc.getScenario(v.scenarioId);
              // 挂起前预计算 diff(旧值 vs 合成新值),确认卡与实际执行共用一份数据
              const diff = diffText(before ?? {}, { ...(before ?? {}), ...patch });
              if (diff !== undefined) {
                const approved = await requestConfirmation(
                  { threadId: ctx.threadId, toolName: 'manage_scenarios', action: 'update', summary: st(lang, 'scenario.updated', { title: before?.title ?? v.scenarioId }), risk: 'update', diff },
                  ctx.emit,
                );
                if (!approved) return { ok: false, error: '用户取消了该操作' };
              }
              const after = await svc.updateScenario(v.scenarioId, patch);
              emitStage(ctx, { kind: 'scenario', id: v.scenarioId, action: 'update', diff });
              return { ok: true, data: `已更新场景「${after.title}」` };
            }
            case 'delete': {
              if (!v.scenarioId) return { ok: false, error: 'delete 需要 scenarioId' };
              const sc = await svc.getScenario(v.scenarioId);
              const pid = sc ? await svc.scenarioProjectId(sc.id) : null;
              if (!sc || pid !== ctx.projectId) return { ok: false, error: '场景不存在或不属于当前项目' };
              const approved = await requestConfirmation(
                { threadId: ctx.threadId, toolName: 'manage_scenarios', action: 'delete', summary: st(lang, 'scenario.deleted', { title: sc.title }), risk: 'delete' },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              await svc.deleteScenario(v.scenarioId);
              emitStage(ctx, { kind: 'scenario', id: v.scenarioId, action: 'delete' });
              return { ok: true, data: `已删除场景「${sc.title}」` };
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
