import { describe, it, expect } from 'vitest';
import type { BrowserContext } from 'playwright-core';
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
  const state = { passwordCount: s.passwordCount ?? 0 };
  const password = {
    count: async () => state.passwordCount,
    fill: async (v: string) => { fills.push(`password:${v}`); },
    press: async (k: string) => { fills.push(`press:${k}`); state.passwordCount = s.afterSubmitPasswordCount ?? 0; },
    first() { return password; },
    waitFor: async () => {},
  };
  const captcha = { count: async () => s.captchaCount ?? 0, first() { return captcha; } };
  const formSubmit = {
    count: async () => s.formSubmitCount ?? 0,
    click: async () => { state.passwordCount = s.afterSubmitPasswordCount ?? 0; },
    first() { return formSubmit; },
  };
  const generic = { count: async () => 0, fill: async (v: string) => { fills.push(`input:${v}`); }, nth() { return generic; } };
  const page = {
    url: () => s.url,
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    close: async () => {},
    locator: (sel: string) => {
      // 注意顺序：form 提交选择器含 "password" 子串，须先按前缀 form:has 分发
      if (sel.startsWith('form:has')) return formSubmit;
      if (sel.includes('password')) return password;
      if (sel.includes('captcha')) return captcha;
      return generic;
    },
    evaluate: async () => s.usernameIdx ?? 0,
  };
  return { context: { newPage: async () => page } as unknown as BrowserContext, fills };
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

  it('登录页有验证码 → 抛错（不填表）', async () => {
    const { context } = fakeContextWithPage({ url: 'http://e/login', passwordCount: 1, captchaCount: 1 });
    await expect(loginInContext(context, CRED, 'http://e/login')).rejects.toThrow(/验证码/);
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
