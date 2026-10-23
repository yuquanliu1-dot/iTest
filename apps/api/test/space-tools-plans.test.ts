import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject, seedOtherProductLine } from './helpers/db.js';
import type { SpaceToolsContext } from '../src/pi/space/tools/context.js';
import { resolveConfirmation } from '../src/pi/space/confirm.js';

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

function makeCtx(over: Partial<SpaceToolsContext> = {}): { ctx: SpaceToolsContext; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const ctx: SpaceToolsContext = {
    threadId: randomUUID(), versionId: '', projectId: '', repo: { cwd: null, issue: null, noRepo: false },
    emit: (e) => events.push(e), ...over,
  };
  return { ctx, events };
}

/** 动态 import:必须在 beforeAll 设置 DATABASE_URL 之后(测试体内)加载,否则 db/client 固化默认连接串。 */
async function toolOf(ctx: SpaceToolsContext) {
  const { buildPlansTools } = await import('../src/pi/space/tools/plans.js');
  return buildPlansTools(ctx)[0]!;
}

async function makeCase(groupId: string, versionId: string, title: string): Promise<string> {
  return (await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1,$2,$3) RETURNING id`, [groupId, versionId, title],
  )).rows[0]!.id as string;
}

/** execute 在 confirm 前有异步 DB 查询 → 轮询等 confirm_request(与 space-tools-cases.test.ts 同模式)。 */
async function untilConfirm(events: Array<Record<string, unknown>>): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const e = events.find((x) => x.type === 'confirm_request');
    if (e) return String(e.confirmId);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('confirm_request not emitted');
}

describe('manage_plans 工具', () => {
  it('create 可带 caseIds;stage(create) 广播;list 命中', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    const c1 = await makeCase(seed.groupId, seed.versionId, 'c1');
    const c2 = await makeCase(seed.groupId, seed.versionId, 'c2');
    const r = await tool.execute({ action: 'create', name: '冒烟', caseIds: [c1, c2] });
    expect(r.ok).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'stage', kind: 'plan', action: 'create' }));
    const planId = (await pool.query(`SELECT id FROM execution_plans WHERE name='冒烟'`)).rows[0]!.id as string;
    const got = await tool.execute({ action: 'get', planId });
    const parsed = JSON.parse((got as { data: string }).data) as { cases: Array<{ order: number; title: string }> };
    expect(parsed.cases.map((c) => c.order)).toEqual([1, 2]);
    const list = JSON.parse(((await tool.execute({ action: 'list' })) as { data: string }).data) as Array<{ name: string; caseCount: number }>;
    expect(list.find((p) => p.name === '冒烟')!.caseCount).toBe(2);
  }, 30_000);

  it('add_cases 跨产品线 → 门控前报错不出确认卡;remove_cases/update 需确认,stage 带确认时同一 diff', async () => {
    const seed = await seedProject(pool);
    // R2 起越界判定按产品线（不是项目）做，外案必须挂在**另一条**线上。
    const otherLineId = await seedOtherProductLine(pool);
    const other = await seedProject(pool, { productLineId: otherLineId });
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    const c1 = await makeCase(seed.groupId, seed.versionId, 'c1');
    const c2 = await makeCase(seed.groupId, seed.versionId, 'c2');
    const foreign = await makeCase(other.groupId, other.versionId, '外来的');
    await tool.execute({ action: 'create', name: '全量', caseIds: [c1, c2] });
    const planId = (await pool.query(`SELECT id FROM execution_plans WHERE name='全量'`)).rows[0]!.id as string;

    // 归属校验在门控前:直接报错并点名越界用例,不出确认卡、数据不变
    const crossRes = (await tool.execute({ action: 'add_cases', planId, caseIds: [foreign] })) as { ok: boolean; error: string };
    expect(crossRes).toMatchObject({ ok: false });
    expect(crossRes.error).toContain(foreign);
    expect(events.find((e) => e.type === 'confirm_request')).toBeUndefined();
    expect((await pool.query(`SELECT count(*)::int AS n FROM plan_cases WHERE plan_id=$1`, [planId])).rows[0]!.n).toBe(2);
    // 混合传入只点名越界者,不误伤本项目的用例
    const mixed = (await tool.execute({ action: 'add_cases', planId, caseIds: [c2, foreign] })) as { ok: boolean; error: string };
    expect(mixed.ok).toBe(false);
    expect(mixed.error).toContain(foreign);
    expect(mixed.error).not.toContain(c2);

    events.length = 0;
    const rm = tool.execute({ action: 'remove_cases', planId, caseIds: [c1] });
    resolveConfirmation(await untilConfirm(events), true);
    expect(await rm).toMatchObject({ ok: true });
    const stage = events.find((e) => e.type === 'stage') as { action: string; diff?: string };
    expect(stage.action).toBe('remove_cases');
    expect(stage.diff).toContain('cases: -1');
    const detail = JSON.parse(((await tool.execute({ action: 'get', planId })) as { data: string }).data) as { cases: Array<{ order: number; title: string }> };
    expect(detail.cases.map((c) => c.order)).toEqual([1]); // c2 重排

    events.length = 0;
    const upd = tool.execute({ action: 'update', planId, name: '全量2', strategy: 'fail_fast' });
    resolveConfirmation(await untilConfirm(events), true);
    expect(await upd).toMatchObject({ ok: true });
    const stage2 = events.find((e) => e.type === 'stage') as { diff?: string };
    expect(stage2.diff).toContain('name: 全量 → 全量2');
    expect(stage2.diff).toContain('strategy: run_all → fail_fast');
  }, 30_000);

  it('create 缺 name → 参数错误;跨项目 planId 被拒', async () => {
    const seed = await seedProject(pool);
    const other = await seedProject(pool);
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    const noName = await tool.execute({ action: 'create' });
    expect(noName).toMatchObject({ ok: false });
    const { createPlan } = await import('../src/services/plans.service.js');
    const otherPlan = await createPlan(other.projectId, { name: '别人的', versionId: other.versionId });
    const cross = await tool.execute({ action: 'get', planId: otherPlan.id });
    expect(cross).toMatchObject({ ok: false });
  }, 30_000);

  it('create 部分失败:计划已建不回滚,错误含 planId 且不重复建;add_cases 确认后可补齐', async () => {
    const seed = await seedProject(pool);
    // 越界用例要挂在**另一条**产品线上才会被拒（同线内引用合法）。
    const otherLineId = await seedOtherProductLine(pool);
    const other = await seedProject(pool, { productLineId: otherLineId });
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    const foreign = await makeCase(other.groupId, other.versionId, '外来的');
    const r = await tool.execute({ action: 'create', name: '半成品', caseIds: [foreign] });
    expect(r).toMatchObject({ ok: false });
    const err = (r as { error: string }).error;
    expect(err).toContain('勿重复 create');
    const planId = (await pool.query(`SELECT id FROM execution_plans WHERE name='半成品'`)).rows[0]!.id as string;
    expect(err).toContain(planId);
    const count = (await pool.query(`SELECT count(*)::int AS n FROM execution_plans WHERE name='半成品'`)).rows[0]!.n as number;
    expect(count).toBe(1);

    const c1 = await makeCase(seed.groupId, seed.versionId, '补齐用例');
    const fix = tool.execute({ action: 'add_cases', planId, caseIds: [c1] });
    resolveConfirmation(await untilConfirm(events), true);
    expect(await fix).toMatchObject({ ok: true });
  }, 30_000);

  it('add_cases 幂等:N=0 短路直接返回,不进确认、不产生重复行', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    const c1 = await makeCase(seed.groupId, seed.versionId, 'ac1');
    await tool.execute({ action: 'create', name: '幂等计划', caseIds: [c1] });
    const planId = (await pool.query(`SELECT id FROM execution_plans WHERE name='幂等计划'`)).rows[0]!.id as string;
    const again = await tool.execute({ action: 'add_cases', planId, caseIds: [c1] });
    expect(again).toMatchObject({ ok: true });
    expect((again as { data: string }).data).toContain('所列用例均已在计划中');
    expect(events.find((e) => e.type === 'confirm_request')).toBeUndefined();
    const n = (await pool.query(`SELECT count(*)::int AS n FROM plan_cases WHERE plan_id=$1 AND case_id=$2`, [planId, c1])).rows[0]!.n as number;
    expect(n).toBe(1);
  }, 30_000);

  it('add_cases/remove_cases:确认卡带精确增量 diff;拒绝 → 取消且组合不变;remove N=0 短路', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    const c1 = await makeCase(seed.groupId, seed.versionId, 'p1');
    const c2 = await makeCase(seed.groupId, seed.versionId, 'p2');
    const c3 = await makeCase(seed.groupId, seed.versionId, 'p3');
    await tool.execute({ action: 'create', name: '增量计划', caseIds: [c1] });
    const planId = (await pool.query(`SELECT id FROM execution_plans WHERE name='增量计划'`)).rows[0]!.id as string;

    // add_cases 拒绝:重复 id 去重后精确计数(+2),取消后组合不变
    events.length = 0;
    const rejected = tool.execute({ action: 'add_cases', planId, caseIds: [c2, c3, c2] });
    await untilConfirm(events);
    const req = events.find((e) => e.type === 'confirm_request') as Record<string, unknown>;
    expect(req).toMatchObject({ toolName: 'manage_plans', action: 'add_cases', risk: 'update', diff: 'cases: +2', summary: '向计划「增量计划」添加 2 个用例' });
    resolveConfirmation(String(req.confirmId), false);
    expect(await rejected).toMatchObject({ ok: false, error: '用户取消了该操作' });
    const n = (await pool.query(`SELECT count(*)::int AS n FROM plan_cases WHERE plan_id=$1`, [planId])).rows[0]!.n as number;
    expect(n).toBe(1);

    // remove_cases 拒绝:取消后用例仍在
    events.length = 0;
    const rmReject = tool.execute({ action: 'remove_cases', planId, caseIds: [c1] });
    resolveConfirmation(await untilConfirm(events), false);
    expect(await rmReject).toMatchObject({ ok: false, error: '用户取消了该操作' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM plan_cases WHERE plan_id=$1`, [planId])).rows[0]!.n).toBe(1);

    // remove_cases N=0:短路,不进确认
    events.length = 0;
    const rmNone = await tool.execute({ action: 'remove_cases', planId, caseIds: [c2] });
    expect(rmNone).toMatchObject({ ok: true });
    expect((rmNone as { data: string }).data).toContain('所列用例均不在计划中');
    expect(events.find((e) => e.type === 'confirm_request')).toBeUndefined();
  }, 30_000);
});

