import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright-core';
import type { LLMClient, LLMResult } from '../src/agent/llm-client.js';
import { runAiTask, solveCaptchaOnce, credentialPlaceholderKind, makeCredentialValueSub, referencesCredential, parseCredentialPlaceholder, credentialPlaceholder, isValidCredentialRef } from '../src/execute/aiTask.js';

/** 记录调用顺序的桩 Page：screenshot/evaluate/url 走默认值，locator 动作全部记录。 */
function makeStubPage() {
  const calls: string[] = [];
  const values: Record<string, string> = {};
  const page = {
    url: () => 'https://sut.example/login',
    screenshot: async () => Buffer.from('png'),
    evaluate: async () => [],
    goto: async (u: string) => { calls.push(`goto:${u}`); },
    waitForLoadState: async () => {},
    keyboard: { press: async (key: string) => { calls.push(`press:${key}`); } },
    waitForTimeout: async (ms: number) => { calls.push(`wait:${ms}`); },
    locator: (selector: string) => ({
      first: () => ({
        click: async () => { calls.push(`click:${selector}`); },
        fill: async (v: string) => { calls.push(`fill:${selector}:${v}`); values[selector] = v; },
        pressSequentially: async (v: string) => { calls.push(`type:${selector}:${v}`); values[selector] = v; },
        inputValue: async () => {
          calls.push(`inputValue:${selector}`);
          return values[selector] ?? '';
        },
        waitFor: async () => undefined,
        evaluate: async () => undefined,
        screenshot: async () => Buffer.from('zoomed'),
      }),
    }),
  };
  return { page: page as unknown as Page, calls, values };
}

/** 按轮次脚本化回复的 mock LLM；每轮收到完整 userMessage。 */
function makeMockLlm(script: Array<Record<string, unknown> | string>) {
  const requests: string[] = [];
  const systems: string[] = [];
  const langs: Array<string | undefined> = [];
  const llm: LLMClient = {
    provider: 'anthropic',
    async complete(req): Promise<LLMResult> {
      requests.push(req.userMessage);
      systems.push(req.systemPrompt);
      langs.push(req.lang);
      const raw = script.shift();
      if (raw === undefined) throw new Error('mock script exhausted');
      return typeof raw === 'string'
        ? { kind: 'text', value: raw, provider: 'anthropic', vision: true }
        : { kind: 'json', value: raw, provider: 'anthropic', vision: true };
    },
  };
  return { llm, requests, systems, langs };
}

describe('solveCaptchaOnce / detectCaptchaFailure（多轮验证）', () => {
  function makeCaptchaStub(opts: { pageText: string }) {
    const calls: string[] = [];
    const inputEl = {
      fill: async (v: string) => { calls.push(`fill:${v}`); },
      type: async (v: string) => { calls.push(`type:${v}`); },
    };
    const imgEl = {
      evaluate: async () => undefined,
      screenshot: async () => Buffer.from('zoomed-captcha'),
    };
    const page = {
      evaluate: async () => opts.pageText,
      evaluateHandle: async () => ({
        evaluateHandle: async (getter: (p: unknown) => unknown) => {
          const g = String(getter);
          return { asElement: () => (g.includes('.input') ? inputEl : imgEl) };
        },
      }),
      screenshot: async () => Buffer.from('fullpage'),
    };
    return { page: page as unknown as Page, calls };
  }

  it('识别成功：填入输入框并返回摘要', async () => {
    const { page, calls } = makeCaptchaStub({ pageText: '' });
    const { llm } = makeMockLlm([{ text: 'Ab3d' }]);
    const summary = await solveCaptchaOnce(page, llm, 'captcha');
    expect(summary).toContain('Ab3d');
    expect(calls).toEqual(['fill:', 'type:Ab3d']);
  });

  it('识别结果非法时抛错（调用方回落通用回路）', async () => {
    const { page } = makeCaptchaStub({ pageText: '' });
    const { llm } = makeMockLlm(['看不清']);
    await expect(solveCaptchaOnce(page, llm)).rejects.toThrow('验证码识别结果非法');
  });
});

