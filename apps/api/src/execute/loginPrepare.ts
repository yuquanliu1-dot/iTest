import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { testCases } from '../db/schema.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';
import { logger } from '../logger.js';
import type { LoginCtx } from './envContext.js';

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
  return resolveCaseUrl(row, { defaultEnvFallback: true });
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
 * 环境凭据自动填表登录：定位密码框，取其文档序之前最后一个可见文本类输入框填用户名，
 * 提交（表单 submit 按钮 → 页面 submit → 密码框 Enter 三级兜底）后复检登录态。
 * 全程不截图、错误文案不含凭据值。
 */
async function autoFillLogin(
  ctx: BrowserContext,
  page: Page,
  cfg: LoginPrepareConfig,
  cred: LoginCtx,
): Promise<LoginPrepareResult> {
  try {
    // 检测页未被重定向到登录页时，先去配置的登录页
    if (cred.loginUrl && !URL_LOGIN_HINTS.test(page.url())) {
      await page.goto(cred.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    const inputs = page.locator('input');
    // IIFE 字符串表达式（tsx/esbuild 会给函数形式回调注入 __name 助手致页面炸；且 evaluateAll
    // 的字符串形式在本版本静默返回 undefined，只有 page.evaluate + IIFE 实测可用）
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
 * 登录准备入口：在调用方提供的 browser context 中探测；如已登录返回 skipped；
 * 否则优先执行登录用例（loginCaseRunner），未配登录用例且提供环境凭据（autoLogin）时自动填表登录。
 */
export async function loginPrepare(
  cfg: LoginPrepareConfig,
  opts: {
    /** 启动新 chromium；返回 browser + 是否已登录 + storageState。 */
    loginCaseRunner: (caseId: string, ctx: BrowserContext) => Promise<{ passed: boolean; storageState: unknown }>;
    /** 环境登录凭据：未配登录用例（cfg.caseId 为空）时的自动填表登录。 */
    autoLogin?: LoginCtx;
  },
): Promise<LoginPrepareResult> {
  if (!cfg.enabled) return { status: 'skipped', reason: 'disabled' };
  if (!cfg.caseId && !opts.autoLogin) return { status: 'skipped', reason: 'no login case' };

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
    if (detect.alreadyLoggedIn) {
      await page.close().catch(() => undefined);
      const ss = await ctx.storageState();
      return { status: 'skipped', reason: detect.reason, storageState: ss };
    }

    if (!cfg.caseId && opts.autoLogin) {
      const result = await autoFillLogin(ctx, page, cfg, opts.autoLogin);
      await page.close().catch(() => undefined);
      return result;
    }

    await page.close().catch(() => undefined);
    const loginRun = await opts.loginCaseRunner(cfg.caseId!, ctx);
    if (!loginRun.passed) {
      return { status: 'failed', reason: 'login case failed' };
    }
    return { status: 'passed', reason: 'login case executed', storageState: loginRun.storageState };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
