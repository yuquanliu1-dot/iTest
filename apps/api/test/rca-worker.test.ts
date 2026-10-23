/**
 * RCA worker 编排：processRcaJob 的守卫（rcaEnabled/failedCases/versionId）、幂等（一线程一 run）、
 * 线程构建（purpose='rca' + 标题）与任务清单注入。stub 会话工厂免 LLM；
 * stub 的 prompt 处理器直接写 plan_run_cases.rca 模拟 AI 调 save_rca_result 落库，
 * 借此验证超时兜底 fillTimeoutRows 不会覆盖已落库的结论（isNull(rca) 过滤）。
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

interface FakeSession {
  prompts: string[];
  aborted: boolean;
  factoryCtx: Record<string, unknown> | null;
}

/** 注入 stub 会话工厂：prompt 记录原文，并模拟 AI 按清单调 save_rca_result 落库（rca.status=skipped）。 */
async function stubFactory(): Promise<FakeSession> {
  const fake: FakeSession = { prompts: [], aborted: false, factoryCtx: null };
  const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
  setSpaceSessionFactory(async (ctx) => {
    fake.factoryCtx = ctx as unknown as Record<string, unknown>;
    return {
      subscribe: () => () => {},
      prompt: async (text: string) => {
        fake.prompts.push(text);
        const { db } = await import('../src/db/client.js');
        const { planRunCases } = await import('../src/db/schema.js');
        const { eq } = await import('drizzle-orm');
        const rows = await db.select({ id: planRunCases.id }).from(planRunCases);
        for (const r of rows) {
          if (text.includes(r.id)) {
            await db
              .update(planRunCases)
              .set({ rca: { status: 'skipped', category: 'case_issue', confidence: 'high', summary: 'stub' } })
              .where(eq(planRunCases.id, r.id));
          }
        }
      },
      abort: () => { fake.aborted = true; },
      dispose: () => {},
      clearQueue: () => ({ steering: [], followUp: [] }),
      isStreaming: false,
      messages: [],
    };
  });
  return fake;
}

/** 造一条 failed 报告：含失败步骤（failureReason/humanMessage）供清单注入断言。 */
async function seedFailedReport(caseId: string): Promise<string> {
  const rep = await pool.query(
    `INSERT INTO reports(case_id, status, step_results, summary) VALUES ($1, 'failed', $2::jsonb, 'e2e') RETURNING id`,
    [
      caseId,
      JSON.stringify([
        { order: 1, status: 'passed', durationMs: 10 },
        { order: 2, status: 'failed', durationMs: 30, error: 'Locator click timeout', failureReason: 'LocatorAllFailed', humanMessage: '页面元素未找到' },
      ]),
    ],
  );
  return rep.rows[0]!.id as string;
}

/** 造 failed 计划运行 + 失败用例行。rcaEnabled=false / failedCases<=0 时不插失败行
 *  （真实收尾语义：没有失败就无可分析）。withVersion=false 时 plan.version_id=null，
 *  但失败行照插——验证 versionId 守卫先于失败清单检查。 */
async function seedFailedRun(
  opts: { rcaEnabled?: boolean; failedCases?: number; withVersion?: boolean } = {},
): Promise<{ runId: string; planRunCaseId: string | null; versionId: string }> {
  const withVersion = opts.withVersion ?? true;
  const { projectId, groupId, versionId } = await seedProject(pool);
  const p = await pool.query(
    `INSERT INTO execution_plans(project_id, name, version_id) VALUES ($1, 'RCA种子计划', $2) RETURNING id`,
    [projectId, withVersion ? versionId : null],
  );
  const r = await pool.query(
    `INSERT INTO plan_runs(plan_id, project_id, status, strategy, rca_enabled, failed_cases)
     VALUES ($1, $2, 'failed', 'run_all', $3, $4) RETURNING id`,
    [p.rows[0]!.id as string, projectId, opts.rcaEnabled ?? true, opts.failedCases ?? 1],
  );
  const runId = r.rows[0]!.id as string;
  if (opts.rcaEnabled === false || (opts.failedCases ?? 1) <= 0) return { runId, planRunCaseId: null, versionId };
  const c = await pool.query(
    `INSERT INTO test_cases(group_id, title, version_id) VALUES ($1, '登录后看不到订单', $2) RETURNING id`,
    [groupId, withVersion ? versionId : null],
  );
  const caseId = c.rows[0]!.id as string;
  const prc = await pool.query(
    `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind, error, report_id)
     VALUES ($1, $2, 1, 'failed', 'business', 'case failed', $3) RETURNING id`,
    [runId, caseId, await seedFailedReport(caseId)],
  );
  return { runId, planRunCaseId: prc.rows[0]!.id as string, versionId };
}

