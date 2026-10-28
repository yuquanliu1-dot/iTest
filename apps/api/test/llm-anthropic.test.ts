import { describe, it, expect, vi } from 'vitest';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = { create: createMock };
  }
  return { __esModule: true, default: Anthropic };
});

import { AnthropicClient } from '../src/agent/llm-anthropic.js';
import { newAiUsage } from '../src/execute/aiUsage.js';

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
    expect(r.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});

describe('AnthropicClient.complete · 缓存断点与多轮累积', () => {
  /** 取最后一次 createMock 调用的请求体。 */
  function lastBody(): {
    system: Array<{ type: string; text?: string; cache_control?: unknown }>;
    messages: Array<{ role: string; content: Array<{ type: string; text?: string; cache_control?: unknown }> }>;
  } {
    return createMock.mock.calls.at(-1)![0];
  }

  const okResp = {
    id: 'msg_x', type: 'message', role: 'assistant', model: 'm',
    content: [{ type: 'text', text: '{"done":true}' }],
    usage: { input_tokens: 5, output_tokens: 3 },
  };

  it('system 与最后一条消息的末尾 block 都打 cache_control（滚动断点）', async () => {
    createMock.mockResolvedValueOnce(okResp);
    const c = new AnthropicClient({ provider: 'anthropic', apiKey: 'k', model: 'm' });
    await c.complete({
      systemPrompt: 'sys',
      userMessage: '当轮',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '第1轮' }] },
        { role: 'assistant', content: [{ type: 'text', text: '{"actions":[]}' }] },
        { role: 'user', content: [{ type: 'text', text: '第2轮' }, { type: 'image', base64: 'AAA', mime: 'image/png' }] },
      ],
    });
    const b = lastBody();
    // system 带断点
    expect(b.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    const msgs = b.messages;
    const lastMsg = msgs[msgs.length - 1]!;
    // 末尾 block（图片）带断点：只打在最后一条，才能覆盖逐轮增长的历史
    expect(lastMsg.content.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    // 同一条消息里非末尾的 block 不打（否则一个请求出现多个断点，浪费写入配额）
    expect(lastMsg.content[0]!.cache_control).toBeUndefined();
    // 历史消息一律不打：它们靠"最后一条"的断点被前缀覆盖
    expect(msgs[0]!.content[0]!.cache_control).toBeUndefined();
    expect(msgs[1]!.content[0]!.cache_control).toBeUndefined();
  });

  it('多轮累积：req.messages 原样回传，历史不丢', async () => {
    createMock.mockResolvedValueOnce(okResp);
    const c = new AnthropicClient({ provider: 'anthropic', apiKey: 'k', model: 'm' });
    await c.complete({
      systemPrompt: 'sys',
      userMessage: '当轮',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '第1轮' }] },
        { role: 'assistant', content: [{ type: 'text', text: '{"actions":[]}' }] },
        { role: 'user', content: [{ type: 'text', text: '第2轮' }, { type: 'image', base64: 'AAA', mime: 'image/png' }] },
      ],
    });
    const b = lastBody();
    expect(b.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(b.messages[0]!.content[0]!.text).toBe('第1轮');
    // 图片 block 转成 SDK 的 source 形态，并保住 base64
    const img = b.messages[2]!.content[1] as unknown as { type: string; source: { data: string; media_type: string } };
    expect(img.type).toBe('image');
    expect(img.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'AAA' });
    expect(b.messages[2]!.content[1]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('vision 标记从累积历史里的图片推断，不只看单轮 image 字段', async () => {
    createMock.mockResolvedValueOnce(okResp);
    const c = new AnthropicClient({ provider: 'anthropic', apiKey: 'k', model: 'm' });
    const r = await c.complete({
      systemPrompt: 'sys',
      userMessage: '无图当轮',
      messages: [{ role: 'user', content: [{ type: 'image', base64: 'AAA', mime: 'image/png' }, { type: 'text', text: '看图' }] }],
    });
    expect(r.vision).toBe(true);
  });

  it('透出 cache_read / cache_creation token（报告据此展示命中）', async () => {
    createMock.mockResolvedValueOnce({
      ...okResp,
      usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0 },
    });
    const c = new AnthropicClient({ provider: 'anthropic', apiKey: 'k', model: 'm' });
    const r = await c.complete({ systemPrompt: 'sys', userMessage: 'u' });
    expect(r.usage).toMatchObject({ promptTokens: 12, cacheReadTokens: 6000, cacheCreationTokens: 0 });
  });

  it('端到端：client.usage 的缓存 token 能进到报告用的 aiUsage 累加器', async () => {
    // 链路：AnthropicClient.complete → onUsage(r) → newAiUsage().stat（挂到 stepResult.aiUsage）。
    // 中间任一环丢掉 cacheReadTokens，报告页就看不到命中率。
    createMock.mockResolvedValueOnce({
      ...okResp,
      usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 6000, cache_creation_input_tokens: 250 },
    });
    const c = new AnthropicClient({ provider: 'anthropic', apiKey: 'k', model: 'm' });
    const acc = newAiUsage();
    acc.add(await c.complete({ systemPrompt: 'sys', userMessage: 'u' }));
    expect(acc.stat).toMatchObject({
      calls: 1,
      promptTokens: 12,
      completionTokens: 3,
      cacheReadTokens: 6000,
      cacheCreationTokens: 250,
    });
  });

  it('缺省 messages 时退化为单轮（兼容性不回归）', async () => {
    createMock.mockResolvedValueOnce(okResp);
    const c = new AnthropicClient({ provider: 'anthropic', apiKey: 'k', model: 'm' });
    await c.complete({ systemPrompt: 'sys', userMessage: '只有单轮', image: { base64: 'IMG', mime: 'image/png' } });
    const b = lastBody();
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0]!.role).toBe('user');
    expect(b.messages[0]!.content.map((x) => x.type)).toEqual(['image', 'text']);
  });
});