import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL } from './helpers/db.js';

let pool: Pool;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
});

afterAll(async () => {
  // 本文件经 db/client.js 持有单例池，先关掉再停容器（与 pi-model-bridge.test.ts 同款处理）。
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE settings`);
});

async function insertSettings(rows: Array<[string, unknown]>) {
  for (const [key, value] of rows) {
    await pool.query(`INSERT INTO settings(key, value) VALUES ($1, $2)`, [key, JSON.stringify(value)]);
  }
}

async function readSettings(): Promise<Map<string, unknown>> {
  const rows = await pool.query(`SELECT key, value FROM settings`);
  return new Map(rows.rows.map((r) => [r.key as string, r.value]));
}

/** 旧版单渠道 5 键（迁移前的样子）。 */
const LEGACY = [
  ['llm_provider', 'anthropic'],
  ['llm_api_key', 'sk-legacy-secret'],
  ['llm_model', 'Auto'],
  ['llm_base_url', 'https://gw.example.com'],
  ['llm_max_tokens', '16384'],
] as const;

describe('旧版单渠道 → 多渠道迁移', () => {
  it('旧 5 键折成一个默认渠道（字段全保留），旧键被删除', async () => {
    await insertSettings(LEGACY.map((r) => [r[0], r[1]] as [string, unknown]));
    const { migrateLegacyLlmChannels } = await import('../src/db/migrateLlmChannels.js');
    const r = await migrateLegacyLlmChannels();
    expect(r.migrated).toBe(true);
    expect(r.legacyRemoved).toBe(true);

    const map = await readSettings();
    expect([...map.keys()].filter((k) => k.startsWith('llm_')).sort()).toEqual([
      'llm_channels',
      'llm_default_channel',
    ]);
    const channels = map.get('llm_channels') as Array<Record<string, unknown>>;
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      provider: 'anthropic',
      apiKey: 'sk-legacy-secret',
      model: 'Auto',
      baseUrl: 'https://gw.example.com',
      maxTokens: 16384,
    });
    expect(map.get('llm_default_channel')).toBe(channels[0]!.id);
  });

  it('迁移后 resolveLlmClient 直接可用（配置不丢）', async () => {
    await insertSettings(LEGACY.map((r) => [r[0], r[1]] as [string, unknown]));
    const { migrateLegacyLlmChannels } = await import('../src/db/migrateLlmChannels.js');
    await migrateLegacyLlmChannels();
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    const { config } = await resolveLlmClient();
    expect(config).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-legacy-secret',
      model: 'Auto',
      baseUrl: 'https://gw.example.com',
      maxTokens: 16384,
    });
  });

  it('幂等：重跑不新增渠道、不覆盖已有内容', async () => {
    await insertSettings(LEGACY.map((r) => [r[0], r[1]] as [string, unknown]));
    const { migrateLegacyLlmChannels } = await import('../src/db/migrateLlmChannels.js');
    await migrateLegacyLlmChannels();
    const first = await readSettings();
    const second = await migrateLegacyLlmChannels();
    expect(second.migrated).toBe(false);
    expect(second.legacyRemoved).toBe(false);
    expect(await readSettings()).toEqual(first);
  });

  it('已有渠道时旧键只被删除，渠道不被覆盖', async () => {
    await insertSettings([
      ['llm_channels', [{ id: 'ch-1', name: '主渠道', provider: 'openai', apiKey: 'sk-new', model: 'gpt-4o-mini' }]],
      ['llm_default_channel', 'ch-1'],
      ...LEGACY.map((r) => [r[0], r[1]] as [string, unknown]),
    ]);
    const { migrateLegacyLlmChannels } = await import('../src/db/migrateLlmChannels.js');
    const r = await migrateLegacyLlmChannels();
    expect(r.migrated).toBe(false);
    expect(r.legacyRemoved).toBe(true);
    const map = await readSettings();
    expect(map.get('llm_channels')).toEqual([
      { id: 'ch-1', name: '主渠道', provider: 'openai', apiKey: 'sk-new', model: 'gpt-4o-mini' },
    ]);
    expect(map.has('llm_provider')).toBe(false);
  });

  it('provider 非法 → 不建渠道，旧键仍被清除', async () => {
    await insertSettings([
      ['llm_provider', 'bogus'],
      ['llm_api_key', 'sk-legacy'],
      ['llm_model', 'm'],
    ]);
    const { migrateLegacyLlmChannels } = await import('../src/db/migrateLlmChannels.js');
    const r = await migrateLegacyLlmChannels();
    expect(r.migrated).toBe(false);
    expect(r.channelCount).toBe(0);
    const map = await readSettings();
    expect(map.has('llm_provider')).toBe(false);
    expect(map.has('llm_channels')).toBe(false);
  });

  it('llm_default_channel 指向不存在的渠道 → 兜底到第一个渠道', async () => {
    await insertSettings([
      ['llm_channels', [{ id: 'ch-1', name: 'A', provider: 'openai', apiKey: 'sk-a', model: 'm' }]],
      ['llm_default_channel', 'ch-gone'],
    ]);
    const { migrateLegacyLlmChannels } = await import('../src/db/migrateLlmChannels.js');
    await migrateLegacyLlmChannels();
    const map = await readSettings();
    expect(map.get('llm_default_channel')).toBe('ch-1');
  });

  it('无旧键无渠道 → 无副作用', async () => {
    const { migrateLegacyLlmChannels } = await import('../src/db/migrateLlmChannels.js');
    const r = await migrateLegacyLlmChannels();
    expect(r).toMatchObject({ migrated: false, channelCount: 0, legacyRemoved: false });
    expect((await readSettings()).size).toBe(0);
  });
});
