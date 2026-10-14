import { describe, it, expect, vi, beforeEach } from 'vitest';

// 两个非 Anthropic provider 的多轮形态回归：它们此前只支持单轮，
// 加了 req.messages 后必须原样回传历史，且缺省/空历史时不崩。
const { openaiCreate, chatStart, chatSend } = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  chatStart: vi.fn(),
  chatSend: vi.fn(),
}));

vi.mock('openai', () => {
  class OpenAI {
    chat = { completions: { create: openaiCreate } };
  }
  return { __esModule: true, default: OpenAI };
});

vi.mock('@google/generative-ai', () => {
  // 真实 SDK 的 startChat 返回一个 ChatSession（带 sendMessage）；桩必须返回它，
  // 否则 complete 里的 chat.sendMessage 会拿到 undefined。
  class GoogleGenerativeAI {
    getGenerativeModel = () => ({
      startChat: (opts: unknown) => {
        chatStart(opts);
        return { sendMessage: chatSend };
      },
    });
  }
  return { GoogleGenerativeAI };
});

import { OpenAIClient } from '../src/agent/llm-openai.js';
import { GoogleClient } from '../src/agent/llm-google.js';
import type { LLMMessage } from '../src/agent/llm-client.js';

const HISTORY: LLMMessage[] = [
  { role: 'user', content: [{ type: 'text', text: '第1轮' }] },
  { role: 'assistant', content: [{ type: 'text', text: '{"actions":[]}' }] },
  { role: 'user', content: [{ type: 'image', base64: 'AAA', mime: 'image/png' }, { type: 'text', text: '第2轮' }] },
];

// 每个用例都断言「本次调用」的入参，桩的调用历史必须隔离
beforeEach(() => {
  vi.clearAllMocks();
});

describe('OpenAIClient 多轮累积', () => {
  it('req.messages 原样回传（assistant 轮不被丢）', async () => {
    openaiCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"ok":1}' } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    const c = new OpenAIClient({ provider: 'openai', apiKey: 'k', model: 'gpt-4o-mini' });
    const r = await c.complete({ systemPrompt: 'sys', userMessage: '当轮', messages: HISTORY });
    const body = openaiCreate.mock.calls[0]![0] as { messages: Array<{ role: string; content: Array<{ type: string }> }> };
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    // 图片转 data URL
    expect(body.messages[3]!.content[0]!.type).toBe('image_url');
    expect(body.messages[3]!.content[1]!.type).toBe('text');
    expect(r.vision).toBe(true);
  });

  it('缺省 messages 时退化为单轮（兼容性不回归）', async () => {
    openaiCreate.mockResolvedValueOnce({ choices: [{ message: { content: '{"ok":1}' } }] });
    const c = new OpenAIClient({ provider: 'openai', apiKey: 'k', model: 'gpt-4o-mini' });
    await c.complete({ systemPrompt: 'sys', userMessage: '只有单轮' });
    const body = openaiCreate.mock.calls[0]![0] as { messages: Array<{ role: string }> };
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });
});

describe('GoogleClient 多轮累积', () => {
  it('assistant 映射成 model，历史进 startChat、当轮走 sendMessage', async () => {
    chatSend.mockResolvedValueOnce({
      response: { text: () => '{"ok":1}', usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 } },
    });
    const c = new GoogleClient({ provider: 'google', apiKey: 'k', model: 'gemini-2.0-flash' });
    const r = await c.complete({ systemPrompt: 'sys', userMessage: '当轮', messages: HISTORY });
    const hist = chatStart.mock.calls[0]![0]!.history as Array<{ role: string; parts: Array<{ text?: string; inlineData?: unknown }> }>;
    expect(hist.map((t) => t.role)).toEqual(['user', 'model']);
    // 当前轮（图 + 文）走 sendMessage，不进 history
    const sent = chatSend.mock.calls[0]![0] as Array<{ text?: string; inlineData?: unknown }>;
    expect(sent).toHaveLength(2);
    expect(sent[0]!.inlineData).toEqual({ mimeType: 'image/png', data: 'AAA' });
    expect(r.vision).toBe(true);
  });

  it('空 messages 数组退化为单轮，不因 turns[-1] 崩溃', async () => {
    chatSend.mockResolvedValueOnce({ response: { text: () => '{"ok":1}' } });
    const c = new GoogleClient({ provider: 'google', apiKey: 'k', model: 'gemini-2.0-flash' });
    // startChat 的 history 必须以 user 开头；空数组会触发 SDK 运行时异常
    await expect(c.complete({ systemPrompt: 'sys', userMessage: 'u', messages: [] })).resolves.toBeTruthy();
    expect(chatStart.mock.calls[0]![0]!.history).toEqual([]);
  });
});