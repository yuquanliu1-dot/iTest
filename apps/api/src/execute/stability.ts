import type { Page } from 'playwright-core';

export type StabilityReason = 'disabled' | 'loading' | 'overlay' | 'hidden';

export interface StabilityOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface StabilityReport {
  ready: boolean;
  reason?: StabilityReason;
  source?: string;
}

export class ElementNotStable extends Error {
  name = 'ElementNotStable' as const;
  reason: StabilityReason;
  source?: string;
  constructor(reason: StabilityReason, source?: string) {
    super(`ElementNotStable: ${reason}${source ? ` (${source})` : ''}`);
    this.reason = reason;
    this.source = source;
  }
}

/**
 * 页内稳定性探测函数。必须自包含（只引用页面全局 document/window）——probe 经
 * page.evaluate 序列化注入执行；独立导出仅为单测可直调（stub 全局 document/window）。
 *
 * 不检查 readonly：页面级探针拿不到本步要操作的目标元素，只能按 DOM 顺序抓第一个
 * 「交互样」元素——prod228 MRM 登录页页顶的语言选择框（readonly 假输入框，点击弹
 * 选择器）会被误判成「页面未就绪」，把页面上所有交互步拖进 2s 稳定性空转（机械步
 * 静默走 dom-fallback、aiTask 步无降级直接失败，2026-11-03 报告
 * c934d5b6 即此）。真正的 readonly 目标由 Playwright fill 自身的报错兜底。
 */
export function stabilityProbeFn(): StabilityReport {
  const sel = document.querySelector(':focus, [data-itest-active="true"], button, input, select, [role="button"]') as HTMLElement | null;
  const el = sel ?? (document.activeElement as HTMLElement | null);
  if (!el) return { ready: true };
  const isDisabled = (el: HTMLElement) =>
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute('aria-busy') === 'true' ||
    el.getAttribute('data-loading') === 'true' ||
    el.classList.contains('ant-btn-loading');
  if (isDisabled(el)) return { ready: false, reason: 'disabled', source: el.outerHTML.slice(0, 80) };
  const isLoadingAncestor = (el: HTMLElement): string | null => {
    let cur: HTMLElement | null = el;
    for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
      if (cur.classList.contains('ant-spin') || cur.classList.contains('ant-spin-spinning')) return '.ant-spin';
      if (cur.getAttribute('aria-busy') === 'true') return '[aria-busy="true"]';
    }
    return null;
  };
  const loadingSrc = isLoadingAncestor(el);
  if (loadingSrc) return { ready: false, reason: 'loading', source: loadingSrc };
  const isOverlayAncestor = (el: HTMLElement): string | null => {
    let cur: HTMLElement | null = el;
    for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
      if (cur.classList.contains('ant-modal-mask') || cur.classList.contains('el-overlay')) return 'overlay-mask';
      if (cur.getAttribute('data-mask') === 'true') return '[data-mask="true"]';
      const pe = window.getComputedStyle(cur).pointerEvents;
      if (pe === 'none') return 'pointer-events:none';
    }
    return null;
  };
  const overlaySrc = isOverlayAncestor(el);
  if (overlaySrc) return { ready: false, reason: 'overlay', source: overlaySrc };
  return { ready: true };
}

async function probe(page: Page): Promise<StabilityReport> {
  return page.evaluate(stabilityProbeFn);
}

export async function waitForStable(
  page: Page,
  _locator: ReturnType<Page['locator']>,
  opts: StabilityOptions = {},
): Promise<StabilityReport> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let last: StabilityReport = { ready: true };
  while (true) {
    // probe 结果形状异常（evaluate 被桥接/替换、返回非 {ready} 形状）时视为稳定，避免阻塞正常执行。
    const raw = (await probe(page)) as unknown;
    const shaped = raw as StabilityReport;
    if (!raw || typeof raw !== 'object' || typeof shaped.ready !== 'boolean') {
      return { ready: true };
    }
    last = shaped;
    if (last.ready) return last;
    if (last.reason && last.reason !== 'hidden') {
      if (Date.now() >= deadline) throw new ElementNotStable(last.reason, last.source);
    }
    if (Date.now() >= deadline) throw new ElementNotStable(last.reason ?? 'hidden', last.source);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
