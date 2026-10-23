import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
import type { SpaceToolsContext } from '../src/pi/space/tools/context.js';
import type { ToolExecutor } from '../src/pi/tools.js';

// 注意:case-ops-tools 链上静态引入 db/client(DATABASE_URL 在 beforeAll 才指向容器),
// 必须在测试体内动态 import(与 space-tools-cases.test.ts 同模式),否则查询打到默认本地库。
async function buildStageCaseOpTool(ctx: SpaceToolsContext): Promise<ToolExecutor> {
  const { buildCaseOpsTools } = await import('../src/pi/space/tools/case-ops-tools.js');
  return buildCaseOpsTools(ctx)[0]!;
}

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  // ai_stage_case_ops 已收录进 SCHEMA_SQL；保留幂等自建兜底（与 src/db/schema.ts 对齐）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_stage_case_ops (
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

async function insertCase(groupId: string, versionId: string | null, title: string): Promise<string> {
  return (await pool.query(`INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, $3) RETURNING id`, [groupId, versionId, title])).rows[0]!.id as string;
}

async function insertStep(caseId: string, order: number, instruction: string, compiled: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO test_steps(case_id, "order", source, instruction, compiled) VALUES ($1, $2, 'manual', $3, $4::jsonb)`,
    [caseId, order, instruction, compiled === null ? null : JSON.stringify(compiled)],
  );
}

describe('stage_case_op 工具', () => {
  it('update_case 绑定/解绑数据集:暂存→applyCaseOp 落库', async () => {
    const seed = await seedProject(pool);
    const { createDataset } = await import('../src/services/datasets.service.js');
    const ds = await createDataset(seed.projectId, {
      name: '登录账号',
      columns: [
        { name: 'username', sensitive: false },
        { name: 'password', sensitive: true },
      ],
      rows: [{ cells: { username: 'alice', password: 'p1' } }],
    });
    const caseId = await insertCase(seed.groupId, seed.versionId, '绑定数据集用例');
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await buildStageCaseOpTool(ctx);
    const { applyCaseOp } = await import('../src/pi/space/tools/case-ops-tools.js');

    // 暂存绑定
    const staged = await tool.execute({ localId: randomUUID(), action: 'update_case', caseId, patch: { datasetId: ds.id } });
    expect(staged.ok).toBe(true);
    expect((staged as { ok: true; data: string }).data).toContain('已暂存');

    // 落库 → dataset_id 已绑定
    await applyCaseOp('update_case', JSON.parse(JSON.stringify({ action: 'update_case', caseId, patch: { datasetId: ds.id } })), ctx);
    const bound = (await pool.query(`SELECT dataset_id FROM test_cases WHERE id=$1`, [caseId])).rows[0]!;
    expect(bound.dataset_id).toBe(ds.id);

    // 解绑:patch.datasetId = null → NULL
    const staged2 = await tool.execute({ localId: randomUUID(), action: 'update_case', caseId, patch: { datasetId: null } });
    expect(staged2.ok).toBe(true);
    await applyCaseOp('update_case', JSON.parse(JSON.stringify({ action: 'update_case', caseId, patch: { datasetId: null } })), ctx);
    const freed = (await pool.query(`SELECT dataset_id FROM test_cases WHERE id=$1`, [caseId])).rows[0]!;
    expect(freed.dataset_id).toBeNull();
  }, 30_000);

  it('跨项目数据集绑定被拒绝:applyCaseOp 抛 dataset_project_mismatch', async () => {
    const seed = await seedProject(pool);
    const other = await seedProject(pool);
    const { createDataset } = await import('../src/services/datasets.service.js');
    const ds = await createDataset(other.projectId, {
      name: '他项目数据集',
      columns: [{ name: 'username', sensitive: false }],
      rows: [],
    });
    const caseId = await insertCase(seed.groupId, seed.versionId, '本项目用例');
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const { applyCaseOp } = await import('../src/pi/space/tools/case-ops-tools.js');

    await expect(
      applyCaseOp('update_case', JSON.parse(JSON.stringify({ action: 'update_case', caseId, patch: { datasetId: ds.id } })), ctx),
    ).rejects.toMatchObject({ code: 'dataset_project_mismatch' });
  }, 30_000);

  it('insert_step/update_step 暂存响应附前瞻变量体检', async () => {
    const seed = await seedProject(pool);
    const { createDataset } = await import('../src/services/datasets.service.js');
    const ds = await createDataset(seed.projectId, {
      name: '登录账号',
      columns: [
        { name: 'username', sensitive: false },
        { name: 'password', sensitive: true },
      ],
      rows: [{ cells: { username: 'alice', password: 'p1' } }],
    });
    const caseId = await insertCase(seed.groupId, seed.versionId, '登录用例');
    await pool.query(`UPDATE test_cases SET dataset_id = $1 WHERE id = $2`, [ds.id, caseId]);
    await insertStep(caseId, 1, '打开页面', [{ kind: 'navigate', locator: [{ strategy: 'css', value: 'body' }], url: 'https://x/' }]);
    const { ctx } = makeCtx({ projectId: seed.projectId, versionId: seed.versionId });
    const tool = await buildStageCaseOpTool(ctx);

    // 引用绑定数据集列 → 体检通过
    const good = await tool.execute({
      localId: randomUUID(), action: 'insert_step', caseId, instruction: '填用户名',
      compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#u' }], value: '{{username}}' }],
    });
    expect(good.ok).toBe(true);
    expect((good as { ok: true; data: string }).data).toContain('变量体检:通过');

    // 引用未定义变量 → 体检点名 ghost
    const bad = await tool.execute({
      localId: randomUUID(), action: 'insert_step', caseId, instruction: '填幽灵',
      compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#g' }], value: '{{ghost}}' }],
    });
    expect(bad.ok).toBe(true);
    const badData = (bad as { ok: true; data: string }).data;
    expect(badData).toContain('变量体检:');
    expect(badData).not.toContain('变量体检:通过');
    expect(badData).toContain('ghost');

    // update_step 同样附体检
    const stepId = (await pool.query(`SELECT id FROM test_steps WHERE case_id=$1 ORDER BY "order" LIMIT 1`, [caseId])).rows[0]!.id as string;
    const up = await tool.execute({
      localId: randomUUID(), action: 'update_step', caseId, stepId,
      compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#u2' }], value: '{{username}}' }],
    });
    expect(up.ok).toBe(true);
    expect((up as { ok: true; data: string }).data).toContain('变量体检:通过');
  }, 30_000);
});
