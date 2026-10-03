import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let reqId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: exp } = await import('express');
  app = exp();
  app.use(exp.json());
  const { requirementsRoute } = await import('../src/routes/requirements.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use((req, _res, next) => { req.user = managerUserOf(userId, username, orgId, orgPath); next(); });
  app.use('/api/requirements', requirementsRoute);
  app.use(errorHandler);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_workspace_state, ai_scenarios, ai_cases, ai_threads RESTART IDENTITY CASCADE`);
  const { projectId } = await seedProject(pool);
  const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
  reqId = r.rows[0]!.id as string;
});

describe('context-mode 端点', () => {
  it('POST /:id/ai-workspace/context-mode 写 doc', async () => {
    const res = await request(app)
      .post(`/api/requirements/${reqId}/ai-workspace/context-mode`)
      .send({ mode: 'repo' });
    expect(res.status).toBe(204);
    const ws = await import('../src/pi/workspace.js');
    const d = await ws.loadDoc(reqId);
    expect(d.contextMode).toBe('repo');
  });

  it('无效 mode 返回 400', async () => {
    const res = await request(app)
      .post(`/api/requirements/${reqId}/ai-workspace/context-mode`)
      .send({ mode: 'banana' });
    expect(res.status).toBe(400);
  });

  it('page 与 auto 模式都能写入', async () => {
    const r1 = await request(app)
      .post(`/api/requirements/${reqId}/ai-workspace/context-mode`)
      .send({ mode: 'page' });
    expect(r1.status).toBe(204);
    const ws = await import('../src/pi/workspace.js');
    expect((await ws.loadDoc(reqId)).contextMode).toBe('page');
    const r2 = await request(app)
      .post(`/api/requirements/${reqId}/ai-workspace/context-mode`)
      .send({ mode: 'auto' });
    expect(r2.status).toBe(204);
    expect((await ws.loadDoc(reqId)).contextMode).toBe('auto');
  });
});