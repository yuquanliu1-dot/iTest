/**
 * One-time data migration from the legacy single channel → multi-channel structure (idempotent, safe to re-run in any state).
 *
 * Background: early LLM config was just 5 single keys in the settings table (provider/apiKey/model/baseUrl/maxTokens).
 * It is now the llm_channels array + llm_default_channel / llm_vision_channel; the legacy path is not kept,
 * so the old keys must be folded into the new structure and then deleted, otherwise the old config becomes an orphan nobody reads.
 *
 * Timing: at API startup (src/index.ts) — deploying to an old DB (prod228 etc.) migrates automatically, invisible to users.
 *
 * Concurrency safety: everything runs in one transaction, taking pg_advisory_xact_lock first to serialize simultaneous multi-replica startups;
 * the migrated channel uses a fixed id (not random), so re-runs/concurrency write the same content and never fork a second channel.
 */
import { inArray, sql } from 'drizzle-orm';
import { db } from './client.js';
import { settings } from './schema.js';
import { logger } from '../logger.js';
import { CHANNEL_KEYS, parseChannels, parseMaxTokens, type LlmChannel } from '../agent/llmSettings.js';

/** The 5 legacy single-channel keys: deleted during migration and never read/written again afterwards (writes already intercepted with 400). */
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

/** Fixed id for the migrated channel: re-runs/concurrency always write the same id. */
const MIGRATED_CHANNEL_ID = '00000000-0000-0000-0000-000000000090';

const LOCK_ID = 0x4c4c4d43; // 'LLMC'

export interface LlmMigrationResult {
  /** Whether a new channel was folded out of the 5 legacy keys. */
  migrated: boolean;
  /** Channel count after migration (or the pre-existing count). */
  channelCount: number;
  /** Whether the legacy keys were removed. */
  legacyRemoved: boolean;
}

export async function migrateLegacyLlmChannels(): Promise<LlmMigrationResult> {
  return db.transaction(async (tx) => {
    // Serialize simultaneous multi-replica startups; released automatically when the transaction ends.
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

    // The default channel must point to a channel that actually exists: fall back to the first one when stale
    const defaultId = String(map.get(CHANNEL_KEYS.defaultChannel) ?? '');
    if (channels.length > 0 && !channels.some((c) => c.id === defaultId)) {
      const fallbackId = channels[0]!.id;
      await tx
        .insert(settings)
        .values({ key: CHANNEL_KEYS.defaultChannel, value: fallbackId })
        .onConflictDoUpdate({ target: settings.key, set: { value: fallbackId, updatedAt: new Date() } });
    }

    // Legacy keys fully removed: no code reads them after migration
    const deleted = await tx
      .delete(settings)
      .where(inArray(settings.key, [...LEGACY_LLM_KEYS]))
      .returning({ key: settings.key });

    return { migrated, channelCount: channels.length, legacyRemoved: deleted.length > 0 };
  });
}
