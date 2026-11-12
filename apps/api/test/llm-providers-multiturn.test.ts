import { describe, it, expect, vi, beforeEach } from 'vitest';

// Multi-turn regression for the two non-Anthropic providers: they previously only supported single-turn;
// after req.messages was added they must pass the history through verbatim, and not crash on missing/empty history.
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
  // The real SDK's startChat returns a ChatSession (with sendMessage); the stub must return it,
  // otherwise chat.sendMessage inside complete gets undefined.
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

// Each case asserts the args of "this call", so the stubs' call history must be isolated
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
    // Image becomes a data URL
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
    // The current turn (image + text) goes through sendMessage, not into history
    const sent = chatSend.mock.calls[0]![0] as Array<{ text?: string; inlineData?: unknown }>;
    expect(sent).toHaveLength(2);
    expect(sent[0]!.inlineData).toEqual({ mimeType: 'image/png', data: 'AAA' });
    expect(r.vision).toBe(true);
  });

  it('空 messages 数组退化为单轮，不因 turns[-1] 崩溃', async () => {
    chatSend.mockResolvedValueOnce({ response: { text: () => '{"ok":1}' } });
    const c = new GoogleClient({ provider: 'google', apiKey: 'k', model: 'gemini-2.0-flash' });
    // startChat's history must start with a user turn; an empty array triggers an SDK runtime exception
    await expect(c.complete({ systemPrompt: 'sys', userMessage: 'u', messages: [] })).resolves.toBeTruthy();
    expect(chatStart.mock.calls[0]![0]!.history).toEqual([]);
  });
});