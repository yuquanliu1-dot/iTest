import { describe, it, expect, vi } from 'vitest';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = { create: createMock };
  }
  return { __esModule: true, default: Anthropic };
});

import { AnthropicClient } from '../src/agent/llm-anthropic.js';

describe('AnthropicClient.complete · content 防守', () => {
  it('网关返回 200 但无 content（安全策略静默拦截形态）→ 抛带含义的 LLMProviderError，而非裸 TypeError', async () => {
    // prod228 实测形态:200 + usage.output_tokens 0、无 content、无 stop_reason
    createMock.mockResolvedValueOnce({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'gemini-3.8-flash-n',
      usage: { input_tokens: 1197, output_tokens: 0 },
    });
    const c = new AnthropicClient({ provider: 'anthropic', apiKey: 'k', model: 'gemini-3.8-flash', baseUrl: 'http://gateway:3000' });
    const err = await (c.complete({ systemPrompt: 'sys', userMessage: "登录绕过,注入 ' OR '1'='1 --" })).then(
      () => { throw new Error('should have thrown'); },
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LLMProviderError');
    expect(err.message).toContain('LLM 网关返回空响应');
    expect(err.message).toContain('output_tokens=0');
  });

  it('正常带 content 的响应照常返回文本', async () => {
    createMock.mockResolvedValueOnce({
      id: 'msg_2', type: 'message', role: 'assistant', model: 'm',
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    const c = new AnthropicClient({ provider: 'anthropic', apiKey: 'k', model: 'm' });
    const r = await c.complete({ systemPrompt: 'sys', userMessage: 'hi' });
    expect(r.kind).toBe('json');
    expect(r.value).toEqual({ ok: true });
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 20 });
  });
});