import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { MySqlContainer, StartedMySqlContainer } from '@testcontainers/mysql';
import { SCHEMA_SQL, seedProject, seedOrg, resetSeedOrgCache } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let mysqlContainer: StartedMySqlContainer;
let pool: Pool;
let app: import('express').Express;
let userId: string;
let username: string;
let orgId: string;
let orgPath: string;
let projectId: string;
let defaultVersionId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  mysqlContainer = await new MySqlContainer('mysql:8.0').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { environmentsRoute } = await import('../src/routes/environments.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const org = await seedOrg(pool);
  userId = org.userId;
  username = org.username;
  orgId = org.orgId;
  orgPath = org.orgPath;
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api', environmentsRoute);
  app.use(errorHandler);
}, 120_000);

afterAll(async () => {
  const { pool: p } = await import('../src/db/client.js');
  await p.end().catch(() => undefined);
  await pool.end();
  await container.stop();
  await mysqlContainer.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE projects, project_versions, "groups", test_cases, test_environments, execution_plans, project_assignments, organizations, users CASCADE`);
  resetSeedOrgCache(pool);
  const org = await seedOrg(pool);
  userId = org.userId;
  username = org.username;
  orgId = org.orgId;
  orgPath = org.orgPath;
  const s = await seedProject(pool);
  projectId = s.projectId;
  defaultVersionId = s.versionId;
});

describe('environments project-level model', () => {
  it('POST 创建项目级环境（不再有 versionId 语义）', async () => {
    const r = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'dev-test' });
    expect(r.status).toBe(200);
    expect(r.body.projectId).toBe(projectId);
    expect(r.body.versionId).toBeUndefined();
    expect(r.body.objects).toEqual([]);
  });

  it('GET 返回项目全部环境（跨版本共享，无 versionId 过滤）', async () => {
    await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'dev-test' });
    await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'pre-prod' });
    const r = await request(app).get(`/api/projects/${projectId}/environments`);
    expect(r.status).toBe(200);
    expect(r.body.map((e: { name: string }) => e.name).sort()).toEqual(['dev-test', 'pre-prod']);
  });

  it('项目内至多一个默认环境（切换默认互斥）', async () => {
    const a = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'dev-test' });
    const b = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'pre-prod' });
    await request(app).patch(`/api/environments/${a.body.id}`).send({ isDefault: true });
    await request(app).patch(`/api/environments/${b.body.id}`).send({ isDefault: true });
    const r = await request(app).get(`/api/projects/${projectId}/environments`);
    const defaults = r.body.filter((e: { isDefault: boolean }) => e.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(b.body.id);
  });

  it('DELETE 后 project_versions.environment_id 自动置空（SET NULL）', async () => {
    const env = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'linked-env' });
    await pool.query(`UPDATE project_versions SET environment_id=$1 WHERE id=$2`, [env.body.id, defaultVersionId]);
    const r = await request(app).delete(`/api/environments/${env.body.id}?confirm=true`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const v = await pool.query(`SELECT environment_id FROM project_versions WHERE id=$1`, [defaultVersionId]);
    expect(v.rows[0]!.environment_id).toBeNull();
  });
});

describe('POST /environments/test-db 连接测试', () => {
  const conn = () => ({
    host: container.getHost(),
    port: container.getMappedPort(5432),
    dbName: container.getDatabase(),
    user: container.getUsername(),
  });

  it('正确凭据 → 200 ok:true + latencyMs', async () => {
    const r = await request(app).post('/api/environments/test-db').send({ ...conn(), password: container.getPassword() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('错误密码 → 200 ok:false（探测失败不抛 HTTP 错误）', async () => {
    const r = await request(app).post('/api/environments/test-db').send({ ...conn(), password: 'definitely-wrong' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(typeof r.body.error).toBe('string');
  });

  it('编辑态密码留空 → objectId 回退已存密文', async () => {
    const env = await request(app).post(`/api/projects/${projectId}/environments`).send({
      name: 'has-db',
      objects: [{ objectType: 'db', payload: { ...conn(), password: container.getPassword() } }],
    });
    const obj = env.body.objects.find((o: { objectType: string }) => o.objectType === 'db');
    const r = await request(app).post('/api/environments/test-db').send({ ...conn(), objectId: obj.id });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('objectId 不存在 → 404', async () => {
    const r = await request(app)
      .post('/api/environments/test-db')
      .send({ ...conn(), objectId: '00000000-0000-4000-8000-000000000000' });
    expect(r.status).toBe(404);
  });

  it('缺 host → 400', async () => {
    const r = await request(app).post('/api/environments/test-db').send({ dbName: 'x', user: 'y' });
    expect(r.status).toBe(400);
  });
});

describe('test-db mysql 方言', () => {
  const mconn = () => ({
    host: mysqlContainer.getHost(),
    port: mysqlContainer.getMappedPort(3306),
    dbName: mysqlContainer.getDatabase(),
    user: mysqlContainer.getUsername(),
    dbType: 'mysql' as const,
  });

  it('正确凭据 → 200 ok:true', async () => {
    const r = await request(app).post('/api/environments/test-db').send({ ...mconn(), password: mysqlContainer.getUserPassword() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('错误密码 → 200 ok:false', async () => {
    const r = await request(app).post('/api/environments/test-db').send({ ...mconn(), password: 'definitely-wrong' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(typeof r.body.error).toBe('string');
  });
});

describe('POST /environments/test-syslog', () => {
  it('缺 host → 400', async () => {
    const r = await request(app).post('/api/environments/test-syslog').send({
      user: 'u', filePath: '/var/log/syslog', authType: 'password', password: 'x',
    });
    expect(r.status).toBe(400);
  });

  it('objectId 不存在 → 404', async () => {
    const r = await request(app).post('/api/environments/test-syslog').send({
      host: 'h', user: 'u', filePath: '/var/log/syslog', authType: 'key',
      objectId: '00000000-0000-4000-8000-000000000000',
    });
    expect(r.status).toBe(404);
  });
});
