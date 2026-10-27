import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'playwright-core';

// playwright-core 打桩：runAiTask 每轮要截图 + 读元素清单，页面本身不参与断言，
// 断言全在「发给 LLM 的 messages 序列」上。
vi.mock('playwright-core', () => {
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue({
      click: vi.fn().mockResolvedValue(undefined),
      first: vi.fn().mockReturnThis(),
      count: vi.fn().mockResolvedValue(1),
      waitFor: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('shot')),
      evaluate: vi.fn().mockResolvedValue(undefined),
    }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fullpage-png')),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    url: vi.fn(() => 'http://env.example/login'),
    viewportSize: vi.fn(() => ({ width: 1280, height: 800 })),
    // dumpElements 的 evaluate：返回元素清单
    evaluate: vi.fn().mockResolvedValue([{ selector: '#user', tag: 'input', placeholder: '账号' }]),
    context: vi.fn(() => ({ pages: () => [] })),
  };
  return { chromium: { launch: vi.fn() }, __page: page };
});

import { runAiTask } from '../src/execute/aiTask.js';
import type { LLMClient, LLMMessage, LLMResult } from '../src/agent/llm-client.js';

const mocked = await import('playwright-core') as unknown as { __page: Page };

/** 记录每次 complete 的 messages，并按脚本返回 LLM 响应。 */
function makeClient(script: string[]): { client: LLMClient; calls: LLMMessage[][] } {
  const calls: LLMMessage[][] = [];
  let i = 0;
  const client: LLMClient = {
    provider: 'anthropic',
    complete: (async (req: { messages?: LLMMessage[] }) => {
      calls.push(structuredClone(req.messages ?? []));
      const text = script[Math.min(i, script.length - 1)]!;
      i++;
      return {
        kind: 'json',
        value: JSON.parse(text),
        provider: 'anthropic',
        vision: false,
        usage: { promptTokens: 10, completionTokens: 5 },
      } satisfies LLMResult;
    }) as LLMClient['complete'],
  };
  return { client, calls };
}

