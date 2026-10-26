import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

/**
 * 计划运行「执行中步骤不可见」回归（2026-10-26 实测 prod228）。
 *
 * 根因：plan_run_cases.report_id 原先只在用例跑完后才回填。执行期间前端拿不到报告 id →
 * 计划运行详情页只能显示「排队等待执行」，步骤要等整条用例结束才一次性出现。
 *
 * 本测试断言：报告行一落库（status=running）就回填 report_id，
 * 且增量写入的 step_results 在用例【仍在执行】时即可读到。
 */
const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('../src/execute/cdp.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, executeCaseReal: execMock, executeCaseInBrowser: execMock };
});

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let projectId: string;
let groupId: string;
let versionId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  groupId = seed.groupId;
  versionId = seed.versionId;
  await pool.query(`INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认', true)`, [projectId]);

  const { default: express } = await import('express');
  const { planRunsRoute } = await import('../src/routes/planRuns.js');
  const { reportsRoute } = await import('../src/routes/reports.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(seed.userId, seed.username, seed.orgId, seed.orgPath);
    next();
  });
  app.use('/api/plan-runs', planRunsRoute);
  app.use('/api/reports', reportsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function insertCase(title: string): Promise<string> {
  const r = await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, $3) RETURNING id`,
    [groupId, versionId, title],
  );
  return r.rows[0].id as string;
}

async function makeRun(caseIds: string[]): Promise<string> {
  const p = await pool.query(
    `INSERT INTO execution_plans(project_id, name) VALUES ($1, '增量步骤计划') RETURNING id`,
    [projectId],
  );
  const planId = p.rows[0].id as string;
  for (let i = 0; i < caseIds.length; i++) {
    await pool.query(`INSERT INTO plan_cases(plan_id, case_id, "order") VALUES ($1, $2, $3)`, [planId, caseIds[i], i]);
  }
  const r = await pool.query(
    `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1, $2, 'running', 'run_all') RETURNING id`,
    [planId, projectId],
  );
  return r.rows[0].id as string;
}

/** executeCaseReal 的第 9 个参数就是 onStep（见 cdp.ts executeCaseReal 签名）。 */
type OnStep = (r: unknown) => void;

describe('计划运行执行期间步骤增量可见', () => {
  it('报告行落库即回填 plan_run_cases.report_id（不等用例跑完）', async () => {
    const caseId = await insertCase('增量用例');
    const planRunId = await makeRun([caseId]);

    // 在「第一步完成、后续步骤仍在跑」的时刻断言——模拟真实执行中的中间态。
    let reportIdDuringRun: string | null = null;
    let stepsDuringRun: unknown[] = [];
    execMock.mockReset();
    execMock.mockImplementation(async (...args: unknown[]) => {
      const onStep = args[8] as OnStep | undefined;
      onStep?.({ order: 1, status: 'passed', durationMs: 12 });
      // 增量写是 fire-and-forget，等它落定再读（runCase 的 pendingWrites 在终态才 await）
      await new Promise((r) => setTimeout(r, 60));
      const prc = await pool.query(`SELECT report_id FROM plan_run_cases WHERE plan_run_id = $1`, [planRunId]);
      reportIdDuringRun = (prc.rows[0]?.report_id as string | null) ?? null;
      if (reportIdDuringRun) {
        const rep = await pool.query(`SELECT step_results FROM reports WHERE id = $1`, [reportIdDuringRun]);
        stepsDuringRun = (rep.rows[0]?.step_results ?? []) as unknown[];
      }
      // 后续步骤很慢：让用例「仍在执行」时断言已经发生
      await new Promise((r) => setTimeout(r, 80));
      return [{ order: 1, status: 'passed', durationMs: 12 }];
    });

    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await runPlanAsync({ planRunId });

    // 执行期间：report_id 已回填 + 第一步已可见
    expect(reportIdDuringRun).toBeTruthy();
    expect(stepsDuringRun).toHaveLength(1);

    // 终态：report_id 仍指向同一条报告
    const prc = await pool.query(`SELECT report_id, status FROM plan_run_cases WHERE plan_run_id = $1`, [planRunId]);
    expect(prc.rows[0].report_id).toBe(reportIdDuringRun);
    expect(prc.rows[0].status).toBe('passed');
  });

  it('计划运行详情接口在运行中即返回 reportId（前端据此定位报告并轮询）', async () => {
    const caseId = await insertCase('详情增量用例');
    const planRunId = await makeRun([caseId]);

    let detailDuringRun: { reportId: string | null } | null = null;
    execMock.mockReset();
    execMock.mockImplementation(async (...args: unknown[]) => {
      await new Promise((r) => setTimeout(r, 60));
      // 用例仍在执行 → 此刻打详情接口
      const detail = await request(app).get(`/api/plan-runs/${planRunId}`);
      const c = detail.body.cases?.find((x: { caseId: string }) => x.caseId === caseId);
      detailDuringRun = { reportId: c?.reportId ?? null };
      await new Promise((r) => setTimeout(r, 60));
      return [];
    });

    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await runPlanAsync({ planRunId });

    expect(detailDuringRun!.reportId).toBeTruthy();
  });

  it('报告详情接口在 running 期间返回已完成的步骤（增量可见）', async () => {
    const caseId = await insertCase('报告增量用例');
    const planRunId = await makeRun([caseId]);

    let repDuringRun: { status: number; body: { status: string; stepResults: unknown[] } } | null = null;
    execMock.mockReset();
    execMock.mockImplementation(async (...args: unknown[]) => {
      const onStep = args[8] as OnStep | undefined;
      onStep?.({ order: 1, status: 'passed', durationMs: 5 });
      await new Promise((r) => setTimeout(r, 80));
      const prc = await pool.query(`SELECT report_id FROM plan_run_cases WHERE plan_run_id = $1`, [planRunId]);
      const rid = (prc.rows[0]?.report_id as string | null) ?? null;
      if (rid) {
        // 用例仍在执行 → 此刻打报告详情
        const rep = await request(app).get(`/api/reports/${rid}`);
        repDuringRun = { status: rep.status, body: rep.body };
      }
      await new Promise((r) => setTimeout(r, 60));
      return [{ order: 1, status: 'passed', durationMs: 5 }];
    });

    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await runPlanAsync({ planRunId });

    expect(repDuringRun).not.toBeNull();
    expect(repDuringRun!.status).toBe(200);
    expect(repDuringRun!.body.status).toBe('running');
    expect(repDuringRun!.body.stepResults).toHaveLength(1);
    expect((repDuringRun!.body.stepResults[0] as { status: string }).status).toBe('passed');
  });
});
