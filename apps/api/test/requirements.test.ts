import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { requirementsRoute } = await import('../src/routes/requirements.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/requirements', requirementsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('requirements CRUD', () => {
  it('POST creates', async () => {
    const { projectId } = await seedProject(pool);
    const r = await request(app).post('/api/requirements').send({ title: '登录功能', content: '手机号+密码', projectId });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('登录功能');
    expect(r.body.id).toBeTruthy();
  });

  it('GET list returns created', async () => {
    const r = await request(app).get('/api/requirements');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBeGreaterThan(0);
  });

  it('GET /:id returns detail', async () => {
    const { projectId } = await seedProject(pool);
    const c = await request(app).post('/api/requirements').send({ title: '注册', content: '手机号注册', projectId });
    const r = await request(app).get(`/api/requirements/${c.body.id}`);
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('注册');
  });

  it('POST rejects empty title', async () => {
    const { projectId } = await seedProject(pool);
    const r = await request(app).post('/api/requirements').send({ title: '', content: 'x', projectId });
    expect(r.status).toBe(400);
  });

  it('GET /:id 404 for missing', async () => {
    const r = await request(app).get('/api/requirements/00000000-0000-0000-0000-000000000000');
    expect(r.status).toBe(404);
  });
});