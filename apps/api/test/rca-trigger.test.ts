/**
 * RCA 触发条件：run 收尾后 rcaEnabled && failedCases>0 才入队。
 * 测试环境无 REDIS_URL → inline fire-and-forget 路径，直接断言 processRcaJob 被调用。
 * 用 FORCE_FAIL_CASE_IDS 造失败（runCase 在进 CDP 前直接写失败报告，无需浏览器）。
 *
 * 「全过不触发」用 deprecated 用例（收尾 skipped、failedCases=0）：裸用例无环境配置会以
 * EnvMissing 失败，无法在不启动浏览器的前提下造出真 passed，deprecated skip 是确定性零失败路径。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

vi.mock('../src/scheduler/rcaWorker.js', () => ({ processRcaJob: vi.fn().mockResolvedValue(undefined) }));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  delete process.env.REDIS_URL; // inline 路径
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  delete process.env.FORCE_FAIL_CASE_IDS;
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function seedPlanWithCase(rcaEnabled: boolean): Promise<{ planId: string; caseId: string }> {
  const { projectId, groupId, versionId } = await seedProject(pool);
  const c = await pool.query(
    `INSERT INTO test_cases(group_id, title, version_id) VALUES ($1, '必败用例', $2) RETURNING id`,
    [groupId, versionId],
  );
  const caseId = c.rows[0]!.id as string;
  const p = await pool.query(
    `INSERT INTO execution_plans(project_id, name, version_id, rca_enabled) VALUES ($1, '触发计划', $2, $3) RETURNING id`,
    [projectId, versionId, rcaEnabled],
  );
  await pool.query(`INSERT INTO plan_cases(plan_id, case_id, "order") VALUES ($1, $2, 1)`, [p.rows[0]!.id as string, caseId]);
  return { planId: p.rows[0]!.id as string, caseId };
}

async function runPlanAndWait(planId: string, caseId: string): Promise<string> {
  process.env.FORCE_FAIL_CASE_IDS = caseId;
  try {
    const { enqueuePlanRun } = await import('../src/execute/enqueuePlanRun.js');
    const { runId } = await enqueuePlanRun({ planId, trigger: { source: 'manual' }, callerUser: null });
    for (let i = 0; i < 100; i++) {
      const r = await pool.query('SELECT status FROM plan_runs WHERE id = $1', [runId]);
      if (r.rows[0] && r.rows[0].status !== 'running') return runId;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error('plan run did not finish');
  } finally {
    delete process.env.FORCE_FAIL_CASE_IDS;
  }
}

/** RCA 入队是 fire-and-forget，run 收敛后 mock 可能还没被调到——短暂轮询等待。 */
async function waitForRcaCalls(min: number, timeoutMs = 5000): Promise<number> {
  const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && vi.mocked(processRcaJob).mock.calls.length < min) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return vi.mocked(processRcaJob).mock.calls.length;
}

describe('RCA 触发条件', () => {
  it('rcaEnabled 且有失败 → processRcaJob 被调用', async () => {
    const { planId, caseId } = await seedPlanWithCase(true);
    const runId = await runPlanAndWait(planId, caseId);
    await waitForRcaCalls(1);
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    expect(vi.mocked(processRcaJob)).toHaveBeenCalledWith({ kind: 'rca', planRunId: runId });
  });

  it('rcaEnabled=false 不触发', async () => {
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    const calls = vi.mocked(processRcaJob).mock.calls.length;
    const { planId, caseId } = await seedPlanWithCase(false);
    await runPlanAndWait(planId, caseId);
    expect(vi.mocked(processRcaJob).mock.calls.length).toBe(calls);
  });

  it('无失败（failedCases=0）不触发', async () => {
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    const calls = vi.mocked(processRcaJob).mock.calls.length;
    const { projectId, groupId, versionId } = await seedProject(pool);
    const c = await pool.query(
      `INSERT INTO test_cases(group_id, title, version_id, status) VALUES ($1, '已废弃用例', $2, 'deprecated') RETURNING id`,
      [groupId, versionId],
    );
    const p = await pool.query(
      `INSERT INTO execution_plans(project_id, name, version_id, rca_enabled) VALUES ($1, '全过计划', $2, true) RETURNING id`,
      [projectId, versionId],
    );
    await pool.query(`INSERT INTO plan_cases(plan_id, case_id, "order") VALUES ($1, $2, 1)`, [p.rows[0]!.id as string, c.rows[0]!.id as string]);
    await runPlanAndWait(p.rows[0]!.id as string, c.rows[0]!.id as string);
    expect(vi.mocked(processRcaJob).mock.calls.length).toBe(calls);
  });
});
