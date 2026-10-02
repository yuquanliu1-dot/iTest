import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { getLlmClient, type LLMClient, type LLMConfig, type LLMProvider } from './llm-client.js';

const KEYS = {
  provider: 'llm_provider',
  apiKey: 'llm_api_key',
  model: 'llm_model',
  baseUrl: 'llm_base_url',
} as const;

export interface ResolvedLLM {
  config: LLMConfig;
  client: LLMClient;
}

const VALID_PROVIDERS: readonly LLMProvider[] = ['openai', 'anthropic', 'google'];

/** 从 settings 表读取 LLM 配置。provider 未配置/无效 → 抛错（LLM 功能需先在设置中配置）。 */
export async function resolveLlmClient(): Promise<ResolvedLLM> {
  if (injectedClient) return injectedClient;
  const rows = await db.select().from(settings);
  const map = new Map(rows.map((r) => [r.key, r.value as unknown]));
  const rawProvider = String(map.get(KEYS.provider) ?? '');
  if (!(VALID_PROVIDERS as readonly string[]).includes(rawProvider)) {
    throw new Error('LLM provider 未配置或无效，请在设置中选择 openai / anthropic / google');
  }
  const provider = rawProvider as LLMProvider;
  const apiKey = String(map.get(KEYS.apiKey) ?? '');
  const model = String(map.get(KEYS.model) ?? '');
  const baseUrl = String(map.get(KEYS.baseUrl) ?? '') || undefined;
  if (!apiKey) {
    throw new Error(`LLM provider ${provider} selected but API key is empty`);
  }
  const config: LLMConfig = { provider, apiKey, model, baseUrl };
  return { config, client: getLlmClient(config) };
}

/** 设置某条 LLM key（保持原 /settings/:key 的 PUT 行为）。 */
export async function setLlmField(key: 'llm_provider' | 'llm_api_key' | 'llm_model' | 'llm_base_url', value: string) {
  const allowed = new Set(['llm_provider', 'llm_api_key', 'llm_model', 'llm_base_url']);
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

/** 单元测试可注入客户端；非空时所有 resolveLlmClient() 调用直接返回它，绕过 settings 表。 */
let injectedClient: ResolvedLLM | null = null;
export function __setLlmClientForTest(c: ResolvedLLM | null): void {
  injectedClient = c;
}