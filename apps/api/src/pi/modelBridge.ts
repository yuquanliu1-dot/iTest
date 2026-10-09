import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';

export type LlmProvider = 'openai' | 'anthropic' | 'google';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl: string | null;
}

const KEYS = {
  provider: 'llm_provider',
  apiKey: 'llm_api_key',
  model: 'llm_model',
  baseUrl: 'llm_base_url',
} as const;

const VALID: readonly LlmProvider[] = ['openai', 'anthropic', 'google'];

/** 读取 LLM 配置；provider 未配置/无效或 apiKey 为空 → null。 */
export async function readLlmConfig(): Promise<LlmConfig | null> {
  const all = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [KEYS.provider, KEYS.apiKey, KEYS.model, KEYS.baseUrl]));
  const map = new Map(all.map((r) => [r.key, r.value as unknown]));
  const rawProvider = String(map.get(KEYS.provider) ?? '');
  if (!(VALID as readonly string[]).includes(rawProvider)) return null;
  const provider = rawProvider as LlmProvider;
  const apiKey = String(map.get(KEYS.apiKey) ?? '');
  const model = String(map.get(KEYS.model) ?? '');
  const rawBase = String(map.get(KEYS.baseUrl) ?? '');
  if (!apiKey || !model) return null;
  return { provider, apiKey, model, baseUrl: rawBase || null };
}

/**
 * settings 里的 model 可以是代理/网关的自定义别名（不在 pi-ai catalog 里，getBuiltinModel 返回
 * undefined）。此时按 provider 合成一个最小合法 Model：api 必须是 pi-ai 的 KnownApi 之一，
 * baseUrl 用 settings 的值（网关）或 provider 默认值。
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
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
    type: 'chat',
  };
}

export const ENV_BY_PROVIDER = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY' } as const;
