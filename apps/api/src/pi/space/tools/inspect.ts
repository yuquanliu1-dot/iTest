import { Type } from '@earendil-works/pi-ai';
import { inspectPage } from '../../inspectPage.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

export function buildInspectTool(_ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'inspect_page',
    description:
      '抓取被测页面并返回实际可交互元素清单(按钮/输入框/链接/选择器/文案,含 data-testid)。创建带步骤的用例前,若知道页面 URL,先调用本工具获取真实元素,禁止凭「典型实现」臆造 locator。若页面需要登录,可传入 perform_login 返回的 storageState 以抓取登录态页面。快照仅为页面初始状态,操作后才出现的元素不在其中。',
    parameters: Type.Object({
      url: Type.String({ minLength: 8, maxLength: 2000 }),
      storageState: Type.Optional(Type.String({ maxLength: 100_000 })),
    }),
    promptGuidelines: [
      '若返回的清单是登录页（出现 password 输入框或 URL 含 login/signin），先调用 get_login_credentials 确认环境有凭据，再调用 perform_login 获取 storageState，最后将 storageState 传入 inspect_page 重新抓取目标页。',
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
      try {
        return { ok: true, data: await inspectPage(url, storageState ? { storageState } : undefined) };
      } catch (e) {
        return { ok: false, error: `页面抓取失败:${(e as Error).message}` };
      }
    },
  };
}
