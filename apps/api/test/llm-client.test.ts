import { describe, it, expect } from 'vitest';
import { getLlmClient, listProviders } from '../src/agent/llm-client.js';

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
