import OpenAI from 'openai';
import type { LLMClient, LLMCompleteResult, LLMConfig, LLMMessage, LLMRequest, LLMResult } from './llm-client.js';
import { tryParseJson } from './llm-client.js';
import { langDirective } from './langDirective.js';

export class OpenAIClient implements LLMClient {
  provider = 'openai' as const;
  private client: OpenAI;
  constructor(private cfg: LLMConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  }
  async complete(req: LLMRequest): Promise<LLMResult> {
    const model = this.cfg.model || 'gpt-4o-mini';
    // Multi-turn accumulation: when req.messages exists, replay the history; otherwise degrade to the single-turn form.
    // The two forms are equivalent (single turn is just a history of length 1), no context is lost.
    type Block =
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } };
    const src: LLMMessage[] = req.messages ?? [{
      role: 'user',
      content: [
        ...(req.image ? [{ type: 'image' as const, base64: req.image.base64, mime: req.image.mime }] : []),
        { type: 'text' as const, text: req.userMessage },
      ],
    }];
    const history: Array<{ role: 'user' | 'assistant'; content: Block[] }> = src.map((m) => ({
      role: m.role,
      content: m.content.map((b): Block => (b.type === 'image'
        ? { type: 'image_url', image_url: { url: `data:${b.mime};base64,${b.base64}` } }
        : { type: 'text', text: b.text })),
    }));
    const t0 = Date.now();
    const systemPrompt = req.lang ? `${req.systemPrompt}\n${langDirective(req.lang)}` : req.systemPrompt;
    const resp = await this.client.chat.completions.create({
      model,
      // Don't pass the parameter when unconfigured (use the provider default, consistent with existing behavior)
      ...(this.cfg.maxTokens ? { max_tokens: this.cfg.maxTokens } : {}),
      messages: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        ...(history as OpenAI.Chat.ChatCompletionMessageParam[]),
      ],
      response_format: { type: 'json_object' as const },
      temperature: 0.2,
    });
    const durationMs = Date.now() - t0;
    const text = resp.choices[0]?.message?.content ?? '';
    const json = tryParseJson(text);
    const base: LLMCompleteResult = json ? { kind: 'json', value: json } : { kind: 'text', value: text };
    // OpenAI semantics: prompt_tokens includes cached_tokens (the latter is a subset of it). The platform's unified convention is
    // "promptTokens = newly computed this call, cacheReadTokens = cache hits" (see the LLMUsage comment,
    // consistent with Anthropic's native convention), so subtract cached_tokens here, otherwise the hit rate would be double-counted.
    const cached = resp.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const usage = resp.usage ? { promptTokens: Math.max(0, (resp.usage.prompt_tokens ?? 0) - cached), completionTokens: resp.usage.completion_tokens ?? 0, cacheReadTokens: cached } : undefined;
    const hasImage = history.some((m) => m.content.some((b) => b.type === 'image_url'));
    return { ...base, provider: 'openai', vision: hasImage, ...(usage ? { usage } : {}), durationMs, model };
  }
}
