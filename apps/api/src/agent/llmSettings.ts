import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { getLlmClient, type LLMClient, type LLMConfig, type LLMProvider } from './llm-client.js';

const KEYS = {
  provider: 'llm_provider',
  apiKey: 'llm_api_key',
  model: 'llm_model',
} as const;

export interface ResolvedLLM {
  config: LLMConfig;
  client: LLMClient;
}

const VALID_PROVIDERS: readonly LLMProvider[] = ['mock', 'openai', 'anthropic', 'google'];

/** 从 settings 表读取 LLM 配置。provider 无效或缺失 → 降级为 mock（与 MVP 启动体验一致）。 */
export async function resolveLlmClient(): Promise<ResolvedLLM> {
  const rows = await db.select().from(settings);
  const map = new Map(rows.map((r) => [r.key, r.value as unknown]));
  const rawProvider = String(map.get(KEYS.provider) ?? 'mock');
  const provider: LLMProvider = (VALID_PROVIDERS as readonly string[]).includes(rawProvider)
    ? (rawProvider as LLMProvider)
    : 'mock';
  const apiKey = String(map.get(KEYS.apiKey) ?? '');
  const model = String(map.get(KEYS.model) ?? '');
  if (provider !== 'mock' && !apiKey) {
    throw new Error(`LLM provider ${provider} selected but API key is empty`);
  }
  const config: LLMConfig = { provider, apiKey, model };
  return { config, client: getLlmClient(config) };
}

/** 设置某条 LLM key（保持原 /settings/:key 的 PUT 行为）。 */
export async function setLlmField(key: 'llm_provider' | 'llm_api_key' | 'llm_model', value: string) {
  const allowed = new Set(['llm_provider', 'llm_api_key', 'llm_model']);
  if (!allowed.has(key)) throw new Error(`unrecognised LLM key ${key}`);
  if (key === 'llm_provider' && !(VALID_PROVIDERS as readonly string[]).includes(value)) {
    throw new Error(`invalid LLM provider ${value}`);
  }
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

// 单测可注入
export const __testing = { KEYS, eq };