import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
import { emptyRepoState, type SpaceToolsContext } from '../src/pi/space/tools/context.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
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

/** 造一条 failed 计划运行 + 失败用例行（plan_run_cases）。
 *  FK 全真：plan_runs.plan_id → execution_plans、plan_run_cases.case_id → test_cases。 */
async function seedFailedRunCase(): Promise<{ planRunId: string; planRunCaseId: string }> {
  const { projectId, groupId, versionId } = await seedProject(pool);
  const plan = await pool.query(
    `INSERT INTO execution_plans(project_id, name) VALUES ($1, 'RCA种子计划') RETURNING id`,
    [projectId],
  );
  const run = await pool.query(
    `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1, $2, 'failed', 'run_all') RETURNING id`,
    [plan.rows[0]!.id as string, projectId],
  );
  const c = await pool.query(
    `INSERT INTO test_cases(group_id, title, version_id) VALUES ($1, '失败用例', $2) RETURNING id`,
    [groupId, versionId],
  );
  const prc = await pool.query(
    `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind, error) VALUES ($1, $2, 1, 'failed', 'business', 'case failed') RETURNING id`,
    [run.rows[0]!.id as string, c.rows[0]!.id as string],
  );
  return { planRunId: run.rows[0]!.id as string, planRunCaseId: prc.rows[0]!.id as string };
}

function toolCtx(overrides: Partial<SpaceToolsContext> = {}): SpaceToolsContext {
  return {
    threadId: randomUUID(),
    versionId: randomUUID(),
    projectId: randomUUID(),
    repo: emptyRepoState(),
    emit: () => {},
    createdByUserId: null,
    manager: false,
    lang: 'zh-CN',
    ...overrides,
  };
}

describe('save_rca_result', () => {
  it('合法入参写入 planRunCases.rca（合并 analyzedAt/threadId）', async () => {
    const { planRunCaseId } = await seedFailedRunCase();
    const tc = toolCtx();
    const { buildSaveRcaResultTool } = await import('../src/pi/space/tools/saveRcaResult.js');
    const tool = buildSaveRcaResultTool(tc);
    const r = await tool.execute({
      planRunCaseId,
      status: 'analyzed',
      category: 'system_defect',
      confidence: 'high',
      summary: '提交接口未校验必填字段',
      evidence: [{ file: 'src/api/submit.ts', lines: '12-34', note: '缺 non-null 校验' }],
      suggestion: '补字段校验',
    });
    expect(r.ok).toBe(true);
    const row = await pool.query('SELECT rca FROM plan_run_cases WHERE id = $1', [planRunCaseId]);
    const rca = row.rows[0]!.rca as Record<string, unknown>;
    expect(rca.status).toBe('analyzed');
    expect(rca.summary).toBe('提交接口未校验必填字段');
    expect(rca.threadId).toBe(tc.threadId);
    expect(typeof rca.analyzedAt).toBe('string');
  });

  it('拒绝 status=timeout / 未知 planRunCaseId / 非法枚举', async () => {
    const { planRunCaseId } = await seedFailedRunCase();
    const { buildSaveRcaResultTool } = await import('../src/pi/space/tools/saveRcaResult.js');
    const tool = buildSaveRcaResultTool(toolCtx());
    expect((await tool.execute({ planRunCaseId, status: 'timeout', category: 'other', confidence: 'low', summary: 'x' })).ok).toBe(false);
    expect((await tool.execute({ planRunCaseId: randomUUID(), status: 'skipped', category: 'other', confidence: 'low', summary: 'x' })).ok).toBe(false);
    expect((await tool.execute({ planRunCaseId, status: 'skipped', category: 'nope', confidence: 'low', summary: 'x' })).ok).toBe(false);
  });

  it('buildSpaceTools 仅在 purpose=rca 线程注册 save_rca_result', async () => {
    const { buildSpaceTools } = await import('../src/pi/space/tools/index.js');
    const chat = buildSpaceTools(toolCtx()).map((t) => t.name);
    expect(chat).not.toContain('save_rca_result');
    const rca = buildSpaceTools(toolCtx({ purpose: 'rca' })).map((t) => t.name);
    expect(rca).toContain('save_rca_result');
  });

  it('session 把 ai_threads.purpose 贯通到工厂 ctx', async () => {
    const { versionId } = await seedProject(pool);
    const threadId = randomUUID();
    await pool.query(
      `INSERT INTO ai_threads(id, kind, version_id, pi_thread_id, purpose) VALUES ($1, 'version', $2, '', 'rca')`,
      [threadId, versionId],
    );
    const { setSpaceSessionFactory, ensureSpaceRecord, resetSpaceSessions } = await import('../src/pi/space/session.js');
    let captured: Record<string, unknown> | null = null;
    setSpaceSessionFactory(async (ctx) => {
      captured = ctx as unknown as Record<string, unknown>;
      return {
        subscribe: () => () => {},
        prompt: async () => {},
        abort: () => {},
        dispose: () => {},
        clearQueue: () => ({ steering: [], followUp: [] }),
        isStreaming: false,
        messages: [],
      };
    });
    await ensureSpaceRecord(threadId);
    expect(captured && (captured as { purpose?: string }).purpose).toBe('rca');
    resetSpaceSessions();
    await pool.query('DELETE FROM ai_threads WHERE id = $1', [threadId]);
  });
});
