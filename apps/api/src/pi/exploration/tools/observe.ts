/**
 * 观察类工具（只读）：observe（截图+元素清单）、screenshot（放大取证）、read_text（文本取证）。
 *
 * 铁律（pi 工具层通用，交互工具同守）：
 * - 工具永不 throw——抛异常会打断 pi agent 循环；失败一律 isError:true + 可行动中文说明。
 * - 全部 executionMode:'sequential'——证据帧竞态防线（观察/动作交错并行会让「截图=决策那一刻」失效）。
 * - vision=false（渠道剥图降级）时不附图，文本里显式说明——绝不静默剥图。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import type { Page } from 'playwright-core';
import { dumpElements, type ElementInfo } from '../../../execute/elementDump.js';
import { waitForPageSettled } from '../../../execute/pageSettle.js';
import { captureLiveRegionMessages } from '../../../execute/liveRegion.js';
import { brittleSelectorReason } from '../../../execute/gates.js';
import { logger } from '../../../logger.js';

/** 工具集依赖（runner 装配时注入；工厂形态便于测试替换 page）。 */
export interface ToolDeps {
  page: Page;
  /** 视觉探针结果：false = 渠道剥图，观察类工具不附图（纯文本元素清单模式）。 */
  vision: boolean;
  /** 探索范围白名单（起点 origin 唯一；空数组 = navigate 全拒）。 */
  scopeOrigins: string[];
  /** 凭据占位符替换（fill 用）；缺省时占位符原样填入。 */
  valueSub?: (value: string) => string;
  /** 终止性错误回调（fill 凭据缺失 EnvMissing/SecretMissing → runner 终止会话）。 */
  onFatal?: (err: Error) => void;
  /** 破坏性操作显式授权位（false/缺省 = click 判中即拒；章程说辞不算授权）。 */
  allowDestructive?: boolean;
  /** 错误信号增量（observe 回灌：自上次 drain 起 console/pageerror/HTTP 4xx-5xx）。 */
  errorSignals?: () => string;
  /** 覆盖账本摘要（observe 回灌：已覆盖路径/交互，别重复）。 */
  coverageSummary?: () => string;
}

/** 元素清单 → 模型文本（与 legacy aiTask 的 userMessage 同口径：box 与截图对齐）。 */
function renderElements(elements: ElementInfo[]): string {
  return `可交互元素（box=[x1,y1,x2,y2] 为视口归一化 0-1000 坐标框，与截图对齐）：${JSON.stringify(elements)}`;
}

