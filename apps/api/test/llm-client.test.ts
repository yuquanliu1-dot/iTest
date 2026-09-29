import { describe, it, expect } from 'vitest';
import { getLlmClient, listProviders } from '../src/agent/llm-client.js';

describe('llm-client', () => {
  it('listProviders returns four providers', () => {
    expect(listProviders()).toEqual(['mock', 'openai', 'anthropic', 'google']);
  });

  it('getLlmClient with provider=mock returns a client', () => {
    const c = getLlmClient({ provider: 'mock', apiKey: '', model: '' });
    expect(c.provider).toBe('mock');
  });

  it('mock client returns structured JSON for requirement scenarios', async () => {
    const c = getLlmClient({ provider: 'mock', apiKey: '', model: '' });
    const out = await c.complete({ systemPrompt: '', userMessage: 'requirement: 用户登录功能' });
    expect(out.kind).toBe('json');
    if (out.kind === 'json') {
      expect(Array.isArray(out.value.cases)).toBe(true);
    }
  });
});
