import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let pool: Pool;
let app: import('express').Express;
let projectId: string;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  ({ projectId } = await seedProject(pool));
  const { default: express } = await import('express');
  const { requirementsRoute } = await import('../src/routes/requirements.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  // Inject the seeded org manager identity (skips real login; visibility checks depend on the managerOrgPaths subtree).
  // helpers/auth depends on the src service chain (which loads the db client), so it must be dynamically imported after DATABASE_URL points at the test container.
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/projects/:projectId/requirements', requirementsRoute);
  app.use('/api/requirements', requirementsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

describe('project requirements', () => {
  it('POST creates under project', async () => {
    const { projectId: pid } = await seedProject(pool);
    const r = await request(app).post(`/api/projects/${pid}/requirements`).send({ title: '登录需求', content: 'desc' });
    expect(r.status).toBe(200);
    expect(r.body.projectId).toBe(pid);
  });

  it('GET lists only project requirements', async () => {
    const other = await seedProject(pool);
    await request(app).post(`/api/projects/${other.projectId}/requirements`).send({ title: 'other', content: 'x' });
    await request(app).post(`/api/projects/${projectId}/requirements`).send({ title: 'mine', content: 'y' });
    const r = await request(app).get(`/api/projects/${projectId}/requirements`);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].title).toBe('mine');
  });

  it('POST to unknown project returns 404', async () => {
    const r = await request(app)
      .post('/api/projects/00000000-0000-0000-0000-000000000000/requirements')
      .send({ title: 'x', content: 'y' });
    expect(r.status).toBe(404);
  });
});