import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { overviewRoute } = await import('../src/routes/overview.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const seed = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(seed.userId, seed.username, seed.orgId, seed.orgPath);
    next();
  });
  app.use('/api/projects', overviewRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('overview', () => {
  it('GET 404 for missing project', async () => {
    const r = await request(app).get('/api/projects/00000000-0000-0000-0000-000000000000/overview');
    expect(r.status).toBe(404);
  });

  it('GET 200 with empty structure for valid project', async () => {
    const org = await seedOrg(pool);
    const p = await pool.query(
      `INSERT INTO projects(organization_id, name) VALUES ($1, 'p1') RETURNING id`,
      [org.orgId],
    );
    const projectId = p.rows[0]!.id;
    const r = await request(app).get(`/api/projects/${projectId}/overview`);
    expect(r.status).toBe(200);
    expect(r.body.kpi.totalCases).toBe(0);
    expect(r.body.trend).toEqual([]);
    expect(r.body.topFailures).toEqual([]);
    expect(r.body.priorityDistribution).toHaveLength(4);
    expect(r.body.plans).toEqual([]);
    expect(r.body.recordingActivity).toEqual([]);
    expect(r.body.aiActivity).toEqual([]);
    expect(r.body.recentRuns).toEqual([]);
  });

  it('GET 400 for invalid range', async () => {
    const org = await seedOrg(pool);
    const p = await pool.query(
      `INSERT INTO projects(organization_id, name) VALUES ($1, 'p2') RETURNING id`,
      [org.orgId],
    );
    const r = await request(app).get(`/api/projects/${p.rows[0]!.id}/overview?range=xx`);
    expect(r.status).toBe(400);
  });
});
