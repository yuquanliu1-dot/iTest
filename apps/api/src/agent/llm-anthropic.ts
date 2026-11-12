import Anthropic from '@anthropic-ai/sdk';
import type { LLMClient, LLMCompleteResult, LLMConfig, LLMMessage, LLMRequest, LLMResult } from './llm-client.js';
import { tryParseJson } from './llm-client.js';
import { langDirective } from './langDirective.js';

/** Rolling cache breakpoints: one on system and one on the last message. Caching matches by prefix; with breakpoints only
 *  on system, the multi-turn accumulated prefix misses entirely from turn 2 onward (2026-10-14 gateway-measured 2%);
 *  after placing one on the last message, hit rate is 86~94%. Prefixes under 1024 tokens are ignored without error. */
const EPHEMERAL = { type: 'ephemeral' } as const;

function buildMessages(req: LLMRequest): Anthropic.MessageParam[] {
  const msgs: LLMMessage[] = req.messages ?? [
    {
      role: 'user',
      content: [
        ...(req.image ? [{ type: 'image' as const, base64: req.image.base64, mime: req.image.mime }] : []),
        { type: 'text' as const, text: req.userMessage },
      ],
    },
  ];
  const last = msgs.length - 1;
  return msgs.map((m, i) => ({
    role: m.role,
    content: m.content.map((b, bi) => {
      // Rolling breakpoint: placed on the last block of the last message (the breakpoint on system
      // only covers system, not the per-turn growing history).
      const cc = i === last && bi === m.content.length - 1 ? { cache_control: EPHEMERAL } : {};
      return b.type === 'image'
        ? { type: 'image' as const, source: { type: 'base64' as const, media_type: b.mime, data: b.base64 }, ...cc }
        : { type: 'text' as const, text: b.text, ...cc };
    }),
  }));
}

export class AnthropicClient implements LLMClient {
  provider = 'anthropic' as const;
  private client: Anthropic;
  constructor(private cfg: LLMConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  }
  async complete(req: LLMRequest): Promise<LLMResult> {
    const model = this.cfg.model || 'claude-sonnet-4-6';
    const systemPrompt = req.lang ? `${req.systemPrompt}\n${langDirective(req.lang)}` : req.systemPrompt;
    const t0 = Date.now();
    const resp = await this.client.messages.create({
      model,
      // Required by the Anthropic API, and thinking content also counts against this budget: when the gateway alias routes to a thinking model,
      // 4096 gets consumed entirely by thinking → empty text, JSON parsing always fails (2026-11-01 prod-measured).
      // llm_max_tokens on the settings page can raise it (e.g. 16384); default stays 4096.
      max_tokens: this.cfg.maxTokens ?? 4096,
      system: [{ type: 'text', text: systemPrompt || 'You are a helpful assistant. Reply with JSON only.', cache_control: EPHEMERAL }],
      messages: buildMessages(req),
    });
    const durationMs = Date.now() - t0;
    // The gateway security policy may silently intercept and return 200 with no content (output_tokens 0, no stop_reason).
    // Without guarding, the .filter below throws a bare TypeError, and it gets swallowed by failureClassifier's SlowLoad fallback.
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
    // promptTokens only contains tokens newly computed this call; the cache-hit part is listed separately in cacheReadTokens,
    // and the two added together are the real billed amount (the report uses this to show cache hits, avoiding "fewer tokens" being misread as prompt savings).
    const usage = {
      promptTokens: resp.usage?.input_tokens ?? 0,
      completionTokens: resp.usage?.output_tokens ?? 0,
      cacheReadTokens: resp.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: resp.usage?.cache_creation_input_tokens ?? 0,
    };
    const hasImage = req.image ? true : (req.messages?.some((m) => m.content.some((b) => b.type === 'image')) ?? false);
    return { ...base, provider: 'anthropic', vision: hasImage, usage, durationMs, model };
  }
}
