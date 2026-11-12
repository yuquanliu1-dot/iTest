import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { reportsRoute } = await import('../src/routes/reports.js');
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
  app.use('/api/reports', reportsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

describe('reports', () => {
  it('GET list returns array', async () => {
    const r = await request(app).get('/api/reports');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it('GET /:id 404 for missing', async () => {
    const r = await request(app).get('/api/reports/00000000-0000-0000-0000-000000000000');
    expect(r.status).toBe(404);
  });

  it('GET /:id 出参含执行起止时刻；老报告（无该两列）为 null', async () => {
    const { groupId } = await seedProject(pool);
    const c = await pool.query(`INSERT INTO test_cases(group_id, title) VALUES ($1,'t') RETURNING id`, [groupId]);
    const caseId = c.rows[0]!.id as string;
    const withTiming = await pool.query(
      `INSERT INTO reports(case_id, status, step_results, started_at, finished_at)
       VALUES ($1,'passed','[]'::jsonb, now(), now()) RETURNING id`,
      [caseId],
    );
    const old = await pool.query(
      `INSERT INTO reports(case_id, status, step_results) VALUES ($1,'passed','[]'::jsonb) RETURNING id`,
      [caseId],
    );

    const r = await request(app).get(`/api/reports/${withTiming.rows[0]!.id}`);
    expect(r.status).toBe(200);
    expect(r.body.startedAt).toBeTruthy();
    expect(r.body.finishedAt).toBeTruthy();

    // Old report: fields exist but are null (the frontend hides the corresponding rows based on this, without erroring)
    const r2 = await request(app).get(`/api/reports/${old.rows[0]!.id}`);
    expect(r2.status).toBe(200);
    expect(r2.body.startedAt).toBeNull();
    expect(r2.body.finishedAt).toBeNull();
  });
});