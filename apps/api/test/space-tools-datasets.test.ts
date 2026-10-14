import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
import type { SpaceToolsContext } from '../src/pi/space/tools/context.js';
import type { ToolExecutor } from '../src/pi/tools.js';

// 注意:stage-tools / services 链上静态引入 db/client(DATABASE_URL 在 beforeAll 才指向容器),
// 必须在测试体内动态 import(与 space-case-ops.test.ts 同模式),否则查询打到默认本地库。
let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  // listStage 并行查全部 6 张 stage 表,其余 4 张补空表(列定义照 src/db/schema.ts)
  await pool.query(`
    CREATE TABLE ai_stage_datasets (
      thread_id text NOT NULL,
      local_id text NOT NULL,
      version_id uuid NOT NULL,
      name varchar(120) NOT NULL,
      description text,
      columns jsonb NOT NULL DEFAULT '[]',
      rows jsonb NOT NULL DEFAULT '[]',
      staged_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT ai_stage_datasets_pk PRIMARY KEY(thread_id, local_id)
    )`);
  // listStage 并行查全部 6 张 stage 表,其余 4 张补空表(列定义照 src/db/schema.ts)
  await pool.query(`
    CREATE TABLE ai_stage_case_ops (
      thread_id text NOT NULL,
      local_id text NOT NULL,
      version_id uuid NOT NULL,
      case_id uuid NOT NULL,
      op varchar(30) NOT NULL,
      payload jsonb NOT NULL,
      summary text NOT NULL,
      diff text,
      staged_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT ai_stage_case_ops_pk PRIMARY KEY(thread_id, local_id)
    )`);
  await pool.query(`
    CREATE TABLE ai_stage_scenarios (
      thread_id text NOT NULL,
      local_id text NOT NULL,
      version_id uuid NOT NULL,
      requirement_id uuid NOT NULL,
      title varchar(200) NOT NULL,
      description text,
      case_local_ids text[] NOT NULL DEFAULT '{}',
      staged_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT ai_stage_scenarios_pk PRIMARY KEY(thread_id, local_id)
    )`);
  await pool.query(`
    CREATE TABLE ai_stage_environments (
      thread_id text NOT NULL,
      local_id text NOT NULL,
      version_id uuid NOT NULL,
      name varchar(120) NOT NULL,
      base_url text,
      objects jsonb NOT NULL DEFAULT '[]',
      staged_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT ai_stage_environments_pk PRIMARY KEY(thread_id, local_id)
    )`);
  await pool.query(`
    CREATE TABLE ai_stage_plans (
      thread_id text NOT NULL,
      local_id text NOT NULL,
      version_id uuid NOT NULL,
      name varchar(200) NOT NULL,
      environment_id uuid,
      case_local_ids text[] NOT NULL DEFAULT '{}',
      staged_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT ai_stage_plans_pk PRIMARY KEY(thread_id, local_id)
    )`);
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

