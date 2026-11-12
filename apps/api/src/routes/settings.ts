import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { getLlmClient, type LLMProvider } from '../agent/llm-client.js';
import { CHANNEL_KEYS, maskApiKey, parseChannels, type LlmChannel } from '../agent/llmSettings.js';
import { LEGACY_LLM_KEYS } from '../db/migrateLlmChannels.js';
import { cache, wrap } from '../lib/cache.js';
import { settingKey, settingsAllKey } from '../lib/cache-keys.js';

const SETTINGS_TTL_MS = 5 * 60_000;

export const settingsRoute = Router();

const PutBody = z.object({
  key: z.string().min(1).max(100),
  value: z.unknown(),
});

const LlmTestBody = z.object({
  channelId: z.string().optional(),
  provider: z.enum(['openai', 'anthropic', 'google']),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
});

/** Sensitive settings key output masking: llm_api_key masks the whole value; the llm_channels array masks apiKey per element. */
const SENSITIVE_LLM_KEYS = new Set<string>(['llm_api_key', CHANNEL_KEYS.channels]);
function maskSensitiveValue(key: string, value: unknown): unknown {
  if (key === 'llm_api_key') return typeof value === 'string' ? maskApiKey(value) : value;
  if (key === CHANNEL_KEYS.channels) {
    return parseChannels(value).map((c) => ({ ...c, apiKey: maskApiKey(c.apiKey) }));
  }
  return value;
}

function readStoredChannels(): Promise<LlmChannel[]> {
  return (async () => {
    const rows = await db.select().from(settings).where(eq(settings.key, CHANNEL_KEYS.channels));
    return parseChannels(rows[0]?.value);
  })();
}

settingsRoute.get('/', async (_req, res) => {
  const out = await wrap(settingsAllKey(), SETTINGS_TTL_MS, async () => {
    const rows = await db.select().from(settings);
    const acc: Record<string, unknown> = {};
    for (const row of rows) acc[row.key] = row.value;
    for (const key of SENSITIVE_LLM_KEYS) {
      if (key in acc) acc[key] = maskSensitiveValue(key, acc[key]);
    }
    return acc;
  });
  res.json(out);
});

// Channel structure view (apiKey returns masked only). Must be registered before /:key.
settingsRoute.get('/llm', async (_req, res) => {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [CHANNEL_KEYS.channels, CHANNEL_KEYS.defaultChannel, CHANNEL_KEYS.visionChannel]));
  const map = new Map(rows.map((r) => [r.key, r.value as unknown]));
  const channels = parseChannels(map.get(CHANNEL_KEYS.channels));
  res.json({
    defaultChannelId: String(map.get(CHANNEL_KEYS.defaultChannel) ?? ''),
    visionChannelId: String(map.get(CHANNEL_KEYS.visionChannel) ?? '') || null,
    channels: channels.map((c) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      model: c.model,
      baseUrl: c.baseUrl ?? null,
      maxTokens: c.maxTokens ?? null,
      apiKeyMasked: maskApiKey(c.apiKey),
      hasApiKey: Boolean(c.apiKey),
    })),
  });
});

const LlmChannelInput = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(100),
  provider: z.enum(['openai', 'anthropic', 'google']),
  apiKey: z.string().max(500).optional(),
  model: z.string().min(1).max(200),
  baseUrl: z.string().max(500).optional(),
  maxTokens: z.number().int().positive().nullable().optional(),
});

const LlmPutBody = z.object({
  defaultChannelId: z.string().min(1),
  visionChannelId: z.string().nullable().optional(),
  channels: z.array(LlmChannelInput).min(1),
});

