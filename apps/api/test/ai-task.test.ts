import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright-core';
import type { LLMClient, LLMResult } from '../src/agent/llm-client.js';
import { runAiTask } from '../src/execute/aiTask.js';

/** 记录调用顺序的桩 Page：screenshot/evaluate/url 走默认值，locator 动作全部记录。 */
function makeStubPage() {
  const calls: string[] = [];
  const page = {
    url: () => 'https://sut.example/login',
    screenshot: async () => Buffer.from('png'),
    evaluate: async () => [],
    keyboard: { press: async (key: string) => { calls.push(`press:${key}`); } },
    waitForTimeout: async (ms: number) => { calls.push(`wait:${ms}`); },
    locator: (selector: string) => ({
      first: () => ({
        click: async () => { calls.push(`click:${selector}`); },
        fill: async (v: string) => { calls.push(`fill:${selector}:${v}`); },
        pressSequentially: async (v: string) => { calls.push(`type:${selector}:${v}`); },
        waitFor: async () => undefined,
        evaluate: async () => undefined,
        screenshot: async () => Buffer.from('zoomed'),
      }),
    }),
  };
  return { page: page as unknown as Page, calls };
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

describe('runAiTask', () => {
  it('多轮循环：执行动作、反馈结果、直到 done', async () => {
    const { page, calls } = makeStubPage();
    const { llm, requests } = makeMockLlm([
      { actions: [{ type: 'fill', selector: '#auth-captcha', value: 'Ab3d' }, { type: 'click', selector: 'button[type=submit]' }] },
      { done: true, summary: '已识别并填入验证码' },
    ]);
    const summary = await runAiTask(page, '识别验证码并填入输入框', llm);
    expect(summary).toBe('已识别并填入验证码');
    expect(calls).toEqual(['fill:#auth-captcha:', 'type:#auth-captcha:Ab3d', 'click:button[type=submit]']);
    // 第 2 轮应携带第 1 轮动作结果反馈
    expect(requests[1]).toContain('上轮动作结果');
    expect(requests[1]).toContain('fill #auth-captcha: ok');
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
});