async function toolOf(ctx: SpaceToolsContext, name: string): Promise<ToolExecutor> {
  const { buildStageTools } = await import('../src/pi/space/tools/stage-tools.js');
  const tool = buildStageTools(ctx).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

const VALID_BODY = {
  localId: randomUUID(),
  name: '登录数据集',
  columns: [
    { name: 'username', sensitive: false },
    { name: 'password', sensitive: true },
    { name: 'expectedTip' },
  ],
  rows: [
    { cells: { username: 'admin', password: 'SUPER-SECRET', expectedTip: '欢迎回来' } },
    { cells: { username: 'locked_user', password: 'wrong-pass', expectedTip: '账号已锁定' } },
  ],
};

describe('stage_dataset 工具', () => {
  it('非法列名/重复列/cells 未知列/非 string 值 → 快速失败,不落库', async () => {
    const seed = await seedProject(pool);
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx, 'stage_dataset');

    const badName = await tool.execute({ ...VALID_BODY, localId: randomUUID(), columns: [{ name: '1user' }] });
    expect(badName.ok).toBe(false);
    expect((badName as { error: string }).error).toContain('不是合法变量名');

    const dup = await tool.execute({ ...VALID_BODY, localId: randomUUID(), columns: [{ name: 'a' }, { name: 'a' }] });
    expect(dup.ok).toBe(false);
    expect((dup as { error: string }).error).toContain('列名重复');

    const unknownCol = await tool.execute({
      ...VALID_BODY, localId: randomUUID(), columns: [{ name: 'a' }], rows: [{ cells: { a: 'x', b: 'y' } }],
    });
    expect(unknownCol.ok).toBe(false);
    expect((unknownCol as { error: string }).error).toContain('未在 columns 声明的列');

    // zod record(string) 拒绝非 string 单元格
    const badCell = await tool.execute({
      // @ts-expect-error 故意传 number 单元格
      ...VALID_BODY, localId: randomUUID(), columns: [{ name: 'a' }], rows: [{ cells: { a: 123 } }],
    });
    expect(badCell.ok).toBe(false);

    const none = await pool.query(`SELECT count(*)::int AS n FROM ai_stage_datasets WHERE thread_id=$1`, [ctx.threadId]);
    expect(none.rows[0]!.n).toBe(0);
  });

  it('成功暂存:敏感列明文留在 stage(草稿语义),listStage 可见,同 localId 幂等 upsert', async () => {
    const seed = await seedProject(pool);
    const { ctx, events } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx, 'stage_dataset');

    const ok = await tool.execute(VALID_BODY);
    expect(ok.ok).toBe(true);
    // SSE stage 事件 kind=dataset 且 payload 带明文(用户预览语义)
    const ev = events.find((e) => e.type === 'stage' && e.kind === 'dataset');
    expect(ev).toBeTruthy();
    expect(JSON.stringify(ev)).toContain('SUPER-SECRET');

    // stage 表存明文(加密只发生在落库 createDataset)
    const row = (await pool.query(`SELECT name, columns, rows FROM ai_stage_datasets WHERE thread_id=$1 AND local_id=$2`, [ctx.threadId, VALID_BODY.localId])).rows[0]!;
    expect(row.name).toBe('登录数据集');
    expect(JSON.stringify(row.rows)).toContain('SUPER-SECRET');

    const { listStage } = await import('../src/pi/space/tools/stage-tools.js');
    const doc = await listStage(ctx.threadId);
    expect(doc.datasets).toHaveLength(1);
    expect(doc.datasets[0]!.columns.map((c) => c.name)).toEqual(['username', 'password', 'expectedTip']);
    expect(doc.datasets[0]!.rows[0]!.cells.password).toBe('SUPER-SECRET');

    // 同 localId 重发 = 幂等 upsert(改名后仍 1 行)
    const ok2 = await tool.execute({ ...VALID_BODY, name: '登录数据集v2' });
    expect(ok2.ok).toBe(true);
    const cnt = await pool.query(`SELECT count(*)::int AS n, max(name) AS name FROM ai_stage_datasets WHERE thread_id=$1`, [ctx.threadId]);
    expect(cnt.rows[0]!.n).toBe(1);
    expect(cnt.rows[0]!.name).toBe('登录数据集v2');
  });

  it('stage_case 携带 datasetLocalId 暂存;listStage 透出绑定关系;前瞻变量体检抓列名不一致', async () => {
    const seed = await seedProject(pool);
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const dsTool = await toolOf(ctx, 'stage_dataset');
    const caseTool = await toolOf(ctx, 'stage_case');
    await dsTool.execute(VALID_BODY);

    // 负例:compiled 引用与数据集列不一致的 {{用户名}} → 体检在暂存响应里立即指出
    const bad = await caseTool.execute({
      localId: randomUUID(), title: '变量写错', datasetLocalId: VALID_BODY.localId,
      steps: [{ action: '输入 {{用户名}}', compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#u' }], value: '{{用户名}}' }] }],
    });
    expect(bad.ok).toBe(true);
    // 中文变量名不进 VAR_RE,由宽松 {{...}} 兜底点名(回放时它会以字面量填入,必须当场暴露)
    expect((bad as { data: string }).data).toContain('{{用户名}} 不是合法变量名');

    const ok = await caseTool.execute({
      localId: randomUUID(), title: '登录-数据驱动', datasetLocalId: VALID_BODY.localId,
      steps: [{ action: '输入 {{username}}/{{password}} 并登录', compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#u' }], value: '{{username}}' }] }],
    });
    expect(ok.ok).toBe(true);
    expect((ok as { data: string }).data).toContain('变量体检:通过');

    const { listStage } = await import('../src/pi/space/tools/stage-tools.js');
    const doc = await listStage(ctx.threadId);
    expect(doc.cases.find((c) => c.title === '登录-数据驱动')!.datasetLocalId).toBe(VALID_BODY.localId);
  });
});

describe('stage_case 覆盖类型(coverageTypes)', () => {
  it('声明的 coverageTypes 落暂存表;响应附覆盖回执点名各类分布', async () => {
    const seed = await seedProject(pool);
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx, 'stage_case');

    const first = await tool.execute({ localId: randomUUID(), title: '登录成功', coverageTypes: ['functional'] });
    expect(first.ok).toBe(true);
    const data1 = (first as { data: string }).data;
    expect(data1).toContain('覆盖回执');
    expect(data1).toContain('本条覆盖 功能（正常流）');
    // 第一条时其余类型均未覆盖,模型据此知道自己还没切
    expect(data1).toContain('异常场景×0');

    await tool.execute({ localId: randomUUID(), title: '密码错误', coverageTypes: ['exception'] });
    const third = await tool.execute({ localId: randomUUID(), title: '超长用户名', coverageTypes: ['boundary'] });
    const data3 = (third as { data: string }).data;
    expect(data3).toContain('功能（正常流）×1');
    expect(data3).toContain('异常场景×1');
    expect(data3).toContain('边界值×1');
    expect(data3).toContain('UI/UX（呈现·交互）×0');

    const { listStage } = await import('../src/pi/space/tools/stage-tools.js');
    const doc = await listStage(ctx.threadId);
    expect(doc.cases.find((c) => c.title === '密码错误')!.coverageTypes).toEqual(['exception']);
  });

  it('非法类型 key 被 zod 拒绝,不入暂存区', async () => {
    const seed = await seedProject(pool);
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx, 'stage_case');

    // @ts-expect-error 故意传未知类型 key
    const bad = await tool.execute({ localId: randomUUID(), title: 'X', coverageTypes: ['perf'] });
    expect(bad.ok).toBe(false);

    const n = await pool.query(`SELECT count(*)::int AS n FROM ai_stage_cases WHERE thread_id=$1`, [ctx.threadId]);
    expect(n.rows[0]!.n).toBe(0);
  });

  it('暂存区的 coverageTypes 能穿过 createCaseWithSteps 落到正式用例表', async () => {
    const seed = await seedProject(pool);
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await toolOf(ctx, 'stage_case');
    await tool.execute({ localId: randomUUID(), title: '登录-越权', coverageTypes: ['security'] });

    const { listStage } = await import('../src/pi/space/tools/stage-tools.js');
    const row = (await listStage(ctx.threadId)).cases[0]!;

    // stageRoute 的落库就是这组字段的透传
    const { createCaseWithSteps } = await import('../src/services/cases.service.js');
    const created = await createCaseWithSteps({
      groupId: seed.groupId, versionId: seed.versionId, title: row.title,
      coverageTypes: row.coverageTypes,
    });
    const saved = (await pool.query(`SELECT coverage_types FROM test_cases WHERE id=$1`, [created.id])).rows[0]!;
    expect(saved.coverage_types).toEqual(['security']);
  });
});

describe('落库链路(createDataset 加密 + createCase 绑定校验)', () => {
  it('createDataset 敏感格加密落库、出参打码;createCaseWithSteps 绑定成功;跨项目/未知 datasetId 拒绝', async () => {
    const seed = await seedProject(pool);
    const { createDataset } = await import('../src/services/datasets.service.js');
    const casesSvc = await import('../src/services/cases.service.js');

    const created = await createDataset(seed.projectId, {
      name: `登录-${randomUUID().slice(0, 8)}`,
      columns: VALID_BODY.columns,
      rows: VALID_BODY.rows,
    });
    // 出参打码
    expect(created.rows[0]!.cells.password).toEqual({ __masked: true });
    // DB 密文:不含明文,含 {c,i,t} 三元组
    const raw = (await pool.query(`SELECT rows FROM datasets WHERE id=$1`, [created.id])).rows[0]!;
    const rawStr = JSON.stringify(raw.rows);
    expect(rawStr).not.toContain('SUPER-SECRET');
    const encCell = raw.rows[0].cells.password as { c: string; i: string; t: string };
    expect(typeof encCell.c).toBe('string');

    // 绑定成功
    const c = await casesSvc.createCaseWithSteps({
      groupId: seed.groupId, versionId: seed.versionId, title: '登录-数据驱动', datasetId: created.id,
      steps: [{ instruction: '登录' }],
    });
    const bound = (await pool.query(`SELECT dataset_id FROM test_cases WHERE id=$1`, [c.id])).rows[0]!;
    expect(bound.dataset_id).toBe(created.id);

    // 未知 datasetId → 404
    await expect(casesSvc.createCase({
      groupId: seed.groupId, versionId: seed.versionId, title: 'x', datasetId: randomUUID(),
    })).rejects.toMatchObject({ status: 404 });

    // 跨项目 → 400 dataset_project_mismatch
    const other = await seedProject(pool);
    const otherDs = await createDataset(other.projectId, {
      name: `他项目-${randomUUID().slice(0, 8)}`,
      columns: [{ name: 'a' }],
      rows: [{ cells: { a: '1' } }],
    });
    await expect(casesSvc.createCase({
      groupId: seed.groupId, versionId: seed.versionId, title: 'x', datasetId: otherDs.id,
    })).rejects.toMatchObject({ status: 400, code: 'dataset_project_mismatch' });
  });
});
