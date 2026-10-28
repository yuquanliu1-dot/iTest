import { type AiLang } from './langDirective.js';

export type LLMProvider = 'openai' | 'anthropic' | 'google';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  /** 自定义网关地址（如内网代理）；留空用各 SDK 官方默认。 */
  baseUrl?: string;
}

/** 一条对话消息（多轮累积形态）。content 里的 image 是截图 block。 */
export interface LLMMessage {
  role: 'user' | 'assistant';
  content: Array<{ type: 'text'; text: string } | { type: 'image'; base64: string; mime: 'image/png' | 'image/jpeg' }>;
}

export interface LLMRequest {
  systemPrompt: string;
  userMessage: string;
  /** 多模态输入：当前只支持单图；后续可扩 image[] */
  image?: { base64: string; mime: 'image/png' | 'image/jpeg' };
  /** 多轮累积历史（可选）。给了就用它替代单轮 userMessage/image。
   *  缺省时退化为原来的单轮形态，行为不变。 */
  messages?: LLMMessage[];
  /** 界面语言。存在时 systemPrompt 末尾自动追加语言指令块;缺省不追加(兼容旧调用)。 */
  lang?: AiLang;
}

export type LLMCompleteResult =
  | { kind: 'json'; value: Record<string, unknown> }
  | { kind: 'text'; value: string };

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  /** 本次命中缓存的 prompt token 数（不含在 promptTokens 内）。 */
  cacheReadTokens?: number;
  /** 本次为建立缓存新写入的 token 数。 */
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

/** 聚合 usage → LLMUsage。缓存 token 恒透出（无命中即 0），调用方据此算命中率。 */
function usageOf(agg: { promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): LLMUsage {
  return {
    promptTokens: agg.promptTokens,
    completionTokens: agg.completionTokens,
    cacheReadTokens: agg.cacheReadTokens,
    cacheCreationTokens: agg.cacheCreationTokens,
  };
}

/** complete 的 JSON 版：解析失败把错误回喂模型重试 1 次（语义重试），仍失败抛错。
 *  返回聚合 usage/durationMs（两次调用累加）与 retries。 */
export async function completeJson(
  client: LLMClient,
  req: LLMRequest,
): Promise<{ value: Record<string, unknown>; retries: number; usage?: LLMUsage; durationMs?: number; model?: string }> {
  // 缓存 token 也要聚合：语义重试的两次调用都可能命中缓存，丢掉就无法在报告里看到命中率。
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
  // 语义重试：把上次的非法输出与错误回喂
  retries = 1;
  const t1 = Date.now();
  const hint = `\n\n上次响应不是合法 JSON（响应开头：「${first.value.slice(0, 120)}」）。请重新输出，只输出 JSON，不要任何其他文字。`;
  // 多轮形态下不能只改 userMessage——clients 优先读 messages，改了也不会生效。
  // 追加一条新的 user 消息承载重试提示（历史保持不变，前缀仍可缓存）。
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
