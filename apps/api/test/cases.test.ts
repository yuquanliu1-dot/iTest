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
    CREATE TABLE requirements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title varchar(200) NOT NULL, content text NOT NULL, status varchar(20) NOT NULL DEFAULT 'draft', created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE test_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requirement_id uuid REFERENCES requirements(id) ON DELETE CASCADE, title varchar(200) NOT NULL, description text, priority varchar(20) NOT NULL DEFAULT 'P1', status varchar(20) NOT NULL DEFAULT 'draft', created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE test_steps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, "order" integer NOT NULL, source varchar(20) NOT NULL, action jsonb NOT NULL, assertion jsonb, created_at timestamp NOT NULL DEFAULT now());
  `);
  const { default: express } = await import('express');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { stepsRoute } = await import('../src/routes/steps.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/cases', casesRoute);
  app.use('/api/cases', stepsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('cases + steps', () => {
  it('POST /api/cases creates', async () => {
    const r = await request(app).post('/api/cases').send({ title: '登录成功', priority: 'P1' });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('登录成功');
  });

  it('GET /api/cases/:id returns case with steps', async () => {
    const c = await request(app).post('/api/cases').send({ title: 'X' });
    const r = await request(app).get(`/api/cases/${c.body.id}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.steps)).toBe(true);
    expect(r.body.steps).toEqual([]);
  });

  it('POST /api/cases/:id/steps appends', async () => {
    const c = await request(app).post('/api/cases').send({ title: 'Y' });
    const r = await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        { order: 1, source: 'agent', action: { kind: 'navigate', url: 'https://example.com/login' } },
        { order: 2, source: 'agent', action: { kind: 'click', locator: [{ strategy: 'role', value: 'button[name="登录"]' }] } },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
  });

  it('POST /api/cases/:id/steps validates DSL', async () => {
    const c = await request(app).post('/api/cases').send({ title: 'Z' });
    const r = await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [{ order: 1, source: 'agent', action: { kind: 'click', locator: [] } }],
    });
    expect(r.status).toBe(400);
  });

  it('PUT reorder rewrites order to 1..n', async () => {
    const c = await request(app).post('/api/cases').send({ title: 'R' });
    const appended = await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [1, 2, 3].map((order) => ({
        order,
        source: 'agent',
        action: { kind: 'navigate', url: `https://x.test/${order}` },
      })),
    });
    const ids = appended.body.steps.map((s: { id: string }) => s.id) as string[];
    const reversed = [...ids].reverse();
    const r = await request(app)
      .put(`/api/cases/${c.body.id}/steps/reorder`)
      .send({ stepIds: reversed });
    expect(r.status).toBe(200);
    expect(r.body.steps.map((s: { id: string }) => s.id)).toEqual(reversed);
    expect(r.body.steps.map((s: { order: number }) => s.order)).toEqual([1, 2, 3]);
  });

  it('PUT reorder rejects partial id list', async () => {
    const c = await request(app).post('/api/cases').send({ title: 'P' });
    const appended = await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [1, 2].map((order) => ({
        order,
        source: 'agent',
        action: { kind: 'navigate', url: 'https://x.test' },
      })),
    });
    const ids = appended.body.steps.map((s: { id: string }) => s.id) as string[];
    const r = await request(app)
      .put(`/api/cases/${c.body.id}/steps/reorder`)
      .send({ stepIds: [ids[0]] });
    expect(r.status).toBe(400);
  });

  it('DELETE step removes it and compacts order', async () => {
    const c = await request(app).post('/api/cases').send({ title: 'D' });
    const appended = await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [1, 2, 3].map((order) => ({
        order,
        source: 'agent',
        action: { kind: 'navigate', url: `https://x.test/${order}` },
      })),
    });
    const ids = appended.body.steps.map((s: { id: string }) => s.id) as string[];
    const r = await request(app).delete(`/api/cases/${c.body.id}/steps/${ids[1]}`);
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/cases/${c.body.id}`);
    expect(detail.body.steps).toHaveLength(2);
    expect(detail.body.steps.map((s: { order: number }) => s.order)).toEqual([1, 2]);
  });

  it('DELETE unknown step returns 404', async () => {
    const c = await request(app).post('/api/cases').send({ title: 'N' });
    const r = await request(app).delete(`/api/cases/${c.body.id}/steps/00000000-0000-0000-0000-000000000000`);
    expect(r.status).toBe(404);
  });
});