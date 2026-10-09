/**
 * 凭证自动登录（自 pi/space/tools/login.ts 提取，perform_login 与 verify_case 共用）。
 * 在调用方持有的 BrowserContext 上完成：新开页 → goto 登录页 → 探测 → 验证码检查 → 自动填表。
 * 密码仅在本模块内部解密使用，不进返回值/日志。
 */
import type { BrowserContext, Page } from 'playwright-core';
import type { LoginCtx } from '../execute/envContext.js';

const GOTO_TIMEOUT_MS = 20_000;
const SETTLE_MS = 800;

const URL_LOGIN_HINTS = /(?:^|\/)(login|signin|sign-in|auth|unauthorized)(?:\/|$|\?)/i;

/** 注入式验证码解决器：调用方持有 LLMClient 与识别策略，本模块只负责在登录页探测到验证码时触发。
 *  抛错由 loginInContext 透传出去（原文案由 solveCaptchaOnce 等实现控制）。 */
export type CaptchaSolver = (page: Page) => Promise<void>;

/** 选择器与 aiTask.ts:captchaRetry 的 hint 定位保持一致；prod228 实测命中 `input[name="verificationCode"]`。 */
const CAPTCHA_INPUT_SELECTOR =
  'input#auth-captcha, input[name="captcha"], input[id*="captcha" i], input[placeholder*="验证码" i]';

async function isLoginPage(page: Page): Promise<boolean> {
  if (URL_LOGIN_HINTS.test(page.url())) return true;
  const hasPassword = await page.locator('input[type="password"]').count().catch(() => 0);
  return hasPassword > 0;
}

/** 在登录页自动填表提交；不泄露密码到返回值或日志。 */
async function fillLoginForm(page: Page, cred: LoginCtx): Promise<boolean> {
  try {
    if (cred.loginUrl && !URL_LOGIN_HINTS.test(page.url())) {
      await page.goto(cred.loginUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
      await page.waitForTimeout(SETTLE_MS);
    }
    const password = page.locator('input[type="password"]').first();
    if ((await password.count()) === 0) return false;

    const inputs = page.locator('input');
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
    if (usernameIdx < 0) return false;

    await inputs.nth(usernameIdx).fill(cred.user);
    await password.fill(cred.password);

    const formSubmit = page
      .locator('form:has(input[type="password"]) button[type="submit"], form:has(input[type="password"]) input[type="submit"]')
      .first();
    if ((await formSubmit.count()) > 0) {
      await formSubmit.click({ timeout: 5000 });
    } else {
      const pageSubmit = page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
      if ((await pageSubmit.count()) > 0) {
        await pageSubmit.click({ timeout: 5000 });
      } else {
        // ElementUI/Vue 等登录按钮常为 button[type=button]（prod228 实测 el-button login-btn），按文本兜底
        const textSubmit = page
          .locator('button:visible', { hasText: /^(登\s*录|sign\s*in|log\s*in|login|submit)$/i })
          .first();
        if ((await textSubmit.count()) > 0) {
          await textSubmit.click({ timeout: 5000 });
        } else {
          await password.press('Enter');
        }
      }
    }
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
    return !(await isLoginPage(page));
  } catch {
    return false;
  }
}

/** 在 context 上完成登录。返回 'logged-in'（本次完成登录）或 'not-needed'（无需登录/已有登录态）。
 *  失败抛错（文案可直接回给 AI/用户）。结束后关闭登录页；登录态(cookie/localStorage)留在 context。
 *  opts.solveCaptcha：探测到登录页含验证码元素时调用（仅依赖注入，不引入对 LLM 模块的硬依赖）。 */
export async function loginInContext(
  context: BrowserContext,
  cred: LoginCtx,
  startUrl: string,
  opts?: { solveCaptcha?: CaptchaSolver },
): Promise<'logged-in' | 'not-needed'> {
  const page = await context.newPage();
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(SETTLE_MS);
    // 部分登录页为客户端渲染/重定向，初次判定可能为 false；短暂等待密码框出现以避免误判
    await Promise.race([
      page.waitForTimeout(5000),
      page.locator('input[type="password"]').first().waitFor({ state: 'attached', timeout: 5000 }),
    ]).catch(() => undefined);
    if (!(await isLoginPage(page))) return 'not-needed';
    const captcha = await page.locator(CAPTCHA_INPUT_SELECTOR).first().count() > 0;
    if (captcha) {
      // 调用方注入解决器（perform_login / verify_case 各自构造，复用 solveCaptchaOnce + runAiTask）。
      // 不存在解决器时仍报原文案，向导用户去配置环境；存在但抛错则原样透传（含 LLM 输出片段）。
      if (!opts?.solveCaptcha) throw new Error('登录页需要验证码，无法自动完成登录');
      await opts.solveCaptcha(page);
    }
    const ok = await fillLoginForm(page, cred);
    if (!ok) throw new Error('自动填表登录失败（未找到用户名/密码输入框或提交后仍在登录页）');
    return 'logged-in';
  } finally {
    await page.close().catch(() => undefined);
  }
}
