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
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { stepsRoute } = await import('../src/routes/steps.js');
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
  app.use('/api/cases', casesRoute);
  app.use('/api/cases', stepsRoute);
  app.use(errorHandler);
}, 60_000);

afterAll(async () => {
  const { pool: p } = await import('../src/db/client.js');
  await p.end().catch(() => undefined);
  await pool.end();
  await container.stop();
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
  groupId = s.groupId;
  defaultVersionId = s.versionId;
  const v = await pool.query(
    `INSERT INTO project_versions(project_id, name) VALUES ($1, 'v1.0') RETURNING id`,
    [projectId],
  );
  v1Id = v.rows[0]!.id as string;
});

describe('cases versionId', () => {
  it('POST 不传 versionId 返回 400 version_required', async () => {
    const r = await request(app).post('/api/cases').send({ title: '默认版本用例', groupId });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('version_required');
  });

  it('POST 显式传 versionId 落到指定版本', async () => {
    const r = await request(app).post('/api/cases').send({ title: 'v1 用例', groupId, versionId: v1Id });
    expect(r.status).toBe(200);
    expect(r.body.versionId).toBe(v1Id);
  });

  it('POST 传非本 project versionId 返回 400 version_mismatch', async () => {
    const other = await seedProject(pool);
    const r = await request(app).post('/api/cases').send({ title: 'bad', groupId, versionId: other.versionId });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('version_mismatch');
  });
});

describe('cases cross-version copy', () => {
  it('单条 copy 默认沿用源 case 的版本（同分组内）', async () => {
    const created = await request(app).post('/api/cases').send({ title: '原用例', groupId, versionId: v1Id });
    const r = await request(app).post(`/api/cases/${created.body.id}/copy`).send({ targetGroupId: groupId });
    expect(r.status).toBe(200);
    expect(r.body.versionId).toBe(v1Id);
  });

  it('单条 copy 传 targetVersionId 可跨版本复制', async () => {
    const created = await request(app).post('/api/cases').send({ title: '源 v1', groupId, versionId: v1Id });
    const r = await request(app)
      .post(`/api/cases/${created.body.id}/copy`)
      .send({ targetGroupId: groupId, targetVersionId: defaultVersionId });
    expect(r.status).toBe(200);
    expect(r.body.versionId).toBe(defaultVersionId);
    expect(r.body.title).toBe('源 v1 副本');
  });

  it('单条 copy 传跨项目 versionId 返回 400 version_mismatch', async () => {
    const other = await seedProject(pool);
    const created = await request(app).post('/api/cases').send({ title: '源', groupId, versionId: v1Id });
    const r = await request(app)
      .post(`/api/cases/${created.body.id}/copy`)
      .send({ targetGroupId: groupId, targetVersionId: other.versionId });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('version_mismatch');
  });

  it('批量 copy 接受 targetVersionId', async () => {
    const c1 = await request(app).post('/api/cases').send({ title: 'A', groupId, versionId: v1Id });
    const c2 = await request(app).post('/api/cases').send({ title: 'B', groupId, versionId: v1Id });
    const r = await request(app).post('/api/cases/copy').send({
      caseIds: [c1.body.id, c2.body.id],
      targetGroupId: groupId,
      targetVersionId: v1Id,
    });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    const list = await request(app).get(`/api/cases?groupId=${groupId}`);
    // 2 source + 2 copies = 4
    expect(list.body).toHaveLength(4);
    const copies = list.body.filter((c: { title: string }) => c.title.endsWith('副本'));
    expect(copies.every((c: { versionId: string }) => c.versionId === v1Id)).toBe(true);
  });
});