export type LLMProvider = 'openai' | 'anthropic' | 'google';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  /** 自定义网关地址（如内网代理）；留空用各 SDK 官方默认。 */
  baseUrl?: string;
}

export interface LLMRequest {
  systemPrompt: string;
  userMessage: string;
  /** 多模态输入：当前只支持单图；后续可扩 image[] */
  image?: { base64: string; mime: 'image/png' | 'image/jpeg' };
}

export type LLMCompleteResult =
  | { kind: 'json'; value: Record<string, unknown> }
  | { kind: 'text'; value: string };

export type LLMResult =
  | { kind: 'json'; value: Record<string, unknown>; provider: LLMProvider; vision: boolean }
  | { kind: 'text'; value: string; provider: LLMProvider; vision: boolean };

export interface LLMClient {
  provider: LLMProvider;
  complete(req: LLMRequest): Promise<LLMResult>;
}

export function listProviders(): LLMProvider[] {
  return ['openai', 'anthropic', 'google'];
}

/** 解析模型输出为 JSON：优先直接 parse，去掉 ```json 围栏、回退提取首段 {...}。 */
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