describe('RCA worker 编排', () => {
  it('happy path：建 purpose=rca 线程并注入含用例/失败步骤的清单，stub 落库不被超时兜底覆盖', async () => {
    const fake = await stubFactory();
    const { runId, planRunCaseId } = await seedFailedRun();
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    await processRcaJob({ kind: 'rca', planRunId: runId });

    const t = await pool.query(
      `SELECT id, title, purpose, plan_run_id FROM ai_threads WHERE purpose='rca' AND plan_run_id=$1`,
      [runId],
    );
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.title as string).toContain('根因分析');
    expect(fake.factoryCtx && (fake.factoryCtx as { purpose?: string }).purpose).toBe('rca');

    expect(fake.prompts).toHaveLength(1);
    const prompt = fake.prompts[0]!;
    expect(prompt).toContain(planRunCaseId!);
    expect(prompt).toContain('登录后看不到订单');
    expect(prompt).toContain('LocatorAllFailed');

    // stub 模拟的 save_rca_result 落库生效，且不被 fillTimeoutRows（isNull(rca)）覆盖成 timeout
    const row = await pool.query(`SELECT rca FROM plan_run_cases WHERE id=$1`, [planRunCaseId]);
    expect((row.rows[0]!.rca as Record<string, unknown>).status).toBe('skipped');
  });

  it('幂等：同 run 第二次调用不再建线程不再发消息', async () => {
    const fake = await stubFactory();
    const { runId } = await seedFailedRun();
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    await processRcaJob({ kind: 'rca', planRunId: runId });
    await processRcaJob({ kind: 'rca', planRunId: runId });
    expect(fake.prompts).toHaveLength(1);
    const t = await pool.query(`SELECT count(*)::int AS n FROM ai_threads WHERE purpose='rca' AND plan_run_id=$1`, [runId]);
    expect(t.rows[0]!.n).toBe(1);
  });

  it('守卫：rcaEnabled=false / failedCases=0 / plan 无 version 都不建线程不发消息', async () => {
    const fake = await stubFactory();
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    const a = await seedFailedRun({ rcaEnabled: false });
    const b = await seedFailedRun({ failedCases: 0 });
    const c = await seedFailedRun({ withVersion: false }); // 失败行存在，但 plan.versionId=null
    await processRcaJob({ kind: 'rca', planRunId: a.runId });
    await processRcaJob({ kind: 'rca', planRunId: b.runId });
    await processRcaJob({ kind: 'rca', planRunId: c.runId });
    expect(fake.prompts).toHaveLength(0);
    const t = await pool.query(`SELECT count(*)::int AS n FROM ai_threads WHERE purpose='rca'`);
    expect(t.rows[0]!.n).toBe(0);
  });

  it('会话工厂抛错不外抛，线程行保留', async () => {
    const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
    setSpaceSessionFactory(async () => { throw new Error('llm down'); });
    const { runId } = await seedFailedRun();
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    await expect(processRcaJob({ kind: 'rca', planRunId: runId })).resolves.toBeUndefined();
    const t = await pool.query(`SELECT count(*)::int AS n FROM ai_threads WHERE purpose='rca' AND plan_run_id=$1`, [runId]);
    expect(t.rows[0]!.n).toBe(1);
  });

  it('崩溃扫补：早于 cutoff 的 rca 线程补标 timeout，年轻线程不动', async () => {
    // 直接 SQL 插线程模拟崩溃现场：线程已建、进程死亡、rca 从未落库
    const old = await seedFailedRun();
    const young = await seedFailedRun();
    const insertThread = (runId: string, versionId: string, age: string) =>
      pool.query(
        `INSERT INTO ai_threads(id, kind, version_id, purpose, plan_run_id, title, pi_thread_id, created_at)
         VALUES (gen_random_uuid(), 'version', $1, 'rca', $2, '根因分析 · 崩溃扫补', '', now() - $3::interval)`,
        [versionId, runId, age],
      );
    await insertThread(old.runId, old.versionId, '1 hour'); // 远超 30+3+5min cutoff
    await insertThread(young.runId, young.versionId, '2 minutes'); // 可能是别副本的活分析

    const { sweepStaleRcaRuns } = await import('../src/scheduler/rcaWorker.js');
    const filled = await sweepStaleRcaRuns();
    expect(filled).toBe(1);

    const oldRow = await pool.query(
      `SELECT prc.rca, t.id AS thread_id FROM plan_run_cases prc
       JOIN ai_threads t ON t.plan_run_id = prc.plan_run_id
       WHERE prc.plan_run_id = $1 AND prc.status='failed'`,
      [old.runId],
    );
    const oldRca = oldRow.rows[0]!.rca as Record<string, unknown>;
    expect(oldRca.status).toBe('timeout');
    expect(oldRca.summary).toBe('分析超时未完成');
    expect(oldRca.threadId).toBe(oldRow.rows[0]!.thread_id);

    const youngRow = await pool.query(`SELECT rca FROM plan_run_cases WHERE plan_run_id=$1`, [young.runId]);
    expect(youngRow.rows[0]!.rca).toBeNull();
  });

  it('兜底不覆盖已落结论、只碰 business 失败行', async () => {
    // stub 落 skipped 模拟 AI 已落结论
    await stubFactory();
    const analyzed = await seedFailedRun();
    const { processRcaJob, sweepStaleRcaRuns } = await import('../src/scheduler/rcaWorker.js');
    await processRcaJob({ kind: 'rca', planRunId: analyzed.runId });
    const analyzedRow = await pool.query(`SELECT rca FROM plan_run_cases WHERE id=$1`, [analyzed.planRunCaseId]);
    expect((analyzedRow.rows[0]!.rca as Record<string, unknown>).status).toBe('skipped');

    // 同一 run 再造一条未分析的失败 business 行 + 一条 login_prepare 失败行，
    // 线程回拨过 cutoff 后扫补：只补未落库的 business 行，已落结论行与 login_prepare 行不动
    const c1 = (await pool.query(`SELECT case_id FROM plan_run_cases WHERE id=$1`, [analyzed.planRunCaseId])).rows[0]!.case_id as string;
    const groupId = (await pool.query(`SELECT group_id FROM test_cases WHERE id=$1`, [c1])).rows[0]!.group_id as string;
    const c2 = await pool.query(
      `INSERT INTO test_cases(group_id, title, version_id) VALUES ($1, '第二条失败', $2) RETURNING id`,
      [groupId, analyzed.versionId],
    );
    const caseId2 = c2.rows[0]!.id as string;
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind) VALUES ($1, $2, 2, 'failed', 'business')`,
      [analyzed.runId, caseId2],
    );
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind) VALUES ($1, $2, 3, 'failed', 'login_prepare')`,
      [analyzed.runId, caseId2],
    );
    await pool.query(
      `UPDATE ai_threads SET created_at = now() - interval '1 hour' WHERE purpose='rca' AND plan_run_id=$1`,
      [analyzed.runId],
    );
    await sweepStaleRcaRuns();

    const rows = await pool.query(
      `SELECT step_kind, rca FROM plan_run_cases WHERE plan_run_id=$1 ORDER BY "order"`,
      [analyzed.runId],
    );
    expect((rows.rows[0]!.rca as Record<string, unknown>).status).toBe('skipped'); // 已落结论不动
    expect((rows.rows[1]!.rca as Record<string, unknown>).status).toBe('timeout'); // business 补标
    expect(rows.rows[2]!.rca).toBeNull(); // login_prepare 不碰
  });
});
