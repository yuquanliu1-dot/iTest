import { Type } from '@earendil-works/pi-ai';
import { chromium } from 'playwright-core';
import { resolveEnv } from '../../../execute/envContext.js';
import { loginInContext } from '../../autoLogin.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

export function buildLoginTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'get_login_credentials',
      description:
        '返回当前版本/项目默认环境的登录凭据概要（用户名、登录页地址、是否已配置密码、环境 ID）。不会暴露密码本身；若需要登录态，可接着调用 perform_login。',
      parameters: Type.Object({}),
      execute: async () => {
        let envCtx: Awaited<ReturnType<typeof resolveEnv>> | undefined;
        try {
          envCtx = await resolveEnv({ versionId: ctx.versionId }, { expectedProjectId: ctx.projectId });
          if (!envCtx.login) {
            return { ok: false, error: '当前默认环境未配置 login 凭据' };
          }
          return {
            ok: true,
            data: JSON.stringify({
              user: envCtx.login.user,
              loginUrl: envCtx.login.loginUrl,
              hasPassword: true,
              environmentId: envCtx.envId,
            }),
          };
        } catch (e) {
          return { ok: false, error: `读取环境失败:${(e as Error).message}` };
        } finally {
          if (envCtx) await envCtx.close().catch(() => {});
        }
      },
    },
    {
      name: 'perform_login',
      description:
        '使用当前版本/项目默认环境的 login 凭据在被测系统执行登录，返回 storageState（JSON 字符串）。后续可将 storageState 传给 inspect_page 以抓取登录态页面；凭据在服务端解密，不会出现在输出中。',
      parameters: Type.Object({
        url: Type.Optional(Type.String({ minLength: 8, maxLength: 2000 })),
      }),
      promptGuidelines: [
        '若 inspect_page 返回登录页，先调用 get_login_credentials 确认凭据已配置，再调用 perform_login 获取 storageState，最后将 storageState 传入 inspect_page。',
      ],
      execute: async (input) => {
        const { url } = input as { url?: string };
        let envCtx: Awaited<ReturnType<typeof resolveEnv>> | undefined;
        try {
          envCtx = await resolveEnv({ versionId: ctx.versionId }, { expectedProjectId: ctx.projectId });
          if (!envCtx.login) {
            return { ok: false, error: '当前默认环境未配置 login 凭据' };
          }
          const targetUrl = url || envCtx.login.loginUrl || envCtx.baseUrl || '';
          if (!targetUrl) {
            return { ok: false, error: '缺少登录目标 URL（未传 url，且环境未配置 loginUrl/baseUrl）' };
          }
          const browser = await chromium.launch({
            headless: true,
            executablePath: process.env.CHROMIUM_PATH || undefined,
          });
          try {
            const context = await browser.newContext({ ignoreHTTPSErrors: true });
            const status = await loginInContext(context, envCtx.login, targetUrl);
            const storageState = await context.storageState();
            return {
              ok: true,
              data: JSON.stringify({
                storageState,
                message: status === 'logged-in' ? '登录成功' : '页面无需登录或已有登录态',
              }),
            };
          } finally {
            await browser.close().catch(() => {});
          }
        } catch (e) {
          return { ok: false, error: `登录失败:${(e as Error).message}` };
        } finally {
          if (envCtx) await envCtx.close().catch(() => {});
        }
      },
    },
  ];
}