describe('runAiTask', () => {
  it('多轮循环：执行动作、反馈结果、直到 done', async () => {
    const { page, calls } = makeStubPage();
    const { llm, requests } = makeMockLlm([
      { actions: [{ type: 'fill', selector: '#auth-captcha', value: 'Ab3d' }, { type: 'click', selector: 'button[type=submit]' }] },
      { done: true, summary: '已识别并填入验证码' },
    ]);
    const summary = await runAiTask(page, '识别验证码并填入输入框', llm);
    expect(summary).toBe('已识别并填入验证码');
    expect(calls).toEqual([
      'fill:#auth-captcha:',
      'type:#auth-captcha:Ab3d',
      'press:Tab',
      'wait:80',
      'inputValue:#auth-captcha',
      'click:button[type=submit]',
    ]);
    // 第 2 轮应携带第 1 轮动作结果反馈
    expect(requests[1]).toContain('上轮动作结果');
    expect(requests[1]).toContain('fill #auth-captcha: ok');
  });

  it('done 响应中携带动作时先执行动作再结束', async () => {
    const { page, calls } = makeStubPage();
    const { llm } = makeMockLlm([
      { actions: [{ type: 'click', selector: '#final' }], done: true, summary: '一步完成' },
    ]);
    const summary = await runAiTask(page, '一步点击完成', llm);
    expect(summary).toBe('一步完成');
    expect(calls).toEqual(['click:#final']);
  });

  it('LLM 输出 fail 时立即抛错', async () => {
    const { page } = makeStubPage();
    const { llm } = makeMockLlm([{ fail: '验证码图片无法辨认' }]);
    await expect(runAiTask(page, '识别验证码', llm)).rejects.toThrow('aiTask 放弃：验证码图片无法辨认');
  });

  it('非法 JSON 输出计入反馈并继续下一轮', async () => {
    const { page, calls } = makeStubPage();
    const { llm, requests } = makeMockLlm([
      '不是 JSON',
      { actions: [{ type: 'press', key: 'Enter' }] },
      { done: true, summary: 'ok' },
    ]);
    await runAiTask(page, '提交表单', llm);
    expect(calls).toEqual(['press:Enter']);
    expect(requests[1]).toContain('不是合法 JSON');
  });

  it('超过最大轮数未完成则抛错', async () => {
    const { page } = makeStubPage();
    // 始终只输出 wait，永不 done
    const { llm } = makeMockLlm(Array.from({ length: 9 }, () => ({ actions: [{ type: 'wait', ms: 10 }] })));
    await expect(runAiTask(page, '永远完不成的指令', llm)).rejects.toThrow(/超过 \d+ 轮未完成/);
  });

  it('动作执行出错时把错误反馈给下一轮而不是中断', async () => {
    const { page } = makeStubPage();
    // click 抛错的桩
    (page as unknown as { locator: (s: string) => unknown }).locator = (selector: string) => ({
      first: () => ({ click: async () => { throw new Error(`no such element: ${selector}`); } }),
    });
    const { llm, requests } = makeMockLlm([
      { actions: [{ type: 'click', selector: '#missing' }] },
      { done: true, summary: '换方案完成' },
    ]);
    const summary = await runAiTask(page, '点一个不存在再换', llm);
    expect(summary).toBe('换方案完成');
    expect(requests[1]).toContain('no such element: #missing');
  });

  it('valueSub 替换：占位符在执行时刻还原为真实值，反馈不含真实值', async () => {
    const { page, calls } = makeStubPage();
    const { llm, requests } = makeMockLlm([
      { actions: [{ type: 'fill', selector: '#pwd', value: '__ITEST_PASSWORD__' }] },
      { done: true, summary: 'ok' },
    ]);
    const summary = await runAiTask(page, '填密码', llm, false, {
      valueSub: (v) => (v === '__ITEST_PASSWORD__' ? 'RealSecret!9' : v),
    });
    expect(summary).toBe('ok');
    expect(calls).toContain('type:#pwd:RealSecret!9');
    // 回读命中真实值 → 反馈 ok，任何一轮请求都不含明文
    expect(requests[1]).toContain('fill #pwd: ok');
    expect(requests[1]).not.toContain('RealSecret!9');
  });

  it('替换后 mismatch：反馈不回显实际值/目标值，只给长度', async () => {
    const calls: string[] = [];
    // React 截断模拟：回读值与键入值不一致
    const page = {
      url: () => 'https://sut.example/login',
      screenshot: async () => Buffer.from('png'),
      evaluate: async () => [],
      goto: async () => {},
      waitForLoadState: async () => {},
      keyboard: { press: async () => {} },
      waitForTimeout: async () => {},
      locator: (selector: string) => ({
        first: () => ({
          click: async () => {},
          fill: async () => {},
          pressSequentially: async (v: string) => { calls.push(`type:${v}`); },
          inputValue: async () => 'Trun',
          waitFor: async () => undefined,
          evaluate: async () => undefined,
          screenshot: async () => Buffer.from('z'),
        }),
      }),
    } as unknown as Page;
    const { llm, requests } = makeMockLlm([
      { actions: [{ type: 'fill', selector: '#pwd', value: '__ITEST_STEP_SECRET__' }] },
      { fail: 'stop' },
    ]);
    await expect(
      runAiTask(page, '填敏感值', llm, false, {
        valueSub: (v) => (v === '__ITEST_STEP_SECRET__' ? 'RealSecret!9' : v),
      }),
    ).rejects.toThrow('aiTask 放弃');
    expect(calls).toEqual(['type:RealSecret!9']);
    expect(requests[1]).toContain('实际值与目标不一致（实际值长度 4）');
    expect(requests[1]).not.toContain('RealSecret!9');
    expect(requests[1]).not.toContain('Trun');
  });

  it('未替换 mismatch：保持既有回显（实际值+目标值）', async () => {
    const page = {
      url: () => 'https://sut.example/login',
      screenshot: async () => Buffer.from('png'),
      evaluate: async () => [],
      goto: async () => {},
      waitForLoadState: async () => {},
      keyboard: { press: async () => {} },
      waitForTimeout: async () => {},
      locator: (selector: string) => ({
        first: () => ({
          click: async () => {},
          fill: async () => {},
          pressSequentially: async () => {},
          inputValue: async () => 'actual-x',
          waitFor: async () => undefined,
          evaluate: async () => undefined,
          screenshot: async () => Buffer.from('z'),
        }),
      }),
    } as unknown as Page;
    const { llm, requests } = makeMockLlm([
      { actions: [{ type: 'fill', selector: '#u', value: 'expected' }] },
      { fail: 'stop' },
    ]);
    await expect(runAiTask(page, '填用户名', llm)).rejects.toThrow();
    expect(requests[1]).toContain('实际值 "actual-x" 与目标 "expected" 不一致');
  });

  it('navigate 动作：goto http(s) 绝对地址并反馈 ok；非法 scheme 被 parseAction 丢弃', async () => {
    const { page } = makeStubPage();
    const { llm, requests } = makeMockLlm([
      { actions: [{ type: 'navigate', url: 'https://sut.example/home' }, { type: 'navigate', url: 'javascript:alert(1)' }] },
      { done: true, summary: '已导航' },
    ]);
    await runAiTask(page, '去首页', llm);
    expect(requests[1]).toContain('navigate https://sut.example/home: ok');
  });

  it('opts.maxTurns 覆盖轮数上限并出现在报错文案', async () => {
    const { page } = makeStubPage();
    const { llm } = makeMockLlm(Array.from({ length: 3 }, () => ({ actions: [{ type: 'wait', ms: 1 }] })));
    await expect(runAiTask(page, '完不成', llm, false, { maxTurns: 2 })).rejects.toThrow(/超过 2 轮未完成/);
  });

  it('lang 缺省回落 zh-CN（无用户上下文确定性输出语言）', async () => {
    const { page } = makeStubPage();
    const { llm, langs } = makeMockLlm([{ done: true, summary: 'ok' }]);
    await runAiTask(page, '一步完成', llm);
    expect(langs[0]).toBe('zh-CN');
  });

  it('opts.lang=en-US 透传给 LLM 请求', async () => {
    const { page } = makeStubPage();
    const { llm, langs } = makeMockLlm([{ done: true, summary: 'ok' }]);
    await runAiTask(page, '一步完成', llm, false, { lang: 'en-US' });
    expect(langs[0]).toBe('en-US');
  });

  it('resourceManifest 进系统提示词且不含真实凭据', async () => {
    const { page } = makeStubPage();
    const { llm, systems } = makeMockLlm([{ done: true, summary: 'ok' }]);
    await runAiTask(page, '登录', llm, false, {
      resourceManifest: '可用 web 服务：\n- backend（默认） http://10.0.0.1:90 已配置凭据\n- staging http://10.0.0.9 未配置凭据',
    });
    expect(systems[0]).toContain('backend（默认） http://10.0.0.1:90');
    expect(systems[0]).toContain('未配置凭据');
    expect(systems[0]).toContain('__ITEST_USERNAME@服务名__');
    // 缺省不注入（无清单的调用方提示词与既有形态一致）
    const { llm: l2, systems: s2 } = makeMockLlm([{ done: true, summary: 'ok' }]);
    await runAiTask(page, '登录', l2);
    expect(s2[0]).not.toContain('可用 web 服务');
  });
});

