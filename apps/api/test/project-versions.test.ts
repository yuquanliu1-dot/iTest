import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject, seedOrg, resetSeedOrgCache } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let userId: string;
let username: string;
let orgId: string;
let orgPath: string;
let projectId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { projectVersionsRoute } = await import('../src/routes/projectVersions.js');
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
  app.use('/api', projectVersionsRoute);
  app.use(errorHandler);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE projects, project_versions, "groups", test_cases, test_environments, execution_plans, project_assignments, organizations, users CASCADE`);
  resetSeedOrgCache(pool);
  // 重建缓存的种子组织（TRUNCATE 后 org 被删，注入身份里的 orgId 已无效）
  const org = await seedOrg(pool);
  userId = org.userId;
  username = org.username;
  orgId = org.orgId;
  orgPath = org.orgPath;
  const s = await seedProject(pool);
  projectId = s.projectId;
});

describe('project versions', () => {
  it('GET /projects/:id/versions 列出 v0', async () => {
    const r = await request(app).get(`/api/projects/${projectId}/versions`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].name).toBe('v0');
    expect(r.body[0].isDefault).toBe(true);
  });

  it('POST /projects/:id/versions 新建并返回 201', async () => {
    const r = await request(app)
      .post(`/api/projects/${projectId}/versions`)
      .send({ name: 'v1.0', description: 'first release' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('v1.0');
    expect(r.body.isDefault).toBe(false);
  });

  it('POST /projects/:id/versions defaultUrl 落库并随 GET 返回', async () => {
    const cr = await request(app)
      .post(`/api/projects/${projectId}/versions`)
      .send({ name: 'v1.0', defaultUrl: 'https://staging.example.com' });
    expect(cr.status).toBe(201);
    expect(cr.body.defaultUrl).toBe('https://staging.example.com');

    const list = await request(app).get(`/api/projects/${projectId}/versions`);
    const v = list.body.find((x: { id: string }) => x.id === cr.body.id);
    expect(v.defaultUrl).toBe('https://staging.example.com');
  });

  it('PATCH /project-versions/:id 清空 defaultUrl（空串 → null）', async () => {
    const cr = await request(app)
      .post(`/api/projects/${projectId}/versions`)
      .send({ name: 'v1.0', defaultUrl: 'https://staging.example.com' });
    expect(cr.status).toBe(201);

    const r = await request(app)
      .patch(`/api/project-versions/${cr.body.id}`)
      .send({ defaultUrl: null });
    expect(r.status).toBe(200);
    expect(r.body.defaultUrl).toBeNull();
  });

  it('同名 version 返回 409 version_name_taken', async () => {
    const r = await request(app)
      .post(`/api/projects/${projectId}/versions`)
      .send({ name: 'v0' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('version_name_taken');
  });

  it('POST /project-versions/:id/set-default 切换默认', async () => {
    const cr = await request(app)
      .post(`/api/projects/${projectId}/versions`)
      .send({ name: 'v1.0' });
    const newId = cr.body.id as string;
    const r = await request(app).post(`/api/project-versions/${newId}/set-default`);
    expect(r.status).toBe(204);
    const list = await request(app).get(`/api/projects/${projectId}/versions`);
    const def = list.body.find((v: { isDefault: boolean }) => v.isDefault);
    expect(def.id).toBe(newId);
  });

  it('删除最后一个版本返回 400 last_version', async () => {
    const list = await request(app).get(`/api/projects/${projectId}/versions`);
    const r = await request(app).delete(`/api/project-versions/${list.body[0].id}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('last_version');
  });

  it('删除非空 version 返回 400 version_not_empty + 计数', async () => {
    // 先建第二个版本，否则只有一个版本会被 last_version 拦截
    await request(app)
      .post(`/api/projects/${projectId}/versions`)
      .send({ name: 'v1.0' });
    await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title) VALUES ((SELECT id FROM "groups" WHERE project_id=$1), (SELECT id FROM project_versions WHERE project_id=$1 AND is_default), 'x')`,
      [projectId],
    );
    const list = await request(app).get(`/api/projects/${projectId}/versions`);
    const r = await request(app).delete(`/api/project-versions/${list.body[0].id}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('version_not_empty');
    expect(r.body.details?.caseCount).toBeGreaterThanOrEqual(1);
  });
});