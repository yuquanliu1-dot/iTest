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
    const { groupId } = await seedProject(pool);
    const r = await request(app).post('/api/cases').send({ title: '登录成功', priority: 'P1', groupId });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('登录成功');
  });

  it('GET /api/cases/:id returns case with steps', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'X', groupId });
    const r = await request(app).get(`/api/cases/${c.body.id}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.steps)).toBe(true);
    expect(r.body.steps).toEqual([]);
  });

  it('POST /api/cases/:id/steps appends', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'Y', groupId });
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
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'Z', groupId });
    const r = await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [{ order: 1, source: 'agent', action: { kind: 'click', locator: [] } }],
    });
    expect(r.status).toBe(400);
  });

  it('PUT reorder rewrites order to 1..n', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'R', groupId });
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
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'P', groupId });
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
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'D', groupId });
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
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'N', groupId });
    const r = await request(app).delete(`/api/cases/${c.body.id}/steps/00000000-0000-0000-0000-000000000000`);
    expect(r.status).toBe(404);
  });

  it('POST /api/cases rejects unknown groupId', async () => {
    const r = await request(app).post('/api/cases').send({
      title: 'X',
      groupId: '00000000-0000-0000-0000-000000000000',
    });
    expect(r.status).toBe(404);
  });

  it('GET /api/cases?groupId filters', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    await request(app).post('/api/cases').send({ title: 'in A', groupId: a.groupId });
    await request(app).post('/api/cases').send({ title: 'in B', groupId: b.groupId });
    const r = await request(app).get(`/api/cases?groupId=${a.groupId}`);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].title).toBe('in A');
  });

  it('GET /api/cases?projectId filters across groups', async () => {
    const { projectId, groupId } = await seedProject(pool);
    await request(app).post('/api/cases').send({ title: 'p1', groupId });
    const other = await seedProject(pool);
    await request(app).post('/api/cases').send({ title: 'p2', groupId: other.groupId });
    const r = await request(app).get(`/api/cases?projectId=${projectId}`);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].title).toBe('p1');
  });

  it('GET /api/cases/:id resolves url by chain case > group > project', async () => {
    const { projectId, groupId } = await seedProject(pool);
    await pool.query(`UPDATE projects SET default_url = 'https://proj.test' WHERE id = $1`, [projectId]);
    const c1 = await request(app).post('/api/cases').send({ title: 'inherit', groupId });
    const d1 = await request(app).get(`/api/cases/${c1.body.id}`);
    expect(d1.body.resolvedUrl).toBe('https://proj.test');

    await pool.query(`UPDATE "groups" SET default_url = 'https://group.test' WHERE id = $1`, [groupId]);
    const d2 = await request(app).get(`/api/cases/${c1.body.id}`);
    expect(d2.body.resolvedUrl).toBe('https://group.test');

    const c2 = await request(app).post('/api/cases').send({ title: 'own', groupId, url: 'https://case.test' });
    const d3 = await request(app).get(`/api/cases/${c2.body.id}`);
    expect(d3.body.resolvedUrl).toBe('https://case.test');
  });

  it('PATCH /api/cases/:id moves case to another group', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'move', groupId: a.groupId });
    const r = await request(app).patch(`/api/cases/${c.body.id}`).send({ groupId: b.groupId });
    expect(r.status).toBe(200);
    expect(r.body.groupId).toBe(b.groupId);
  });

  it('PUT /api/cases/:id/steps replaces all steps with name/delayMs', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'R', groupId });
    await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [{ order: 1, source: 'agent', action: { kind: 'navigate', url: 'https://a.com' } }],
    });
    const r = await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        { action: { kind: 'click', locator: [{ strategy: 'text', value: 'Go' }] }, source: 'recorder', name: '点 Go', delayMs: 500 },
        { action: { kind: 'fill', locator: [{ strategy: 'css', value: '#x' }], value: 'v' }, source: 'manual' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.steps).toHaveLength(2);
    expect(r.body.steps[0].order).toBe(1);
    expect(r.body.steps[0].name).toBe('点 Go');
    expect(r.body.steps[0].delayMs).toBe(500);
    expect(r.body.steps[1].name).toBeNull();
    const g = await request(app).get(`/api/cases/${c.body.id}`);
    expect(g.body.steps).toHaveLength(2);
  });

  it('PUT /api/cases/:id/steps compiles aiStep actions via mock LLM', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'AI', groupId });
    const r = await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        { action: { kind: 'aiStep', instruction: '等待主区域', compiled: null }, source: 'manual' },
      ],
    });
    expect(r.status).toBe(200);
    const compiled = r.body.steps[0].action.compiled;
    expect(Array.isArray(compiled)).toBe(true);
    expect(compiled[0].kind).toBe('waitFor');
  });

  it('PUT /api/cases/:id/steps allows empty array (clear all)', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'E', groupId });
    const r = await request(app).put(`/api/cases/${c.body.id}/steps`).send({ steps: [] });
    expect(r.status).toBe(200);
    expect(r.body.steps).toHaveLength(0);
  });

  it('POST /api/cases/:id/steps/recompile returns compiled or null', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'RC', groupId });
    const ok = await request(app).post(`/api/cases/${c.body.id}/steps/recompile`).send({ instruction: '关闭弹窗' });
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.compiled)).toBe(true);
  });
});
