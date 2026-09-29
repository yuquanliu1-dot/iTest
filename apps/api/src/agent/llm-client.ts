export type LLMProvider = 'mock' | 'openai' | 'anthropic' | 'google';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
}

export type LLMCompleteResult =
  | { kind: 'json'; value: Record<string, unknown> }
  | { kind: 'text'; value: string };

export interface LLMClient {
  provider: LLMProvider;
  complete(req: { systemPrompt: string; userMessage: string }): Promise<LLMCompleteResult>;
}

export function listProviders(): LLMProvider[] {
  return ['mock', 'openai', 'anthropic', 'google'];
}

class MockClient implements LLMClient {
  provider = 'mock' as const;

  async complete({ userMessage }: { systemPrompt: string; userMessage: string }): Promise<LLMCompleteResult> {
    if (userMessage.includes('requirement') || userMessage.includes('需求')) {
      return {
        kind: 'json',
        value: {
          cases: [
            {
              title: 'mock 生成的用例',
              description: 'mock provider 自动产出',
              priority: 'P1',
              steps: [
                { order: 1, action: { kind: 'navigate', url: 'https://example.com' } },
                {
                  order: 2,
                  action: { kind: 'click', locator: [{ strategy: 'role', value: 'button[name="登录"]' }] },
                },
              ],
            },
          ],
        },
      };
    }
    if (userMessage.includes('case') || userMessage.includes('用例')) {
      return {
        kind: 'json',
        value: {
          steps: [
            { order: 99, action: { kind: 'assertVisible', locator: [{ strategy: 'role', value: 'main' }] } },
          ],
        },
      };
    }
    return { kind: 'text', value: '[mock] no specific response for this input' };
  }
}

export function getLlmClient(config: LLMConfig): LLMClient {
  if (config.provider === 'mock') return new MockClient();
  throw new Error(`LLM provider ${config.provider} not implemented in MVP. Use 'mock'.`);
}
