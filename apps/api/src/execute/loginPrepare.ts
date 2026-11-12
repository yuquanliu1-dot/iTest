import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { testCases } from '../db/schema.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';
import { logger } from '../logger.js';
import type { LoginCtx } from './envContext.js';

const DEFAULT_KEYWORDS = ['请先登录', '未登录', '未授权', '登录后'];

const URL_LOGIN_HINTS = /(?:^|\/)(login|signin|sign-in|auth|unauthorized)(?:\/|$|\?)/i;

// Common error-page signatures: on a hit, this must not be judged as "logged in" (exclusion-style probing is inherently false-positive-prone on error pages;
// prod228 record: a Whitelabel 404 was treated as no login signals → the login case was silently skipped).
const ERROR_PAGE_SIGNATURE = /whitelabel error page|http status \d{3}|\b404 not found\b|\b502 bad gateway\b|\b503 service unavailable\b/i;

export interface LoginPrepareConfig {
  enabled: boolean;
  caseId?: string | null;
  detectionUrl?: string | null;
  successSelector?: string | null;
  unauthorizedKeywords?: string[] | null;
  /** The plan's first business case, providing the fallback detectionUrl. */
  firstCaseId?: string | null;
}

export interface LoginPrepareResult {
  status: 'skipped' | 'passed' | 'failed';
  reason?: string;
  storageState?: unknown;
  detectionReportId?: string;
}

function buildKeywords(c: LoginPrepareConfig): string[] {
  const base = c.unauthorizedKeywords && c.unauthorizedKeywords.length > 0 ? c.unauthorizedKeywords : DEFAULT_KEYWORDS;
  return base;
}

async function resolveDetectionUrl(c: LoginPrepareConfig): Promise<string | null> {
  if (c.detectionUrl) return c.detectionUrl;
  if (!c.firstCaseId) return null;
  const row = (await db.select({
    url: testCases.url,
    webServiceRef: testCases.webServiceRef,
    groupId: testCases.groupId,
    defaultEnvId: testCases.defaultEnvId,
  }).from(testCases).where(eq(testCases.id, c.firstCaseId)))[0];
  if (!row) return null;
  return resolveCaseUrl(row, { defaultEnvFallback: true });
}

async function openDetectionPage(
  browser: BrowserContext,
  url: string,
  timeoutMs = 5000,
): Promise<{ page: Page; status: number | null } | null> {
  const page = await browser.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => undefined);
    return { page, status: resp?.status() ?? null };
  } catch (e) {
    logger.warn({ err: e, url }, 'login detection: navigation failed');
    await page.close().catch(() => undefined);
    return null;
  }
}

interface DetectionOutcome {
  alreadyLoggedIn: boolean;
  reason: string;
}

async function detectLoginState(page: Page, c: LoginPrepareConfig, status?: number | null): Promise<DetectionOutcome> {
  if (c.successSelector) {
    const found = await page.locator(c.successSelector).first().count().catch(() => 0);
    if (found > 0) return { alreadyLoggedIn: true, reason: 'selector hit' };
  }
  // The detection page itself returning an error response (4xx/5xx) proves no usable session: treat as not logged in and go through the login case/autoLogin.
  if (status != null && status >= 400) {
    return { alreadyLoggedIn: false, reason: `detection page error (HTTP ${status})` };
  }
  const url = page.url();
  if (!URL_LOGIN_HINTS.test(url)) {
    const hasPassword = await page.locator('input[type="password"]').count().catch(() => 0);
    if (hasPassword === 0) {
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000);
      if (ERROR_PAGE_SIGNATURE.test(body)) {
        return { alreadyLoggedIn: false, reason: 'detection page error (error-page signature)' };
      }
      const keywords = buildKeywords(c);
      const hit = keywords.find((k) => body.includes(k));
      if (!hit) return { alreadyLoggedIn: true, reason: 'no login signals' };
      return { alreadyLoggedIn: false, reason: `keyword hit: ${hit}` };
    }
  }
  return { alreadyLoggedIn: false, reason: URL_LOGIN_HINTS.test(url) ? 'url login hint' : 'password input present' };
}

/**
 * Environment-credential auto-form-fill login: locate the password box, take the last visible text-type input before it in document order for the username,
 * submit (three-tier fallback: form submit button → page submit → Enter in the password box), then re-check the login state.
 * No screenshots throughout, and error text never contains credential values.
 */
