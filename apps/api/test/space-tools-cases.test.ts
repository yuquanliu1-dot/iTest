import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
import type { SpaceToolsContext } from '../src/pi/space/tools/context.js';
import type { ToolExecutor } from '../src/pi/tools.js';
import { resolveConfirmation } from '../src/pi/space/confirm.js';

// 注意:buildCasesTools 链上静态引入 db/client(DATABASE_URL 在 beforeAll 才指向容器),
// 必须在测试体内动态 import(与 cases.service.test.ts 同模式),否则查询打到默认本地库。
async function buildCasesToolsLazy(ctx: SpaceToolsContext): Promise<ToolExecutor> {
  const { buildCasesTools } = await import('../src/pi/space/tools/cases.js');
  return buildCasesTools(ctx)[0]!;
}

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

/** execute 在 confirm 前有异步 DB 查询 → 轮询等 confirm_request。 */
async function untilConfirm(events: Array<Record<string, unknown>>): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const e = events.find((x) => x.type === 'confirm_request');
    if (e) return String(e.confirmId);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('confirm_request not emitted');
}

describe('manage_cases 工具', () => {
  it('create:compiled click 展开为具体步骤行;stage(create) 广播', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await buildCasesToolsLazy(ctx);
    const r = await tool.execute({
      action: 'create', title: '下单流程', groupId: seed.groupId,
      steps: [
        { action: '打开首页', compiled: [{ kind: 'navigate', url: 'https://a.example.com/' }] },
        { action: '点击下单', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '.buy' }] }], assertion: '出现成功提示' },
      ],
    });
    expect(r.ok).toBe(true);
    const steps = (await pool.query(
      `SELECT s.action FROM test_steps s JOIN test_cases c ON c.id = s.case_id WHERE c.title = '下单流程' ORDER BY s."order"`,
    )).rows as Array<{ action: { kind: string } }>;
    expect(steps.map((s) => s.action.kind)).toEqual(['navigate', 'click']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'stage', kind: 'case', action: 'create' }));
  }, 30_000);

  it('update:拒绝 → 取消且数据不变;确认 → 生效且 stage 用确认时同一 diff;跨版本 caseId 拒绝', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await buildCasesToolsLazy(ctx);
    await tool.execute({ action: 'create', title: '旧名', groupId: seed.groupId });
    const caseId = (await pool.query(`SELECT id FROM test_cases WHERE title='旧名'`)).rows[0]!.id as string;

    // 拒绝:confirm_request 携带预计算 diff,取消后数据不变
    events.length = 0;
    const rejected = tool.execute({ action: 'update', caseId, title: '新名', priority: 'P0' });
    await untilConfirm(events);
    const req = events.find((e) => e.type === 'confirm_request') as Record<string, unknown>;
    expect(req).toMatchObject({ toolName: 'manage_cases', action: 'update', risk: 'update', summary: '更新用例「旧名」' });
    expect(String(req.diff)).toContain('title: 旧名 → 新名');
    resolveConfirmation(String(req.confirmId), false);
    expect(await rejected).toMatchObject({ ok: false, error: '用户取消了该操作' });
    expect((await pool.query(`SELECT title FROM test_cases WHERE id=$1`, [caseId])).rows[0]!.title).toBe('旧名');

    // 确认:字段生效,stage 用确认时的同一 diff
    events.length = 0;
    const approved = tool.execute({ action: 'update', caseId, title: '新名', priority: 'P0' });
    resolveConfirmation(await untilConfirm(events), true);
    expect(await approved).toMatchObject({ ok: true });
    const stage = events.find((e) => e.type === 'stage') as { diff?: string };
    expect(stage.diff).toContain('title: 旧名 → 新名');
    expect(stage.diff).toContain('priority: P1 → P0');
    expect((await pool.query(`SELECT title, priority FROM test_cases WHERE id=$1`, [caseId])).rows[0]).toMatchObject({ title: '新名', priority: 'P0' });

    const other = await seedProject(pool);
    const { ctx: ctx2 } = makeCtx({ projectId: other.projectId, versionId: other.versionId });
    const r2 = await (await buildCasesToolsLazy(ctx2)).execute({ action: 'update', caseId, title: '越权' });
    expect(r2).toMatchObject({ ok: false });
    expect((r2 as { error: string }).error).toContain('不属于当前版本');
  }, 30_000);

  it('delete:确认被拒 → 返回取消且用例仍在;确认通过 → 删除', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await buildCasesToolsLazy(ctx);
    await tool.execute({ action: 'create', title: '待删用例', groupId: seed.groupId });
    const realId = (await pool.query(`SELECT id FROM test_cases WHERE title='待删用例'`)).rows[0]!.id as string;

    const rejected = tool.execute({ action: 'delete', caseId: realId });
    const cid = await untilConfirm(events);
    resolveConfirmation(cid, false);
    expect(await rejected).toMatchObject({ ok: false, error: '用户取消了该操作' });
    expect((await pool.query(`SELECT id FROM test_cases WHERE id=$1`, [realId])).rowCount).toBe(1);

    events.length = 0;
    const approved = tool.execute({ action: 'delete', caseId: realId });
    const cid2 = await untilConfirm(events);
    resolveConfirmation(cid2, true);
    expect(await approved).toMatchObject({ ok: true });
    expect((await pool.query(`SELECT id FROM test_cases WHERE id=$1`, [realId])).rowCount).toBe(0);
  }, 30_000);

  it('归属校验:他项目分组 create/move_group 被拒;search 关键词过滤;create_group 建组可用', async () => {
    const seed = await seedProject(pool);
    const other = await seedProject(pool);
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await buildCasesToolsLazy(ctx);

    const badGroup = await tool.execute({ action: 'create', title: 'x', groupId: other.groupId });
    expect(badGroup).toMatchObject({ ok: false });

    const g = await tool.execute({ action: 'create_group', groupName: 'AI分组', groupDefaultUrl: 'https://g.example.com' });
    expect(g.ok).toBe(true);
    const gid = (await pool.query(`SELECT id FROM groups WHERE name='AI分组' AND project_id=$1`, [seed.projectId])).rows[0]!.id as string;

    await tool.execute({ action: 'create', title: '登录成功用例', groupId: gid });
    await tool.execute({ action: 'create', title: '支付用例', groupId: gid });
    const search = await tool.execute({ action: 'search', keyword: '登录' });
    expect((search as { ok: true; data: string }).data).toContain('登录成功用例');
    expect((search as { ok: true; data: string }).data).not.toContain('支付用例');

    const caseId = (await pool.query(`SELECT id FROM test_cases WHERE title='登录成功用例'`)).rows[0]!.id as string;
    const moved = await tool.execute({ action: 'move_group', caseId, targetGroupId: seed.groupId });
    expect(moved.ok).toBe(true);
    const crossMove = await tool.execute({ action: 'move_group', caseId, targetGroupId: other.groupId });
    expect(crossMove).toMatchObject({ ok: false });
  }, 30_000);
});
