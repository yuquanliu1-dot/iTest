import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

/**
 * Regression for "steps invisible during execution" in plan runs (field-verified on prod228, 2026-10-26).
 *
 * Root cause: plan_run_cases.report_id used to be backfilled only after the case finished. During execution the frontend
 * had no report id, so the plan-run detail page could only show "queued for execution"; steps appeared all at once only
 * after the whole case ended.
 *
 * This test asserts: report_id is backfilled as soon as the report row lands (status=running),
 * and incrementally written step_results are readable while the case is still executing.
 */
const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('../src/execute/cdp.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, executeCaseReal: execMock, executeCaseInBrowser: execMock };
});

let pool: Pool;
let app: import('express').Express;
let projectId: string;
let groupId: string;
let versionId: string;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
  pool = new Pool({ connectionString: pgDb.uri });
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

/** The 9th argument of executeCaseReal is onStep (see the executeCaseReal signature in cdp.ts). */
type OnStep = (r: unknown) => void;

describe('计划运行执行期间步骤增量可见', () => {
  it('报告行落库即回填 plan_run_cases.report_id（不等用例跑完）', async () => {
    const caseId = await insertCase('增量用例');
    const planRunId = await makeRun([caseId]);

    // Assert at the moment "step 1 finished, later steps still running" — simulating a real mid-execution state.
    let reportIdDuringRun: string | null = null;
    let stepsDuringRun: unknown[] = [];
    execMock.mockReset();
    execMock.mockImplementation(async (...args: unknown[]) => {
      const onStep = args[8] as OnStep | undefined;
      onStep?.({ order: 1, status: 'passed', durationMs: 12 });
      // Incremental writes are fire-and-forget; wait for them to settle before reading (runCase awaits pendingWrites only at terminal state)
      await new Promise((r) => setTimeout(r, 60));
      const prc = await pool.query(`SELECT report_id FROM plan_run_cases WHERE plan_run_id = $1`, [planRunId]);
      reportIdDuringRun = (prc.rows[0]?.report_id as string | null) ?? null;
      if (reportIdDuringRun) {
        const rep = await pool.query(`SELECT step_results FROM reports WHERE id = $1`, [reportIdDuringRun]);
        stepsDuringRun = (rep.rows[0]?.step_results ?? []) as unknown[];
      }
      // Later steps are slow: the assertion happens while the case is "still executing"
      await new Promise((r) => setTimeout(r, 80));
      return [{ order: 1, status: 'passed', durationMs: 12 }];
    });

    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await runPlanAsync({ planRunId });

    // During execution: report_id already backfilled + step 1 already visible
    expect(reportIdDuringRun).toBeTruthy();
    expect(stepsDuringRun).toHaveLength(1);

    // Terminal state: report_id still points to the same report
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
      // Case still executing → hit the detail endpoint now
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
        // Case still executing → hit the report detail endpoint now
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