async function autoFillLogin(
  ctx: BrowserContext,
  page: Page,
  cfg: LoginPrepareConfig,
  cred: LoginCtx,
  defaultWebOrigin: string | null,
): Promise<LoginPrepareResult> {
  try {
    // When the detection page wasn't redirected to a login page, go to the configured login page first (a relative loginUrl joined with the environment's default web origin)
    if (cred.loginUrl && !URL_LOGIN_HINTS.test(page.url())) {
      const loginTarget = cred.loginUrl.startsWith('/')
        ? `${defaultWebOrigin ?? ''}${cred.loginUrl}`
        : cred.loginUrl;
      if (!/^https?:\/\//.test(loginTarget)) {
        return { status: 'failed', reason: 'auto login: loginUrl is relative but no default web origin' };
      }
      await page.goto(loginTarget, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    const inputs = page.locator('input');
    // IIFE string expression (tsx/esbuild inject a __name helper into function-form callbacks, crashing the page; and evaluateAll's
    // string form silently returns undefined in this version — only page.evaluate + IIFE is measured to work)
    const usernameIdx = await page.evaluate<number>(`(() => {
      const els = Array.from(document.querySelectorAll('input'));
      const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
      const pi = els.findIndex((el) => el.type === 'password' && visible(el));
      if (pi < 0) return -1;
      for (let i = pi - 1; i >= 0; i--) {
        const el = els[i];
        const t = (el.type || 'text').toLowerCase();
        if (['text', 'email', 'tel', 'username'].includes(t) && visible(el)) return i;
      }
      return -1;
    })()`);
    if (usernameIdx < 0) {
      return { status: 'failed', reason: 'auto login: no username/password inputs on login page' };
    }
    const password = page.locator('input[type="password"]').first();
    await inputs.nth(usernameIdx).fill(cred.user);
    await password.fill(cred.password);

    const formSubmit = page
      .locator('form:has(input[type="password"]) button[type="submit"], form:has(input[type="password"]) input[type="submit"]')
      .first();
    if ((await formSubmit.count().catch(() => 0)) > 0) {
      await formSubmit.click({ timeout: 5000 });
    } else {
      const pageSubmit = page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
      if ((await pageSubmit.count().catch(() => 0)) > 0) {
        await pageSubmit.click({ timeout: 5000 });
      } else {
        await password.press('Enter');
      }
    }
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);

    const redetect = await detectLoginState(page, cfg);
    if (!redetect.alreadyLoggedIn) {
      return { status: 'failed', reason: 'auto login: still on login page after submit' };
    }
    const ss = await ctx.storageState();
    return { status: 'passed', reason: 'auto login', storageState: ss };
  } catch (e) {
    logger.warn({ err: e }, 'auto login failed');
    return { status: 'failed', reason: 'auto login failed (see api logs)' };
  }
}

/**
 * Login-preparation entry point: probes within the browser context provided by the caller; returns skipped if already logged in;
 * otherwise prefers running the login case (loginCaseRunner), or auto-form-fill login when no login case is configured and environment credentials are provided (autoLogin).
 *
 * loginCaseRunner receives the caller-held `browser` + `ctx`: the login case runs its steps directly in the same ctx,
 * and afterwards the real storageState is exported from that same ctx. When the callback returns `takeOwnership: true`,
 * this function no longer closes the browser — the caller (runPlan's business loop) is responsible for closing it — so subsequent business cases
 * can reuse the same chromium process instead of paying for a newContext each time.
 */
export async function loginPrepare(
  cfg: LoginPrepareConfig,
  opts: {
    /** Launch a new chromium; return the browser + whether already logged in + storageState.
     *  With takeOwnership=true this function doesn't close the browser — the caller is responsible. */
    loginCaseRunner: (
      caseId: string,
      ctx: BrowserContext,
      browser: Browser,
    ) => Promise<{ passed: boolean; storageState?: unknown; takeOwnership?: boolean }>;
    /** Environment login credentials: auto-form-fill login when no login case is configured (cfg.caseId empty). */
    autoLogin?: LoginCtx;
    /** Environment's default web service origin: joined when loginUrl is a relative path. */
    defaultWebOrigin?: string | null;
    /** playground live view source: the detection page/auto-login page also enters the feed (the auto-form-fill login process is visible). */
    liveView?: { setPage(p: Page): void };
  },
): Promise<LoginPrepareResult> {
  if (!cfg.enabled) return { status: 'skipped', reason: 'disabled' };
  if (!cfg.caseId && !opts.autoLogin) return { status: 'skipped', reason: 'no login case' };

  const url = await resolveDetectionUrl(cfg);
  if (!url) {
    return { status: 'failed', reason: 'no detection URL (set detectionUrl or first business case.url)' };
  }

  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  let takeOwnership = false;
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const opened = await openDetectionPage(ctx, url);
    if (!opened) return { status: 'failed', reason: 'detection page navigation failed' };
    const page = opened.page;
    // Detection/auto-login page enters the live feed (on the loginCaseRunner path, runCase's newPage takes over switching shortly after)
    opts.liveView?.setPage(page);

    const detect = await detectLoginState(page, cfg, opened.status);
    if (detect.alreadyLoggedIn) {
      await page.close().catch(() => undefined);
      const ss = await ctx.storageState();
      return { status: 'skipped', reason: detect.reason, storageState: ss };
    }

    if (!cfg.caseId && opts.autoLogin) {
      const result = await autoFillLogin(ctx, page, cfg, opts.autoLogin, opts.defaultWebOrigin ?? null);
      await page.close().catch(() => undefined);
      return result;
    }

    await page.close().catch(() => undefined);
    const loginRun = await opts.loginCaseRunner(cfg.caseId!, ctx, browser);
    if (!loginRun.passed) {
      return { status: 'failed', reason: 'login case failed' };
    }
    // When the caller takes ownership, don't close the browser; otherwise keep the original "close after run" behavior (auto-fill/unit-test scenarios).
    takeOwnership = loginRun.takeOwnership === true;
    return { status: 'passed', reason: 'login case executed', storageState: loginRun.storageState };
  } finally {
    if (!takeOwnership) {
      await browser.close().catch(() => undefined);
    }
  }
}
