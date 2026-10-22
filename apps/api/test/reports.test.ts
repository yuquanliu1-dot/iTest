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
  const { reportsRoute } = await import('../src/routes/reports.js');
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
  app.use('/api/reports', reportsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('reports', () => {
  it('GET list returns array', async () => {
    const r = await request(app).get('/api/reports');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it('GET /:id 404 for missing', async () => {
    const r = await request(app).get('/api/reports/00000000-0000-0000-0000-000000000000');
    expect(r.status).toBe(404);
  });

  it('GET /:id 出参含执行起止时刻；老报告（无该两列）为 null', async () => {
    const { groupId } = await seedProject(pool);
    const c = await pool.query(`INSERT INTO test_cases(group_id, title) VALUES ($1,'t') RETURNING id`, [groupId]);
    const caseId = c.rows[0]!.id as string;
    const withTiming = await pool.query(
      `INSERT INTO reports(case_id, status, step_results, started_at, finished_at)
       VALUES ($1,'passed','[]'::jsonb, now(), now()) RETURNING id`,
      [caseId],
    );
    const old = await pool.query(
      `INSERT INTO reports(case_id, status, step_results) VALUES ($1,'passed','[]'::jsonb) RETURNING id`,
      [caseId],
    );

    const r = await request(app).get(`/api/reports/${withTiming.rows[0]!.id}`);
    expect(r.status).toBe(200);
    expect(r.body.startedAt).toBeTruthy();
    expect(r.body.finishedAt).toBeTruthy();

    // 老报告：字段存在但为 null（前端据此隐藏对应行，不报错）
    const r2 = await request(app).get(`/api/reports/${old.rows[0]!.id}`);
    expect(r2.status).toBe(200);
    expect(r2.body.startedAt).toBeNull();
    expect(r2.body.finishedAt).toBeNull();
  });
});