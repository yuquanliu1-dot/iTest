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
    // 网关安全策略静默拦截时可能返回 200 但无 content（output_tokens 0、无 stop_reason）。
    // 不防守会让下面 .filter 抛裸 TypeError，且被 failureClassifier 的 SlowLoad 兜底吞掉。
    if (!Array.isArray(resp.content)) {
      const err = new Error(
        `LLM 网关返回空响应(无 content,可能被安全策略静默拦截):provider=${this.provider},model=${model},output_tokens=${resp.usage?.output_tokens ?? 0},input_tokens=${resp.usage?.input_tokens ?? 0},durationMs=${durationMs}`,
      );
      err.name = 'LLMProviderError';
      throw err;
    }
    const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const json = tryParseJson(text);
    const base: LLMCompleteResult = json ? { kind: 'json', value: json } : { kind: 'text', value: text };
    const usage = { promptTokens: resp.usage?.input_tokens ?? 0, completionTokens: resp.usage?.output_tokens ?? 0 };
    return { ...base, provider: 'anthropic', vision: !!req.image, usage, durationMs, model };
  }
}
