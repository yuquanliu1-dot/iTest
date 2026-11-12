import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { CHANNEL_KEYS, parseChannels } from '../agent/llmSettings.js';

export type LlmProvider = 'openai' | 'anthropic' | 'google';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl: string | null;
  /** Max output tokens per reply (channel maxTokens); unconfigured/invalid → undefined, client uses its own default. */
  maxTokens?: number;
}

/** Reads LLM config (only understands the llm_channels multi-channel structure, takes the default channel);
 *  no channels configured or channel missing apiKey/model → null. The pi path carries only chat/distillation
 *  plain-text calls, no vision channel. */
export async function readLlmConfig(): Promise<LlmConfig | null> {
  const all = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [CHANNEL_KEYS.channels, CHANNEL_KEYS.defaultChannel]));
  const map = new Map(all.map((r) => [r.key, r.value as unknown]));

  const channels = parseChannels(map.get(CHANNEL_KEYS.channels));
  if (channels.length === 0) return null;
  const defaultId = String(map.get(CHANNEL_KEYS.defaultChannel) ?? '');
  const c = channels.find((ch) => ch.id === defaultId) ?? channels[0]!;
  if (!c.apiKey || !c.model) return null;
  return {
    provider: c.provider,
    apiKey: c.apiKey,
    model: c.model,
    baseUrl: c.baseUrl ?? null,
    ...(c.maxTokens !== undefined ? { maxTokens: c.maxTokens } : {}),
  };
}

/**
 * The model in settings can be a proxy/gateway custom alias (not in the pi-ai catalog, so
 * getBuiltinModel returns undefined). In that case a minimal valid Model is synthesized per
 * provider: api must be one of pi-ai's KnownApi values, baseUrl uses the settings value
 * (gateway) or the provider default.
 */
export function synthesizeModel(provider: LlmProvider, modelId: string, baseUrl: string | null): Record<string, unknown> {
  const defaults: Record<LlmProvider, { api: string; baseUrl: string }> = {
    anthropic: { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
    openai: { api: 'openai-completions', baseUrl: 'https://api.openai.com/v1' },
    google: { api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com' },
  };
  const d = defaults[provider];
  return {
    id: modelId,
    name: modelId,
    api: d.api,
    provider,
    baseUrl: baseUrl ?? d.baseUrl,
    reasoning: false,
    // 'image' must be declared: pi-ai transformMessages filters message image blocks by model.input
    // (downgradeUnsupportedImages → placeholder text). ['text'] would silently strip user
    // attachments before they reach the gateway — the whole chain reads "all green but the model
    // never sees the image". When the gateway routes to a non-vision model, the remote API's
    // error is the fallback: prefer explicit failure over silently dropping images.
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
    type: 'chat',
  };
}

export const ENV_BY_PROVIDER = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY' } as const;
