import { GoogleGenerativeAI } from '@google/generative-ai';
import type { LLMClient, LLMCompleteResult, LLMConfig, LLMRequest, LLMResult } from './llm-client.js';
import { tryParseJson } from './llm-client.js';

export class GoogleClient implements LLMClient {
  provider = 'google' as const;
  private client: GoogleGenerativeAI;
  constructor(private cfg: LLMConfig) {
    this.client = new GoogleGenerativeAI(cfg.apiKey);
  }
  async complete(req: LLMRequest): Promise<LLMResult> {
    const model = this.cfg.model || 'gemini-2.0-flash';
    const m = this.client.getGenerativeModel({
      model,
      systemInstruction: req.systemPrompt || 'You are a helpful assistant. Reply with JSON only.',
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    });
    const parts: Array<{ text: string } | { inlineData: { mimeType: 'image/png' | 'image/jpeg'; data: string } }> = [
      { text: req.userMessage },
    ];
    if (req.image) {
      parts.push({ inlineData: { mimeType: req.image.mime, data: req.image.base64 } });
    }
    const resp = await m.generateContent(parts);
    const text = resp.response.text();
    const json = tryParseJson(text);
    const base: LLMCompleteResult = json ? { kind: 'json', value: json } : { kind: 'text', value: text };
    return { ...base, provider: 'google', vision: !!req.image };
  }
}
