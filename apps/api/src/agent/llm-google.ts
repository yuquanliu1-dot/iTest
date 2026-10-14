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
    // 多轮累积：req.messages 存在时按 user/assistant 交替回传，否则退化为单轮。
    // 空数组按单轮处理：startChat 的 history 必须以 user 开头，且末轮要单独 sendMessage，
    // 空历史会导致 turns[-1] 为 undefined。
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
    // startChat 需要历史（不含当前轮）+ 当前轮 parts；单轮形态时 history 为空。
    const chat = m.startChat({ history: turns.slice(0, -1).map((t) => ({ ...t, parts: t.parts as never })) });
    const resp = await chat.sendMessage(turns[turns.length - 1]!.parts as never);
    const durationMs = Date.now() - t0;
    const text = resp.response.text();
    const json = tryParseJson(text);
    const base: LLMCompleteResult = json ? { kind: 'json', value: json } : { kind: 'text', value: text };
    const meta = resp.response.usageMetadata;
    const usage = meta ? { promptTokens: meta.promptTokenCount ?? 0, completionTokens: meta.candidatesTokenCount ?? 0 } : undefined;
    return { ...base, provider: 'google', vision: turns.some((x) => x.parts.some((p) => 'inlineData' in p)), ...(usage ? { usage } : {}), durationMs, model };
  }
}
