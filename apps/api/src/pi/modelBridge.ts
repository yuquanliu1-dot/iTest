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
