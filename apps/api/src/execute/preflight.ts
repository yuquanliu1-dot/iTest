import type { Page } from 'playwright-core';
import type { PreflightReport } from '@itest/shared';

const DEFAULT_KEYWORDS = ['请先登录', '未登录', '未授权', '登录后'];

interface CaseRowLite { url?: string | null; title: string }

export interface PreflightOptions {
  /** True when the caller (init-goto) has already navigated to the target page: skip this function's second goto. A same-URL page.goto
   *  equals a full page reload — it knocks a slow SPA back to its startup phase, and here we only wait for domcontentloaded — the prod228
   *  report 02c812ea's step 1 rushing into a blank page (LocatorAllFailed count=0) was exactly this. When skipped, urlReachable is
   *  directly true: if init-goto's goto throws, it propagates at the call site and never reaches here. */
  skipNavigate?: boolean;
}

export async function preflight(page: Page, caseRow: CaseRowLite, opts: PreflightOptions = {}): Promise<PreflightReport> {
  const started = Date.now();
  let urlReachable = true;
  let urlNote: string | undefined;
  if (caseRow.url && caseRow.url.trim() && !opts.skipNavigate) {
    try {
      await page.goto(caseRow.url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    } catch (e) {
      urlReachable = false;
      urlNote = e instanceof Error ? e.message : String(e);
    }
  }
  let loggedIn = true;
  try {
    const body = await page.evaluate(() => (document?.body?.innerText ?? '')) as string;
    loggedIn = !DEFAULT_KEYWORDS.some((k) => body.includes(k));
  } catch {
    loggedIn = true;
  }
  let tabsObserved: number[] | undefined;
  try {
    const ctx = page.context();
    const pages = ctx.pages();
    tabsObserved = pages.map((_, i) => i);
  } catch {
    tabsObserved = undefined;
  }
  let sourceOrigin: string | undefined;
  let currentOrigin: string | undefined;
  let originMismatch: boolean | undefined;
  try {
    if (caseRow.url) sourceOrigin = new URL(caseRow.url).origin;
    const u = page.url();
    currentOrigin = new URL(u).origin;
    originMismatch = sourceOrigin && currentOrigin ? sourceOrigin !== currentOrigin : undefined;
  } catch {
    /* noop */
  }
  return {
    urlReachable,
    urlNote,
    loggedIn,
    sourceOrigin,
    currentOrigin,
    originMismatch,
    tabsObserved,
    durationMs: Date.now() - started,
  };
}
