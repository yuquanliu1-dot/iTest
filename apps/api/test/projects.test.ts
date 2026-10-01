import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { projectsRoute } = await import('../src/routes/projects.js');
  const { groupsRoute } = await import('../src/routes/groups.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  // 注入种子组织管理员身份（跳过真实登录；可见性判定依赖 managerOrgPaths 子树）。
  // helpers/auth 依赖 src 服务链（连带加载 db client），须等 DATABASE_URL 指向测试容器后再动态加载。
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/projects', projectsRoute);
  app.use('/api/groups', groupsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('projects', () => {
  it('POST creates, GET lists with caseCount', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'CueCast 官网', description: '官网回归', defaultUrl: 'https://cuecast.test' });
    expect(created.status).toBe(200);
    expect(created.body.name).toBe('CueCast 官网');
    expect(created.body.description).toBe('官网回归');

    await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, 'g1')`, [created.body.id]);
    const g = await pool.query(`SELECT id FROM "groups" WHERE project_id = $1`, [created.body.id]);
    await pool.query(
      `INSERT INTO test_cases(title, group_id) VALUES ('c1', $1), ('c2', $1)`,
      [g.rows[0]!.id],
    );

    const list = await request(app).get('/api/projects');
    const mine = list.body.find((p: { id: string }) => p.id === created.body.id);
    expect(mine.caseCount).toBe(2);
  });

  it('PATCH renames and updates defaultUrl', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'P' });
    const r = await request(app).patch(`/api/projects/${created.body.id}`).send({ name: 'P2', description: '新描述', defaultUrl: 'https://x.test' });
    expect(r.body.name).toBe('P2');
    expect(r.body.description).toBe('新描述');
    expect(r.body.defaultUrl).toBe('https://x.test');
  });

  it('DELETE rejects non-empty project with 409', async () => {
    const { projectId, groupId } = await seedProject(pool);
    await pool.query(`INSERT INTO test_cases(title, group_id) VALUES ('x', $1)`, [groupId]);
    const r = await request(app).delete(`/api/projects/${projectId}`);
    expect(r.status).toBe(409);
  });

  it('DELETE removes project with empty groups', async () => {
    const { projectId } = await seedProject(pool);
    const r = await request(app).delete(`/api/projects/${projectId}`);
    expect(r.status).toBe(200);
  });

  it('DELETE removes empty project', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'empty' });
    const r = await request(app).delete(`/api/projects/${created.body.id}`);
    expect(r.status).toBe(200);
  });
});

describe('groups', () => {
  it('POST/GET groups under project with caseCount', async () => {
    const p = await request(app).post('/api/projects').send({ name: 'GP' });
    const g = await request(app).post(`/api/projects/${p.body.id}/groups`).send({ name: '登录与账号' });
    expect(g.status).toBe(200);
    await pool.query(`INSERT INTO test_cases(title, group_id) VALUES ('c', $1)`, [g.body.id]);
    const list = await request(app).get(`/api/projects/${p.body.id}/groups`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].caseCount).toBe(1);
  });

  it('DELETE rejects group with cases', async () => {
    const { groupId } = await seedProject(pool);
    await pool.query(`INSERT INTO test_cases(title, group_id) VALUES ('c', $1)`, [groupId]);
    const r = await request(app).delete(`/api/groups/${groupId}`);
    expect(r.status).toBe(409);
  });
});

describe('project stats', () => {
  it('returns counts and per-group breakdown', async () => {
    const p = await request(app).post('/api/projects').send({ name: 'S' });
    const g = await request(app).post(`/api/projects/${p.body.id}/groups`).send({ name: 'g' });
    await pool.query(`INSERT INTO test_cases(title, group_id) VALUES ('a', $1), ('b', $1)`, [g.body.id]);
    const r = await request(app).get(`/api/projects/${p.body.id}/stats`);
    expect(r.status).toBe(200);
    expect(r.body.cases).toBe(2);
    expect(r.body.groups).toHaveLength(1);
    expect(r.body.groups[0].caseCount).toBe(2);
  });
});