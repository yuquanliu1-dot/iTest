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
  /** 单次回复最大输出 token（渠道 maxTokens）；未配置/非法 → undefined，client 用自己的默认。 */
  maxTokens?: number;
}

/** 读取 LLM 配置（只认 llm_channels 多渠道结构，取默认渠道）；
 *  未配置渠道或渠道缺 apiKey/model → null。pi 路径只承载聊天/蒸馏纯文本调用，不接视觉渠道。 */
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
    // 'image' 必须声明:pi-ai transformMessages 按 model.input 过滤消息图片块
    // (downgradeUnsupportedImages → 占位文本)。['text'] 会让用户附件在发往网关前被
    // 静默剥掉——整条链路"全绿但模型看不见图"。网关路由到无视觉能力的模型时,
    // 由对端 API 报错兜底,宁可显式失败也不静默丢图。
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
    type: 'chat',
  };
}

export const ENV_BY_PROVIDER = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY' } as const;
