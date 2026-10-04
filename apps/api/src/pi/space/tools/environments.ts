/**
 * manage_environments:环境列表/详情/upsert(含对象,但拒绝明文凭据;更新标量字段走阻塞确认)/set_secret(阻塞确认)/删除(阻塞确认)。
 * 明文凭据只能走 set_secret:summary 不回显值;工具返回与 stage 事件均只有掩码。
 * findEnvironmentObject 返回含密文的原始行,仅限内部定位 id,严禁序列化进任何输出。
 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import * as svc from '../../../services/environments.service.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import { resolveEnvironmentProjectId } from '../../../services/projectAccess.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';
import { diffText } from './diff.js';
import { requestConfirmation } from '../confirm.js';

const Actions = z.object({
  action: z.enum(['list', 'get', 'upsert', 'set_secret', 'delete']),
  environmentId: z.string().uuid().optional(),
  name: z.string().min(1).max(120).optional(),
  baseUrl: z.string().max(2000).nullable().optional(),
  isDefault: z.boolean().optional(),
  objects: z.array(z.object({
    objectType: z.enum(['db', 'syslog', 'login']),
    label: z.string().max(120).optional(),
    payload: z.record(z.unknown()),
    isDefault: z.boolean().optional(),
  })).max(10).optional(),
  objectType: z.enum(['db', 'syslog', 'login']).optional(), // set_secret 用
  label: z.string().max(120).optional(), // set_secret 用(缺省「默认」)
  value: z.string().min(1).max(8000).optional(), // set_secret 明文(仅进加密,不进任何输出)
});

export function buildEnvironmentsTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'manage_environments',
      description:
        '测试环境管理。action=list(项目环境全集,对象凭据已掩码)| get(environmentId)| upsert(新建或更新环境与对象字段:environmentId 缺省=新建需 name;objects 按 objectType+label 合并;payload 禁带 password/privateKey)| set_secret(environmentId+objectType+value,需用户确认,值不回显)| delete(environmentId,需用户确认)。',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('list'), Type.Literal('get'), Type.Literal('upsert'), Type.Literal('set_secret'), Type.Literal('delete')]),
        environmentId: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        baseUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        isDefault: Type.Optional(Type.Boolean()),
        objects: Type.Optional(Type.Array(Type.Object({
          objectType: Type.Union([Type.Literal('db'), Type.Literal('syslog'), Type.Literal('login')]),
          label: Type.Optional(Type.String()),
          payload: Type.Record(Type.String(), Type.Unknown()),
          isDefault: Type.Optional(Type.Boolean()),
        }), { maxItems: 10 })),
        objectType: Type.Optional(Type.Union([Type.Literal('db'), Type.Literal('syslog'), Type.Literal('login')])),
        label: Type.Optional(Type.String()),
        value: Type.Optional(Type.String()),
      }),
      promptGuidelines: [
        'db 对象 payload 常用字段:host/port/dbName/user;syslog 对象:host/sshPort/user/filePath/authType("key"|"password");login 对象(应用登录凭据):user/loginUrl(登录页地址,可空=计划检测页),密码用 set_secret 设置。',
        '凭据(db/syslog 的 password/privateKey、login 的 password)严禁放进 upsert 的 payload:先 upsert 其它字段,再单独调 set_secret(会请用户确认)。',
        'set_secret 的 value 是明文凭据,只会被加密保存,不会出现在任何输出里;用户拒绝即放弃。',
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
              return { ok: true, data: JSON.stringify(await svc.listEnvironments(ctx.projectId), null, 2) };
            }
            case 'get': {
              if (!v.environmentId) return { ok: false, error: 'get 需要 environmentId' };
              const pid = await resolveEnvironmentProjectId(v.environmentId);
              if (pid !== ctx.projectId) return { ok: false, error: '环境不存在或不属于当前项目' };
              const detail = await svc.getEnvironment(v.environmentId);
              if (!detail) return { ok: false, error: '环境不存在或不属于当前项目' };
              return { ok: true, data: JSON.stringify(detail, null, 2) };
            }
            case 'upsert': {
              for (const o of v.objects ?? []) {
                if ('password' in o.payload || 'privateKey' in o.payload) {
                  return { ok: false, error: 'upsert 的 payload 不接受明文 password/privateKey:请先 upsert 对象的其它字段,再单独调 action=set_secret 设置凭据' };
                }
              }
              let envId: string;
              let upsertDiff: string | undefined;
              if (v.environmentId) {
                const pid = await resolveEnvironmentProjectId(v.environmentId);
                if (pid !== ctx.projectId) return { ok: false, error: '环境不存在或不属于当前项目' };
                const patch: { name?: string; baseUrl?: string | null; isDefault?: boolean } = {};
                if (v.name !== undefined) patch.name = v.name;
                if (v.baseUrl !== undefined) patch.baseUrl = v.baseUrl;
                if (v.isDefault !== undefined) patch.isDefault = v.isDefault;
                if (Object.keys(patch).length > 0) {
                  // 更新路径走阻塞确认:挂起前预计算 diff(旧值 vs 合成新值),确认卡与实际执行共用一份数据
                  const before = await svc.getEnvironment(v.environmentId);
                  upsertDiff = diffText(before ?? {}, { ...(before ?? {}), ...patch });
                  if (upsertDiff !== undefined) {
                    const approved = await requestConfirmation(
                      {
                        threadId: ctx.threadId, toolName: 'manage_environments', action: 'upsert',
                        summary: `更新环境「${before?.name ?? v.environmentId}」`, risk: 'update', diff: upsertDiff,
                      },
                      ctx.emit,
                    );
                    if (!approved) return { ok: false, error: '用户取消了该操作' };
                  }
                  await svc.updateEnvironment(v.environmentId, patch);
                }
                envId = v.environmentId;
              } else {
                if (!v.name) return { ok: false, error: 'upsert 新建环境需要 name' };
                envId = (await svc.createEnvironment(ctx.projectId, { name: v.name, baseUrl: v.baseUrl ?? null })).id;
              }
              for (const o of v.objects ?? []) await svc.upsertEnvironmentObject(envId, o);
              emitStage(ctx, { kind: 'environment', id: envId, action: 'upsert', diff: upsertDiff });
              return { ok: true, data: JSON.stringify(await svc.getEnvironment(envId), null, 2) };
            }
            case 'set_secret': {
              if (!v.environmentId || !v.objectType || !v.value) return { ok: false, error: 'set_secret 需要 environmentId、objectType 与 value' };
              const pid = await resolveEnvironmentProjectId(v.environmentId);
              if (pid !== ctx.projectId) return { ok: false, error: '环境不存在或不属于当前项目' };
              const env = await svc.getEnvironment(v.environmentId);
              const obj = await svc.findEnvironmentObject(v.environmentId, v.objectType, v.label);
              if (!obj) return { ok: false, error: `该环境还没有 ${v.objectType} 对象「${v.label ?? '默认'}」:先用 upsert 创建后再设置凭据` };
              const approved = await requestConfirmation(
                {
                  threadId: ctx.threadId, toolName: 'manage_environments', action: 'set_secret',
                  summary: `设置环境「${env?.name ?? v.environmentId}」的 ${v.objectType} 对象「${obj.label}」访问凭据(值不回显)`,
                  risk: 'secret',
                },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              await svc.setEnvironmentObjectSecret(obj.id, v.value);
              emitStage(ctx, { kind: 'environment', id: v.environmentId, action: 'set_secret' });
              return { ok: true, data: '凭据已加密保存' };
            }
            case 'delete': {
              if (!v.environmentId) return { ok: false, error: 'delete 需要 environmentId' };
              const pid = await resolveEnvironmentProjectId(v.environmentId);
              if (pid !== ctx.projectId) return { ok: false, error: '环境不存在或不属于当前项目' };
              const env = await svc.getEnvironment(v.environmentId);
              const usage = await svc.environmentUsage(v.environmentId);
              const usageText = usage.caseCount + usage.planCount > 0
                ? `(将使 ${usage.caseCount} 个用例与 ${usage.planCount} 个计划的引用置空)`
                : '(无引用)';
              const approved = await requestConfirmation(
                {
                  threadId: ctx.threadId, toolName: 'manage_environments', action: 'delete',
                  summary: `删除环境「${env?.name ?? v.environmentId}」${usageText}`,
                  risk: 'delete',
                },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              await svc.deleteEnvironment(v.environmentId);
              emitStage(ctx, { kind: 'environment', id: v.environmentId, action: 'delete' });
              return { ok: true, data: `已删除环境「${env?.name ?? v.environmentId}」` };
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
