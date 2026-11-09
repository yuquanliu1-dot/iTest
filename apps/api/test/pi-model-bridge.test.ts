import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedLlmChannel } from './helpers/db.js';

let pool: Pool;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
});

afterAll(async () => {
  // 本文件经 modelBridge.js 间接持有 db/client.js 的单例池，先关掉再停容器，
  // 否则容器停止会打断残留连接报 57P01（与 pi-tools.test.ts / pi-workspace.test.ts 同款处理）。
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE settings`);
});

describe('readLlmConfig', () => {
  it('returns null when no channel configured', async () => {
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toBeNull();
  });

  it('returns parsed config when fully configured', async () => {
    await seedLlmChannel(pool, {
      provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1',
    });
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toEqual({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('treats invalid provider as unconfigured', async () => {
    await pool.query(`INSERT INTO settings(key, value) VALUES ('llm_channels', $1)`, [
      JSON.stringify([{ id: 'a', name: 'A', provider: 'bogus', apiKey: 'sk-test', model: 'm' }]),
    ]);
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toBeNull();
  });

  it('treats empty apiKey as unconfigured', async () => {
    await seedLlmChannel(pool, { provider: 'openai', apiKey: '', model: 'gpt-4o-mini' });
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toBeNull();
  });

  it('parses channel maxTokens into maxTokens', async () => {
    await seedLlmChannel(pool, { provider: 'anthropic', apiKey: 'sk-test', model: 'Auto', maxTokens: 16384 });
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-test',
      model: 'Auto',
      baseUrl: null,
      maxTokens: 16384,
    });
  });

  it('ignores invalid channel maxTokens（乱码/非正数）→ 无 maxTokens 字段', async () => {
    await pool.query(`INSERT INTO settings(key, value) VALUES ('llm_channels', $1)`, [
      JSON.stringify([{ id: 'a', name: 'A', provider: 'anthropic', apiKey: 'sk-test', model: 'Auto', maxTokens: 'abc' }]),
    ]);
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    const cfg = await readLlmConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.maxTokens).toBeUndefined();
  });
});

describe('readLlmConfig 多渠道结构', () => {
  async function insertChannels(channels: unknown[], defaultId: string) {
    await pool.query(`INSERT INTO settings(key, value) VALUES ($1, $2), ($3, $4)`, [
      'llm_channels', JSON.stringify(channels), 'llm_default_channel', JSON.stringify(defaultId),
    ]);
  }

  it('新结构生效：返回默认渠道 config（baseUrl null/maxTokens 透传）', async () => {
    await insertChannels(
      [
        { id: 'a', name: 'A', provider: 'anthropic', apiKey: 'sk-a', model: 'Auto', maxTokens: 4096 },
        { id: 'b', name: 'B', provider: 'openai', apiKey: 'sk-b', model: 'm', baseUrl: 'https://gw.example.com' },
      ],
      'b',
    );
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toEqual({
      provider: 'openai',
      apiKey: 'sk-b',
      model: 'm',
      baseUrl: 'https://gw.example.com',
    });
  });

  it('默认渠道缺 apiKey/model → null', async () => {
    await insertChannels([{ id: 'a', name: 'A', provider: 'anthropic', apiKey: '', model: 'Auto' }], 'a');
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toBeNull();
  });

  it('旧版 5 个单键不再被读取 → null（已由启动迁移折成渠道）', async () => {
    await pool.query(`INSERT INTO settings(key, value) VALUES
      ('llm_provider','"anthropic"'),
      ('llm_api_key','"sk-legacy"'),
      ('llm_model','"old"')`);
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toBeNull();
  });
});

describe('resolveLlmClient', () => {
  it('reads channel maxTokens into config.maxTokens', async () => {
    await seedLlmChannel(pool, { provider: 'anthropic', apiKey: 'sk-test', model: 'Auto', maxTokens: 16384 });
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    const { config } = await resolveLlmClient();
    expect(config.maxTokens).toBe(16384);
  });

  it('invalid channel maxTokens → config.maxTokens undefined（回退 client 默认）', async () => {
    await pool.query(`INSERT INTO settings(key, value) VALUES ('llm_channels', $1)`, [
      JSON.stringify([{ id: 'a', name: 'A', provider: 'anthropic', apiKey: 'sk-test', model: 'Auto', maxTokens: 0 }]),
    ]);
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    const { config } = await resolveLlmClient();
    expect(config.maxTokens).toBeUndefined();
  });
});
