import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright-core';
import type { LLMClient, LLMResult } from '../src/agent/llm-client.js';
import { runAiTask, solveCaptchaOnce, detectCaptchaFailure } from '../src/execute/aiTask.js';

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
  const llm: LLMClient = {
    provider: 'anthropic',
    async complete(req): Promise<LLMResult> {
      requests.push(req.userMessage);
      const raw = script.shift();
      if (raw === undefined) throw new Error('mock script exhausted');
      return typeof raw === 'string'
        ? { kind: 'text', value: raw, provider: 'anthropic', vision: true }
        : { kind: 'json', value: raw, provider: 'anthropic', vision: true };
    },
  };
  return { llm, requests };
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

  it('detectCaptchaFailure 匹配验证码错误/过期提示', async () => {
    const { page: p1 } = makeCaptchaStub({ pageText: '欢迎回来\n验证码错误或已过期' });
    expect(await detectCaptchaFailure(p1)).toBe(true);
    const { page: p2 } = makeCaptchaStub({ pageText: '欢迎回来\n登录成功' });
    expect(await detectCaptchaFailure(p2)).toBe(false);
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
});
