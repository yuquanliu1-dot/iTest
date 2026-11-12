/**
 * Observation tools (read-only): observe (screenshot + element list), screenshot (zoomed
 * forensics), read_text (text forensics).
 *
 * Iron rules (shared across the pi tool layer; interaction tools follow them too):
 * - Tools never throw — a thrown exception breaks the pi agent loop; failures are always
 *   isError:true + an actionable message.
 * - All use executionMode:'sequential' — the evidence-frame race defense (interleaved parallel
 *   observe/action would invalidate "screenshot = the moment of decision").
 * - When vision=false (channel strips images, degraded mode) no image is attached and the text
 *   says so explicitly — never silently strip images.
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import type { Page } from 'playwright-core';
import { dumpElements, type ElementInfo } from '../../../execute/elementDump.js';
import { waitForPageSettled } from '../../../execute/pageSettle.js';
import { captureLiveRegionMessages } from '../../../execute/liveRegion.js';
import { brittleSelectorReason } from '../../../execute/gates.js';
import { toolErr, toolOk, toolOkImage } from './result.js';
import { logger } from '../../../logger.js';

/** Tool-set dependencies (injected by the runner at assembly; the factory shape makes page swappable in tests). */
export interface ToolDeps {
  page: Page;
  /** Vision probe result: false = channel strips images; observation tools attach no image (plain-text element-list mode). */
  vision: boolean;
  /** Exploration scope whitelist (start origin only; empty array = every navigate rejected). */
  scopeOrigins: string[];
  /** Credential placeholder substitution (used by fill); when absent the placeholder is filled as-is. */
  valueSub?: (value: string) => string;
  /** Fatal error callback (fill with missing credentials EnvMissing/SecretMissing → runner terminates the session). */
  onFatal?: (err: Error) => void;
  /** Destructive-operation explicit authorization bit (false/absent = click hits rejected outright; charter wording does not count). */
  allowDestructive?: boolean;
  /** Error-signal delta (fed back by observe: console/pageerror/HTTP 4xx-5xx since last drain).
   *  Also gives the count — the trail summary states "N new error signals this round", the observe step's most valuable conclusion. */
  errorSignals?: () => { text: string; count: number };
  /** Coverage ledger digest (fed back by observe: covered paths/interactions — do not repeat). */
  coverageSummary?: () => string;
}

/** Element list → model text (same semantics as legacy aiTask's userMessage: box aligned with the screenshot). */
function renderElements(elements: ElementInfo[]): string {
  return `可交互元素（box=[x1,y1,x2,y2] 为视口归一化 0-1000 坐标框，与截图对齐）：${JSON.stringify(elements)}`;
}

/** observe: wait for render settle → viewport screenshot + element list (image + text dual content). */
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
        // settle is best-effort: on timeout continue with the current frame
      }
      const vp = deps.page.viewportSize() ?? { width: 1280, height: 800 };
      let elements: ElementInfo[] = [];
      try {
        elements = await dumpElements(deps.page);
      } catch (e) {
        logger.warn({ err: e }, 'exploration observe dumpElements failed');
      }
      // Feed-back blocks: coverage ledger (covered paths not repeated) + error-signal delta (console/pageerror/HTTP 4xx-5xx).
      // Error signals go first — "the page errored" outranks "what the page looks like".
      const signals = deps.errorSignals?.() ?? { text: '', count: 0 };
      const blocks = [signals.text, deps.coverageSummary?.() ?? ''].filter(Boolean);
      const text = [...blocks, `当前 URL：${deps.page.url()}`, `视口：${vp.width}x${vp.height}`, renderElements(elements)].join('\n');
      // Result summary (trail body): what this step "saw" — URL, viewport, interactive element count, new error-signal count this round.
      const summary = [
        `URL ${deps.page.url()}`,
        `视口 ${vp.width}x${vp.height}`,
        `可交互元素 ${elements.length} 个`,
        signals.count > 0 ? `新错误信号 ${signals.count} 条` : '无新错误信号',
      ].join('｜');
      if (!deps.vision) {
        return toolOk(
          `${summary}（无视觉通道，纯元素清单）`,
          `${text}\n（当前渠道无视觉通道：无截图附图，请依据元素清单的 selector/tag/text/value 操作）`,
        );
      }
      // Main screenshot JPEG q85: coordinate pointing needs no lossless precision (same tradeoff as legacy aiTask).
      // 15s: a screenshot timeout silently degrades to "no image this round"; longer beats shorter (prod228 saw occasional 5s timeouts).
      const buf = await deps.page.screenshot({ timeout: 15_000, type: 'jpeg', quality: 85 }).catch(() => null);
      if (!buf) {
        return toolOk(`${summary}（本轮截图失败）`, `${text}\n（本轮截图失败，请依据元素清单操作）`);
      }
      return toolOkImage(summary, text, buf.toString('base64'), 'image/jpeg');
    },
  });
}

