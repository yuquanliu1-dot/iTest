import { describe, it, expect } from 'vitest';
import { getLlmClient, listProviders, completeJson } from '../src/agent/llm-client.js';
import type { LLMClient, LLMRequest, LLMResult } from '../src/agent/llm-client.js';

describe('llm-client', () => {
  it('listProviders returns three providers', () => {
    expect(listProviders()).toEqual(['openai', 'anthropic', 'google']);
  });

  it('getLlmClient returns a client per provider', () => {
    for (const provider of listProviders()) {
      const c = getLlmClient({ provider, apiKey: 'sk-test', model: '' });
      expect(c.provider).toBe(provider);
    }
  });
});

/** 按序回放预置响应的 fake client。 */
function fakeClient(responses: Array<Partial<LLMResult>>): LLMClient & { requests: LLMRequest[] } {
  let i = 0;
  const requests: LLMRequest[] = [];
  return {
    provider: 'openai',
    async complete(req) {
      requests.push(req);
      const preset = responses[Math.min(i, responses.length - 1)]!;
      i++;
      const base: LLMResult = (preset.kind === 'text'
        ? { kind: 'text', value: preset.value as string }
        : { kind: 'json', value: preset.value as Record<string, unknown> }) as LLMResult;
      return { ...base, provider: 'openai', vision: false, usage: preset.usage, durationMs: 100, model: 'test-model' };
    },
    requests,
  };
}

describe('completeJson 语义重试', () => {
  const req: LLMRequest = { systemPrompt: 'sys', userMessage: 'say json' };

  it('首次即合法 JSON → retries=0，usage/durationMs/model 透出', async () => {
    const c = fakeClient([{ kind: 'json', value: { ok: true }, usage: { promptTokens: 10, completionTokens: 5 } }]);
    const r = await completeJson(c, req);
    expect(r.value).toEqual({ ok: true });
    expect(r.retries).toBe(0);
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(r.durationMs).toBe(100);
    expect(r.model).toBe('test-model');
    expect(c.requests).toHaveLength(1);
  });

  it('首次非法、重试合法 → retries=1，错误回喂进 userMessage，usage 累加两次', async () => {
    const c = fakeClient([
      { kind: 'text', value: 'not json at all', usage: { promptTokens: 10, completionTokens: 5 } },
      { kind: 'json', value: { ok: 2 }, usage: { promptTokens: 20, completionTokens: 8 } },
    ]);
    const r = await completeJson(c, req);
    expect(r.value).toEqual({ ok: 2 });
    expect(r.retries).toBe(1);
    expect(r.usage).toEqual({ promptTokens: 30, completionTokens: 13 });
    expect(r.durationMs).toBe(200);
    // 重试请求携带上次错误反馈
    expect(c.requests[1]!.userMessage).toContain('不是合法 JSON');
    expect(c.requests[1]!.userMessage).toContain('not json at all');
  });

  it('两次都非法 → 抛错', async () => {
    const c = fakeClient([{ kind: 'text', value: 'still not json' }]);
    await expect(completeJson(c, req)).rejects.toThrow(/不是合法 JSON/);
    expect(c.requests).toHaveLength(2);
  });

  it('多轮形态的语义重试：提示追加为新 user 消息，而不是被 messages 忽略', async () => {
    // 回归动机：clients 优先读 req.messages，早期实现只改 userMessage 会让重试提示
    // 在多轮形态下静默丢失 —— 模型收到完全相同的请求，重复返回同样的非法 JSON。
    const multiReq: LLMRequest = {
      systemPrompt: 'sys',
      userMessage: '当轮',
      messages: [{ role: 'user', content: [{ type: 'text', text: '第1轮' }] }],
    };
    const c = fakeClient([
      { kind: 'text', value: 'not json at all' },
      { kind: 'json', value: { ok: 3 } },
    ]);
    const r = await completeJson(c, multiReq);
    expect(r.value).toEqual({ ok: 3 });
    expect(r.retries).toBe(1);
    const retry = c.requests[1]!;
    // 历史保留 + 追加承载提示的新消息
    expect(retry.messages).toHaveLength(2);
    expect(retry.messages![0]!.content[0]).toEqual({ type: 'text', text: '第1轮' });
    const hintText = retry.messages![1]!.content[0]!;
    expect(hintText.type).toBe('text');
    expect((hintText as { text: string }).text).toContain('不是合法 JSON');
    expect((hintText as { text: string }).text).toContain('not json at all');
  });
});
