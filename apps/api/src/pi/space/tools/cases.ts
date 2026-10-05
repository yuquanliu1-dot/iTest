/**
 * manage_cases:版本内用例检索/详情/创建/改元数据/删除/移动分组/建分组。
 * 归属校验(实体 ∈ ctx.projectId / ctx.versionId)在这里;per-user 可见性在 HTTP 边界。
 * delete/update 走阻塞确认;其余写操作广播 stage 事件(非阻塞)。
 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import * as svc from '../../../services/cases.service.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';
import { diffText } from './diff.js';
import { requestConfirmation } from '../confirm.js';

const Actions = z.object({
  action: z.enum(['search', 'get', 'create', 'update', 'delete', 'move_group', 'create_group']),
  caseId: z.string().uuid().optional(),
  keyword: z.string().max(200).optional(),
  groupId: z.string().uuid().optional(),
  targetGroupId: z.string().uuid().optional(),
  groupName: z.string().min(1).max(200).optional(),
  groupDefaultUrl: z.string().max(2000).optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  status: z.enum(['draft', 'review', 'ready', 'deprecated']).optional(),
  url: z.string().max(2000).nullable().optional(),
  /** Track 1：用例级预期描述（自然语言）。回放结束后由 vision LLM 拿最终截图判定。
   * 步骤级 assertion 字段保留向后兼容，但 dispatch 层只接受真实元素断言；用例成败由本字段+vision 决定。 */
  expectedOutcome: z.string().max(4000).nullable().optional(),
  steps: z.array(z.object({
    action: z.string().min(1).max(2000),
    assertion: z.string().max(2000).nullable().optional(),
    compiled: z.array(z.unknown()).optional(),
  })).max(30).optional(),
  tagIds: z.array(z.string().uuid()).optional(),
});