describe('manage_plans 工具·schedule CRUD', () => {
  let testCounter = 0;
  /** 造一个空 plan + 配套 ctx,一并返回 planId/projectId/tool/events。
   *  关键点:tool 必须与 plan 同一 ctx(共享 projectId/versionId/emit),否则后面
   *  tool.execute 会报「计划不存在或不属于当前项目」。
   *  用唯一 planName 避免跨测试残留(每个 seedProject 也是新项目,但 plans 表没 projectId 索引时按 name 查会撞同名)。 */
  async function newPlan(): Promise<{ planId: string; projectId: string; tool: Awaited<ReturnType<typeof toolOf>>; events: Array<Record<string, unknown>> }> {
    const name = `调度测试-${++testCounter}-${randomUUID().slice(0, 8)}`;
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    await tool.execute({ action: 'create', name });
    const planId = (await pool.query(`SELECT id FROM execution_plans WHERE name=$1`, [name])).rows[0]!.id as string;
    return { planId, projectId: seed.projectId, tool, events };
  }

  /** 直接走 service 造调度(绕过 confirm 卡挂起);后续 update/delete 测试要 trigger confirm。 */
  async function seedSchedule(planId: string, cron = '0 9 * * *'): Promise<string> {
    const { createPlanSchedule } = await import('../src/services/planSchedules.service.js');
    const { seedOrg } = await import('./helpers/db.js');
    const { userId } = await seedOrg(pool);
    const row = await createPlanSchedule(planId, { cronExpr: cron, createdByUserId: userId });
    return row.id;
  }

  it('create_schedule 走确认卡 → 通过 → stage(create_schedule) 广播 + DB 写入 + 返回 nextRunAt', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    // 同一个 ctx 上下文建 plan + 调度,确保 ctx.projectId === plan.projectId
    const planId = await (async () => {
      const r = await tool.execute({ action: 'create', name: '每天9点' });
      if (!r.ok) throw new Error('seed create plan failed: ' + (r as { error?: string }).error);
      return (await pool.query(`SELECT id FROM execution_plans WHERE name=$1`, ['每天9点'])).rows[0]!.id as string;
    })();

    events.length = 0;
    const req = tool.execute({ action: 'create_schedule', planId, cronExpr: '0 9 * * *' });
    const confirmId = await untilConfirm(events);
    const reqEvent = events.find((e) => e.type === 'confirm_request') as Record<string, unknown>;
    expect(reqEvent).toMatchObject({ toolName: 'manage_plans', action: 'create_schedule', risk: 'update' });
    expect(String(reqEvent.summary)).toContain('0 9 * * *');
    resolveConfirmation(confirmId, true);
    const r = await req as { ok: boolean; data: string };
    expect(r.ok).toBe(true);
    expect(r.data).toContain('下次执行');
    const stage = events.find((e) => e.type === 'stage') as { kind: string; action: string };
    expect(stage).toMatchObject({ kind: 'plan', action: 'create_schedule' });
    const row = (await pool.query(`SELECT cron_expr, enabled, timezone FROM plan_schedules WHERE plan_id=$1`, [planId])).rows[0] as { cron_expr: string; enabled: boolean; timezone: string };
    expect(row).toMatchObject({ cron_expr: '0 9 * * *', enabled: true, timezone: 'Asia/Shanghai' });
  }, 30_000);

  it('create_schedule 跨项目 planId 拒绝 → 门控前报错 + 不弹卡 + DB 0 行', async () => {
    const seed = await seedProject(pool);
    const other = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    // 造一个属于 other 项目的 plan
    const { createPlan } = await import('../src/services/plans.service.js');
    const otherPlan = await createPlan(other.projectId, { name: '别人的', versionId: other.versionId });

    events.length = 0;
    const r = await tool.execute({ action: 'create_schedule', planId: otherPlan.id, cronExpr: '0 9 * * *' });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('不属于当前项目');
    expect(events.find((e) => e.type === 'confirm_request')).toBeUndefined();
    const n = (await pool.query(`SELECT count(*)::int AS n FROM plan_schedules WHERE plan_id=$1`, [otherPlan.id])).rows[0]!.n as number;
    expect(n).toBe(0);
  }, 30_000);

  it('update_schedule 改 cron 走卡 → diff 含 cron before→after;拒绝 → DB cron 不变', async () => {
    const { planId, tool, events } = await newPlan();
    const sid = await seedSchedule(planId, '0 9 * * *');

    // 拒绝路径
    events.length = 0;
    const rejected = tool.execute({ action: 'update_schedule', scheduleId: sid, cronExpr: '30 8 * * *' });
    await untilConfirm(events);
    const reqEvent = events.find((e) => e.type === 'confirm_request') as Record<string, unknown>;
    expect(String(reqEvent.diff)).toContain('cron: 0 9 * * * → 30 8 * * *');
    resolveConfirmation(String(reqEvent.confirmId), false);
    expect(await rejected).toMatchObject({ ok: false, error: '用户取消了该操作' });
    const before = (await pool.query(`SELECT cron_expr FROM plan_schedules WHERE id=$1`, [sid])).rows[0]!.cron_expr as string;
    expect(before).toBe('0 9 * * *');

    // 通过路径
    events.length = 0;
    const approved = tool.execute({ action: 'update_schedule', scheduleId: sid, cronExpr: '30 8 * * *' });
    const cid2 = await untilConfirm(events);
    resolveConfirmation(cid2, true);
    const r2 = await approved as { ok: boolean; data: string };
    expect(r2.ok).toBe(true);
    const stage = events.find((e) => e.type === 'stage') as { action: string; diff?: string };
    expect(stage.action).toBe('update_schedule');
    expect(stage.diff).toContain('cron: 0 9 * * * → 30 8 * * *');
    const after = (await pool.query(`SELECT cron_expr FROM plan_schedules WHERE id=$1`, [sid])).rows[0]!.cron_expr as string;
    expect(after).toBe('30 8 * * *');
  }, 30_000);

  it('update_schedule 字段全等于现值 → 短路不弹卡', async () => {
    const { planId, tool, events } = await newPlan();
    const sid = await seedSchedule(planId, '0 9 * * *');

    events.length = 0;
    const r = await tool.execute({ action: 'update_schedule', scheduleId: sid, cronExpr: '0 9 * * *' });
    expect(r).toMatchObject({ ok: true });
    expect((r as { data: string }).data).toContain('调度无需更新');
    expect(events.find((e) => e.type === 'confirm_request')).toBeUndefined();
  }, 30_000);

  it('update_schedule 字段全缺 → 参数错误;不存在 scheduleId → "调度不存在或已删除"', async () => {
    const { planId, tool } = await newPlan();
    const sid = await seedSchedule(planId, '0 9 * * *');

    expect(await tool.execute({ action: 'update_schedule', scheduleId: sid }))
      .toMatchObject({ ok: false });
    expect(await tool.execute({ action: 'update_schedule', scheduleId: '00000000-0000-0000-0000-000000000000', cronExpr: '0 9 * * *' }))
      .toMatchObject({ ok: true, data: expect.stringContaining('调度不存在或已删除') });
  }, 30_000);

  it('delete_schedule 走卡 → 通过删除;拒绝保留行;不存在 scheduleId 短路', async () => {
    const { planId, tool, events } = await newPlan();
    const sid = await seedSchedule(planId, '0 9 * * *');

    // 不存在 → 短路,不弹卡
    events.length = 0;
    const r0 = await tool.execute({ action: 'delete_schedule', scheduleId: '00000000-0000-0000-0000-000000000000' });
    expect(r0).toMatchObject({ ok: true, data: expect.stringContaining('调度不存在或已删除') });
    expect(events.find((e) => e.type === 'confirm_request')).toBeUndefined();

    // 拒绝 → 行保留
    events.length = 0;
    const rejected = tool.execute({ action: 'delete_schedule', scheduleId: sid });
    await untilConfirm(events);
    const reqEvent = events.find((e) => e.type === 'confirm_request') as Record<string, unknown>;
    expect(reqEvent.risk).toBe('delete');
    expect(String(reqEvent.summary)).toContain('0 9 * * *');
    resolveConfirmation(String(reqEvent.confirmId), false);
    expect(await rejected).toMatchObject({ ok: false, error: '用户取消了该操作' });
    const n1 = (await pool.query(`SELECT count(*)::int AS n FROM plan_schedules WHERE id=$1`, [sid])).rows[0]!.n as number;
    expect(n1).toBe(1);

    // 通过 → 删除
    events.length = 0;
    const approved = tool.execute({ action: 'delete_schedule', scheduleId: sid });
    const cid = await untilConfirm(events);
    resolveConfirmation(cid, true);
    expect(await approved).toMatchObject({ ok: true });
    const n2 = (await pool.query(`SELECT count(*)::int AS n FROM plan_schedules WHERE id=$1`, [sid])).rows[0]!.n as number;
    expect(n2).toBe(0);
  }, 30_000);

  it('list_schedules 命中新建项;空计划返 []', async () => {
    const { planId, tool, events } = await newPlan();

    events.length = 0;
    const empty = await tool.execute({ action: 'list_schedules', planId }) as { ok: boolean; data: string };
    expect(empty.ok).toBe(true);
    expect(JSON.parse(empty.data)).toEqual([]);
    expect(events.find((e) => e.type === 'confirm_request')).toBeUndefined();

    await seedSchedule(planId, '0 9 * * *');
    await seedSchedule(planId, '30 14 * * *');
    const full = await tool.execute({ action: 'list_schedules', planId }) as { ok: boolean; data: string };
    expect(full.ok).toBe(true);
    const rows = JSON.parse(full.data) as Array<{ cronExpr: string }>;
    expect(rows.map((r) => r.cronExpr)).toEqual(['0 9 * * *', '30 14 * * *']);
  }, 30_000);

  it('create_schedule cron 非法 → 不弹卡 + 参数错误', async () => {
    const { planId, tool, events } = await newPlan();

    events.length = 0;
    const r = await tool.execute({ action: 'create_schedule', planId, cronExpr: 'not a cron' });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/cron|参数不合法|计划不存在/);
    expect(events.find((e) => e.type === 'confirm_request')).toBeUndefined();
    const n = (await pool.query(`SELECT count(*)::int AS n FROM plan_schedules WHERE plan_id=$1`, [planId])).rows[0]!.n as number;
    expect(n).toBe(0);
  }, 30_000);
});
