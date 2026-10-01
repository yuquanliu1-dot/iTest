import type { Page } from 'playwright-core';

export type StabilityReason = 'disabled' | 'loading' | 'overlay' | 'readonly' | 'hidden';

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

async function probe(page: Page): Promise<StabilityReport> {
  return page.evaluate(() => {
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
    const ro = (el as HTMLInputElement).readOnly === true || el.getAttribute('aria-readonly') === 'true';
    if (ro) return { ready: false, reason: 'readonly', source: el.outerHTML.slice(0, 80) };
    return { ready: true };
  });
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
    last = await probe(page);
    if (last.ready) return last;
    if (last.reason && last.reason !== 'hidden') {
      if (Date.now() >= deadline) throw new ElementNotStable(last.reason, last.source);
    }
    if (Date.now() >= deadline) throw new ElementNotStable(last.reason ?? 'hidden', last.source);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
