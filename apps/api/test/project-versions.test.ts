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
}, 30_000);

describe('project versions', () => {
  it('GET /projects/:id/versions 列出 v0', async () => {
    const r = await request(app).get(`/api/projects/${projectId}/versions`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].name).toBe('v0');
  });

  it('POST /projects/:id/versions 新建并返回 201', async () => {
    const r = await request(app)
      .post(`/api/projects/${projectId}/versions`)
      .send({ name: 'v1.0', description: 'first release' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('v1.0');
  });

  it('同名 version 返回 409 version_name_taken', async () => {
    const r = await request(app)
      .post(`/api/projects/${projectId}/versions`)
      .send({ name: 'v0' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('version_name_taken');
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
      `INSERT INTO test_cases(group_id, version_id, title) VALUES ((SELECT id FROM "groups" WHERE project_id=$1), (SELECT id FROM project_versions WHERE project_id=$1 AND name='v0'), 'x')`,
      [projectId],
    );
    // 显式删除 v0（此版本的用例计数 ≥1）而非 list.body[0]——GET 列表按 created_at 排序,
    // v0/v1.0 同毫秒时会乱序,list.body[0] 可能命中空版本导致误断言（时敏 flake）
    const v0 = (await pool.query(`SELECT id FROM project_versions WHERE project_id=$1 AND name='v0'`, [projectId])).rows[0] as { id: string };
    const r = await request(app).delete(`/api/project-versions/${v0.id}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('version_not_empty');
    expect(r.body.details?.caseCount).toBeGreaterThanOrEqual(1);
  });

  it('PATCH environmentId 关联环境并随 GET 返回 environmentName', async () => {
    const env = await pool.query(
      `INSERT INTO test_environments(project_id, name) VALUES ($1, 'staging-env') RETURNING id`,
      [projectId],
    );
    const envId = env.rows[0]!.id as string;
    const cr = await request(app).post(`/api/projects/${projectId}/versions`).send({ name: 'v1.0' });
    expect(cr.status).toBe(201);
    const r = await request(app).patch(`/api/project-versions/${cr.body.id}`).send({ environmentId: envId });
    expect(r.status).toBe(200);
    expect(r.body.environmentId).toBe(envId);
    const list = await request(app).get(`/api/projects/${projectId}/versions`);
    const v = list.body.find((x: { id: string }) => x.id === cr.body.id);
    expect(v.environmentName).toBe('staging-env');
  });

  it('PATCH environmentId 跨项目环境返回 400 env_project_mismatch', async () => {
    const other = await seedProject(pool);
    const env = await pool.query(
      `INSERT INTO test_environments(project_id, name) VALUES ($1, 'other-env') RETURNING id`,
      [other.projectId],
    );
    const cr = await request(app).post(`/api/projects/${projectId}/versions`).send({ name: 'v1.0' });
    const r = await request(app).patch(`/api/project-versions/${cr.body.id}`).send({ environmentId: env.rows[0]!.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('env_project_mismatch');
  });

  it('PATCH environmentId null 清除关联', async () => {
    const env = await pool.query(
      `INSERT INTO test_environments(project_id, name) VALUES ($1, 'staging-env') RETURNING id`,
      [projectId],
    );
    const cr = await request(app).post(`/api/projects/${projectId}/versions`).send({ name: 'v1.0' });
    await request(app).patch(`/api/project-versions/${cr.body.id}`).send({ environmentId: env.rows[0]!.id });
    const r = await request(app).patch(`/api/project-versions/${cr.body.id}`).send({ environmentId: null });
    expect(r.status).toBe(200);
    expect(r.body.environmentId).toBeNull();
    const list = await request(app).get(`/api/projects/${projectId}/versions`);
    const v = list.body.find((x: { id: string }) => x.id === cr.body.id);
    expect(v.environmentName).toBeNull();
  });

  it('POST 带 environmentId 创建关联并随 GET 返回 environmentName', async () => {
    const env = await pool.query(
      `INSERT INTO test_environments(project_id, name) VALUES ($1, 'staging-env') RETURNING id`,
      [projectId],
    );
    const envId = env.rows[0]!.id as string;
    const r = await request(app).post(`/api/projects/${projectId}/versions`).send({ name: 'v2.0', environmentId: envId });
    expect(r.status).toBe(201);
    expect(r.body.environmentId).toBe(envId);
    const list = await request(app).get(`/api/projects/${projectId}/versions`);
    const v = list.body.find((x: { id: string }) => x.id === r.body.id);
    expect(v.environmentName).toBe('staging-env');
  });

  it('POST 缺省 environmentId → null', async () => {
    const r = await request(app).post(`/api/projects/${projectId}/versions`).send({ name: 'v2.0' });
    expect(r.status).toBe(201);
    expect(r.body.environmentId).toBeNull();
  });

  it('POST 跨项目环境返回 400 env_project_mismatch', async () => {
    const other = await seedProject(pool);
    const env = await pool.query(
      `INSERT INTO test_environments(project_id, name) VALUES ($1, 'other-env') RETURNING id`,
      [other.projectId],
    );
    const r = await request(app)
      .post(`/api/projects/${projectId}/versions`)
      .send({ name: 'v2.0', environmentId: env.rows[0]!.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('env_project_mismatch');
  });
});