// Save channels wholesale: apiKey left empty/absent = keep the stored original by id (what the frontend gets is masked, no plaintext)
settingsRoute.put('/llm', async (req, res) => {
  const body = LlmPutBody.parse(req.body);
  const existingById = new Map((await readStoredChannels()).map((c) => [c.id, c]));

  const seen = new Set<string>();
  const channels: LlmChannel[] = [];
  for (const input of body.channels) {
    const id = input.id ?? randomUUID();
    if (seen.has(id)) throw new HttpError(400, 'validation', `渠道 id 重复: ${id}`);
    seen.add(id);
    let apiKey = (input.apiKey ?? '').trim();
    if (!apiKey) {
      const prev = existingById.get(id);
      if (!prev?.apiKey) throw new HttpError(400, 'validation', `渠道「${input.name}」缺少 API Key`);
      apiKey = prev.apiKey;
    }
    channels.push({
      id,
      name: input.name.trim(),
      provider: input.provider,
      apiKey,
      model: input.model.trim(),
      ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
      ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
    });
  }
  if (!seen.has(body.defaultChannelId)) throw new HttpError(400, 'validation', 'defaultChannelId 不在渠道列表中');
  const visionChannelId = body.visionChannelId?.trim() || '';
  if (visionChannelId && !seen.has(visionChannelId)) {
    throw new HttpError(400, 'validation', 'visionChannelId 不在渠道列表中');
  }

  const writes: Array<{ key: string; value: unknown }> = [
    { key: CHANNEL_KEYS.channels, value: channels },
    { key: CHANNEL_KEYS.defaultChannel, value: body.defaultChannelId },
    { key: CHANNEL_KEYS.visionChannel, value: visionChannelId },
  ];
  for (const w of writes) {
    await db
      .insert(settings)
      .values({ key: w.key, value: w.value as object })
      .onConflictDoUpdate({ target: settings.key, set: { value: w.value as object, updatedAt: new Date() } });
  }
  // Invalidate: the whole settings dictionary view + the per-key views of the three channel keys
  await cache.del(settingsAllKey());
  for (const w of writes) await cache.del(settingKey(w.key));
  res.json({ ok: true });
});

// Generic single-key PUT (the existing write path for non-LLM keys like ai_fallback_locator_failed)
settingsRoute.put('/', async (req, res) => {
  const body = PutBody.parse(req.body);
  // Legacy single-channel keys are deprecated (migrated into llm_channels and deleted at startup); reject writes to avoid orphan configs nobody reads
  if ((LEGACY_LLM_KEYS as readonly string[]).includes(body.key)) {
    throw new HttpError(400, 'legacy_llm_config', '旧版单渠道配置已废弃，请在「LLM Provider」中新增渠道');
  }
  const rows = await db
    .insert(settings)
    .values({ key: body.key, value: body.value as object })
    .onConflictDoUpdate({ target: settings.key, set: { value: body.value as object, updatedAt: new Date() } })
    .returning();
  // Invalidate: the whole settings dictionary view + this key's per-key view
  await cache.del(settingsAllKey());
  await cache.del(settingKey(body.key));
  res.json({ key: rows[0]!.key, value: rows[0]!.value });
});

settingsRoute.get('/:key', async (req, res) => {
  const k = req.params.key!;
  const row = await wrap<{ key: string; value: unknown; updatedAt: Date } | null>(settingKey(k), SETTINGS_TTL_MS, async () => {
    const rows = await db.select().from(settings).where(eq(settings.key, k));
    const r = rows[0];
    return r ? { key: r.key, value: r.value, updatedAt: r.updatedAt } : null;
  });
  if (!row) throw new HttpError(404, 'not_found', `key ${k} not found`);
  res.json({ ...row, value: SENSITIVE_LLM_KEYS.has(k) ? maskSensitiveValue(k, row.value) : row.value });
});

// Probe LLM connectivity using the form's current values (unsaved is fine); HTTP 200 + ok:false means the probe failed.
// Stored channels' keys are masked on output: when apiKey is empty, take the stored true value as base by channelId, with non-empty form fields overriding.
settingsRoute.post('/llm/test', async (req, res) => {
  const body = LlmTestBody.parse(req.body);
  let apiKey = (body.apiKey ?? '').trim();
  let model = (body.model ?? '').trim();
  let baseUrl = (body.baseUrl ?? '').trim();
  if (!apiKey && body.channelId) {
    const channel = (await readStoredChannels()).find((c) => c.id === body.channelId);
    if (channel) {
      apiKey = channel.apiKey;
      if (!model) model = channel.model;
      if (!baseUrl) baseUrl = channel.baseUrl ?? '';
    }
  }
  const config = {
    provider: body.provider,
    apiKey,
    model,
    baseUrl: baseUrl || undefined,
  };
  if (!config.apiKey) {
    res.json({ ok: false, provider: config.provider, error: 'API key 为空，请先填写' });
    return;
  }
  const client = getLlmClient(config);
  const startedAt = Date.now();
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('连接超时（30s）')), 30_000).unref(),
    );
    await Promise.race([
      client.complete({ systemPrompt: 'You are a connectivity probe. Reply with JSON {"ok":true}.', userMessage: 'ping' }),
      timeout,
    ]);
    res.json({ ok: true, provider: config.provider as LLMProvider, latencyMs: Date.now() - startedAt });
  } catch (e) {
    res.json({
      ok: false,
      provider: config.provider as LLMProvider,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
