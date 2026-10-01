import type { LLMClient, LLMCompleteResult, LLMRequest, LLMResult } from './llm-client.js';

export class MockClient implements LLMClient {
  provider = 'mock' as const;
  async complete(req: LLMRequest): Promise<LLMResult> {
    return { ...this.build(req.userMessage), provider: 'mock', vision: !!req.image };
  }
  private build(userMessage: string): LLMCompleteResult {
    if (userMessage.includes('vision-input')) {
      return { kind: 'text', value: '[mock-vision] ABC123' };
    }
    if (userMessage.includes('ai-step')) {
      return {
        kind: 'json',
        value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] },
      };
    }
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
                { order: 2, action: { kind: 'click', locator: [{ strategy: 'role', value: 'button[name="登录"]' }] } },
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
