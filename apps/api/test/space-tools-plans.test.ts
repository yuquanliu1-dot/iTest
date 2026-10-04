import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
import type { SpaceToolsContext } from '../src/pi/space/tools/context.js';

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
    threadId: randomUUID(), versionId: '', projectId: '', cwd: null, repoAvailable: false,
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

  it('add_cases 跨项目 → 失败文案含归属;remove_cases 后重排且 stage 带 diff;update 带 diff', async () => {
    const seed = await seedProject(pool);
    const other = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    const c1 = await makeCase(seed.groupId, seed.versionId, 'c1');
    const c2 = await makeCase(seed.groupId, seed.versionId, 'c2');
    const foreign = await makeCase(other.groupId, other.versionId, '外来的');
    await tool.execute({ action: 'create', name: '全量', caseIds: [c1, c2] });
    const planId = (await pool.query(`SELECT id FROM execution_plans WHERE name='全量'`)).rows[0]!.id as string;

    const cross = await tool.execute({ action: 'add_cases', planId, caseIds: [foreign] });
    expect(cross).toMatchObject({ ok: false });
    expect((cross as { error: string }).error).toContain('belong to the plan project');

    events.length = 0;
    const rm = await tool.execute({ action: 'remove_cases', planId, caseIds: [c1] });
    expect(rm.ok).toBe(true);
    const stage = events.find((e) => e.type === 'stage') as { action: string; diff?: string };
    expect(stage.action).toBe('remove_cases');
    expect(stage.diff).toContain('cases: -1');
    const detail = JSON.parse(((await tool.execute({ action: 'get', planId })) as { data: string }).data) as { cases: Array<{ order: number; title: string }> };
    expect(detail.cases.map((c) => c.order)).toEqual([1]); // c2 重排

    events.length = 0;
    await tool.execute({ action: 'update', planId, name: '全量2', strategy: 'fail_fast' });
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
});
