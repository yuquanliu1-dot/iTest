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
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/cases', casesRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function makeCase(groupId: string, versionId: string, title: string): Promise<{ id: string }> {
  const c = await request(app).post('/api/cases').send({ title, groupId, versionId });
  return c.body as { id: string };
}

describe('case status', () => {
  it('create 默认 draft', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await makeCase(groupId, versionId, '默认态');
    const detail = await request(app).get(`/api/cases/${c.id}`);
    expect(detail.body.status).toBe('draft');
  });

  it('PATCH 合法 status 更新成功', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await makeCase(groupId, versionId, '流转');
    const r = await request(app).patch(`/api/cases/${c.id}`).send({ status: 'review' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('review');
    const again = await request(app).patch(`/api/cases/${c.id}`).send({ status: 'deprecated' });
    expect(again.body.status).toBe('deprecated');
    // 自由回退
    const back = await request(app).patch(`/api/cases/${c.id}`).send({ status: 'draft' });
    expect(back.body.status).toBe('draft');
  });

  it('PATCH 非法 status 400', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c = await makeCase(groupId, versionId, '非法值');
    const r = await request(app).patch(`/api/cases/${c.id}`).send({ status: 'done' });
    expect(r.status).toBe(400);
  });

  it('batch-status 批量更新并返回 count', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c1 = await makeCase(groupId, versionId, 'a');
    const c2 = await makeCase(groupId, versionId, 'b');
    const r = await request(app).post('/api/cases/batch-status').send({ caseIds: [c1.id, c2.id], status: 'ready' });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    const list = await request(app).get(`/api/cases?groupId=${groupId}`);
    expect(list.body).toHaveLength(2);
    expect(list.body.every((c: { status: string }) => c.status === 'ready')).toBe(true);
  });

  it('batch-status 含未知 id 404；空数组 400；非法枚举 400', async () => {
    const { groupId, versionId } = await seedProject(pool);
    const c1 = await makeCase(groupId, versionId, 'x');
    const unknown = await request(app)
      .post('/api/cases/batch-status')
      .send({ caseIds: [c1.id, '00000000-0000-0000-0000-000000000000'], status: 'ready' });
    expect(unknown.status).toBe(404);
    const empty = await request(app).post('/api/cases/batch-status').send({ caseIds: [], status: 'ready' });
    expect(empty.status).toBe(400);
    const bad = await request(app).post('/api/cases/batch-status').send({ caseIds: [c1.id], status: 'done' });
    expect(bad.status).toBe(400);
  });
});
