import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'playwright-core';

// playwright-core stub: runAiTask takes a screenshot + reads the element list each turn; the page itself takes no part in assertions,
// which all live on "the message sequence sent to the LLM".
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
    // evaluate for dumpElements: returns the element list
    evaluate: vi.fn().mockResolvedValue([{ selector: '#user', tag: 'input', placeholder: '账号' }]),
    context: vi.fn(() => ({ pages: () => [] })),
  };
  return { chromium: { launch: vi.fn() }, __page: page };
});

import { runAiTask } from '../src/execute/aiTask.js';
import type { LLMClient, LLMMessage, LLMResult } from '../src/agent/llm-client.js';

const mocked = await import('playwright-core') as unknown as { __page: Page };

/** Record the messages of each complete call and return the scripted LLM response. */
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

/** Take all user text blocks from one request (handy for asserting "whether history accumulates"). */
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
    // Turn 1: click the input; turn 2: fill the value and finish
    const { client, calls } = makeClient([
      JSON.stringify({ actions: [{ type: 'click', selector: '#user' }], done: false }),
      JSON.stringify({ actions: [{ type: 'fill', selector: '#user', value: 'alice' }], done: true, summary: '填好了' }),
    ]);
    await runAiTask(mocked.__page, '登录', client, false, { maxTurns: 4 });

    expect(calls).toHaveLength(2);
    // Turn 1: only itself
    expect(calls[0]!.map((m) => m.role)).toEqual(['user']);
    // Turn 2: user1 + assistant1 + user2 -- this is the key to cache hits
    expect(calls[1]!.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    // Turn 1's content is still in turn 2's request (the old implementation dropped it entirely)
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
    // The original JSON output is replayed verbatim (not an action summary, which would drift the prefix and hurt the hit rate)
    expect(assistantMsg.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify({ actions: [], done: false, summary: '观察中' }),
    });
  });

  it('每轮历史严格只增不减：前缀逐轮延长（第 k 轮请求的前 k-1 条与前一轮逐字相同）', async () => {
    // The cache matches by prefix; this is a direct assertion that "the prefix is truly stable"
    const { client, calls } = makeClient([
      JSON.stringify({ actions: [{ type: 'click', selector: '#a' }], done: false }),
      JSON.stringify({ actions: [{ type: 'click', selector: '#b' }], done: false }),
      JSON.stringify({ actions: [], done: true, summary: 'ok' }),
    ]);
    await runAiTask(mocked.__page, '多点几次', client, false, { maxTurns: 5 });

    expect(calls).toHaveLength(3);
    // The first 4 entries of turn 3's request == all 4 entries of turn 2's request
    const prev = calls[1]!;
    const cur = calls[2]!;
    expect(cur.length).toBe(prev.length + 2); // +assistant +new user
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
    // Turn 2 still keeps turn 1's screenshot block -- under the old implementation screenshots were dropped each turn and couldn't be reused
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

  it('maxTurns 用尽仍逐轮累积（第 3 轮请求带满前 2 轮历史；兜底判定是独立单轮调用不进 agent 历史）', async () => {
    const { client, calls } = makeClient([JSON.stringify({ actions: [], done: false })]);
    await expect(runAiTask(mocked.__page, '做不完', client, false, { maxTurns: 3 })).rejects.toThrow(/超过 3 轮/);
    // 3 agent-loop turns + 1 turns-exhausted fallback judgment (goes through the systemPrompt+userMessage channel, without loop history)
    expect(calls).toHaveLength(4);
    // 3 turns = user1,a1,user2,a2,user3
    expect(calls[2]!.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    // The fallback judgment carries no messages (the zero-action completion judgment is an independent out-of-loop vision call and doesn't affect the cache prefix)
    expect(calls[3]).toEqual([]);
  });

  it('onUsage 仍每轮回调一次（aiUsage 统计口径不变）', async () => {
    const { client } = makeClient([JSON.stringify({ actions: [], done: true, summary: 'ok' })]);
    const onUsage = vi.fn();
    await runAiTask(mocked.__page, '计量', client, false, { maxTurns: 3, onUsage });
    expect(onUsage).toHaveBeenCalledTimes(1);
  });
});