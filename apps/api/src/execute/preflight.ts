import type { Page } from 'playwright-core';
import type { PreflightReport } from '@itest/shared';

const DEFAULT_KEYWORDS = ['请先登录', '未登录', '未授权', '登录后'];

interface CaseRowLite { url?: string | null; title: string }

export interface PreflightOptions {
  /** 调用方（init-goto）已导航到目标页时置 true：跳过本函数的二次 goto。同 URL 的 page.goto
   *  等于整页重载，会把慢 SPA 打回启动初期、且此处只等 domcontentloaded——prod228 报告
   *  02c812ea 第 1 步冲进空白页（LocatorAllFailed count=0）即此。跳过时 urlReachable 直接
   *  true：init-goto 的 goto 若抛错在调用点就传播了，到不了这里。 */
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