describe('凭据占位符协议（credentialPlaceholderKind / makeCredentialValueSub）', () => {
  it('识别哨兵与花括号变体，裸名与普通文本不认', () => {
    // 哨兵精确形态
    expect(credentialPlaceholderKind('__ITEST_USERNAME__')).toBe('user');
    expect(credentialPlaceholderKind('__ITEST_PASSWORD__')).toBe('password');
    expect(credentialPlaceholderKind('__ITEST_STEP_SECRET__')).toBe('secret');
    // 花括号变体（2026-10-21 prod228 实测模型输出形态）
    expect(credentialPlaceholderKind('{{ITEST_USERNAME}}')).toBe('user');
    expect(credentialPlaceholderKind('{{__ITEST_USERNAME__}}')).toBe('user');
    expect(credentialPlaceholderKind('{{ITEST_PASSWORD}}')).toBe('password');
    expect(credentialPlaceholderKind('{{ITEST_STEP_SECRET}}')).toBe('secret');
    // 裸名（无哨兵/花括号包裹）不认——避免把普通文本误判成凭据
    expect(credentialPlaceholderKind('ITEST_USERNAME')).toBeNull();
    expect(credentialPlaceholderKind('普通文本')).toBeNull();
    expect(credentialPlaceholderKind('{{OTHER_VAR}}')).toBeNull();
    expect(credentialPlaceholderKind('')).toBeNull();
  });

  it('referencesCredential：任意形态（哨兵/花括号/裸名）都算引用，普通文本不算', () => {
    expect(referencesCredential('__ITEST_USERNAME__')).toBe(true);
    expect(referencesCredential('{{ITEST_USERNAME}}')).toBe(true);
    expect(referencesCredential('{{__ITEST_PASSWORD__}}')).toBe(true);
    expect(referencesCredential('ITEST_STEP_SECRET')).toBe(true);
    expect(referencesCredential('在登录页填写 {{ITEST_USERNAME}} 登录')).toBe(true);
    expect(referencesCredential('点击保存按钮')).toBe(false);
    expect(referencesCredential('{{OTHER_VAR}}')).toBe(false);
  });

  it('makeCredentialValueSub：占位符换真实值，缺凭据抛命名错误，非占位符原样', () => {
    const sub = makeCredentialValueSub({ user: 'admin', password: 'pw9', secret: null });
    expect(sub('__ITEST_USERNAME__')).toBe('admin');
    expect(sub('{{ITEST_USERNAME}}')).toBe('admin');
    expect(sub('{{__ITEST_PASSWORD__}}')).toBe('pw9');
    expect(sub('plain')).toBe('plain');
    // 环境未配 login → EnvMissing（绝不静默填空串/字面量）
    const noLogin = makeCredentialValueSub({ user: null, password: null, secret: null });
    expect(() => noLogin('__ITEST_USERNAME__')).toThrow(/env-missing/);
    // 步骤无密文 → SecretMissing
    expect(() => noLogin('{{ITEST_STEP_SECRET}}')).toThrow(/secret-missing/);
  });

  it('runAiTask：valueSub 抛 EnvMissing 时动作循环直接终止（不反馈给 LLM 空转）', async () => {
    // prod228 实测根因之一：凭据缺失被当普通动作错误反馈给 LLM，换 selector 重试烧掉整轮调用。
    // 现在第一轮 fill 抛 EnvMissing 就终止 —— requests 只有 1 条（第 2 轮从未发生）。
    const { page } = makeStubPage();
    const { llm, requests } = makeMockLlm([
      { actions: [{ type: 'fill', selector: '#user', value: '__ITEST_USERNAME__' }], done: true, summary: '填完' },
      { done: true, summary: '不应到达' },
    ]);
    await expect(
      runAiTask(page, '登录', llm, false, { valueSub: makeCredentialValueSub({ user: null, password: null, secret: null }) }),
    ).rejects.toThrow(/env-missing/);
    expect(requests).toHaveLength(1);
  });
});

