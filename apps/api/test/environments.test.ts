import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let projectId: string;
let userId: string;
let username: string;
let orgId: string;
let orgPath: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { environmentsRoute } = await import('../src/routes/environments.js');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const seed = await seedOrg(pool);
  userId = seed.userId; username = seed.username; orgId = seed.orgId; orgPath = seed.orgPath;
  const seeded = await seedProject(pool, orgId);
  projectId = seeded.projectId;
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api', environmentsRoute);
  app.use('/api/cases', casesRoute);
  app.use(errorHandler);
}, 60000);

afterAll(async () => {
  const { pool: p } = await import('../src/db/client.js');
  await p.end().catch(() => undefined);
  await pool.end();
  await container.stop();
});

describe('environments CRUD', () => {
  it('creates an env with encrypted password and masks response', async () => {
    const r = await request(app).post(`/api/projects/${projectId}/environments`).send({
      name: 'staging', dbHost: 'pg', dbPort: 5432, dbName: 'app', dbUser: 'app', dbPassword: 'hunter2',
    });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('staging');
    expect(r.body.dbPasswordCiphertext).toBe('••••••••');
  });

  it('PATCH preserves password when not provided', async () => {
    const list = await request(app).get(`/api/projects/${projectId}/environments`);
    const id = list.body[0]!.id;
    const r = await request(app).patch(`/api/environments/${id}`).send({ name: 'staging-renamed' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('staging-renamed');
    expect(r.body.dbPasswordCiphertext).toBe('••••••••');
  });

  it('DELETE requires confirm when cases reference the env', async () => {
    const list = await request(app).get(`/api/projects/${projectId}/environments`);
    const envId = list.body[0]!.id;
    const group = await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, 'g') RETURNING id`, [projectId]);
    const c = await pool.query(`INSERT INTO test_cases(group_id, title, default_env_id) VALUES ($1, 't1', $2) RETURNING id, default_env_id`, [group.rows[0]!.id, envId]);
    const noConfirm = await request(app).delete(`/api/environments/${envId}`);
    expect(noConfirm.status).toBe(200);
    expect(noConfirm.body.requiresConfirm).toBe(true);
    expect(noConfirm.body.caseCount).toBe(1);
    const confirmed = await request(app).delete(`/api/environments/${envId}?confirm=true`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.ok).toBe(true);
    const check = await pool.query(`SELECT default_env_id FROM test_cases WHERE id=$1`, [c.rows[0]!.id]);
    expect(check.rows[0]!.default_env_id).toBeNull();
  });

  it('allowed-tables returns the whitelist', async () => {
    const r = await request(app).get('/api/environments/allowed-tables');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('reports');
    expect(r.body.reports).toContain('id');
    expect(r.body.reports).toContain('status');
  });
});