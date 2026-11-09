import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import {
  getLlmClient,
  type LLMClient,
  type LLMConfig,
  type LLMProvider,
  type LLMRequest,
  type LLMResult,
} from './llm-client.js';

/** 多渠道 settings 键（旧版 5 个单键已由 db/migrateLlmChannels.ts 迁移后删除）。 */
export const CHANNEL_KEYS = {
  channels: 'llm_channels',
  defaultChannel: 'llm_default_channel',
  visionChannel: 'llm_vision_channel',
} as const;

/** 一个 LLM 渠道（settings 键 llm_channels 数组元素）。 */
export interface LlmChannel {
  id: string;
  name: string;
  provider: LLMProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
}

export interface ResolvedLLM {
  config: LLMConfig;
  client: LLMClient;
}

const VALID_PROVIDERS: readonly LLMProvider[] = ['openai', 'anthropic', 'google'];

/** maxTokens 唯一解析口径：数字或字符串数字，正整数才生效，否则 undefined（client 用默认）。 */
export function parseMaxTokens(v: unknown): number | undefined {
  const n = Number(String(v ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** 解析 llm_channels 存储值；非数组或元素畸形（缺 id/provider 非法）逐个过滤。 */
export function parseChannels(v: unknown): LlmChannel[] {
  if (!Array.isArray(v)) return [];
  const out: LlmChannel[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    const provider = r.provider as LLMProvider;
    if (!id || !(VALID_PROVIDERS as readonly string[]).includes(provider)) continue;
    const maxTokens = parseMaxTokens(r.maxTokens);
    out.push({
      id,
      name: typeof r.name === 'string' ? r.name : '',
      provider,
      apiKey: typeof r.apiKey === 'string' ? r.apiKey : '',
      model: typeof r.model === 'string' ? r.model : '',
      ...(typeof r.baseUrl === 'string' && r.baseUrl ? { baseUrl: r.baseUrl } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });
  }
  return out;
}

/** API Key 掩码：>8 位留首尾各 4 位，否则全掩。 */
export function maskApiKey(key: string): string {
  if (!key) return '';
  return key.length > 8 ? `${key.slice(0, 4)}****${key.slice(-4)}` : '****';
}

function channelToConfig(c: LlmChannel): LLMConfig {
  return {
    provider: c.provider,
    apiKey: c.apiKey,
    model: c.model,
    baseUrl: c.baseUrl,
    ...(c.maxTokens !== undefined ? { maxTokens: c.maxTokens } : {}),
  };
}

/** 请求是否含图：单图字段或多轮 history 任一 image block。 */
function requestHasImages(req: LLMRequest): boolean {
  if (req.image != null) return true;
  return req.messages?.some((m) => m.content.some((b) => b.type === 'image')) ?? false;
}

/**
 * 视觉路由 client：含图请求走视觉渠道，纯文本走默认渠道。
 * LLMResult 从被路由 client 原样透传（model/usage 反映实际执行的渠道）。
 * 挂在 client 边界而非调用点——同一 client 变量常既做纯文本前置检查又传给含图的 runAiTask。
 */
export class VisionRoutingClient implements LLMClient {
  constructor(
    private main: LLMClient,
    private vision: LLMClient,
  ) {}
  get provider(): LLMProvider {
    return this.main.provider;
  }
  complete(req: LLMRequest): Promise<LLMResult> {
    return (requestHasImages(req) ? this.vision : this.main).complete(req);
  }
}

/** 从 settings 表读取 LLM 配置。旧版单渠道已迁移为 llm_channels 数组，此处只认新结构：
 *  未配置任何渠道 → 抛错（LLM 功能需先在设置中新增渠道）。
 *  配置了视觉渠道时返回 VisionRoutingClient（含图请求自动路由到视觉渠道），调用点无感。 */
export async function resolveLlmClient(): Promise<ResolvedLLM> {
  if (injectedClient) return injectedClient;
  const rows = await db.select().from(settings);
  const map = new Map(rows.map((r) => [r.key, r.value as unknown]));

  const channels = parseChannels(map.get(CHANNEL_KEYS.channels));
  if (channels.length === 0) {
    throw new Error('尚未配置 LLM 渠道，请在设置中新增渠道');
  }
  const defaultId = String(map.get(CHANNEL_KEYS.defaultChannel) ?? '');
  const channel = channels.find((c) => c.id === defaultId) ?? channels[0]!;
  const effectiveDefaultId = channel.id;
  if (!channel.apiKey) {
    throw new Error(`LLM 渠道「${channel.name || channel.id}」缺少 API Key，请在设置中补全`);
  }
  const config = channelToConfig(channel);

  const mainClient = getLlmClient(config);
  const visionChannelId = String(map.get(CHANNEL_KEYS.visionChannel) ?? '');
  const visionChannel =
    visionChannelId && visionChannelId !== effectiveDefaultId
      ? channels.find((c) => c.id === visionChannelId && c.apiKey && c.model)
      : undefined;
  if (visionChannel) {
    return { config, client: new VisionRoutingClient(mainClient, getLlmClient(channelToConfig(visionChannel))) };
  }
  return { config, client: mainClient };
}

/** 单元测试可注入客户端；非空时所有 resolveLlmClient() 调用直接返回它，绕过 settings 表。 */
let injectedClient: ResolvedLLM | null = null;
export function __setLlmClientForTest(c: ResolvedLLM | null): void {
  injectedClient = c;
}