describe('凭据占位符 @ref 归属协议', () => {
  it('parseCredentialPlaceholder：@ref 形态解析出归属服务', () => {
    expect(parseCredentialPlaceholder('__ITEST_USERNAME@backend__')).toEqual({ kind: 'user', ref: 'backend' });
    expect(parseCredentialPlaceholder('__ITEST_PASSWORD@front_end1__')).toEqual({ kind: 'password', ref: 'front_end1' });
    expect(parseCredentialPlaceholder('{{ITEST_USERNAME@backend}}')).toEqual({ kind: 'user', ref: 'backend' });
    expect(parseCredentialPlaceholder('{{__ITEST_USERNAME@backend__}}')).toEqual({ kind: 'user', ref: 'backend' });
    // 无 ref 形态仍解析，ref 为 null
    expect(parseCredentialPlaceholder('__ITEST_USERNAME__')).toEqual({ kind: 'user', ref: null });
    expect(parseCredentialPlaceholder('{{ITEST_PASSWORD}}')).toEqual({ kind: 'password', ref: null });
    // ref 非法（数字开头 / 含 @ / 含空格）→ 整个占位符不认，绝不退化成无 ref
    expect(parseCredentialPlaceholder('__ITEST_USERNAME@1bad__')).toBeNull();
    expect(parseCredentialPlaceholder('__ITEST_USERNAME@a@b__')).toBeNull();
    expect(parseCredentialPlaceholder('__ITEST_USERNAME@ bad __')).toBeNull();
    // secret 不解析 ref（敏感密文是步骤级，与 web 无关）：@段被忽略
    expect(parseCredentialPlaceholder('__ITEST_STEP_SECRET@x__')).toEqual({ kind: 'secret', ref: null });
    // 裸名 / 普通文本仍不认
    expect(parseCredentialPlaceholder('ITEST_USERNAME')).toBeNull();
    expect(parseCredentialPlaceholder('普通文本')).toBeNull();
    expect(parseCredentialPlaceholder('')).toBeNull();
  });

  it('credentialPlaceholder / isValidCredentialRef 往返一致', () => {
    expect(credentialPlaceholder('user', 'backend')).toBe('__ITEST_USERNAME@backend__');
    expect(credentialPlaceholder('password', null)).toBe('__ITEST_PASSWORD__');
    expect(credentialPlaceholder('secret')).toBe('__ITEST_STEP_SECRET__');
    for (const ref of ['backend', 'front_end1', '_x']) expect(isValidCredentialRef(ref)).toBe(true);
    for (const ref of ['', '1bad', 'a-b', 'a b', 'a'.repeat(65)]) expect(isValidCredentialRef(ref)).toBe(false);
    // 渲染出来的占位符一定解析得回同一个 ref
    for (const kind of ['user', 'password'] as const) {
      for (const ref of ['backend', 'admin_web']) {
        expect(parseCredentialPlaceholder(credentialPlaceholder(kind, ref))).toEqual({ kind, ref });
      }
    }
  });

  it('referencesCredential：@ref 形态也算引用', () => {
    expect(referencesCredential('__ITEST_USERNAME@backend__')).toBe(true);
    expect(referencesCredential('在 backend 登录页填写 __ITEST_USERNAME@backend__')).toBe(true);
    expect(referencesCredential('{{ITEST_PASSWORD@front}}')).toBe(true);
    expect(referencesCredential('点击保存')).toBe(false);
  });
});

