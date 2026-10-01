import OpenAI from 'openai';
import type { LLMClient, LLMCompleteResult, LLMConfig, LLMRequest, LLMResult } from './llm-client.js';
import { tryParseJson } from './llm-client.js';

export class OpenAIClient implements LLMClient {
  provider = 'openai' as const;
  private client: OpenAI;
  constructor(private cfg: LLMConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  }
  async complete(req: LLMRequest): Promise<LLMResult> {
    const model = this.cfg.model || 'gpt-4o-mini';
    const userContent: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      { type: 'text', text: req.userMessage },
    ];
    if (req.image) {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:${req.image.mime};base64,${req.image.base64}` },
      });
    }
    const resp = await this.client.chat.completions.create({
      model,
      messages: [
        ...(req.systemPrompt ? [{ role: 'system' as const, content: req.systemPrompt }] : []),
        { role: 'user' as const, content: userContent },
      ],
      response_format: { type: 'json_object' as const },
      temperature: 0.2,
    });
    const text = resp.choices[0]?.message?.content ?? '';
    const json = tryParseJson(text);
    const base: LLMCompleteResult = json ? { kind: 'json', value: json } : { kind: 'text', value: text };
    return { ...base, provider: 'openai', vision: !!req.image };
  }
}
