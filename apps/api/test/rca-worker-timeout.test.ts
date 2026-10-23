/**
 * 超时护栏:RCA_TIMEOUT_MS 到点 runWithTimeout 先 steer 一条收尾消息,宽限 RCA_GRACE_MS
 * 到点 cancelThread(abort),processRcaJob 的 finally 里 fillTimeoutRows 把未落 rca 的
 * 失败行兜底写成 status=timeout。prompt 挂死模拟 AI 长转,首发与 steer 两条消息都不返回,
 * 全靠 runWithTimeout 的两条 Promise.race 定时器驱动——同时验证计时器有清理路径
 * (vitest 必须能正常退出,不留悬挂定时器)。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  delete process.env.REDIS_URL;
  // 必须在动态 import rcaWorker 之前:模块顶层读 env 定超时
  process.env.RCA_TIMEOUT_MS = '200';
  process.env.RCA_GRACE_MS = '200';
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

afterEach(async () => {
  const { resetSpaceSessions } = await import('../src/pi/space/session.js');
  resetSpaceSessions();
  await pool.query(`DELETE FROM ai_threads WHERE purpose='rca'`);
});

describe('rca 超时兜底', () => {
  it('prompt 挂死 → 超时 steer 收尾 → 宽限 abort,未分析行写 status=timeout', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    // FK 完整:plan_runs.plan_id NOT NULL → 必须真 execution_plans 行
    const p = await pool.query(
      `INSERT INTO execution_plans(project_id, name, version_id, rca_enabled) VALUES ($1, '超时计划', $2, true) RETURNING id`,
      [projectId, versionId],
    );
    const r = await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy, rca_enabled, failed_cases)
       VALUES ($1, $2, 'failed', 'run_all', true, 1) RETURNING id`,
      [p.rows[0]!.id as string, projectId],
    );
    const runId = r.rows[0]!.id as string;
    const c = await pool.query(
      `INSERT INTO test_cases(group_id, title, version_id) VALUES ($1, '超时用例', $2) RETURNING id`,
      [groupId, versionId],
    );
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind) VALUES ($1, $2, 1, 'failed', 'business')`,
      [runId, c.rows[0]!.id as string],
    );

    const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
    const prompts: string[] = [];
    let aborted = false;
    setSpaceSessionFactory(async () => ({
      subscribe: () => () => {},
      prompt: async (text: string) => {
        prompts.push(text);
        await new Promise<void>(() => { /* 挂死模拟 AI 长转:首发与 steer 都不返回 */ });
      },
      abort: () => { aborted = true; },
      dispose: () => {},
      clearQueue: () => ({ steering: [], followUp: [] }),
      isStreaming: true,
      messages: [],
    }));
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    await processRcaJob({ kind: 'rca', planRunId: runId });

    // steer 收尾消息确实发出(第二条 prompt),随后 cancelThread → abort
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!).toContain('超时');
    expect(aborted).toBe(true);
    // 未落 rca 的失败行被 fillTimeoutRows 兜底标 timeout
    const rows = await pool.query('SELECT rca FROM plan_run_cases WHERE plan_run_id=$1', [runId]);
    expect((rows.rows[0]!.rca as Record<string, unknown>).status).toBe('timeout');
  }, 30_000);
});
