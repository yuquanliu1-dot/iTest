/**
 * manage_devices:项目设备目标(移动用例绑定)读/建/改/删。
 * 新建实时写;更新走阻塞确认卡(diff 摘要);删除确认卡带绑定用例数(FK set null 自动解绑)。
 * deviceRef 为设备寻址标识(如 udid / 设备名),appBundleId/appPath/launchArgs 为可选 App 装载参数。
 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import * as svc from '../../../services/deviceTargets.service.js';
import { resolveDeviceTargetProjectId } from '../../../services/projectAccess.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';
import { diffText } from './diff.js';
import { requestConfirmation } from '../confirm.js';
import { st, type StLang } from '../../../i18n.js';
import { aiLangFrom } from '../../../agent/langDirective.js';

const Actions = z.object({
  action: z.enum(['list', 'get', 'upsert', 'delete']),
  deviceTargetId: z.string().uuid().optional(),
  name: z.string().min(1).max(128).optional(),
  mobileOs: z.enum(['ios', 'android']).optional(),
  deviceRef: z.string().min(1).max(128).optional(),
  appBundleId: z.string().max(256).nullable().optional(),
  appPath: z.string().max(4000).nullable().optional(),
  launchArgs: z.array(z.string()).optional(),
});

export function buildDevicesTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'manage_devices',
      description:
        '设备目标管理(移动用例的绑定对象)。action=list(项目设备目标全集)| get(deviceTargetId)| upsert(缺 deviceTargetId=新建需 name/mobileOs/deviceRef,实时落库;带 deviceTargetId=更新,需用户确认)| delete(deviceTargetId,需用户确认,绑定的移动用例自动解绑)。Web 用例不需要设备目标;仅移动用例(mobileDeviceTargetId)引用。',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('list'), Type.Literal('get'), Type.Literal('upsert'), Type.Literal('delete')]),
        deviceTargetId: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        mobileOs: Type.Optional(Type.Union([Type.Literal('ios'), Type.Literal('android')])),
        deviceRef: Type.Optional(Type.String()),
        appBundleId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        appPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        launchArgs: Type.Optional(Type.Array(Type.String())),
      }),
      promptGuidelines: [
        '创建前先 list 确认是否已存在同名设备目标(项目内 name 唯一,重名返回 409)。',
        'upsert 更新是全量替换语义:先 get 拿当前值,只传要改的字段,未传字段置空;更新会向用户发确认卡,被拒或超时视为放弃,不要重试。',
        'delete 会向用户发确认卡(附绑定移动用例数);删除后引用自动置空,被拒即放弃。',
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
              const rows = await svc.listDeviceTargets(ctx.projectId);
              return {
                ok: true,
                data: JSON.stringify(rows.map(({ projectId: _pid, updatedAt: _u, ...rest }) => rest), null, 2),
              };
            }
            case 'get': {
              if (!v.deviceTargetId) return { ok: false, error: 'get 需要 deviceTargetId' };
              const pid = await resolveDeviceTargetProjectId(v.deviceTargetId);
              if (pid !== ctx.projectId) return { ok: false, error: '设备目标不存在或不属于当前项目' };
              const d = await svc.getDeviceTarget(v.deviceTargetId);
              if (!d) return { ok: false, error: '设备目标不存在或不属于当前项目' };
              const { projectId: _pid, updatedAt: _u, ...rest } = d;
              return { ok: true, data: JSON.stringify(rest, null, 2) };
            }
            case 'upsert': {
              if (!v.name || !v.mobileOs || !v.deviceRef) return { ok: false, error: 'upsert 需要 name、mobileOs(ios|android) 与 deviceRef' };
              const body = {
                name: v.name,
                mobileOs: v.mobileOs,
                deviceRef: v.deviceRef,
                appBundleId: v.appBundleId ?? null,
                appPath: v.appPath ?? null,
                launchArgs: v.launchArgs ?? [],
              };
              if (v.deviceTargetId) {
                const pid = await resolveDeviceTargetProjectId(v.deviceTargetId);
                if (pid !== ctx.projectId) return { ok: false, error: '设备目标不存在或不属于当前项目' };
                const before = await svc.getDeviceTarget(v.deviceTargetId);
                if (!before) return { ok: false, error: '设备目标不存在或不属于当前项目' };
                const diff = diffText(before, { ...before, ...body });
                const approved = await requestConfirmation(
                  {
                    threadId: ctx.threadId, toolName: 'manage_devices', action: 'upsert',
                    summary: st(lang, 'device.updated', { name: before.name }), risk: 'update', diff,
                  },
                  ctx.emit,
                );
                if (!approved) return { ok: false, error: '用户取消了该操作' };
                const after = await svc.updateDeviceTarget(v.deviceTargetId, body);
                emitStage(ctx, { kind: 'device', id: v.deviceTargetId, action: 'upsert', diff: diff ?? undefined });
                return { ok: true, data: `已更新设备目标「${after.name}」(${after.mobileOs}, ref=${after.deviceRef})` };
              }
              const created = await svc.createDeviceTarget(ctx.projectId, body);
              emitStage(ctx, { kind: 'device', id: created.id, action: 'upsert' });
              return { ok: true, data: `已创建设备目标「${created.name}」(${created.id})` };
            }
            case 'delete': {
              if (!v.deviceTargetId) return { ok: false, error: 'delete 需要 deviceTargetId' };
              const pid = await resolveDeviceTargetProjectId(v.deviceTargetId);
              if (pid !== ctx.projectId) return { ok: false, error: '设备目标不存在或不属于当前项目' };
              const d = await svc.getDeviceTarget(v.deviceTargetId);
              const usage = await svc.deviceTargetUsage(v.deviceTargetId);
              const usageText = usage.caseCount > 0
                ? st(lang, 'device.usageReferenced', { caseCount: usage.caseCount })
                : st(lang, 'device.usageNone');
              const approved = await requestConfirmation(
                {
                  threadId: ctx.threadId, toolName: 'manage_devices', action: 'delete',
                  summary: st(lang, 'device.deleted', { name: d?.name ?? v.deviceTargetId, usage: usageText }),
                  risk: 'delete',
                },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              await svc.deleteDeviceTarget(v.deviceTargetId);
              emitStage(ctx, { kind: 'device', id: v.deviceTargetId, action: 'delete' });
              return { ok: true, data: `已删除设备目标「${d?.name ?? v.deviceTargetId}」` };
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
