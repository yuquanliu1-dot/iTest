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
let groupId: string;
let defaultVersionId: string;
let v1Id: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { plansRoute } = await import('../src/routes/plans.js');
  const { casesRoute } = await import('../src/routes/cases.js');
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
  app.use('/api/projects/:projectId/plans', plansRoute);
  app.use('/api/plans', plansRoute);
  app.use('/api/cases', casesRoute);
  app.use('/api', environmentsRoute);
  app.use(errorHandler);
}, 60_000);

afterAll(async () => {
  const { pool: p } = await import('../src/db/client.js');
  await p.end().catch(() => undefined);
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE projects, project_versions, "groups", test_cases, test_environments, execution_plans, plan_cases, plan_runs, plan_run_cases, reports, project_assignments, organizations, users CASCADE`);
  resetSeedOrgCache(pool);
  const org = await seedOrg(pool);
  userId = org.userId;
  username = org.username;
  orgId = org.orgId;
  orgPath = org.orgPath;
  const s = await seedProject(pool);
  projectId = s.projectId;
  groupId = s.groupId;
  defaultVersionId = s.versionId;
  const v = await pool.query(
    `INSERT INTO project_versions(project_id, name) VALUES ($1, 'v1.0') RETURNING id`,
    [projectId],
  );
  v1Id = v.rows[0]!.id as string;
});

describe('plan versionId', () => {
  it('POST 不传 versionId 返回 400 version_required', async () => {
    const r = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('version_required');
  });

  it('POST 显式传 versionId 落到指定版本', async () => {
    const r = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId: v1Id });
    expect(r.status).toBe(200);
    expect(r.body.versionId).toBe(v1Id);
  });

  it('POST 传跨项目 versionId 返回 400 version_mismatch', async () => {
    const other = await seedProject(pool);
    const r = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId: other.versionId });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('version_mismatch');
  });

  it('PATCH environmentId 被剥离：计划级环境字段退役（环境归属改到组级），不再校验也不再落库', async () => {
    const env = await request(app).post(`/api/projects/${projectId}/environments`).send({ name: 'e1' });
    expect(env.status).toBe(200);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId: defaultVersionId });
    expect(plan.status).toBe(200);
    // 同项目环境：字段被 zod 剥离，不落计划
    const r = await request(app).patch(`/api/plans/${plan.body.id}`).send({ environmentId: env.body.id });
    expect(r.status).toBe(200);
    expect(r.body.environmentId).toBeNull();
    // 跨项目环境：同样剥离，不再触发 env_project_mismatch
    const other = await seedProject(pool);
    const env2 = await request(app).post(`/api/projects/${other.projectId}/environments`).send({ name: 'other-env' });
    expect(env2.status).toBe(200);
    const r2 = await request(app).patch(`/api/plans/${plan.body.id}`).send({ environmentId: env2.body.id });
    expect(r2.status).toBe(200);
    expect(r2.body.environmentId).toBeNull();
  });

  it('PUT cases 跨版本引用允许', async () => {
    // 创建两个版本下的用例
    const c1 = await request(app).post('/api/cases').send({ title: 'v0', groupId, versionId: defaultVersionId });
    const c2 = await request(app).post('/api/cases').send({ title: 'v1', groupId, versionId: v1Id });
    expect(c1.status).toBe(200);
    expect(c2.status).toBe(200);
    // 计划绑定到 v0（defaultVersionId）
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId: defaultVersionId });
    expect(plan.status).toBe(200);
    // 跨版本引用 c2（v1）到 plan（v0 → 允许）
    const r = await request(app)
      .put(`/api/plans/${plan.body.id}/cases`)
      .send({ caseIds: [c1.body.id, c2.body.id] });
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/plans/${plan.body.id}`);
    expect(detail.body.cases).toHaveLength(2);
  });
});