import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
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
  await container.stop();
});

describe('settings KV', () => {
  it('GET /api/settings returns empty initially', async () => {
    const r = await request(app).get('/api/settings');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });

  it('PUT /api/settings creates a key', async () => {
    const r = await request(app).put('/api/settings').send({ key: 'llm_provider', value: 'mock' });
    expect(r.status).toBe(200);
    expect(r.body.key).toBe('llm_provider');
  });

  it('GET /api/settings/:key returns the value', async () => {
    const r = await request(app).get('/api/settings/llm_provider');
    expect(r.status).toBe(200);
    expect(r.body.value).toBe('mock');
  });

  it('PUT same key upserts', async () => {
    await request(app).put('/api/settings').send({ key: 'llm_provider', value: 'openai' });
    const r = await request(app).get('/api/settings/llm_provider');
    expect(r.body.value).toBe('openai');
  });

  it('PUT rejects missing key', async () => {
    const r = await request(app).put('/api/settings').send({ value: 'x' });
    expect(r.status).toBe(400);
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