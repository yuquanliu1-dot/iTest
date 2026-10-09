/**
 * planSchedules.service 单测：直接调 service 函数，验证
 * - list / get / create / update / delete 行为
 * - validateCron 失败抛 HttpError(400, 'bad_cron_expr')
 * - DB 列写入正确（enabled / cronExpr / nextRunAt）
 * - delete 不存在 schedule 返回 deleted=false
 *
 * 注：测试环境不连 Redis；upsertScheduleJob / removeScheduleJob 内部守门,DB 写入仍正常。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function newPlanWithUser(): Promise<{ planId: string; userId: string }> {
  const { seedOrg } = await import('./helpers/db.js');
  const { orgId, userId } = await seedOrg(pool);
  const { projectId } = await seedProject(pool);
  const created = (await pool.query(
    `INSERT INTO execution_plans(project_id, name) VALUES ($1, 'svc-test') RETURNING id`,
    [projectId],
  )).rows[0]!.id as string;
  void orgId;
  return { planId: created, userId };
}

describe('planSchedules.service', () => {
  it('validateCron 合法表达式返回 Date;非法抛 HttpError 400 bad_cron_expr', async () => {
    const { validateCron } = await import('../src/services/planSchedules.service.js');
    const d = validateCron('0 9 * * *', 'Asia/Shanghai');
    expect(d).toBeInstanceOf(Date);
    expect(() => validateCron('not a cron', 'Asia/Shanghai')).toThrowError(/cron 表达式非法/);
  });

  it('listPlanSchedules 空计划返 [];create 后返 1 条按 createdAt asc', async () => {
    const { listPlanSchedules, createPlanSchedule } = await import('../src/services/planSchedules.service.js');
    const { planId, userId } = await newPlanWithUser();
    expect(await listPlanSchedules(planId)).toEqual([]);
    const a = await createPlanSchedule(planId, { cronExpr: '0 9 * * *', createdByUserId: userId });
    const b = await createPlanSchedule(planId, { cronExpr: '30 14 * * *', createdByUserId: userId });
    const list = await listPlanSchedules(planId);
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it('getPlanSchedule 不存在返 null', async () => {
    const { getPlanSchedule } = await import('../src/services/planSchedules.service.js');
    expect(await getPlanSchedule('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('createPlanSchedule 默认 enabled=true / timezone=Asia/Shanghai;nextRunAt 是未来 Date', async () => {
    const { createPlanSchedule } = await import('../src/services/planSchedules.service.js');
    const { planId, userId } = await newPlanWithUser();
    const row = await createPlanSchedule(planId, { cronExpr: '0 9 * * *', createdByUserId: userId });
    expect(row.enabled).toBe(true);
    expect(row.timezone).toBe('Asia/Shanghai');
    expect(row.cronExpr).toBe('0 9 * * *');
    expect(row.nextRunAt).toBeInstanceOf(Date);
    expect(row.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('createPlanSchedule cron 非法抛 HttpError,DB 0 行', async () => {
    const { createPlanSchedule } = await import('../src/services/planSchedules.service.js');
    const { planId, userId } = await newPlanWithUser();
    await expect(createPlanSchedule(planId, { cronExpr: 'bad', createdByUserId: userId })).rejects.toMatchObject({ status: 400, code: 'bad_cron_expr' });
    const n = (await pool.query(`SELECT count(*)::int AS n FROM plan_schedules WHERE plan_id=$1`, [planId])).rows[0]!.n as number;
    expect(n).toBe(0);
  });

  it('updatePlanSchedule 改 cron 后 nextRunAt 改变;改 enabled 后 enabled 翻转;不存在 scheduleId 抛 404', async () => {
    const { createPlanSchedule, updatePlanSchedule } = await import('../src/services/planSchedules.service.js');
    const { planId, userId } = await newPlanWithUser();
    const row = await createPlanSchedule(planId, { cronExpr: '0 9 * * *', createdByUserId: userId });
    const originalNext = row.nextRunAt!.getTime();

    const updCron = await updatePlanSchedule(row.id, { cronExpr: '30 14 * * *' });
    expect(updCron.cronExpr).toBe('30 14 * * *');
    expect(updCron.nextRunAt!.getTime()).not.toBe(originalNext);

    const updEnabled = await updatePlanSchedule(row.id, { enabled: false });
    expect(updEnabled.enabled).toBe(false);

    await expect(updatePlanSchedule('00000000-0000-0000-0000-000000000000', { enabled: true })).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('deletePlanSchedule 已删返 deleted:true,DB 0 行;不存在返 deleted:false', async () => {
    const { createPlanSchedule, deletePlanSchedule } = await import('../src/services/planSchedules.service.js');
    const { planId, userId } = await newPlanWithUser();
    const row = await createPlanSchedule(planId, { cronExpr: '0 9 * * *', createdByUserId: userId });
    const r = await deletePlanSchedule(row.id);
    expect(r).toEqual({ deleted: true });
    const n = (await pool.query(`SELECT count(*)::int AS n FROM plan_schedules WHERE plan_id=$1`, [planId])).rows[0]!.n as number;
    expect(n).toBe(0);
    const r2 = await deletePlanSchedule(row.id);
    expect(r2).toEqual({ deleted: false });
  });

  it('loadPlanOr404 不存在 planId 抛 404', async () => {
    const { loadPlanOr404 } = await import('../src/services/planSchedules.service.js');
    await expect(loadPlanOr404('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});