import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
});

afterAll(async () => {
  // 本文件经 modelBridge.js 间接持有 db/client.js 的单例池，先关掉再停容器，
  // 否则容器停止会打断残留连接报 57P01（与 pi-tools.test.ts / pi-workspace.test.ts 同款处理）。
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE settings`);
});

describe('readLlmConfig', () => {
  it('returns null when provider not configured', async () => {
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toBeNull();
  });

  it('returns parsed config when fully configured', async () => {
    await pool.query(`INSERT INTO settings(key, value) VALUES
      ('llm_provider','"openai"'),
      ('llm_api_key','"sk-test"'),
      ('llm_model','"gpt-4o-mini"'),
      ('llm_base_url','"https://api.openai.com/v1"')`);
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toEqual({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('treats invalid provider as unconfigured', async () => {
    await pool.query(`INSERT INTO settings(key, value) VALUES ('llm_provider','"bogus"')`);
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toBeNull();
  });

  it('treats empty apiKey as unconfigured', async () => {
    await pool.query(`INSERT INTO settings(key, value) VALUES
      ('llm_provider','"openai"'),
      ('llm_api_key','""'),
      ('llm_model','"gpt-4o-mini"')`);
    const { readLlmConfig } = await import('../src/pi/modelBridge.js');
    expect(await readLlmConfig()).toBeNull();
  });
});
