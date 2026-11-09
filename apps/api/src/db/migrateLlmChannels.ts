/**
 * 旧版单渠道 → 多渠道结构的一次性数据迁移（幂等，可在任何状态重跑）。
 *
 * 背景：早期 LLM 配置只有 settings 表里的 5 个单键（provider/apiKey/model/baseUrl/maxTokens）。
 * 现已改为 llm_channels 数组 + llm_default_channel / llm_vision_channel，旧路径不再保留，
 * 因此旧键必须折成新结构后删除，否则旧配置会变成没人读的孤儿。
 *
 * 执行时机：API 启动时（src/index.ts）——旧库（prod228 等）发版即自动迁移，用户无感。
 *
 * 并发安全：整体在一个事务里，先取 pg_advisory_xact_lock 串行化多副本同时启动；
 * 迁移渠道用固定 id（不随机），重跑/并发都写同一份内容，不会分裂出第二条渠道。
 */
import { inArray, sql } from 'drizzle-orm';
import { db } from './client.js';
import { settings } from './schema.js';
import { logger } from '../logger.js';
import { CHANNEL_KEYS, parseChannels, parseMaxTokens, type LlmChannel } from '../agent/llmSettings.js';

/** 旧版单渠道 5 键：迁移时被删除，且迁移后不再被任何代码读写（写路径已 400 拦截）。 */
export const LEGACY_LLM_KEYS = [
  'llm_provider',
  'llm_api_key',
  'llm_model',
  'llm_base_url',
  'llm_max_tokens',
] as const;

const LEGACY_PROVIDER_KEY = 'llm_provider';
const LEGACY_API_KEY_KEY = 'llm_api_key';
const LEGACY_MODEL_KEY = 'llm_model';
const LEGACY_BASE_URL_KEY = 'llm_base_url';
const LEGACY_MAX_TOKENS_KEY = 'llm_max_tokens';

const VALID_PROVIDERS = ['openai', 'anthropic', 'google'] as const;

/** 迁移渠道的固定 id：重跑/并发都写同一个 id。 */
const MIGRATED_CHANNEL_ID = '00000000-0000-0000-0000-000000000090';

const LOCK_ID = 0x4c4c4d43; // 'LLMC'

export interface LlmMigrationResult {
  /** 是否由旧 5 键折出了一个新渠道。 */
  migrated: boolean;
  /** 迁移后（或原有）的渠道数。 */
  channelCount: number;
  /** 是否清掉了旧键。 */
  legacyRemoved: boolean;
}

export async function migrateLegacyLlmChannels(): Promise<LlmMigrationResult> {
  return db.transaction(async (tx) => {
    // 多副本同时启动时串行化；事务结束自动释放。
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_ID})`);

    const rows = await tx
      .select()
      .from(settings)
      .where(
        inArray(settings.key, [
          ...LEGACY_LLM_KEYS,
          CHANNEL_KEYS.channels,
          CHANNEL_KEYS.defaultChannel,
          CHANNEL_KEYS.visionChannel,
        ]),
      );
    const map = new Map(rows.map((r) => [r.key, r.value as unknown]));

    let channels = parseChannels(map.get(CHANNEL_KEYS.channels));
    let migrated = false;

    if (channels.length === 0) {
      const provider = String(map.get(LEGACY_PROVIDER_KEY) ?? '');
      if ((VALID_PROVIDERS as readonly string[]).includes(provider)) {
        const apiKey = String(map.get(LEGACY_API_KEY_KEY) ?? '');
        const model = String(map.get(LEGACY_MODEL_KEY) ?? '');
        const baseUrl = String(map.get(LEGACY_BASE_URL_KEY) ?? '').trim();
        const maxTokens = parseMaxTokens(map.get(LEGACY_MAX_TOKENS_KEY));
        const channel: LlmChannel = {
          id: MIGRATED_CHANNEL_ID,
          name: provider,
          provider: provider as LlmChannel['provider'],
          apiKey,
          model,
          ...(baseUrl ? { baseUrl } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
        };
        await tx
          .insert(settings)
          .values({ key: CHANNEL_KEYS.channels, value: [channel] })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: [channel], updatedAt: new Date() },
          });
        channels = [channel];
        migrated = true;
        logger.info({ provider, model }, '旧版单渠道配置已迁移为默认渠道');
      } else if (rows.some((r) => r.key === LEGACY_PROVIDER_KEY)) {
        logger.warn({ provider }, '旧版单渠道配置的 provider 非法，无法迁移，旧键将被清除');
      }
    }

    // 默认渠道必须指向真实存在的渠道：失效时兜底到第一个
    const defaultId = String(map.get(CHANNEL_KEYS.defaultChannel) ?? '');
    if (channels.length > 0 && !channels.some((c) => c.id === defaultId)) {
      const fallbackId = channels[0]!.id;
      await tx
        .insert(settings)
        .values({ key: CHANNEL_KEYS.defaultChannel, value: fallbackId })
        .onConflictDoUpdate({ target: settings.key, set: { value: fallbackId, updatedAt: new Date() } });
    }

    // 旧键彻底清除：迁移后没有任何代码读它们
    const deleted = await tx
      .delete(settings)
      .where(inArray(settings.key, [...LEGACY_LLM_KEYS]))
      .returning({ key: settings.key });

    return { migrated, channelCount: channels.length, legacyRemoved: deleted.length > 0 };
  });
}
