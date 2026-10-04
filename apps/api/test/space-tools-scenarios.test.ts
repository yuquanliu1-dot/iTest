import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
import type { SpaceToolsContext } from '../src/pi/space/tools/context.js';
import { resolveConfirmation } from '../src/pi/space/confirm.js';

// 注意:buildScenariosTools 链上静态引入 db/client(DATABASE_URL 在 beforeAll 才指向容器),
// 必须在测试体内动态 import(与 space-tools-cases.test.ts 同模式),否则查询打到默认本地库。
async function toolOf(ctx: SpaceToolsContext) {
  return (await import('../src/pi/space/tools/scenarios.js')).buildScenariosTools(ctx)[0]!;
}

async function makeRequirement(projectId: string): Promise<string> {
  return (await pool.query(
    `INSERT INTO requirements(project_id, title, content) VALUES ($1,'登录模块','c') RETURNING id`, [projectId],
  )).rows[0]!.id as string;
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
    threadId: randomUUID(), versionId: '', projectId: '', cwd: null, repoAvailable: false,
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

describe('manage_scenarios 工具', () => {
  it('create:跨项目 requirement 拒绝;本项目 requirement 建场景并广播 stage;list 命中', async () => {
    const seed = await seedProject(pool);
    const other = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    const foreignRid = await makeRequirement(other.projectId);
    const bad = await tool.execute({ action: 'create', requirementId: foreignRid, title: '越权场景' });
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { error: string }).error).toContain('不属于当前项目');

    const rid = await makeRequirement(seed.projectId);
    const r = await tool.execute({ action: 'create', requirementId: rid, title: '密码登录', description: '账密' });
    expect(r.ok).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'stage', kind: 'scenario', action: 'create' }));

    const list = await tool.execute({ action: 'list' });
    expect((list as { data: string }).data).toContain('密码登录');
  }, 30_000);

  it('update:改名生效且 stage 带 diff', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    const rid = await makeRequirement(seed.projectId);
    await tool.execute({ action: 'create', requirementId: rid, title: '旧场景' });
    const sid = (await pool.query(`SELECT id FROM scenarios WHERE title='旧场景'`)).rows[0]!.id as string;
    events.length = 0;
    const r = await tool.execute({ action: 'update', scenarioId: sid, title: '新场景' });
    expect(r.ok).toBe(true);
    const stage = events.find((e) => e.type === 'stage') as { diff?: string };
    expect(stage.diff).toContain('title: 旧场景 → 新场景');
  }, 30_000);

  it('delete:拒绝保留/确认删除', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    const rid = await makeRequirement(seed.projectId);
    await tool.execute({ action: 'create', requirementId: rid, title: '待删场景' });
    const sid = (await pool.query(`SELECT id FROM scenarios WHERE title='待删场景'`)).rows[0]!.id as string;

    const rejected = tool.execute({ action: 'delete', scenarioId: sid });
    const cid = await untilConfirm(events);
    resolveConfirmation(cid, false);
    expect(await rejected).toMatchObject({ ok: false, error: '用户取消了该操作' });
    expect((await pool.query(`SELECT id FROM scenarios WHERE id=$1`, [sid])).rowCount).toBe(1);

    events.length = 0;
    const approved = tool.execute({ action: 'delete', scenarioId: sid });
    resolveConfirmation(await untilConfirm(events), true);
    expect(await approved).toMatchObject({ ok: true });
    expect((await pool.query(`SELECT id FROM scenarios WHERE id=$1`, [sid])).rowCount).toBe(0);
  }, 30_000);
});