/** screenshot: selector targets an element → 4x zoomed white-background screenshot (captcha/small text); without selector → full-page image. */
export function createScreenshotTool(deps: ToolDeps) {
  return defineTool({
    name: 'screenshot',
    label: 'screenshot',
    description: '截图取证：传 selector 时返回该元素的 4 倍放大白底截图（验证码/小字/密集区域辨认用）；不传返回全页视口截图。',
    parameters: Type.Object({ selector: Type.Optional(Type.String({ description: '目标元素 CSS selector（取自元素清单）' })) }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      if (!deps.vision) {
        return toolErr(
          '视觉通道不可用，截图工具不可用',
          '当前渠道无视觉通道：截图不可用，请依据元素清单的 selector/tag/text/value 操作。',
        );
      }
      const sel = params.selector?.trim();
      if (sel) {
        const reason = brittleSelectorReason(sel);
        if (reason) {
          return toolErr(
            `脆弱 selector 被拒（${reason}）`,
            `screenshot ${sel}: error 脆弱 selector 被拒（${reason}）。改用元素清单里给出的 selector。`,
          );
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
          return toolErr(
            `元素截图失败：${msg.slice(0, 120)}`,
            `screenshot ${sel}: error ${msg.slice(0, 200)}。确认 selector 在元素清单里且元素可见；找不到就先 observe 核对当前页面。`,
          );
        }
        if (!buf) {
          return toolErr(
            '元素截图失败，可改用全页截图（不带 selector）',
            `screenshot ${sel}: error 元素截图失败，可改用全页截图（不带 selector）。`,
          );
        }
        return toolOkImage(
          `已取元素放大截图：${sel}`,
          `元素 ${sel} 的 4 倍放大白底截图如下。`,
          buf.toString('base64'),
          'image/png',
        );
      }
      const buf = await deps.page.screenshot({ timeout: 15_000, type: 'png' }).catch(() => null);
      if (!buf) {
        return toolErr(
          '全页截图失败（页面可能在持续重绘）',
          'screenshot: error 全页截图失败（页面可能在持续重绘）。先 wait 几秒再试。',
        );
      }
      return toolOkImage(
        `已取全页截图（${deps.page.url()}）`,
        `全页视口截图如下（当前 URL：${deps.page.url()}）。`,
        buf.toString('base64'),
        'image/png',
      );
    },
  });
}

/** read_text: element text / aria-live region text (first-hand toast evidence; illegible screenshots are no excuse for missed reports). */
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
          return toolErr(
            `脆弱 selector 被拒（${reason}）`,
            `read_text ${sel}: error 脆弱 selector 被拒（${reason}）。改用元素清单里给出的 selector。`,
          );
        }
        try {
          const text = await deps.page.locator(sel).first().innerText({ timeout: 3000 });
          const body = text.trim().slice(0, 4000);
          return toolOk(
            `${sel} 文本 ${body.length} 字${body ? `：${body.slice(0, 80)}` : '（空）'}`,
            `${sel} 的文本：\n${body || '（空）'}`,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolErr(
            `读取文本失败：${msg.slice(0, 120)}`,
            `read_text ${sel}: error ${msg.slice(0, 200)}。确认 selector 在元素清单里且元素可见。`,
          );
        }
      }
      // Without selector: first-hand toast/message text + page body text as fallback (both capped; feedback must not bloat unboundedly)
      const msgs = await captureLiveRegionMessages(deps.page).catch(() => [] as string[]);
      const body = await deps.page
        .evaluate(() => (document.body?.innerText ?? '').replace(/\n{2,}/g, '\n').trim())
        .catch(() => '');
      const lines = [
        msgs.length > 0 ? `页面消息（aria-live）：\n${msgs.slice(0, 5).map((m) => `- "${m.slice(0, 160)}"`).join('\n')}` : '页面消息（aria-live）：（无）',
        `页面主体文本（截断）：\n${body.slice(0, 2000) || '（空）'}`,
      ];
      return toolOk(
        `页面消息 ${msgs.length} 条｜主体文本 ${body.length} 字${msgs.length > 0 ? `：${msgs[0]!.slice(0, 60)}` : ''}`,
        lines.join('\n'),
      );
    },
  });
}
