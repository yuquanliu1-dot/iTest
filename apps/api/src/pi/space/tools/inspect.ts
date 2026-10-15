import { Type } from '@earendil-works/pi-ai';
import { inspectPage } from '../../inspectPage.js';
import { resolveEnv } from '../../../execute/envContext.js';
import { getLoginState, loginStateKey } from './loginStateCache.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

export function buildInspectTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'inspect_page',
    description:
      '抓取被测页面并返回实际可交互元素清单(按钮/输入框/链接/选择器/文案,含 data-testid)。创建带步骤的用例前,若知道页面 URL,先调用本工具获取真实元素,禁止凭「典型实现」臆造 locator。默认自动注入本环境的登录态;若返回的清单是登录页,再显式传 perform_login 返回的 storageState 重新抓取。快照仅为页面初始状态,操作后才出现的元素不在其中。',
    parameters: Type.Object({
      url: Type.String({ minLength: 8, maxLength: 2000 }),
      storageState: Type.Optional(Type.String({ maxLength: 100_000 })),
    }),
    promptGuidelines: [
      '工具会自动注入本环境的登录态，无需手动传 storageState。',
      '若返回的清单仍是登录页（出现 password 输入框或 URL 含 login/signin），先调用 get_login_credentials 确认环境有凭据，再调用 perform_login 获取 storageState，显式传给 inspect_page 重新抓取。',
    ],
    execute: async (input) => {
      const { url, storageState: raw } = input as { url: string; storageState?: string };
      let storageState: unknown | undefined;
      if (raw) {
        try {
          storageState = JSON.parse(raw);
        } catch {
          return { ok: false, error: 'storageState 不是合法 JSON' };
        }
      }
      // 调用方没显式传 storageState 时，退回登录态缓存（同 verifyCase.ts 的用法）：
      // 微前端/会话式后台未登录时只渲染出登录页外壳，抓到的「元素」其实全是登录表单——
      // 模型会误判成「页面没渲染出来」。命中缓存则直接注入，省掉一轮 perform_login。
      if (!storageState) {
        let envCtx: Awaited<ReturnType<typeof resolveEnv>> | undefined;
        try {
          envCtx = await resolveEnv({ versionId: ctx.versionId }, { expectedProjectId: ctx.projectId });
          const cached = getLoginState(loginStateKey(envCtx.envId, envCtx.login?.user));
          if (cached) storageState = cached;
        } catch {
          // 环境不可解析不是致命错误：无登录态照常抓取，模型会看到登录页并自行决定是否 perform_login
        } finally {
          if (envCtx) await envCtx.close().catch(() => {});
        }
      }
      try {
        return { ok: true, data: await inspectPage(url, storageState ? { storageState } : undefined) };
      } catch (e) {
        return { ok: false, error: `页面抓取失败:${(e as Error).message}` };
      }
    },
  };
}
