import type { Page, Frame } from 'playwright-core';

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
 * In-page stability probe function. Must be self-contained (only references page globals
 * document/window) — the probe is serialized and injected for execution via page.evaluate;
 * the standalone export exists only so unit tests can call it directly (stub the global
 * document/window).
 *
 * Does not check readonly: a page-level probe cannot see the target element this step operates
 * on and can only grab the first "interactive-looking" element in DOM order — the language
 * selector at the top of the prod228 MRM login page (a readonly fake input that opens a picker
 * on click) would be misjudged as "page not ready", dragging every interactive step on the page
 * into a 2s stability stall (mechanical steps silently go dom-fallback, aiTask steps have no
 * fallback and fail outright — the 2026-11-03 report c934d5b6 was exactly this). Real readonly
 * targets are backed by Playwright fill's own error.
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

async function probe(page: Page | Frame): Promise<StabilityReport> {
  return page.evaluate(stabilityProbeFn);
}

export async function waitForStable(
  page: Page | Frame,
  _locator: ReturnType<Page['locator']>,
  opts: StabilityOptions = {},
): Promise<StabilityReport> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let last: StabilityReport = { ready: true };
  while (true) {
    // Treat an abnormal probe result shape (evaluate bridged/replaced, returns a non-{ready} shape) as stable, to avoid blocking normal execution.
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

/**
 * Post-click quiet period: after a mechanical click succeeds, wait for the DOM to settle before releasing the next step.
 *
 * Existing stability mechanisms are all pre-action (waitForStable checks disabled/loading/overlay, waitTargetEnabled
 * waits for the target to recover) and cannot stop "the click succeeded but its effect was wiped by a later async
 * re-render": recorded on prod228 as 14dd97e2/e3f9a616 — the row click landed 275ms before the Search response
 * arrived; when the response came, el-table replaced the data array and cleared the current-row selection, and the
 * next step waiting for Modify to enable hit target-disabled and degraded to AI; clicking the row 4s after Search
 * works fine (Modify enables within 2.5s). This polls a DOM fingerprint (element count + innerText length) and
 * treats quietMs with no change as quiet, letting async responses and re-renders finish before the next action.
 *
 * best-effort: never fails this step (the click already happened) — if it cannot probe (evaluate missing/navigation
 * throws) it releases immediately; if the budget expires without quiet it also releases, no worse than the status
 * quo. deadline + maxIters double protection (same pattern as waitForPageSettled: unit tests mocking a frozen wall
 * clock need an iteration cap to terminate). The 4s budget covers the observed 0.5-2s query response window; a
 * healthy page pays about quietMs(400ms) per click.
 */
export async function waitForDomQuiet(
  page: Page,
  budgetMs = 4000,
  quietMs = 400,
  pollMs = 100,
): Promise<void> {
  const signature = async (): Promise<number | null> => {
    try {
      return await page.evaluate(() => {
        const n = document.getElementsByTagName('*').length;
        const t = document.body?.innerText ?? '';
        return n * 1000003 + t.length;
      });
    } catch {
      return null;
    }
  };
  let prev = await signature();
  if (prev === null) return; // Cannot probe → do not wait; never worse than the status quo
  let lastChange = Date.now();
  const deadline = lastChange + budgetMs;
  const maxIters = Math.max(2, Math.ceil(budgetMs / Math.max(1, pollMs)) + 5);
  for (let iter = 0; iter < maxIters && Date.now() < deadline; iter++) {
    await page.waitForTimeout(pollMs).catch(() => undefined);
    const cur = await signature();
    if (cur === null) return;
    if (cur !== prev) {
      prev = cur;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return; // quietMs with no DOM change → quiet
    }
  }
  // Budget expired without quiet → return; never fails this step
}
