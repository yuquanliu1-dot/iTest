import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
import type { SpaceToolsContext } from '../src/pi/space/tools/context.js';
import type { ToolExecutor } from '../src/pi/tools.js';
import { resolveConfirmation } from '../src/pi/space/confirm.js';

// 注意:buildEnvironmentsTools 链上静态引入 db/client(DATABASE_URL 在 beforeAll 才指向容器),
// 必须在测试体内动态 import(与 space-tools-cases.test.ts 同模式),否则查询打到默认本地库。
async function toolOf(ctx: SpaceToolsContext): Promise<ToolExecutor> {
  return (await import('../src/pi/space/tools/environments.js')).buildEnvironmentsTools(ctx)[0]!;
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

describe('manage_environments 工具', () => {
  it('upsert 新建环境+db 对象(拒绝明文密码);set_secret 确认后密文落库,任何出口无明文', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);

    const rejectedPayload = await tool.execute({
      action: 'upsert', name: '生产',
      objects: [{ objectType: 'db', payload: { host: 'h', dbName: 'd', user: 'u', password: 'SUPER-SECRET' } }],
    });
    expect(rejectedPayload).toMatchObject({ ok: false });
    expect((rejectedPayload as { error: string }).error).toContain('set_secret');
    expect(JSON.stringify(events)).not.toContain('SUPER-SECRET');

    const created = await tool.execute({
      action: 'upsert', name: '生产', baseUrl: 'https://prod.example.com',
      objects: [{ objectType: 'db', payload: { host: 'h', dbName: 'd', user: 'u' }, isDefault: true }],
    });
    expect(created.ok).toBe(true);
    expect((created as { data: string }).data).not.toContain('SUPER-SECRET');
    const envId = (await pool.query(`SELECT id FROM test_environments WHERE name='生产'`)).rows[0]!.id as string;
    const objId = (await pool.query(`SELECT id FROM environment_objects WHERE environment_id=$1`, [envId])).rows[0]!.id as string;

    events.length = 0;
    const secret = tool.execute({ action: 'set_secret', environmentId: envId, objectType: 'db', value: 'SUPER-SECRET' });
    const cid = await untilConfirm(events);
    const req = events.find((e) => e.type === 'confirm_request') as Record<string, unknown>;
    expect(String(req.summary)).not.toContain('SUPER-SECRET'); // summary 不回显明文
    expect(String(req.risk)).toBe('secret');
    resolveConfirmation(cid, true);
    expect(await secret).toMatchObject({ ok: true, data: '凭据已加密保存' });

    const raw = (await pool.query(`SELECT payload FROM environment_objects WHERE id=$1`, [objId])).rows[0]!.payload as { secret: { c: string; i: string; t: string } };
    expect(raw.secret.c).toBeTruthy();
    expect(JSON.stringify(raw)).not.toContain('SUPER-SECRET');
    expect(JSON.stringify(events)).not.toContain('SUPER-SECRET');

    const list = await tool.execute({ action: 'list' });
    expect((list as { data: string }).data).toContain('••••••••');
    expect((list as { data: string }).data).toContain('https://prod.example.com');
  }, 30_000);

  it('set_secret 被拒 → payload 无 secret;对象不存在 → 不进确认直接报错', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    await tool.execute({ action: 'upsert', name: '灰度' });
    const envId = (await pool.query(`SELECT id FROM test_environments WHERE name='灰度'`)).rows[0]!.id as string;

    const missing = await tool.execute({ action: 'set_secret', environmentId: envId, objectType: 'db', value: 'x' });
    expect(missing).toMatchObject({ ok: false });
    expect((missing as { error: string }).error).toContain('先');

    events.length = 0;
    const pending = await tool.execute({ action: 'set_secret', environmentId: envId, objectType: 'syslog', label: '默认', value: 'k' });
    // syslog 对象不存在 → 不进确认,直接报错
    expect(pending).toMatchObject({ ok: false });
    expect(events.find((e) => e.type === 'confirm_request')).toBeUndefined();

    await tool.execute({ action: 'upsert', environmentId: envId, objects: [{ objectType: 'syslog', payload: { host: 's', filePath: '/var/log/syslog', authType: 'password' } }] });
    events.length = 0;
    const p2 = tool.execute({ action: 'set_secret', environmentId: envId, objectType: 'syslog', value: 'SYS-KEY' });
    resolveConfirmation(await untilConfirm(events), false);
    expect(await p2).toMatchObject({ ok: false, error: '用户取消了该操作' });
    const raw = (await pool.query(
      `SELECT o.payload FROM environment_objects o JOIN test_environments e ON e.id=o.environment_id WHERE e.id=$1 AND o.object_type='syslog'`, [envId],
    )).rows[0]!.payload as { secret?: unknown };
    expect(raw.secret).toBeUndefined();
  }, 30_000);

  it('upsert 更新:拒绝 → 取消且环境不变;确认 → 生效且 stage 用确认时同一 diff;仅对象合并(patch 空)不进确认', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    await tool.execute({ action: 'upsert', name: '灰度环境', baseUrl: 'https://old.example.com' });
    const envId = (await pool.query(`SELECT id FROM test_environments WHERE name='灰度环境'`)).rows[0]!.id as string;

    events.length = 0;
    const rejected = tool.execute({ action: 'upsert', environmentId: envId, name: '改名环境', baseUrl: 'https://new.example.com' });
    await untilConfirm(events);
    const req = events.find((e) => e.type === 'confirm_request') as Record<string, unknown>;
    expect(req).toMatchObject({ toolName: 'manage_environments', action: 'upsert', risk: 'update', summary: '更新环境「灰度环境」' });
    expect(String(req.diff)).toContain('name: 灰度环境 → 改名环境');
    expect(String(req.diff)).toContain('baseUrl: https://old.example.com → https://new.example.com');
    resolveConfirmation(String(req.confirmId), false);
    expect(await rejected).toMatchObject({ ok: false, error: '用户取消了该操作' });
    const row = (await pool.query(`SELECT name, base_url FROM test_environments WHERE id=$1`, [envId])).rows[0]!;
    expect(row.name).toBe('灰度环境');
    expect(row.base_url).toBe('https://old.example.com');

    events.length = 0;
    const approved = tool.execute({ action: 'upsert', environmentId: envId, name: '改名环境', baseUrl: 'https://new.example.com' });
    resolveConfirmation(await untilConfirm(events), true);
    expect(await approved).toMatchObject({ ok: true });
    const stage = events.find((e) => e.type === 'stage') as { diff?: string };
    expect(stage.diff).toContain('name: 灰度环境 → 改名环境');
    expect((await pool.query(`SELECT name, base_url FROM test_environments WHERE id=$1`, [envId])).rows[0]).toMatchObject({ name: '改名环境', base_url: 'https://new.example.com' });

    // patch 为空、仅 objects 合并 → 保持自动执行,不进确认
    events.length = 0;
    const objOnly = await tool.execute({ action: 'upsert', environmentId: envId, objects: [{ objectType: 'db', payload: { host: 'h' } }] });
    expect(objOnly).toMatchObject({ ok: true });
    expect(events.find((e) => e.type === 'confirm_request')).toBeUndefined();
  }, 30_000);

  it('delete:summary 带引用计数;确认后环境删除且用例引用置空', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx);
    await tool.execute({ action: 'upsert', name: '要删的环境' });
    const envId = (await pool.query(`SELECT id FROM test_environments WHERE name='要删的环境'`)).rows[0]!.id as string;
    await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title, default_env_id) SELECT id,$1,'c',$2 FROM groups WHERE project_id=$3 LIMIT 1`,
      [seed.versionId, envId, seed.projectId],
    );

    events.length = 0;
    const pending = tool.execute({ action: 'delete', environmentId: envId });
    const cid = await untilConfirm(events);
    const req = events.find((e) => e.type === 'confirm_request') as { summary: string };
    expect(req.summary).toContain('要删的环境');
    expect(req.summary).toContain('1 个用例');
    resolveConfirmation(cid, true);
    expect(await pending).toMatchObject({ ok: true });
    expect((await pool.query(`SELECT id FROM test_environments WHERE id=$1`, [envId])).rowCount).toBe(0);
    expect((await pool.query(`SELECT default_env_id FROM test_cases WHERE title='c'`)).rows[0]!.default_env_id).toBeNull();
  }, 30_000);
});
