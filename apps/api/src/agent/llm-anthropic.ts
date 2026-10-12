import Anthropic from '@anthropic-ai/sdk';
import type { LLMClient, LLMCompleteResult, LLMConfig, LLMRequest, LLMResult } from './llm-client.js';
import { tryParseJson } from './llm-client.js';

export class AnthropicClient implements LLMClient {
  provider = 'anthropic' as const;
  private client: Anthropic;
  constructor(private cfg: LLMConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  }
  async complete(req: LLMRequest): Promise<LLMResult> {
    const model = this.cfg.model || 'claude-sonnet-4-6';
    const userContent: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg'; data: string } }
    > = [{ type: 'text', text: req.userMessage }];
    if (req.image) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: req.image.mime, data: req.image.base64 },
      });
    }
    const t0 = Date.now();
    const resp = await this.client.messages.create({
      model,
      max_tokens: 4096,
      system: req.systemPrompt || 'You are a helpful assistant. Reply with JSON only.',
      messages: [{ role: 'user', content: userContent }],
    });
    const durationMs = Date.now() - t0;
    const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const json = tryParseJson(text);
    const base: LLMCompleteResult = json ? { kind: 'json', value: json } : { kind: 'text', value: text };
    const usage = { promptTokens: resp.usage?.input_tokens ?? 0, completionTokens: resp.usage?.output_tokens ?? 0 };
    return { ...base, provider: 'anthropic', vision: !!req.image, usage, durationMs, model };
  }
}