/** observe：等渲染静默 → 视口截图 + 元素清单（image + text 双 content）。 */
export function createObserveTool(deps: ToolDeps) {
  return defineTool({
    name: 'observe',
    label: 'observe',
    description: '观察当前页面：等待渲染稳定后返回视口截图 + 可交互元素清单。每次导航/动作后、下一步判断前必先调用。',
    promptGuidelines: ['页面状态判断只能基于最近一次 observe 的截图与元素清单；凭记忆决策是探索事故的头号来源'],
    parameters: Type.Object({}),
    executionMode: 'sequential',
    execute: async () => {
      try {
        await waitForPageSettled(deps.page, { timeoutMs: 2500, settleMs: 200 });
      } catch {
        // settle 尽力而为：超时按当前帧继续
      }
      const vp = deps.page.viewportSize() ?? { width: 1280, height: 800 };
      let elements: ElementInfo[] = [];
      try {
        elements = await dumpElements(deps.page);
      } catch (e) {
        logger.warn({ err: e }, 'exploration observe dumpElements failed');
      }
      // 回灌块：覆盖账本（已覆盖别重复）+ 错误信号增量（console/pageerror/HTTP 4xx-5xx）。
      // 错误信号放最前——「页面报错了」比「页面长什么样」优先级更高。
      const blocks = [deps.errorSignals?.() ?? '', deps.coverageSummary?.() ?? ''].filter(Boolean);
      const text = [...blocks, `当前 URL：${deps.page.url()}`, `视口：${vp.width}x${vp.height}`, renderElements(elements)].join('\n');
      if (!deps.vision) {
        return {
          content: [{ type: 'text', text: `${text}\n（当前渠道无视觉通道：无截图附图，请依据元素清单的 selector/tag/text/value 操作）` }],
          details: undefined,
        };
      }
      // 主截图 JPEG q85：坐标指认不需要无损精度（与 legacy aiTask 同取舍）
      // 15s：截图超时静默退化成「本轮无图」，宁长勿短（prod228 实证 5s 偶发超时）。
      const buf = await deps.page.screenshot({ timeout: 15_000, type: 'jpeg', quality: 85 }).catch(() => null);
      if (!buf) {
        return { content: [{ type: 'text', text: `${text}\n（本轮截图失败，请依据元素清单操作）` }], details: undefined };
      }
      return {
        content: [
          { type: 'text', text },
          { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' },
        ],
        details: undefined,
      };
    },
  });
}

/** screenshot：selector 指定元素 → 4 倍放大白底截图（验证码/小字辨认）；无 selector → 全页图。 */
export function createScreenshotTool(deps: ToolDeps) {
  return defineTool({
    name: 'screenshot',
    label: 'screenshot',
    description: '截图取证：传 selector 时返回该元素的 4 倍放大白底截图（验证码/小字/密集区域辨认用）；不传返回全页视口截图。',
    parameters: Type.Object({ selector: Type.Optional(Type.String({ description: '目标元素 CSS selector（取自元素清单）' })) }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      if (!deps.vision) {
        return {
          content: [{ type: 'text', text: '当前渠道无视觉通道：截图不可用，请依据元素清单的 selector/tag/text/value 操作。' }],
          details: undefined,
          isError: true,
        };
      }
      const sel = params.selector?.trim();
      if (sel) {
        const reason = brittleSelectorReason(sel);
        if (reason) {
          return {
            content: [{ type: 'text', text: `screenshot ${sel}: error 脆弱 selector 被拒（${reason}）。改用元素清单里给出的 selector。` }],
            details: undefined,
            isError: true,
          };
        }
        const el = deps.page.locator(sel).first();
        let buf: Buffer | null = null;
        try {
          await el.waitFor({ state: 'visible', timeout: 3000 });
          await el
            .evaluate((e) => {
              (e as HTMLElement).style.zoom = '4';
              (e as HTMLElement).style.background = '#fff';
            })
            .catch(() => undefined);
          try {
            buf = await el.screenshot({ timeout: 3000 });
          } finally {
            await el
              .evaluate((e) => {
                (e as HTMLElement).style.zoom = '';
                (e as HTMLElement).style.background = '';
              })
              .catch(() => undefined);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: 'text', text: `screenshot ${sel}: error ${msg.slice(0, 200)}。确认 selector 在元素清单里且元素可见；找不到就先 observe 核对当前页面。` }],
            details: undefined,
            isError: true,
          };
        }
        if (!buf) {
          return { content: [{ type: 'text', text: `screenshot ${sel}: error 元素截图失败，可改用全页截图（不带 selector）。` }], details: undefined, isError: true };
        }
        return {
          content: [
            { type: 'text', text: `元素 ${sel} 的 4 倍放大白底截图如下。` },
            { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
          ],
          details: undefined,
        };
      }
      const buf = await deps.page.screenshot({ timeout: 15_000, type: 'png' }).catch(() => null);
      if (!buf) {
        return { content: [{ type: 'text', text: 'screenshot: error 全页截图失败（页面可能在持续重绘）。先 wait 几秒再试。' }], details: undefined, isError: true };
      }
      return {
        content: [
          { type: 'text', text: `全页视口截图如下（当前 URL：${deps.page.url()}）。` },
          { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
        ],
        details: undefined,
      };
    },
  });
}

/** read_text：元素文本 / aria-live 区域文本（toast 一手证据，截图读不清不成为漏报理由）。 */
export function createReadTextTool(deps: ToolDeps) {
  return defineTool({
    name: 'read_text',
    label: 'read_text',
    description: '读取页面文本：传 selector 读该元素文本；不传读 aria-live 消息区域（应用 toast/提示的一手文本）+ 页面主体文本。',
    parameters: Type.Object({ selector: Type.Optional(Type.String({ description: '目标元素 CSS selector（取自元素清单）' })) }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const sel = params.selector?.trim();
      if (sel) {
        const reason = brittleSelectorReason(sel);
        if (reason) {
          return {
            content: [{ type: 'text', text: `read_text ${sel}: error 脆弱 selector 被拒（${reason}）。改用元素清单里给出的 selector。` }],
            details: undefined,
            isError: true,
          };
        }
        try {
          const text = await deps.page.locator(sel).first().innerText({ timeout: 3000 });
          return { content: [{ type: 'text', text: `${sel} 的文本：\n${text.trim().slice(0, 4000) || '（空）'}` }], details: undefined };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: 'text', text: `read_text ${sel}: error ${msg.slice(0, 200)}。确认 selector 在元素清单里且元素可见。` }],
            details: undefined,
            isError: true,
          };
        }
      }
      // 无 selector：toast/提示一手文本 + 页面主体文本兜底（都封顶，反馈不能无限膨胀）
      const msgs = await captureLiveRegionMessages(deps.page).catch(() => [] as string[]);
      const body = await deps.page
        .evaluate(() => (document.body?.innerText ?? '').replace(/\n{2,}/g, '\n').trim())
        .catch(() => '');
      const lines = [
        msgs.length > 0 ? `页面消息（aria-live）：\n${msgs.slice(0, 5).map((m) => `- "${m.slice(0, 160)}"`).join('\n')}` : '页面消息（aria-live）：（无）',
        `页面主体文本（截断）：\n${body.slice(0, 2000) || '（空）'}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }], details: undefined };
    },
  });
}