describe('makeCredentialValueSub byRef（@ref 归属解析）', () => {
  it('@ref 命中 byRef，未命中回落默认，再不命中抛点名错误', () => {
    const sub = makeCredentialValueSub({
      user: 'def_u', password: 'def_p', secret: null,
      byRef: (ref) => (ref === 'backend' ? { user: 'be_u', password: 'be_p' } : null),
    });
    expect(sub('__ITEST_USERNAME@backend__')).toBe('be_u');
    expect(sub('__ITEST_PASSWORD@backend__')).toBe('be_p');
    // @ref 未命中 → 回落默认（同一 web 的不同形态占位符不打架）
    expect(sub('__ITEST_USERNAME@nope__')).toBe('def_u');
    expect(sub('__ITEST_USERNAME__')).toBe('def_u');
    // 双空 → 命名错误，且消息点名缺失的 ref 与可用 ref
    const none = makeCredentialValueSub({ user: null, password: null, secret: null, byRef: () => null });
    expect(() => none('__ITEST_USERNAME@backend__')).toThrow(/env-missing/);
    expect(() => none('__ITEST_USERNAME@backend__')).toThrow(/backend/);
  });

  it('secret 恒走步骤密文，不看 byRef', () => {
    const sub = makeCredentialValueSub({
      user: 'u', password: 'p', secret: 'step-secret',
      byRef: () => ({ user: 'x', password: 'y' }),
    });
    expect(sub('__ITEST_STEP_SECRET@anything__')).toBe('step-secret');
  });
});
