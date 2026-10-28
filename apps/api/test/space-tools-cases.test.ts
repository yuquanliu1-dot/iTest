import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
import type { SpaceToolsContext } from '../src/pi/space/tools/context.js';
import type { ToolExecutor } from '../src/pi/tools.js';

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

async function insertVersion(projectId: string, name: string): Promise<string> {
  return (await pool.query(`INSERT INTO project_versions(project_id, name) VALUES ($1, $2) RETURNING id`, [projectId, name])).rows[0]!.id as string;
}

async function insertCase(groupId: string, versionId: string | null, title: string): Promise<string> {
  return (await pool.query(`INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, $3) RETURNING id`, [groupId, versionId, title])).rows[0]!.id as string;
}

async function insertStep(caseId: number | string, order: number, instruction: string, compiled: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO test_steps(case_id, "order", source, instruction, compiled) VALUES ($1, $2, 'manual', $3, $4::jsonb)`,
    [caseId, order, instruction, compiled === null ? null : JSON.stringify(compiled)],
  );
}

describe('manage_cases 工具', () => {
  it('search:缺省当前版本;versionId 跨版本检索;他项目版本/分组拒绝;create_group 建组可用', async () => {
    const seed = await seedProject(pool);
    const other = await seedProject(pool);
    const v1 = await insertVersion(seed.projectId, 'v1');
    await insertCase(seed.groupId, seed.versionId, '本版登录用例');
    await insertCase(seed.groupId, v1, '别版登录用例');
    await insertCase(other.groupId, other.versionId, '他项目用例');
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await buildCasesToolsLazy(ctx);

    // 缺省只搜当前版本
    const cur = await tool.execute({ action: 'search', keyword: '登录' });
    expect((cur as { ok: true; data: string }).data).toContain('本版登录用例');
    expect((cur as { ok: true; data: string }).data).not.toContain('别版登录用例');

    // 传 versionId 检索同项目其它版本
    const cross = await tool.execute({ action: 'search', keyword: '登录', versionId: v1 });
    expect((cross as { ok: true; data: string }).data).toContain('别版登录用例');
    expect((cross as { ok: true; data: string }).data).not.toContain('本版登录用例');

    // 他项目版本 / 他项目分组拒绝
    expect(await tool.execute({ action: 'search', versionId: other.versionId })).toMatchObject({ ok: false });
    expect(await tool.execute({ action: 'search', groupId: other.groupId })).toMatchObject({ ok: false });

    // create_group 仍实时写
    const g = await tool.execute({ action: 'create_group', groupName: 'AI分组' });
    expect(g.ok).toBe(true);
    expect((await pool.query(`SELECT id FROM groups WHERE name='AI分组' AND project_id=$1`, [seed.projectId])).rowCount).toBe(1);
  }, 30_000);

  it('get:当前版本可读;同项目跨版本可读;跨项目拒绝', async () => {
    const seed = await seedProject(pool);
    const other = await seedProject(pool);
    const v1 = await insertVersion(seed.projectId, 'v1');
    const curId = await insertCase(seed.groupId, seed.versionId, '本版用例');
    const v1CaseId = await insertCase(seed.groupId, v1, '别版用例');
    const otherCaseId = await insertCase(other.groupId, other.versionId, '他项目用例');
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await buildCasesToolsLazy(ctx);

    expect((await tool.execute({ action: 'get', caseId: curId })).ok).toBe(true);
    expect((await tool.execute({ action: 'get', caseId: v1CaseId })).ok).toBe(true);
    expect(await tool.execute({ action: 'get', caseId: otherCaseId })).toMatchObject({ ok: false });
  }, 30_000);

  it('list_versions:列出项目版本并标出当前版本', async () => {
    const seed = await seedProject(pool);
    await insertVersion(seed.projectId, 'v1');
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await buildCasesToolsLazy(ctx);

    const r = await tool.execute({ action: 'list_versions' });
    expect(r.ok).toBe(true);
    const versions = JSON.parse((r as { ok: true; data: string }).data) as Array<{ name: string; isCurrent: boolean }>;
    expect(versions.find((v) => v.name === 'v0')).toMatchObject({ isCurrent: true });
    expect(versions.find((v) => v.name === 'v1')).toMatchObject({ isCurrent: false });
  }, 30_000);

  it('copy_to_version:跨版本复制(步骤克隆+标题副本);缺省目标=当前版本;显式目标版本;归属拒绝', async () => {
    const seed = await seedProject(pool);
    const other = await seedProject(pool);
    const v1 = await insertVersion(seed.projectId, 'v1');
    const v2 = await insertVersion(seed.projectId, 'v2');
    const srcId = await insertCase(seed.groupId, v1, '登录用例');
    await insertStep(srcId, 0, '打开首页', [{ kind: 'navigate', url: 'https://a.example.com' }]);
    await insertStep(srcId, 1, '点击登录', null);
    const otherCaseId = await insertCase(other.groupId, other.versionId, '他项目用例');
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await buildCasesToolsLazy(ctx);

    // 缺省目标 = 当前线程版本(v0)
    const r = await tool.execute({ action: 'copy_to_version', caseId: srcId, targetGroupId: seed.groupId });
    expect(r.ok).toBe(true);
    const copied = (await pool.query(
      `SELECT id, version_id FROM test_cases WHERE title = '登录用例 副本'`,
    )).rows[0]!;
    expect(copied.version_id).toBe(seed.versionId);
    const steps = (await pool.query(
      `SELECT instruction, compiled FROM test_steps WHERE case_id = $1 ORDER BY "order"`,
      [copied.id],
    )).rows as Array<{ instruction: string; compiled: Array<{ kind: string }> | null }>;
    expect(steps.map((s) => s.instruction)).toEqual(['打开首页', '点击登录']);
    expect(steps[0]!.compiled?.[0]?.kind).toBe('navigate');
    expect(steps[1]!.compiled).toBeNull();

    // 显式目标版本 v2
    await tool.execute({ action: 'copy_to_version', caseId: srcId, targetGroupId: seed.groupId, versionId: v2 });
    expect((await pool.query(
      `SELECT id FROM test_cases WHERE title = '登录用例 副本1' AND version_id = $1`,
      [v2],
    )).rowCount).toBe(1);

    // 归属拒绝:他项目源用例 / 他项目目标分组 / 他项目目标版本
    expect(await tool.execute({ action: 'copy_to_version', caseId: otherCaseId, targetGroupId: seed.groupId }))
      .toMatchObject({ ok: false });
    expect(await tool.execute({ action: 'copy_to_version', caseId: srcId, targetGroupId: other.groupId }))
      .toMatchObject({ ok: false });
    expect(await tool.execute({ action: 'copy_to_version', caseId: srcId, targetGroupId: seed.groupId, versionId: other.versionId }))
      .toMatchObject({ ok: false });

    // 不存在的版本
    expect(await tool.execute({ action: 'copy_to_version', caseId: srcId, targetGroupId: seed.groupId, versionId: randomUUID() }))
      .toMatchObject({ ok: false });
  }, 30_000);

  it('manage_datasets:list 仅结构;get 回脱敏行值({__masked:true}),敏感明文绝不外泄;跨项目拒绝', async () => {
    const seed = await seedProject(pool);
    const other = await seedProject(pool);
    const { createDataset } = await import('../src/services/datasets.service.js');
    const ds = await createDataset(seed.projectId, {
      name: '登录账号',
      columns: [
        { name: 'username', sensitive: false },
        { name: 'password', sensitive: true },
      ],
      rows: [
        { cells: { username: 'alice', password: 'alice-secret-pass' } },
        { disabled: true, cells: { username: 'bob', password: 'bob-secret-pass' } },
      ],
    });
    expect(ds.id).toBeTruthy();
    const otherDs = await createDataset(other.projectId, {
      name: '他项目数据集',
      columns: [{ name: 'k', sensitive: false }],
      rows: [{ cells: { k: 'v' } }],
    });
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const { buildDatasetsTools } = await import('../src/pi/space/tools/datasets.js');
    const tool = buildDatasetsTools(ctx)[0]!;

    // list:仅结构(列/敏感标记/行数),无行值;projectId/updatedAt 字段不外泄
    const r = await tool.execute({ action: 'list' });
    expect(r.ok).toBe(true);
    const raw = (r as { ok: true; data: string }).data;
    const list = JSON.parse(raw) as Array<{ name: string; columns: Array<{ name: string; sensitive: boolean }>; rowCount: number; enabledRowCount: number }>;
    const d = list.find((x) => x.name === '登录账号')!;
    expect(d.columns).toEqual([
      { name: 'username', sensitive: false },
      { name: 'password', sensitive: true },
    ]);
    expect(d.rowCount).toBe(2);
    expect(d.enabledRowCount).toBe(1);
    expect(raw).not.toContain('alice');
    expect(raw).not.toContain('bob');
    expect(raw).not.toContain('secret-pass');
    expect(raw).not.toContain('projectId');
    expect(raw).not.toContain('updatedAt');

    // get:非敏感明文可见;敏感格 {__masked:true} 占位,敏感明文/密文绝不外泄
    const g = await tool.execute({ action: 'get', datasetId: ds.id });
    expect(g.ok).toBe(true);
    const gRaw = (g as { ok: true; data: string }).data;
    const detail = JSON.parse(gRaw) as { rows: Array<{ disabled?: boolean; cells: Record<string, unknown> }> };
    expect(detail.rows[0]!.cells.username).toBe('alice');
    expect(detail.rows[0]!.cells.password).toEqual({ __masked: true });
    expect(detail.rows[1]!.disabled).toBe(true);
    expect(gRaw).not.toContain('secret-pass');
    expect(gRaw).not.toContain('"c"');

    // 跨项目数据集拒绝
    expect(await tool.execute({ action: 'get', datasetId: otherDs.id })).toMatchObject({ ok: false });
  }, 30_000);

  it('get:已绑定数据集的用例返回 dataset 结构;未绑定返回 dataset:null', async () => {
    const seed = await seedProject(pool);
    const { createDataset } = await import('../src/services/datasets.service.js');
    const ds = await createDataset(seed.projectId, {
      name: '登录账号',
      columns: [
        { name: 'username', sensitive: false },
        { name: 'password', sensitive: true },
      ],
      rows: [
        { cells: { username: 'alice', password: 'alice-secret-pass' } },
        { disabled: true, cells: { username: 'bob', password: 'bob-secret-pass' } },
      ],
    });
    const boundId = await insertCase(seed.groupId, seed.versionId, '绑定数据集用例');
    await pool.query(`UPDATE test_cases SET dataset_id = $1 WHERE id = $2`, [ds.id, boundId]);
    const freeId = await insertCase(seed.groupId, seed.versionId, '未绑定用例');
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await buildCasesToolsLazy(ctx);

    const bound = await tool.execute({ action: 'get', caseId: boundId });
    expect(bound.ok).toBe(true);
    const boundRaw = (bound as { ok: true; data: string }).data;
    const boundDetail = JSON.parse(boundRaw) as { dataset: { name: string; columns: Array<{ name: string; sensitive: boolean }>; enabledRowCount: number } | null };
    expect(boundDetail.dataset).toEqual({
      id: ds.id,
      name: '登录账号',
      columns: [
        { name: 'username', sensitive: false },
        { name: 'password', sensitive: true },
      ],
      enabledRowCount: 1,
      // 行选择：启用行下标数组；[] = 所有启用行
      rowIndexes: [],
    });
    // dataset 结构信息里不含任何行值
    expect(boundRaw).not.toContain('alice');
    expect(boundRaw).not.toContain('secret-pass');

    const free = await tool.execute({ action: 'get', caseId: freeId });
    expect(free.ok).toBe(true);
    const freeDetail = JSON.parse((free as { ok: true; data: string }).data) as { dataset: unknown };
    expect(freeDetail.dataset).toBeNull();
  }, 30_000);
});
