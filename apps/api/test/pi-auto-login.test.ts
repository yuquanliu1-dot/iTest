import { describe, it, expect, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import { loginInContext } from '../src/pi/autoLogin.js';

interface Script {
  url: string;
  passwordCount?: number;
  captchaCount?: number;
  usernameIdx?: number;
  formSubmitCount?: number;
  /** 提交后密码框数量（0=已跳离登录页 → 登录成功） */
  afterSubmitPasswordCount?: number;
}

/** 状态化 fake：locator 按 selector 关键字分发；提交动作(click/press)翻转密码框计数。 */
function fakeContextWithPage(s: Script) {
  const fills: string[] = [];
  // url 用对象包一层便于 click 后改写（避开 URL_LOGIN_HINTS 在「URL 含 /login」上恒真）
  const urlRef: { v: string } = { v: s.url };
  const state = { passwordCount: s.passwordCount ?? 0 };
  const password = {
    count: async () => state.passwordCount,
    fill: async (v: string) => { fills.push(`password:${v}`); },
    press: async (k: string) => { fills.push(`press:${k}`); state.passwordCount = s.afterSubmitPasswordCount ?? 0; urlRef.v = 'http://e/home'; },
    first() { return password; },
    waitFor: async () => {},
  };
  const captcha = { count: async () => s.captchaCount ?? 0, first() { return captcha; } };
  const formSubmit = {
    count: async () => s.formSubmitCount ?? 0,
    click: async () => { state.passwordCount = s.afterSubmitPasswordCount ?? 0; urlRef.v = 'http://e/home'; },
    first() { return formSubmit; },
  };
  const pageSubmit = {
    count: async () => s.formSubmitCount ?? 0,
    click: async () => { state.passwordCount = s.afterSubmitPasswordCount ?? 0; urlRef.v = 'http://e/home'; },
    first() { return pageSubmit; },
  };
  const generic = { count: async () => 0, fill: async (v: string) => { fills.push(`input:${v}`); }, nth() { return generic; } };
  const page = {
    url: () => urlRef.v,
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    close: async () => {},
    locator: (sel: string) => {
      if (sel.startsWith('form:has')) return formSubmit;
      if (sel === 'input[type="password"]') return password;
      if (sel.includes('captcha')) return captcha;
      if ((sel.includes('button[type="submit"]') || sel.includes('input[type="submit"]')) && sel.includes(':visible')) {
        return pageSubmit;
      }
      return generic;
    },
    evaluate: async () => s.usernameIdx ?? 0,
  };
  return { context: { newPage: async () => page } as unknown as BrowserContext, page, fills };
}

const CRED = { user: 'qa01', password: 'Secret!1', loginUrl: null };

describe('loginInContext', () => {
  it('页面无密码框且 URL 无登录提示 → not-needed', async () => {
    const { context } = fakeContextWithPage({ url: 'http://e/home' });
    await expect(loginInContext(context, CRED, 'http://e/home')).resolves.toBe('not-needed');
  });

  it('密码框存在且提交后跳离登录页 → logged-in，并填入用户名/密码', async () => {
    const { context, fills } = fakeContextWithPage({
      url: 'http://e/home',
      passwordCount: 1,
      usernameIdx: 0,
      formSubmitCount: 1,
      afterSubmitPasswordCount: 0,
    });
    await expect(loginInContext(context, CRED, 'http://e/home')).resolves.toBe('logged-in');
    expect(fills).toContain('input:qa01');
    expect(fills).toContain('password:Secret!1');
  });

  it('登录页有验证码但未注入 solveCaptcha → 抛原文案错误', async () => {
    const { context } = fakeContextWithPage({ url: 'http://e/login', passwordCount: 1, captchaCount: 1 });
    await expect(loginInContext(context, CRED, 'http://e/login')).rejects.toThrow(/登录页需要验证码/);
  });

  it('登录页有验证码 + 注入 solveCaptcha → 调用 solver 后填表登录', async () => {
    const { context, page, fills } = fakeContextWithPage({
      url: 'http://e/login',
      passwordCount: 1,
      captchaCount: 1,
      usernameIdx: 0,
      formSubmitCount: 1,
      afterSubmitPasswordCount: 0,
    });
    // solveCaptcha 模拟「识别成功」后把验证码 input 填上,下游 isLoginPage 判定密码框消失（已登出登录页）
    const solver = vi.fn(async (p: { evaluate: (s: string) => Promise<unknown> }) => { /* no-op */ });
    await expect(
      loginInContext(context, CRED, 'http://e/login', { solveCaptcha: solver }),
    ).resolves.toBe('logged-in');
    expect(solver).toHaveBeenCalledTimes(1);
    expect(solver.mock.calls[0]![0]).toBe(page);
    expect(fills).toContain('input:qa01');
    expect(fills).toContain('password:Secret!1');
  });

  it('solver 抛错 → loginInContext 透传', async () => {
    const { context } = fakeContextWithPage({ url: 'http://e/login', passwordCount: 1, captchaCount: 1 });
    const solver = vi.fn(async () => { throw new Error('验证码识别结果非法: 200'); });
    await expect(
      loginInContext(context, CRED, 'http://e/login', { solveCaptcha: solver }),
    ).rejects.toThrow(/验证码识别结果非法/);
  });

  it('无验证码时即使注入 solveCaptcha → 也不调用 solver', async () => {
    const { context } = fakeContextWithPage({
      url: 'http://e/home',
      passwordCount: 1,
      usernameIdx: 0,
      formSubmitCount: 1,
      afterSubmitPasswordCount: 0,
    });
    const solver = vi.fn(async () => {});
    await expect(
      loginInContext(context, CRED, 'http://e/home', { solveCaptcha: solver }),
    ).resolves.toBe('logged-in');
    expect(solver).not.toHaveBeenCalled();
  });

  it('提交后仍在登录页 → 抛自动填表登录失败', async () => {
    const { context } = fakeContextWithPage({
      url: 'http://e/home',
      passwordCount: 1,
      usernameIdx: 0,
      formSubmitCount: 1,
      afterSubmitPasswordCount: 1,
    });
    await expect(loginInContext(context, CRED, 'http://e/home')).rejects.toThrow(/自动填表登录失败/);
  });
});
