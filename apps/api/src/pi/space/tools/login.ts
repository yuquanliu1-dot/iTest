import { Type } from '@earendil-works/pi-ai';
import { chromium, type Page } from 'playwright-core';
import { resolveEnv } from '../../../execute/envContext.js';
import type { LoginCtx } from '../../../execute/envContext.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

const GOTO_TIMEOUT_MS = 20_000;
const SETTLE_MS = 800;

const URL_LOGIN_HINTS = /(?:^|\/)(login|signin|sign-in|auth|unauthorized)(?:\/|$|\?)/i;

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
        await password.press('Enter');
      }
    }
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
    return !(await isLoginPage(page));
  } catch {
    return false;
  }
}

export function buildLoginTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'get_login_credentials',
      description:
        '返回当前版本/项目默认环境的登录凭据概要（用户名、登录页地址、是否已配置密码、环境 ID）。不会暴露密码本身；若需要登录态，可接着调用 perform_login。',
      parameters: Type.Object({}),
      execute: async () => {
        let envCtx: Awaited<ReturnType<typeof resolveEnv>> | undefined;
        try {
          envCtx = await resolveEnv({ versionId: ctx.versionId }, { expectedProjectId: ctx.projectId });
          if (!envCtx.login) {
            return { ok: false, error: '当前默认环境未配置 login 凭据' };
          }
          return {
            ok: true,
            data: JSON.stringify({
              user: envCtx.login.user,
              loginUrl: envCtx.login.loginUrl,
              hasPassword: true,
              environmentId: envCtx.envId,
            }),
          };
        } catch (e) {
          return { ok: false, error: `读取环境失败:${(e as Error).message}` };
        } finally {
          if (envCtx) await envCtx.close().catch(() => {});
        }
      },
    },
    {
      name: 'perform_login',
      description:
        '使用当前版本/项目默认环境的 login 凭据在被测系统执行登录，返回 storageState（JSON 字符串）。后续可将 storageState 传给 inspect_page 以抓取登录态页面；凭据在服务端解密，不会出现在输出中。',
      parameters: Type.Object({
        url: Type.Optional(Type.String({ minLength: 8, maxLength: 2000 })),
      }),
      promptGuidelines: [
        '若 inspect_page 返回登录页，先调用 get_login_credentials 确认凭据已配置，再调用 perform_login 获取 storageState，最后将 storageState 传入 inspect_page。',
      ],
      execute: async (input) => {
        const { url } = input as { url?: string };
        let envCtx: Awaited<ReturnType<typeof resolveEnv>> | undefined;
        try {
          envCtx = await resolveEnv({ versionId: ctx.versionId }, { expectedProjectId: ctx.projectId });
          if (!envCtx.login) {
            return { ok: false, error: '当前默认环境未配置 login 凭据' };
          }
          const browser = await chromium.launch({
            headless: true,
            executablePath: process.env.CHROMIUM_PATH || undefined,
          });
          try {
            const context = await browser.newContext({ ignoreHTTPSErrors: true });
            const page = await context.newPage();
            const targetUrl = url || envCtx.login.loginUrl || envCtx.baseUrl || '';
            if (!targetUrl) {
              return { ok: false, error: '缺少登录目标 URL（未传 url，且环境未配置 loginUrl/baseUrl）' };
            }
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
            await page.waitForTimeout(SETTLE_MS);
            // 部分登录页为客户端渲染/重定向，初次判定可能为 false；短暂等待密码框出现以避免误判
            await Promise.race([
              page.waitForTimeout(5000),
              page.locator('input[type="password"]').first().waitFor({ state: 'attached', timeout: 5000 }),
            ]).catch(() => undefined);

            let message = '页面无需登录或已有登录态';
            if (await isLoginPage(page)) {
              const captcha = await page.locator('input#auth-captcha, input[name="captcha"], input[id*="captcha" i], input[placeholder*="验证码" i]').first().count() > 0;
              if (captcha) {
                return { ok: false, error: '登录页需要验证码，无法自动完成登录' };
              }
              const ok = await fillLoginForm(page, envCtx.login);
              if (!ok) {
                return { ok: false, error: '自动填表登录失败（未找到用户名/密码输入框或提交后仍在登录页）' };
              }
              message = '登录成功';
            }
            const storageState = await context.storageState();
            return { ok: true, data: JSON.stringify({ storageState, message }) };
          } finally {
            await browser.close().catch(() => {});
          }
        } catch (e) {
          return { ok: false, error: `登录失败:${(e as Error).message}` };
        } finally {
          if (envCtx) await envCtx.close().catch(() => {});
        }
      },
    },
  ];
}
