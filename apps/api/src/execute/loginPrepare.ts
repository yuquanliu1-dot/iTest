import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { testCases } from '../db/schema.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';
import { logger } from '../logger.js';

const DEFAULT_KEYWORDS = ['请先登录', '未登录', '未授权', '登录后'];

const URL_LOGIN_HINTS = /(?:^|\/)(login|signin|sign-in|auth|unauthorized)(?:\/|$|\?)/i;

export interface LoginPrepareConfig {
  enabled: boolean;
  caseId?: string | null;
  detectionUrl?: string | null;
  successSelector?: string | null;
  unauthorizedKeywords?: string[] | null;
  /** 计划中第一个业务用例，提供 fallback detectionUrl。 */
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
  const row = (await db.select().from(testCases).where(eq(testCases.id, c.firstCaseId)))[0];
  if (!row) return null;
  return resolveCaseUrl(row);
}

async function openDetectionPage(browser: BrowserContext, url: string, timeoutMs = 5000): Promise<Page | null> {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => undefined);
    return page;
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

async function detectLoginState(page: Page, c: LoginPrepareConfig): Promise<DetectionOutcome> {
  if (c.successSelector) {
    const found = await page.locator(c.successSelector).first().count().catch(() => 0);
    if (found > 0) return { alreadyLoggedIn: true, reason: 'selector hit' };
  }
  const url = page.url();
  if (!URL_LOGIN_HINTS.test(url)) {
    const hasPassword = await page.locator('input[type="password"]').count().catch(() => 0);
    if (hasPassword === 0) {
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000);
      const keywords = buildKeywords(c);
      const hit = keywords.find((k) => body.includes(k));
      if (!hit) return { alreadyLoggedIn: true, reason: 'no login signals' };
      return { alreadyLoggedIn: false, reason: `keyword hit: ${hit}` };
    }
  }
  return { alreadyLoggedIn: false, reason: URL_LOGIN_HINTS.test(url) ? 'url login hint' : 'password input present' };
}

/**
 * 登录准备入口：在调用方提供的 browser context 中探测；如已登录返回 skipped；
 * 否则执行登录用例（由调用方传入的 loginCaseRunner 处理）。
 */
export async function loginPrepare(
  cfg: LoginPrepareConfig,
  opts: {
    /** 启动新 chromium；返回 browser + 是否已登录 + storageState。 */
    loginCaseRunner: (caseId: string, ctx: BrowserContext) => Promise<{ passed: boolean; storageState: unknown }>;
  },
): Promise<LoginPrepareResult> {
  if (!cfg.enabled) return { status: 'skipped', reason: 'disabled' };
  if (!cfg.caseId) return { status: 'skipped', reason: 'no login case' };

  const url = await resolveDetectionUrl(cfg);
  if (!url) {
    return { status: 'failed', reason: 'no detection URL (set detectionUrl or first business case.url)' };
  }

  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const ctx = await browser.newContext();
    const page = await openDetectionPage(ctx, url);
    if (!page) return { status: 'failed', reason: 'detection page navigation failed' };

    const detect = await detectLoginState(page, cfg);
    await page.close().catch(() => undefined);

    if (detect.alreadyLoggedIn) {
      const ss = await ctx.storageState();
      return { status: 'skipped', reason: detect.reason, storageState: ss };
    }

    const loginRun = await opts.loginCaseRunner(cfg.caseId!, ctx);
    if (!loginRun.passed) {
      return { status: 'failed', reason: 'login case failed' };
    }
    return { status: 'passed', reason: 'login case executed', storageState: loginRun.storageState };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