/** 取一次请求里所有 user 文本 block（便于断言"历史是否累积"）。 */
function userTexts(msgs: LLMMessage[]): string[] {
  return msgs
    .filter((m) => m.role === 'user')
    .map((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
}

describe('runAiTask 多轮累积（prompt cache 前缀）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('第 N 轮请求包含第 1..N 轮的完整历史（不再只发当轮）', async () => {
    // 轮1: 点输入框；轮2: 填值并完成
    const { client, calls } = makeClient([
      JSON.stringify({ actions: [{ type: 'click', selector: '#user' }], done: false }),
      JSON.stringify({ actions: [{ type: 'fill', selector: '#user', value: 'alice' }], done: true, summary: '填好了' }),
    ]);
    await runAiTask(mocked.__page, '登录', client, false, { maxTurns: 4 });

    expect(calls).toHaveLength(2);
    // 第 1 轮：只有自己
    expect(calls[0]!.map((m) => m.role)).toEqual(['user']);
    // 第 2 轮：user1 + assistant1 + user2 —— 这是缓存能命中的关键
    expect(calls[1]!.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    // 第 1 轮的内容仍在第 2 轮请求里（旧实现会整个丢掉）
    expect(userTexts(calls[1]!)[0]).toContain('第 1/4 轮');
    expect(userTexts(calls[1]!)[1]).toContain('第 2/4 轮');
  });

  it('assistant 历史回放 LLM 原始输出（保证前缀与实际发送逐字一致）', async () => {
    const { client, calls } = makeClient([
      JSON.stringify({ actions: [], done: false, summary: '观察中' }),
      JSON.stringify({ actions: [], done: true, summary: '完成' }),
    ]);
    await runAiTask(mocked.__page, '观察', client, false, { maxTurns: 3 });
    const assistantMsg = calls[1]!.find((m) => m.role === 'assistant')!;
    // 原始 JSON 输出原样回放（不是动作摘要，否则前缀漂移、命中率反降）
    expect(assistantMsg.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify({ actions: [], done: false, summary: '观察中' }),
    });
  });

  it('每轮历史严格只增不减：前缀逐轮延长（第 k 轮请求的前 k-1 条与前一轮逐字相同）', async () => {
    // 缓存按前缀匹配，这是"前缀真的稳定"的直接断言
    const { client, calls } = makeClient([
      JSON.stringify({ actions: [{ type: 'click', selector: '#a' }], done: false }),
      JSON.stringify({ actions: [{ type: 'click', selector: '#b' }], done: false }),
      JSON.stringify({ actions: [], done: true, summary: 'ok' }),
    ]);
    await runAiTask(mocked.__page, '多点几次', client, false, { maxTurns: 5 });

    expect(calls).toHaveLength(3);
    // 第 3 轮请求的前 4 条 == 第 2 轮请求的全部 4 条
    const prev = calls[1]!;
    const cur = calls[2]!;
    expect(cur.length).toBe(prev.length + 2); // +assistant +新 user
    for (let i = 0; i < prev.length; i++) {
      expect(JSON.stringify(cur[i])).toBe(JSON.stringify(prev[i]));
    }
  });

  it('截图以 image block 进历史，且排在文本之前（与单轮形态顺序一致）', async () => {
    const { client, calls } = makeClient([
      JSON.stringify({ actions: [], done: false }),
      JSON.stringify({ actions: [], done: true, summary: 'ok' }),
    ]);
    await runAiTask(mocked.__page, '看图', client, false, { maxTurns: 3 });
    const firstUser = calls[0]![0]!;
    expect(firstUser.role).toBe('user');
    expect(firstUser.content[0]!.type).toBe('image');
    expect(firstUser.content[1]!.type).toBe('text');
    // 第 2 轮仍保留第 1 轮的截图 block —— 旧实现下截图每轮被丢弃，无法复用
    expect(calls[1]![0]!.content.some((b) => b.type === 'image')).toBe(true);
  });

  it('非法 JSON 轮次也进历史（下一轮能看到自己上一轮说了什么）', async () => {
    const calls: LLMMessage[][] = [];
    let i = 0;
    const client: LLMClient = {
      provider: 'anthropic',
      complete: (async (req: { messages?: LLMMessage[] }) => {
        calls.push(structuredClone(req.messages ?? []));
        const bad = i === 0;
        i++;
        return {
          kind: 'text',
          value: bad ? '这不是 JSON' : JSON.stringify({ actions: [], done: true }),
          provider: 'anthropic',
          vision: false,
        } satisfies LLMResult;
      }) as LLMClient['complete'],
    };
    await runAiTask(mocked.__page, '坏输出', client, false, { maxTurns: 3 });
    const assistantMsg = calls[1]!.find((m) => m.role === 'assistant')!;
    expect(assistantMsg.content[0]).toEqual({ type: 'text', text: '这不是 JSON' });
  });

  it('单轮完成（首轮 done）时历史只有 1 条，行为与旧实现等价', async () => {
    const { client, calls } = makeClient([JSON.stringify({ actions: [], done: true, summary: '一步到位' })]);
    const summary = await runAiTask(mocked.__page, '一步', client, false, { maxTurns: 4 });
    expect(summary).toBe('一步到位');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((m) => m.role)).toEqual(['user']);
  });

  it('maxTurns 用尽仍逐轮累积（第 5 轮请求带满前 4 轮历史）', async () => {
    const { client, calls } = makeClient([JSON.stringify({ actions: [], done: false })]);
    await expect(runAiTask(mocked.__page, '做不完', client, false, { maxTurns: 3 })).rejects.toThrow(/超过 3 轮/);
    expect(calls).toHaveLength(3);
    // 3 轮 = user1,a1,user2,a2,user3
    expect(calls[2]!.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  });

  it('onUsage 仍每轮回调一次（aiUsage 统计口径不变）', async () => {
    const { client } = makeClient([JSON.stringify({ actions: [], done: true, summary: 'ok' })]);
    const onUsage = vi.fn();
    await runAiTask(mocked.__page, '计量', client, false, { maxTurns: 3, onUsage });
    expect(onUsage).toHaveBeenCalledTimes(1);
  });
});