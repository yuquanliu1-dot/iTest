import { Type } from '@earendil-works/pi-ai';
import { inspectPage } from '../../inspectPage.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

export function buildInspectTool(_ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'inspect_page',
    description:
      '抓取被测页面并返回实际可交互元素清单(按钮/输入框/链接/选择器/文案,含 data-testid)。创建带步骤的用例前,若知道页面 URL,先调用本工具获取真实元素,禁止凭「典型实现」臆造 locator。快照仅为页面初始状态,操作后才出现的元素不在其中。',
    parameters: Type.Object({
      url: Type.String({ minLength: 8, maxLength: 2000 }),
    }),
    execute: async (input) => {
      const { url } = input as { url: string };
      try {
        return { ok: true, data: await inspectPage(url) };
      } catch (e) {
        return { ok: false, error: `页面抓取失败:${(e as Error).message}` };
      }
    },
  };
}
