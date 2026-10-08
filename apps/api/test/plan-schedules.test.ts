/**
 * plan_schedules 路由测试：cron-only CRUD + 校验 + DB+BullMQ 同步。
 *
 * 注：测试环境不连 Redis；upsertScheduleJob / removeScheduleJob 内部走 isSchedulerReady()
 * 守门，未连接时直接返回 0 副作用。DB 写入仍正常。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let userCtx: { userId: string; username: string; orgId: string; orgPath: string };

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { plansRoute } = await import('../src/routes/plans.js');
  const { planSchedulesRoute } = await import('../src/routes/planSchedules.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  userCtx = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userCtx.userId, userCtx.username, userCtx.orgId, userCtx.orgPath);
    next();
  });
  app.use('/api/projects/:projectId/plans', plansRoute);
  app.use('/api/plans', plansRoute);
  app.use('/api/plans', planSchedulesRoute);
  app.use('/api/plan-schedules', planSchedulesRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function bootstrapPlan(): Promise<string> {
  const { projectId, versionId } = await seedProject(pool);
  // 创建计划要求 versionId 必填；这里种一条空计划即可。
  const created = await request(app)
    .post(`/api/projects/${projectId}/plans`)
    .send({ name: '调度测试', versionId });
  expect(created.status).toBe(200);
  return created.body.id as string;
}

describe('plan_schedules routes', () => {
  it('create cron, list, patch enabled, delete', async () => {
    const planId = await bootstrapPlan();
    const c = await request(app)
      .post(`/api/plans/${planId}/schedules`)
      .send({ cronExpr: '0 9 * * *', timezone: 'Asia/Shanghai' });
    expect(c.status).toBe(200);
    expect(c.body.cronExpr).toBe('0 9 * * *');
    expect(c.body.timezone).toBe('Asia/Shanghai');
    expect(c.body.enabled).toBe(true);
    expect(c.body.nextRunAt).not.toBeNull();

    const list = await request(app).get(`/api/plans/${planId}/schedules`);
    expect(list.body).toHaveLength(1);

    const sid = c.body.id as string;
    const p = await request(app)
      .patch(`/api/plan-schedules/${sid}`)
      .send({ enabled: false });
    expect(p.status).toBe(200);
    expect(p.body.enabled).toBe(false);

    const d = await request(app).delete(`/api/plan-schedules/${sid}`);
    expect(d.status).toBe(200);

    const after = await request(app).get(`/api/plans/${planId}/schedules`);
    expect(after.body).toHaveLength(0);
  });

  it('create cron with bad expression returns 400', async () => {
    const planId = await bootstrapPlan();
    const bad = await request(app)
      .post(`/api/plans/${planId}/schedules`)
      .send({ cronExpr: 'this is not cron' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
  });

  it('patch cronExpr updates and re-validates nextRunAt', async () => {
    const planId = await bootstrapPlan();
    const c = await request(app)
      .post(`/api/plans/${planId}/schedules`)
      .send({ cronExpr: '0 9 * * *' });
    const sid = c.body.id as string;
    const originalNext = c.body.nextRunAt;

    const p = await request(app)
      .patch(`/api/plan-schedules/${sid}`)
      .send({ cronExpr: '30 14 * * *' });
    expect(p.status).toBe(200);
    expect(p.body.cronExpr).toBe('30 14 * * *');
    expect(p.body.nextRunAt).not.toBeNull();
    expect(p.body.nextRunAt).not.toBe(originalNext);
  });

  it('enable / disable toggles enabled flag', async () => {
    const planId = await bootstrapPlan();
    const c = await request(app)
      .post(`/api/plans/${planId}/schedules`)
      .send({ cronExpr: '0 9 * * *' });
    const sid = c.body.id as string;

    const dis = await request(app).post(`/api/plan-schedules/${sid}/disable`);
    expect(dis.body.enabled).toBe(false);
    const en = await request(app).post(`/api/plan-schedules/${sid}/enable`);
    expect(en.body.enabled).toBe(true);
  });

  it('404 for unknown schedule id', async () => {
    const planId = await bootstrapPlan();
    const r = await request(app).get(`/api/plans/${planId}/schedules`);
    expect(r.status).toBe(200);

    const bogus = await request(app)
      .patch(`/api/plan-schedules/00000000-0000-0000-0000-000000000000`)
      .send({ enabled: false });
    expect(bogus.status).toBe(404);
  });
});
