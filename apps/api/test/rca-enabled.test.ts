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
  delete process.env.REDIS_URL; // enqueue 走 inline，无队列依赖
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { plansRoute } = await import('../src/routes/plans.js');
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
  app.use('/api/projects/:projectId/plans', plansRoute);
  app.use('/api/plans', plansRoute);
  app.use(errorHandler);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('rcaEnabled 透传', () => {
  it('create 带 rcaEnabled=true → 详情可见;patch 置 false 生效', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const created = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({ name: 'RCA 计划', versionId, rcaEnabled: true });
    expect(created.status).toBe(200);
    expect(created.body.rcaEnabled).toBe(true);

    const patched = await request(app).patch(`/api/plans/${created.body.id}`).send({ rcaEnabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body.rcaEnabled).toBe(false);
  });

  it('enqueuePlanRun 把 rcaEnabled 快照进 plan_runs', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const created = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({ name: '快照计划', versionId, rcaEnabled: true });
    const run = await request(app).post(`/api/plans/${created.body.id}/run`);
    expect(run.status).toBe(200);
    // 等待后台 run 收敛到终态，避免与 afterAll 的 pool.end 竞争（快照行本身已同步落库）
    for (let i = 0; i < 50; i++) {
      const cur = await pool.query('SELECT status FROM plan_runs WHERE id = $1', [run.body.runId]);
      if (cur.rows[0]!.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const row = await pool.query('SELECT rca_enabled, status FROM plan_runs WHERE id = $1', [run.body.runId]);
    expect(row.rows[0]!.rca_enabled).toBe(true);
  });
});
