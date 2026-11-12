import { GoogleGenerativeAI } from '@google/generative-ai';
import type { LLMClient, LLMCompleteResult, LLMConfig, LLMRequest, LLMResult } from './llm-client.js';
import { tryParseJson } from './llm-client.js';
import { langDirective } from './langDirective.js';

export class GoogleClient implements LLMClient {
  provider = 'google' as const;
  private client: GoogleGenerativeAI;
  constructor(private cfg: LLMConfig) {
    this.client = new GoogleGenerativeAI(cfg.apiKey);
  }
  async complete(req: LLMRequest): Promise<LLMResult> {
    const model = this.cfg.model || 'gemini-2.0-flash';
    const systemPrompt = req.lang ? `${req.systemPrompt}\n${langDirective(req.lang)}` : req.systemPrompt;
    const m = this.client.getGenerativeModel({
      model,
      systemInstruction: systemPrompt || 'You are a helpful assistant. Reply with JSON only.',
      // Don't pass the parameter when unconfigured (use the provider default, consistent with existing behavior)
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2, ...(this.cfg.maxTokens ? { maxOutputTokens: this.cfg.maxTokens } : {}) },
    });
    // Multi-turn accumulation: when req.messages exists, replay alternating user/assistant turns; otherwise degrade to single-turn.
    // Empty arrays are treated as single-turn: startChat's history must start with user, and the last turn needs a separate sendMessage;
    // an empty history would make turns[-1] undefined.
    const src = req.messages && req.messages.length > 0 ? req.messages : [{
      role: 'user' as const,
      content: [
        ...(req.image ? [{ type: 'image' as const, base64: req.image.base64, mime: req.image.mime }] : []),
        { type: 'text' as const, text: req.userMessage },
      ],
    }];
    const turns = src.map((msg) => ({
      role: msg.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: msg.content.map((b) => (b.type === 'image'
        ? { inlineData: { mimeType: b.mime, data: b.base64 } }
        : { text: b.text })),
    }));
    const t0 = Date.now();
    // startChat needs history (excluding the current turn) + current-turn parts; history is empty in single-turn form.
    const chat = m.startChat({ history: turns.slice(0, -1).map((t) => ({ ...t, parts: t.parts as never })) });
    const resp = await chat.sendMessage(turns[turns.length - 1]!.parts as never);
    const durationMs = Date.now() - t0;
    const text = resp.response.text();
    const json = tryParseJson(text);
    const base: LLMCompleteResult = json ? { kind: 'json', value: json } : { kind: 'text', value: text };
    const meta = resp.response.usageMetadata;
    // Gemini semantics: promptTokenCount includes cachedContentTokenCount (the latter is a subset of it). The platform's unified convention is
    // "promptTokens = newly computed this call, cacheReadTokens = cache hits" (see the LLMUsage comment,
    // consistent with Anthropic's native convention), so subtract the cached part here, otherwise the hit rate would be double-counted.
    const cached = meta?.cachedContentTokenCount ?? 0;
    const usage = meta ? { promptTokens: Math.max(0, (meta.promptTokenCount ?? 0) - cached), completionTokens: meta.candidatesTokenCount ?? 0, cacheReadTokens: cached } : undefined;
    return { ...base, provider: 'google', vision: turns.some((x) => x.parts.some((p) => 'inlineData' in p)), ...(usage ? { usage } : {}), durationMs, model };
  }
}
