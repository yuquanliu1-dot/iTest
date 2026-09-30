import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { reportsRoute } = await import('../src/routes/reports.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/reports', reportsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
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
});