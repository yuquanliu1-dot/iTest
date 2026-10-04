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

function readSecret(payload: unknown): { c: string; i: string; t: string } | undefined {
  return (payload as { secret?: { c: string; i: string; t: string } }).secret;
}

describe('environments CRUD', () => {
  it('creates an env with a db object; password encrypted, secret masked in response', async () => {
    const r = await request(app).post(`/api/projects/${projectId}/environments`).send({
      name: 'staging',
      objects: [{ objectType: 'db', payload: { host: 'pg', port: 5432, dbName: 'app', user: 'app', password: 'hunter2' }, isDefault: true }],
    });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('staging');
    expect(r.body.objects).toHaveLength(1);
    expect(r.body.objects[0].objectType).toBe('db');
    expect(r.body.objects[0].payload.secret).toBe('••••••••');
    expect(r.body.objects[0].payload.password).toBeUndefined();
    // 密文真实落库（AES 三元组 base64）
    const row = await pool.query(`SELECT payload FROM environment_objects WHERE environment_id=$1`, [r.body.id]);
    const secret = readSecret(row.rows[0]!.payload);
    expect(secret?.c).toBeTruthy();
    expect(secret!.c).not.toContain('hunter2');
  });

  it('POST duplicate env name → 409 name_conflict', async () => {
    const r = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'staging' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('name_conflict');
  });

  it('POST baseUrl 落库并随 GET 返回', async () => {
    const r = await request(app).post(`/api/projects/${projectId}/environments`).send({
      name: 'env-with-url',
      baseUrl: 'https://pre.example.com',
    });
    expect(r.status).toBe(200);
    expect(r.body.baseUrl).toBe('https://pre.example.com');
    const list = await request(app).get(`/api/projects/${projectId}/environments`);
    const env = list.body.find((e: { id: string }) => e.id === r.body.id);
    expect(env.baseUrl).toBe('https://pre.example.com');
  });

  it('PATCH baseUrl null 清空', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/environments`).send({
      name: 'clear-url',
      baseUrl: 'https://tmp.example.com',
    });
    const r = await request(app).patch(`/api/environments/${created.body.id}`).send({ baseUrl: null });
    expect(r.status).toBe(200);
    expect(r.body.baseUrl).toBeNull();
  });

  it('GET lists all project envs with objects', async () => {
    await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'syslog-env', objects: [{ objectType: 'syslog', payload: { host: 'log', user: 'root', filePath: '/var/log/app.log' } }] });
    const r = await request(app).get(`/api/projects/${projectId}/environments`);
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThanOrEqual(2);
    const syslogEnv = r.body.find((e: { name: string }) => e.name === 'syslog-env');
    expect(syslogEnv.objects).toHaveLength(1);
    expect(syslogEnv.objects[0].objectType).toBe('syslog');
  });

  it('PATCH env sets isDefault and clears project siblings', async () => {
    const a = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'pre-prod' });
    const r = await request(app).patch(`/api/environments/${a.body.id}`).send({ isDefault: true });
    expect(r.status).toBe(200);
    expect(r.body.isDefault).toBe(true);
    const list = await request(app).get(`/api/projects/${projectId}/environments`);
    const defaults = list.body.filter((e: { isDefault: boolean }) => e.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(a.body.id);
  });

  it('object PATCH replaces payload and preserves secret when password left empty', async () => {
    const env = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'obj-env' });
    const obj = await request(app).post(`/api/environments/${env.body.id}/objects`).send({
      objectType: 'db', payload: { host: 'a.db', dbName: 'app', user: 'u', password: 'p1' },
    });
    expect(obj.status).toBe(200);
    const upd = await request(app).patch(`/api/environment-objects/${obj.body.id}`).send({
      payload: { host: 'b.db', dbName: 'app', user: 'u', password: '' },
    });
    expect(upd.status).toBe(200);
    expect(upd.body.payload.host).toBe('b.db');
    expect(upd.body.payload.secret).toBe('••••••••');
    // 旧密文保留且可解出原密码
    const row = await pool.query(`SELECT payload FROM environment_objects WHERE id=$1`, [obj.body.id]);
    const secret = readSecret(row.rows[0]!.payload)!;
    const { decrypt } = await import('../src/lib/secret-crypto.js');
    expect(decrypt({ ciphertext: Buffer.from(secret.c, 'base64'), iv: Buffer.from(secret.i, 'base64'), tag: Buffer.from(secret.t, 'base64') })).toBe('p1');
  });

  it('object PATCH with a new password replaces the secret', async () => {
    const env = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'rekey-env' });
    const obj = await request(app).post(`/api/environments/${env.body.id}/objects`).send({
      objectType: 'db', payload: { host: 'a.db', dbName: 'app', user: 'u', password: 'p1' },
    });
    await request(app).patch(`/api/environment-objects/${obj.body.id}`).send({
      payload: { host: 'a.db', dbName: 'app', user: 'u', password: 'p2' },
    });
    const row = await pool.query(`SELECT payload FROM environment_objects WHERE id=$1`, [obj.body.id]);
    const secret = readSecret(row.rows[0]!.payload)!;
    const { decrypt } = await import('../src/lib/secret-crypto.js');
    expect(decrypt({ ciphertext: Buffer.from(secret.c, 'base64'), iv: Buffer.from(secret.i, 'base64'), tag: Buffer.from(secret.t, 'base64') })).toBe('p2');
  });

  it('deleting the default object promotes the earliest sibling', async () => {
    const env = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'promote-env' });
    const first = await request(app).post(`/api/environments/${env.body.id}/objects`).send({ objectType: 'syslog', payload: { host: 'l1' }, isDefault: true });
    const second = await request(app).post(`/api/environments/${env.body.id}/objects`).send({ objectType: 'syslog', payload: { host: 'l2' } });
    const del = await request(app).delete(`/api/environment-objects/${first.body.id}`);
    expect(del.status).toBe(200);
    const after = await pool.query(`SELECT id, is_default FROM environment_objects WHERE environment_id=$1`, [env.body.id]);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].id).toBe(second.body.id);
    expect(after.rows[0].is_default).toBe(true);
  });

  it('DELETE requires confirm when cases reference the env', async () => {
    const list = await request(app).get(`/api/projects/${projectId}/environments`);
    const envId = list.body[0]!.id;
    const group = await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, 'g') RETURNING id`, [projectId]);
    const c = await pool.query(`INSERT INTO test_cases(group_id, title, default_env_id) VALUES ($1, 't1', $2) RETURNING id`, [group.rows[0]!.id, envId]);
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

  it('allowed-tables returns the whitelist incl. environment_objects (no payload column)', async () => {
    const r = await request(app).get('/api/environments/allowed-tables');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('reports');
    expect(r.body.reports).toContain('status');
    expect(r.body.environment_objects).toContain('object_type');
    expect(r.body.environment_objects).not.toContain('payload');
  });
});