export function buildCasesTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'manage_cases',
      description:
        '用例管理。action=search(版本内检索,可带 keyword/groupId)| get(caseId,含步骤与标签)| create(title+groupId+expectedOutcome 必填,可带 description/priority/url/steps/tagIds)| update(caseId + title/description/priority/status/url/expectedOutcome 任一)| delete(caseId,需用户确认)| move_group(caseId+targetGroupId)| create_group(groupName,可带 groupDefaultUrl 作为用例默认入口 URL)。',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('search'), Type.Literal('get'), Type.Literal('create'), Type.Literal('update'),
          Type.Literal('delete'), Type.Literal('move_group'), Type.Literal('create_group'),
        ]),
        caseId: Type.Optional(Type.String()),
        keyword: Type.Optional(Type.String()),
        groupId: Type.Optional(Type.String()),
        targetGroupId: Type.Optional(Type.String()),
        groupName: Type.Optional(Type.String()),
        groupDefaultUrl: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        priority: Type.Optional(Type.Union([Type.Literal('P0'), Type.Literal('P1'), Type.Literal('P2'), Type.Literal('P3')])),
        status: Type.Optional(Type.Union([Type.Literal('draft'), Type.Literal('review'), Type.Literal('ready'), Type.Literal('deprecated')])),
        url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        expectedOutcome: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        steps: Type.Optional(Type.Array(Type.Object({
          action: Type.String({ minLength: 1, maxLength: 2000 }),
          assertion: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          compiled: Type.Optional(Type.Array(Type.Unknown())),
        }), { maxItems: 30 })),
        tagIds: Type.Optional(Type.Array(Type.String())),
      }),
      promptGuidelines: [
        '创建用例前先 search 相近标题避免重复;groupId 必须来自上下文摘要、search 或 create_group 的结果,禁止臆造 id。',
        '【Track 1】每个用例必须带 expectedOutcome(自然语言描述预期终态):用一句到三句话讲清楚用例走到最后页面/状态应该是什么样。例:"空字段提交后,登录框出现红色提示『请输入用户名和密码』"、"连续错误 5 次后,登录页显示『账号已临时锁定,请 30 秒后再试』"。回放结束后 vision LLM 会拿最终截图与 expectedOutcome 比对,通过才算用例通过。',
        '写 steps 时:action 是人类可读操作指令。步骤级 assertion 字段保留但已被 dispatcher 收紧——只有带 locator 的真实元素断言会执行(指定的 input/button 可见),target=page match=contains 的整页文本断言会被跳过。推荐直接放弃步骤级 assertion,把所有"是否成功"写到 expectedOutcome 里让 vision 判。',
        'locator 必须是一层数组,每个元素是 {strategy, value},strategy 限 role/text/testId/css/xpath;不知道真实元素就省略 compiled(不要编造),或先调 inspect_page 抓页面。',
        'delete 会向用户发确认卡;被拒或超时返回取消,不要重试同一删除。',
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
            case 'create': {
              if (!v.title) return { ok: false, error: 'create 需要 title' };
              if (!v.groupId) return { ok: false, error: 'create 需要 groupId(可先用 create_group 创建)' };
              // Track 1：expectedOutcome 是用例级断言的唯一依据，强制必填。
              // 这里仅做软警告：为空时允许保存但不再 vision 判定，调用方承担「没有自动判终态」的成本。
              const created = await svc.createCaseWithSteps({
                groupId: v.groupId, versionId: ctx.versionId, title: v.title,
                description: v.description, priority: v.priority, url: v.url, tagIds: v.tagIds,
                expectedOutcome: v.expectedOutcome ?? null,
                // 工具入参的 steps[].action 对应 service 的 AiStepInput.instruction(人类可读指令)
                steps: v.steps?.map((s) => ({ instruction: s.action, assertion: s.assertion, compiled: s.compiled })),
              });
              emitStage(ctx, { kind: 'case', id: created.id, action: 'create' });
              const warning = !v.expectedOutcome
                ? '（提示：未提供 expectedOutcome，回放时不会自动判定用例终态，依赖步骤级断言/手动查看报告。）'
                : '';
              return { ok: true, data: `已创建用例「${created.title}」(${created.id})${warning}` };
            }
            case 'update': {
              if (!v.caseId) return { ok: false, error: 'update 需要 caseId' };
              const before = await svc.getCaseDetail(v.caseId);
              if (!before || before.versionId !== ctx.versionId) return { ok: false, error: '用例不存在或不属于当前版本' };
              const patch: svc.UpdateCasePatch = {};
              if (v.title !== undefined) patch.title = v.title;
              if (v.description !== undefined) patch.description = v.description;
              if (v.priority !== undefined) patch.priority = v.priority;
              if (v.status !== undefined) patch.status = v.status;
              if (v.url !== undefined) patch.url = v.url;
              if (v.expectedOutcome !== undefined) patch.expectedOutcome = v.expectedOutcome;
              if (Object.keys(patch).length === 0) return { ok: false, error: 'update 未提供任何要修改的字段(title/description/priority/status/url/expectedOutcome)' };
              // 挂起前预计算 diff(旧值 vs 合成新值),确认卡与实际执行共用一份数据
              const diff = diffText(before, { ...before, ...patch });
              if (diff !== undefined) {
                const approved = await requestConfirmation(
                  { threadId: ctx.threadId, toolName: 'manage_cases', action: 'update', summary: `更新用例「${before.title}」`, risk: 'update', diff },
                  ctx.emit,
                );
                if (!approved) return { ok: false, error: '用户取消了该操作' };
              }
              const after = await svc.updateCase(v.caseId, patch);
              emitStage(ctx, { kind: 'case', id: v.caseId, action: 'update', diff });
              return { ok: true, data: `已更新用例「${after.title}」` };
            }
            case 'delete': {
              if (!v.caseId) return { ok: false, error: 'delete 需要 caseId' };
              const detail = await svc.getCaseDetail(v.caseId);
              if (!detail || detail.versionId !== ctx.versionId) return { ok: false, error: '用例不存在或不属于当前版本' };
              const approved = await requestConfirmation(
                { threadId: ctx.threadId, toolName: 'manage_cases', action: 'delete', summary: `删除用例「${detail.title}」`, risk: 'delete' },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              await svc.deleteCase(v.caseId);
              emitStage(ctx, { kind: 'case', id: v.caseId, action: 'delete' });
              return { ok: true, data: `已删除用例「${detail.title}」` };
            }
            case 'move_group': {
              if (!v.caseId || !v.targetGroupId) return { ok: false, error: 'move_group 需要 caseId 与 targetGroupId' };
              const before = await svc.getCaseDetail(v.caseId);
              if (!before || before.versionId !== ctx.versionId) return { ok: false, error: '用例不存在或不属于当前版本' };
              const targetPid = await svc.groupProjectId(v.targetGroupId);
              if (targetPid !== ctx.projectId) return { ok: false, error: '目标分组不存在或不属于当前项目' };
              await svc.updateCase(v.caseId, { groupId: v.targetGroupId });
              emitStage(ctx, { kind: 'case', id: v.caseId, action: 'move_group', diff: `groupId: ${before.groupId} → ${v.targetGroupId}` });
              return { ok: true, data: `已把用例「${before.title}」移动到分组 ${v.targetGroupId}` };
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
          }
        } catch (e) {
          if (e instanceof HttpError) return { ok: false, error: e.message };
          return { ok: false, error: `操作失败:${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },
  ];
}
