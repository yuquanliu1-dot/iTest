import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let pg: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { recorderRoute } = await import('../src/routes/recorder.js');
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
  app.use('/api/recorder', recorderRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await pg.stop();
});

describe('recorder routes', () => {
  it('POST /api/recorder/sessions accepts mode/incognito/resumeFromOrder', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'R', groupId });
    const r = await request(app).post('/api/recorder/sessions').send({
      caseId: c.body.id,
      mode: 'incognito',
      incognito: true,
      resumeFromOrder: 3,
    });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('incognito');
  });

  it('resume with unbound upload step in the prefix returns 409', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'RU', groupId });
    await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        {
          action: { kind: 'click', locator: [{ strategy: 'css', value: '#x' }] },
          source: 'manual',
        },
        {
          action: { kind: 'click', locator: [{ strategy: 'css', value: '#y' }] },
          source: 'manual',
        },
      ],
    });
    // Force step #1 into an upload step with no fileId (bypassing PUT validation)
    await pool.query(
      `UPDATE test_steps SET action = $1 WHERE case_id = $2 AND "order" = 1`,
      [JSON.stringify({ kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }] }), c.body.id],
    );
    // resumeFromOrder = 2 → prefix is step #1 (unbound upload) → 409
    const r = await request(app).post('/api/recorder/sessions').send({
      caseId: c.body.id,
      mode: 'resume',
      resumeFromOrder: 2,
    });
    expect(r.status).toBe(409);
  });

  it('resume boundary step itself is not validated', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'RB', groupId });
    await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        {
          action: { kind: 'click', locator: [{ strategy: 'css', value: '#x' }] },
          source: 'manual',
        },
      ],
    });
    // Step #1 is an unbound upload, but resume starts AT it (resumeFromOrder = 1),
    // so the prefix is empty and creation must succeed.
    await pool.query(
      `UPDATE test_steps SET action = $1 WHERE case_id = $2 AND "order" = 1`,
      [JSON.stringify({ kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }] }), c.body.id],
    );
    const r = await request(app).post('/api/recorder/sessions').send({
      caseId: c.body.id,
      mode: 'resume',
      resumeFromOrder: 1,
    });
    expect(r.status).toBe(200);
  });
});