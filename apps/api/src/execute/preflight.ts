import type { Page } from 'playwright-core';
import type { PreflightReport } from '@itest/shared';

const DEFAULT_KEYWORDS = ['请先登录', '未登录', '未授权', '登录后'];

interface CaseRowLite { url?: string | null; title: string }

export async function preflight(page: Page, caseRow: CaseRowLite): Promise<PreflightReport> {
  const started = Date.now();
  let urlReachable = true;
  let urlNote: string | undefined;
  if (caseRow.url && caseRow.url.trim()) {
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
