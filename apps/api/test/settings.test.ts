import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';

let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(`
    CREATE TABLE settings (key varchar(100) PRIMARY KEY, value jsonb NOT NULL, updated_at timestamp NOT NULL DEFAULT now())
  `);
  const { default: express } = await import('express');
  const { settingsRoute } = await import('../src/routes/settings.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

describe('settings KV', () => {
  it('GET /api/settings returns empty initially', async () => {
    const r = await request(app).get('/api/settings');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });

  it('PUT /api/settings creates a key', async () => {
    const r = await request(app).put('/api/settings').send({ key: 'ai_fallback_locator_failed', value: 'mock' });
    expect(r.status).toBe(200);
    expect(r.body.key).toBe('ai_fallback_locator_failed');
  });

  it('GET /api/settings/:key returns the value', async () => {
    const r = await request(app).get('/api/settings/ai_fallback_locator_failed');
    expect(r.status).toBe(200);
    expect(r.body.value).toBe('mock');
  });

  it('PUT same key upserts', async () => {
    await request(app).put('/api/settings').send({ key: 'ai_fallback_locator_failed', value: 'v2' });
    const r = await request(app).get('/api/settings/ai_fallback_locator_failed');
    expect(r.body.value).toBe('v2');
  });

  it('PUT rejects missing key', async () => {
    const r = await request(app).put('/api/settings').send({ value: 'x' });
    expect(r.status).toBe(400);
  });

  it('PUT 旧版单渠道键 → 400（旧配置已废弃）', async () => {
    const r = await request(app).put('/api/settings').send({ key: 'llm_provider', value: 'openai' });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('旧版单渠道配置已废弃');
  });
});

describe('POST /api/settings/llm/test', () => {
  it('provider with empty apiKey reports failure', async () => {
    const r = await request(app).post('/api/settings/llm/test').send({
      provider: 'openai', apiKey: '  ', model: '', baseUrl: '',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain('API key');
  });

  it('invalid provider is rejected with 400', async () => {
    const r = await request(app).post('/api/settings/llm/test').send({
      provider: 'bogus', apiKey: '', model: '', baseUrl: '',
    });
    expect(r.status).toBe(400);
  });

  it('unreachable baseUrl maps SDK error to ok:false', async () => {
    const r = await request(app).post('/api/settings/llm/test').send({
      provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini', baseUrl: 'http://127.0.0.1:9',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(typeof r.body.error).toBe('string');
    expect(r.body.error.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('GET/PUT /api/settings/llm', () => {
  const CHANNEL = {
    id: 'ch-1', name: '主渠道', provider: 'openai', apiKey: 'sk-secret-abcd1234', model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1', maxTokens: 8192,
  };

  it('GET /llm initially returns empty view', async () => {
    const r = await request(app).get('/api/settings/llm');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ defaultChannelId: '', visionChannelId: null, channels: [] });
  });

  it('PUT /llm writes channels; GET /llm masks apiKey', async () => {
    const put = await request(app).put('/api/settings/llm').send({
      defaultChannelId: 'ch-1', visionChannelId: null, channels: [CHANNEL],
    });
    expect(put.status).toBe(200);
    const r = await request(app).get('/api/settings/llm');
    expect(r.status).toBe(200);
    expect(r.body.defaultChannelId).toBe('ch-1');
    expect(r.body.channels).toHaveLength(1);
    const c = r.body.channels[0];
    expect(c).toMatchObject({ id: 'ch-1', name: '主渠道', provider: 'openai', model: 'gpt-4o-mini', hasApiKey: true });
    expect(c.apiKeyMasked).toBe('sk-s****1234');
    expect(JSON.stringify(r.body)).not.toContain('sk-secret-abcd1234');
  });

  it('PUT /llm 后通用 GET 与单键 GET 都不回明文', async () => {
    const all = await request(app).get('/api/settings');
    expect(JSON.stringify(all.body)).not.toContain('sk-secret-abcd1234');
    const chans = all.body.llm_channels;
    expect(Array.isArray(chans)).toBe(true);
    expect(chans[0].apiKey).toBe('sk-s****1234');
    const single = await request(app).get('/api/settings/llm_channels');
    expect(JSON.stringify(single.body)).not.toContain('sk-secret-abcd1234');
  });

  it('PUT /llm apiKey 留空 → 按 id 保留存量原值', async () => {
    const put = await request(app).put('/api/settings/llm').send({
      defaultChannelId: 'ch-1',
      channels: [{ ...CHANNEL, model: 'gpt-4.1', apiKey: '' }],
    });
    expect(put.status).toBe(200);
    const r = await request(app).get('/api/settings/llm');
    expect(r.body.channels[0].hasApiKey).toBe(true);
    expect(r.body.channels[0].model).toBe('gpt-4.1');
    expect(r.body.channels[0].apiKeyMasked).toBe('sk-s****1234');
  });

  it('PUT /llm 新渠道缺 apiKey → 400', async () => {
    const r = await request(app).put('/api/settings/llm').send({
      defaultChannelId: 'ch-new',
      channels: [{ id: 'ch-new', name: '新', provider: 'openai', apiKey: '', model: 'm' }],
    });
    expect(r.status).toBe(400);
  });

  it('PUT /llm defaultChannelId 不在渠道列表 → 400', async () => {
    const r = await request(app).put('/api/settings/llm').send({
      defaultChannelId: 'ch-gone',
      channels: [{ ...CHANNEL, apiKey: '' }],
    });
    expect(r.status).toBe(400);
  });

  it('PUT /llm visionChannelId 不在渠道列表 → 400', async () => {
    const r = await request(app).put('/api/settings/llm').send({
      defaultChannelId: 'ch-1', visionChannelId: 'ch-gone', channels: [{ ...CHANNEL, apiKey: '' }],
    });
    expect(r.status).toBe(400);
  });

  it('PUT /llm 缺渠道 → 400', async () => {
    const r = await request(app).put('/api/settings/llm').send({ defaultChannelId: 'ch-1', channels: [] });
    expect(r.status).toBe(400);
  });

  it('POST /llm/test 带 channelId：空 apiKey 取存量真值（连接错误而非「key 为空」）', async () => {
    // First swap the stored channel's baseUrl to an unreachable port (empty apiKey = keep stored) to avoid the test calling a real endpoint
    const put = await request(app).put('/api/settings/llm').send({
      defaultChannelId: 'ch-1',
      channels: [{ ...CHANNEL, apiKey: '', baseUrl: 'http://127.0.0.1:9' }],
    });
    expect(put.status).toBe(200);
    // Form apiKey/model/baseUrl all empty → the server probes with the stored real values
    const r = await request(app).post('/api/settings/llm/test').send({
      channelId: 'ch-1', provider: 'openai', apiKey: '', model: '', baseUrl: '',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).not.toContain('API key');
  }, 30_000);
});