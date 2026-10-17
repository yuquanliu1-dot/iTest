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
    // 多轮累积：req.messages 存在时按历史回传，否则退化为单轮形态。
    // 两种形态等价（单轮只是长度为 1 的历史），不会丢上下文。
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
    const usage = resp.usage ? { promptTokens: resp.usage.prompt_tokens ?? 0, completionTokens: resp.usage.completion_tokens ?? 0 } : undefined;
    const hasImage = history.some((m) => m.content.some((b) => b.type === 'image_url'));
    return { ...base, provider: 'openai', vision: hasImage, ...(usage ? { usage } : {}), durationMs, model };
  }
}
