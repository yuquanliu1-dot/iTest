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
      '抓取被测页面并返回实际可交互元素清单(按钮/输入框/链接/选择器/文案,含 data-testid)与抓取质量自评。可作为页面事实的取证渠道:草稿需要确认页面控件/字段时自主调用查证(默认自动注入本环境的登录态),查到即回流程。它抓的是页面初始状态——操作后才出现的元素不在其中,执行与断言证据仍以 verify_case 实测反馈为准(失败反馈自带失败页 URL、截图与可交互元素清单)。若返回「抓取质量: 低」,说明 URL 可能无效/是空壳页/登录页/404,不要基于该清单编造用例,先核对 URL 或换渠道取证(读前端代码确认真实路由)。',
    parameters: Type.Object({
      url: Type.String({ minLength: 8, maxLength: 2000 }),
      storageState: Type.Optional(Type.String({ maxLength: 100_000 })),
    }),
    promptGuidelines: [
      '草稿阶段缺页面事实(页面上有哪些控件/字段)时,可用本工具自主取证——自动注入登录态,无需用户批准;查到即回流程,不要连环抓页面空转。元素存在性与执行证据仍以 verify_case 实测为准(初始快照不含操作后出现的元素)。',
      '工具会自动注入本环境的登录态，无需手动传 storageState。',
      '若返回的清单仍是登录页（出现 password 输入框或 URL 含 login/signin），先调用 get_login_credentials 确认凭据已配置，再调用 perform_login 获取 storageState，显式传给 inspect_page 重新抓取。',
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
      // When the caller doesn't pass storageState explicitly, fall back to the login-state cache (same usage as verifyCase.ts):
      // micro-frontend/session-based backends render only a login-page shell when not logged in, so the captured "elements" are
      // actually all login form — the model would misjudge it as "the page didn't render". A cache hit injects directly, saving a perform_login round.
      if (!storageState) {
        let envCtx: Awaited<ReturnType<typeof resolveEnv>> | undefined;
        try {
          envCtx = await resolveEnv({ versionId: ctx.versionId }, { expectedProjectId: ctx.projectId });
          const cached = getLoginState(loginStateKey(envCtx.envId, envCtx.login?.user));
          if (cached) storageState = cached;
        } catch {
          // An unresolvable environment is not fatal: fetch as usual without a login state; the model will see the login page and decide on its own whether to perform_login
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
