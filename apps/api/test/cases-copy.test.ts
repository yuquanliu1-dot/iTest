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
  const { casesRoute } = await import('../src/routes/cases.js');
  const { stepsRoute } = await import('../src/routes/steps.js');
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
  app.use('/api/cases', casesRoute);
  app.use('/api/cases', stepsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function makeCaseWithSteps(groupId: string, versionId: string, title: string) {
  const c = await request(app).post('/api/cases').send({ title, groupId, versionId });
  await request(app).post(`/api/cases/${c.body.id}/steps`).send({
    steps: [
      { order: 1, source: 'agent', action: { kind: 'navigate', url: 'https://x.test' } },
      { order: 2, source: 'recorder', action: { kind: 'click', locator: [{ strategy: 'css', value: '#btn' }] } },
    ],
  });
  return c.body as { id: string; title: string };
}

describe('case copy', () => {
  it('single copy clones steps and appends 副本', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const src = await makeCaseWithSteps(groupId, versionId, '创建项目');
    const r = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: groupId });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('创建项目 副本');
    const detail = await request(app).get(`/api/cases/${r.body.id}`);
    expect(detail.body.steps).toHaveLength(2);
    expect(detail.body.requirementId).toBeNull();
  });

  it('copy naming increments 副本1, 副本2', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const src = await makeCaseWithSteps(groupId, versionId, '登录');
    const c1 = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: groupId });
    const c2 = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: groupId });
    const c3 = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: groupId });
    expect(c1.body.title).toBe('登录 副本');
    expect(c2.body.title).toBe('登录 副本1');
    expect(c3.body.title).toBe('登录 副本2');
  });

  it('batch copy to another group', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    const c1 = await makeCaseWithSteps(a.groupId, a.versionId, 'A');
    const c2 = await makeCaseWithSteps(a.groupId, a.versionId, 'B');
    const r = await request(app).post('/api/cases/copy').send({ caseIds: [c1.id, c2.id], targetGroupId: b.groupId });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    const inB = await request(app).get(`/api/cases?groupId=${b.groupId}`);
    expect(inB.body).toHaveLength(2);
  });

  it('copy to unknown group returns 404', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const src = await makeCaseWithSteps(groupId, versionId, 'X');
    const r = await request(app)
      .post(`/api/cases/${src.id}/copy`)
      .send({ targetGroupId: '00000000-0000-0000-0000-000000000000' });
    expect(r.status).toBe(404);
  });

  it('DELETE /api/cases/:id removes case and its steps', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const src = await makeCaseWithSteps(groupId, versionId, '待删除');
    const r = await request(app).delete(`/api/cases/${src.id}`);
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/cases/${src.id}`);
    expect(detail.status).toBe(404);
    const steps = await pool.query(`SELECT * FROM test_steps WHERE case_id = $1`, [src.id]);
    expect(steps.rows).toHaveLength(0);
  });

  it('POST /api/cases/batch-delete removes all listed cases and their steps', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c1 = await makeCaseWithSteps(groupId, versionId, '批删-1');
    const c2 = await makeCaseWithSteps(groupId, versionId, '批删-2');
    const r = await request(app).post('/api/cases/batch-delete').send({ caseIds: [c1.id, c2.id] });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    const list = await request(app).get(`/api/cases?groupId=${groupId}`);
    expect(list.body).toHaveLength(0);
    const steps = await pool.query(`SELECT * FROM test_steps WHERE case_id IN ($1, $2)`, [c1.id, c2.id]);
    expect(steps.rows).toHaveLength(0);
  });

  it('POST /api/cases/batch-delete rejects the whole batch when any id is missing', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c1 = await makeCaseWithSteps(groupId, versionId, '存在');
    const r = await request(app).post('/api/cases/batch-delete').send({
      caseIds: [c1.id, '00000000-0000-0000-0000-000000000000'],
    });
    expect(r.status).toBe(404);
    // 校验失败时 c1 仍然存在（未误删）
    const list = await request(app).get(`/api/cases?groupId=${groupId}`);
    expect(list.body).toHaveLength(1);
  });

  it('POST /api/cases/batch-delete rejects empty list with 400', async () => {
    const r = await request(app).post('/api/cases/batch-delete').send({ caseIds: [] });
    expect(r.status).toBe(400);
  });
});
