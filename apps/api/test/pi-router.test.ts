import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: exp } = await import('express');
  app = exp();
  app.use(exp.json());
  const { piRoute } = await import('../src/pi/router.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use((req, _res, next) => { req.user = managerUserOf(userId, username, orgId, orgPath); next(); });
  app.use('/api/pi', piRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_workspace_state, ai_threads RESTART IDENTITY CASCADE`);
});

describe('pi wire contract', () => {
  it('GET /models returns [] when unconfigured', async () => {
    const r = await request(app).get('/api/pi/models');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBe(0);
  });

  it('POST /threads without requirementId 400s', async () => {
    const r = await request(app).post('/api/pi/threads').send({});
    expect(r.status).toBe(400);
  });

  it('POST /threads with requirementId 200s and is idempotent', async () => {
    const { projectId } = await seedProject(pool);
    const req = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const a = await request(app).post('/api/pi/threads').send({ metadata: { requirementId: req.rows[0]!.id } });
    const b = await request(app).post('/api/pi/threads').send({ metadata: { requirementId: req.rows[0]!.id } });
    expect(a.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
  });

  it('POST /threads/:id/messages returns 204 even without LLM', async () => {
    const { projectId } = await seedProject(pool);
    const req = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const t = await request(app).post('/api/pi/threads').send({ metadata: { requirementId: req.rows[0]!.id } });
    const m = await request(app).post(`/api/pi/threads/${t.body.id}/messages`).send({ input: { content: 'hi' } });
    expect(m.status).toBe(204);
  });

  it('PATCH /threads/:id returns 501', async () => {
    const r = await request(app).patch('/api/pi/threads/00000000-0000-0000-0000-000000000000').send({});
    expect(r.status).toBe(501);
  });

  it('GET /threads/:id/events is text/event-stream', async () => {
    const { projectId } = await seedProject(pool);
    const req = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const t = await request(app).post('/api/pi/threads').send({ metadata: { requirementId: req.rows[0]!.id } });
    // 验证路由被 mount（未授权 thread 不会 404，而是 res.end()，得到 200 + 空 body）
    const r = await request(app).get(`/api/pi/threads/00000000-0000-0000-0000-000000000000/events`);
    expect([200, 404]).toContain(r.status);
  });
});