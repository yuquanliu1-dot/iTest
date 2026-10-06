import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { getLlmClient, type LLMProvider } from '../agent/llm-client.js';
import { cache, wrap } from '../lib/cache.js';
import { settingKey, settingsAllKey } from '../lib/cache-keys.js';

const SETTINGS_TTL_MS = 5 * 60_000;

export const settingsRoute = Router();

const PutBody = z.object({
  key: z.string().min(1).max(100),
  value: z.unknown(),
});

const LlmTestBody = z.object({
  provider: z.enum(['openai', 'anthropic', 'google']),
  apiKey: z.string(),
  model: z.string(),
  baseUrl: z.string(),
});

settingsRoute.get('/', async (_req, res) => {
  const out = await wrap(settingsAllKey(), SETTINGS_TTL_MS, async () => {
    const rows = await db.select().from(settings);
    const acc: Record<string, unknown> = {};
    for (const row of rows) acc[row.key] = row.value;
    return acc;
  });
  res.json(out);
});

settingsRoute.get('/:key', async (req, res) => {
  const k = req.params.key!;
  const row = await wrap<{ key: string; value: unknown; updatedAt: Date } | null>(settingKey(k), SETTINGS_TTL_MS, async () => {
    const rows = await db.select().from(settings).where(eq(settings.key, k));
    const r = rows[0];
    return r ? { key: r.key, value: r.value, updatedAt: r.updatedAt } : null;
  });
  if (!row) throw new HttpError(404, 'not_found', `key ${k} not found`);
  res.json(row);
});

settingsRoute.put('/', async (req, res) => {
  const body = PutBody.parse(req.body);
  const rows = await db
    .insert(settings)
    .values({ key: body.key, value: body.value as object })
    .onConflictDoUpdate({ target: settings.key, set: { value: body.value as object, updatedAt: new Date() } })
    .returning();
  // 失效:整张 settings 字典视图 + 此 key 的单条视图
  await cache.del(settingsAllKey());
  await cache.del(settingKey(body.key));
  res.json({ key: rows[0]!.key, value: rows[0]!.value });
});

// 用表单当前值（未保存也可）探测 LLM 连通性；HTTP 200 + ok:false 表示探测失败
settingsRoute.post('/llm/test', async (req, res) => {
  const body = LlmTestBody.parse(req.body);
  const config = {
    provider: body.provider,
    apiKey: body.apiKey.trim(),
    model: body.model.trim(),
    baseUrl: body.baseUrl.trim() || undefined,
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