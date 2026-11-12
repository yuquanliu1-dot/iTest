import { type AiLang } from './langDirective.js';

export type LLMProvider = 'openai' | 'anthropic' | 'google';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  /** Custom gateway address (e.g. internal proxy); leave empty to use each SDK's official default. */
  baseUrl?: string;
  /** Max output tokens per reply (settings key llm_max_tokens); when omitted, each client uses its own default. */
  maxTokens?: number;
}

/** A conversation message (multi-turn accumulated form). The image in content is a screenshot block. */
export interface LLMMessage {
  role: 'user' | 'assistant';
  content: Array<{ type: 'text'; text: string } | { type: 'image'; base64: string; mime: 'image/png' | 'image/jpeg' }>;
}

export interface LLMRequest {
  systemPrompt: string;
  userMessage: string;
  /** Multimodal input: currently only a single image; may extend to image[] later */
  image?: { base64: string; mime: 'image/png' | 'image/jpeg' };
  /** Multi-turn accumulated history (optional). When given, replaces the single-turn userMessage/image.
   *  When omitted, degrades to the original single-turn form with unchanged behavior. */
  messages?: LLMMessage[];
  /** UI language. When present, the language directive block is auto-appended to the end of systemPrompt; not appended when omitted (compatible with old callers). */
  lang?: AiLang;
}

export type LLMCompleteResult =
  | { kind: 'json'; value: Record<string, unknown> }
  | { kind: 'text'; value: string };

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens that hit the cache this call (not included in promptTokens). */
  cacheReadTokens?: number;
  /** Tokens newly written this call to establish the cache. */
  cacheCreationTokens?: number;
}

export type LLMResult =
  | { kind: 'json'; value: Record<string, unknown>; provider: LLMProvider; vision: boolean; usage?: LLMUsage; durationMs?: number; model?: string }
  | { kind: 'text'; value: string; provider: LLMProvider; vision: boolean; usage?: LLMUsage; durationMs?: number; model?: string };

export interface LLMClient {
  provider: LLMProvider;
  complete(req: LLMRequest): Promise<LLMResult>;
}

export function listProviders(): LLMProvider[] {
  return ['openai', 'anthropic', 'google'];
}

/** Parse model output as JSON: direct parse first, then strip the ```json fence, falling back to extracting the first {...} segment. */
export function tryParseJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  try { return JSON.parse(trimmed) as Record<string, unknown>; } catch { /* fall through */ }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1]!.trim()) as Record<string, unknown>; } catch { /* fall through */ }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)) as Record<string, unknown>; } catch { /* fall through */ }
  }
  return null;
}

import { OpenAIClient } from './llm-openai.js';
import { AnthropicClient } from './llm-anthropic.js';
import { GoogleClient } from './llm-google.js';

export function getLlmClient(config: LLMConfig): LLMClient {
  switch (config.provider) {
    case 'openai': return new OpenAIClient(config);
    case 'anthropic': return new AnthropicClient(config);
    case 'google': return new GoogleClient(config);
  }
}

/** Aggregate usage → LLMUsage. Cache tokens are always exposed (0 when no hit); callers compute hit rate from this. */
function usageOf(agg: { promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): LLMUsage {
  return {
    promptTokens: agg.promptTokens,
    completionTokens: agg.completionTokens,
    cacheReadTokens: agg.cacheReadTokens,
    cacheCreationTokens: agg.cacheCreationTokens,
  };
}

/** JSON version of complete: on parse failure, feed the error back to the model and retry once (semantic retry); throw if it still fails.
 *  Returns aggregated usage/durationMs (accumulated across both calls) and retries. */
export async function completeJson(
  client: LLMClient,
  req: LLMRequest,
): Promise<{ value: Record<string, unknown>; retries: number; usage?: LLMUsage; durationMs?: number; model?: string }> {
  // Cache tokens must also be aggregated: both calls in a semantic retry may hit the cache; dropping them makes the hit rate invisible in the report.
  const agg = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, hasUsage: false };
  let durationMs = 0;
  let retries = 0;
  const t0 = Date.now();
  const first = await client.complete(req);
  durationMs += first.durationMs ?? Date.now() - t0;
  if (first.usage) { agg.promptTokens += first.usage.promptTokens; agg.completionTokens += first.usage.completionTokens; agg.cacheReadTokens += first.usage.cacheReadTokens ?? 0; agg.cacheCreationTokens += first.usage.cacheCreationTokens ?? 0; agg.hasUsage = true; }
  if (first.kind === 'json') {
    return { value: first.value, retries: 0, ...(agg.hasUsage ? { usage: usageOf(agg) } : {}), ...(durationMs > 0 ? { durationMs } : {}), ...(first.model ? { model: first.model } : {}) };
  }
  // Semantic retry: feed the previous invalid output and error back
  retries = 1;
  const t1 = Date.now();
  const hint = `\n\n上次响应不是合法 JSON（响应开头：「${first.value.slice(0, 120)}」）。请重新输出，只输出 JSON，不要任何其他文字。`;
  // In multi-turn form, changing userMessage alone won't work — clients read messages first, so the change takes no effect.
  // Append a new user message carrying the retry hint (history stays unchanged, prefix stays cacheable).
  const retryReq: LLMRequest = req.messages
    ? { ...req, messages: [...req.messages, { role: 'user', content: [{ type: 'text', text: hint.trim() }] }] }
    : { ...req, userMessage: `${req.userMessage}${hint}` };
  const second = await client.complete(retryReq);
  durationMs += second.durationMs ?? Date.now() - t1;
  if (second.usage) { agg.promptTokens += second.usage.promptTokens; agg.completionTokens += second.usage.completionTokens; agg.cacheReadTokens += second.usage.cacheReadTokens ?? 0; agg.cacheCreationTokens += second.usage.cacheCreationTokens ?? 0; agg.hasUsage = true; }
  if (second.kind !== 'json') {
    throw new Error(`LLM 响应不是合法 JSON（重试 1 次后仍失败）：${second.value.slice(0, 200)}`);
  }
  return { value: second.value, retries, ...(agg.hasUsage ? { usage: usageOf(agg) } : {}), ...(durationMs > 0 ? { durationMs } : {}), ...(second.model ? { model: second.model } : {}) };
}
