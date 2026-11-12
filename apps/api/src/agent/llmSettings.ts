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

/** Multi-channel settings keys (the 5 legacy single keys were migrated by db/migrateLlmChannels.ts and then removed). */
export const CHANNEL_KEYS = {
  channels: 'llm_channels',
  defaultChannel: 'llm_default_channel',
  visionChannel: 'llm_vision_channel',
} as const;

/** One LLM channel (an element of the settings key llm_channels array). */
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

/** The single parsing convention for maxTokens: number or numeric string; only positive integers take effect, otherwise undefined (client uses its default). */
export function parseMaxTokens(v: unknown): number | undefined {
  const n = Number(String(v ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Parse the stored llm_channels value; filter out non-arrays and malformed elements one by one (missing id / invalid provider). */
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

/** API key masking: for >8 chars keep the first and last 4, otherwise mask everything. */
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

/** Whether the request contains images: the single-image field or any image block in the multi-turn history. */
function requestHasImages(req: LLMRequest): boolean {
  if (req.image != null) return true;
  return req.messages?.some((m) => m.content.some((b) => b.type === 'image')) ?? false;
}

/**
 * Vision routing client: image-bearing requests go to the vision channel, plain text goes to the default channel.
 * LLMResult is passed through unchanged from the routed client (model/usage reflect the channel actually executed).
 * Attached at the client boundary rather than call sites — the same client variable often does both plain-text prechecks and image-bearing runAiTask calls.
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

/** Read LLM config from the settings table. The legacy single channel has been migrated to the llm_channels array; only the new structure is recognized here:
 *  no channels configured → throw (LLM features require adding a channel in settings first).
 *  When a vision channel is configured, returns VisionRoutingClient (image-bearing requests auto-route to the vision channel), transparent to call sites. */
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

/** Client injectable for unit tests; when non-null, all resolveLlmClient() calls return it directly, bypassing the settings table. */
let injectedClient: ResolvedLLM | null = null;
export function __setLlmClientForTest(c: ResolvedLLM | null): void {
  injectedClient = c;
}
