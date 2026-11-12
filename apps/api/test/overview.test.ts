import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedOrg, seedProductLine } from './helpers/db.js';

let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { overviewRoute } = await import('../src/routes/overview.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const seed = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(seed.userId, seed.username, seed.orgId, seed.orgPath);
    next();
  });
  app.use('/api/projects', overviewRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

describe('overview', () => {
  it('GET 404 for missing project', async () => {
    const r = await request(app).get('/api/projects/00000000-0000-0000-0000-000000000000/overview');
    expect(r.status).toBe(404);
  });

  it('GET 200 with empty structure for valid project', async () => {
    const { productLineId } = await seedProductLine(pool);
    const p = await pool.query(
      `INSERT INTO projects(product_line_id, name) VALUES ($1, 'p1') RETURNING id`,
      [productLineId],
    );
    const projectId = p.rows[0]!.id;
    const r = await request(app).get(`/api/projects/${projectId}/overview`);
    expect(r.status).toBe(200);
    expect(r.body.kpi.totalCases).toBe(0);
    expect(r.body.kpi.totalPlans).toBe(0);
    expect(r.body.kpi.passRate).toBe(0);
    expect(r.body.kpi.firstPassRate).toBe(0);
    expect(r.body.kpi.totalRuns7d).toBe(0);
    expect(r.body.kpi.aiCalls7d).toBe(0);
    expect(r.body.kpi.aiHealedReports7d).toBe(0);
    expect(r.body.kpi.p95DurationMs).toBeNull();
    expect(r.body.kpi.solidifyRate).toBe(0);
    expect(r.body.kpi.solidifyPendingSteps).toBe(0);
    expect(r.body.kpi.solidifyPendingAiTasks).toBe(0);
    expect(r.body.trend).toEqual(
      Array.from({ length: 7 }).map((_, i) => {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(new Date(y, d.getMonth(), d.getDate() - (6 - i)).getDate()).padStart(2, '0');
        const mm = String(new Date(y, d.getMonth(), d.getDate() - (6 - i)).getMonth() + 1).padStart(2, '0');
        const yy = new Date(y, d.getMonth(), d.getDate() - (6 - i)).getFullYear();
        return { date: `${yy}-${mm}-${day}`, passed: 0, firstPassed: 0, failed: 0, total: 0 };
      }),
    );
    expect(r.body.topFailures).toEqual([]);
    expect(r.body.executions).toEqual({ passed: 0, failed: 0, blocked: 0, healed: 0 });
    expect(r.body.rca).toEqual({
      analyzed: 0,
      highConfidence: 0,
      byCategory: { case_issue: 0, environment: 0, system_defect: 0, other: 0 },
    });
    expect(r.body.coverage).toEqual({
      totalRequirements: 0,
      linkedRequirements: 0,
      uncoveredRequirements: 0,
      linkedCases: 0,
      totalCases: 0,
      byCoverageType: {},
    });
    expect(r.body.plans).toEqual([]);
    expect(r.body.schedules).toEqual({ enabledCount: 0 });
    expect(r.body.recordingActivity).toEqual([]);
    expect(r.body.aiUsage).toHaveLength(7);
    expect(r.body.aiUsage.every((b: { calls: number; healedSteps: number }) => b.calls === 0 && b.healedSteps === 0)).toBe(true);
    expect(r.body.recentRuns).toEqual([]);
  });

  it('GET 400 for invalid range', async () => {
    const { productLineId } = await seedProductLine(pool);
    const p = await pool.query(
      `INSERT INTO projects(product_line_id, name) VALUES ($1, 'p2') RETURNING id`,
      [productLineId],
    );
    const r = await request(app).get(`/api/projects/${p.rows[0]!.id}/overview?range=xx`);
    expect(r.status).toBe(400);
  });

  it('recordingActivity aggregates compiled step kinds per project', async () => {
    const { productLineId } = await seedProductLine(pool);
    const p = await pool.query(
      `INSERT INTO projects(product_line_id, name) VALUES ($1, 'p4') RETURNING id`,
      [productLineId],
    );
    const projectId = p.rows[0]!.id;
    const g = await pool.query(
      `INSERT INTO "groups"(project_id, name) VALUES ($1, 'g') RETURNING id`,
      [projectId],
    );
    const groupId = g.rows[0]!.id;
    const c = await pool.query(
      `INSERT INTO test_cases(group_id, title) VALUES ($1, 'case1') RETURNING id`,
      [groupId],
    );
    const caseId = c.rows[0]!.id;
    await pool.query(
      `INSERT INTO test_steps(case_id, "order", source, compiled) VALUES
        ($1, 0, 'recorder', '[{"kind":"click"},{"kind":"fill"}]'::jsonb),
        ($1, 1, 'recorder', '[{"kind":"click"}]'::jsonb),
        ($1, 2, 'recorder', NULL)`,
      [caseId],
    );
    const r = await request(app).get(`/api/projects/${projectId}/overview`);
    expect(r.status).toBe(200);
    expect(r.body.recordingActivity).toEqual([
      { kind: 'click', count: 2 },
      { kind: 'fill', count: 1 },
    ]);
  });

  it('窗口外报告不进 trend/KPI/topFailures，但进 recentRuns（窗口拆分语义锁）', async () => {
    const { productLineId } = await seedProductLine(pool);
    const p = await pool.query(
      `INSERT INTO projects(product_line_id, name) VALUES ($1, 'p5') RETURNING id`,
      [productLineId],
    );
    const projectId = p.rows[0]!.id;
    const g = await pool.query(
      `INSERT INTO "groups"(project_id, name) VALUES ($1, 'g') RETURNING id`,
      [projectId],
    );
    const groupId = g.rows[0]!.id;
    const c = await pool.query(
      `INSERT INTO test_cases(group_id, title) VALUES ($1, 'case1') RETURNING id`,
      [groupId],
    );
    const caseId = c.rows[0]!.id;
    await pool.query(
      `INSERT INTO reports(case_id, status, step_results, created_at) VALUES
        ($1, 'passed', '[]'::jsonb, now()),
        ($1, 'failed', '[]'::jsonb, now() - interval '30 days')`,
      [caseId],
    );
    const r = await request(app).get(`/api/projects/${projectId}/overview`);
    expect(r.status).toBe(200);
    // KPI/trend only count the 7d window
    expect(r.body.kpi.totalRuns7d).toBe(1);
    expect(r.body.kpi.passRate).toBe(1);
    expect(r.body.trend[6].total).toBe(1);
    expect(r.body.trend[6].passed).toBe(1);
    // healed defaults to false → this pass counts as a first pass
    expect(r.body.trend[6].firstPassed).toBe(1);
    // topFailures window aligns with trend: failures from 30 days ago are not counted
    expect(r.body.topFailures).toEqual([]);
    // recent covers all time: out-of-window reports still appear in the latest list (time-descending, newest first)
    expect(r.body.recentRuns).toHaveLength(2);
    expect((r.body.recentRuns as Array<{ status: string }>).map((x) => x.status)).toEqual(['passed', 'failed']);
  });

  it('聚合口径：双通过率/AI 用量/固化率/p95/RCA/覆盖/flaky/计划表', async () => {
    const { productLineId } = await seedProductLine(pool);
    const p = await pool.query(
      `INSERT INTO projects(product_line_id, name) VALUES ($1, 'p3') RETURNING id`,
      [productLineId],
    );
    const projectId = p.rows[0]!.id;
    const g = await pool.query(
      `INSERT INTO "groups"(project_id, name) VALUES ($1, 'g') RETURNING id`,
      [projectId],
    );
    const groupId = g.rows[0]!.id;

    // 2 requirements, req1 linked to caseA; caseB linked via a hand-filled number
    const reqs = await pool.query(
      `INSERT INTO requirements(project_id, title, content) VALUES
        ($1, '登录需求', '登录校验'), ($1, '越权需求', '越权拦截') RETURNING id`,
      [projectId],
    );
    const req1 = reqs.rows[0]!.id;

    const cs = await pool.query(
      `INSERT INTO test_cases(group_id, title, requirement_id, requirement_no, coverage_types) VALUES
        ($1, '稳过用例', $2, NULL, '["functional","boundary"]'::jsonb),
        ($1, 'flaky用例', NULL, 'REQ-77', '["functional"]'::jsonb)
        RETURNING id`,
      [groupId, req1],
    );
    const caseA = cs.rows[0]!.id;
    const caseB = cs.rows[1]!.id;

    // caseA: 2 first passes + 1 failure; caseB: 2 failures + 1 healed pass (flaky)
    await pool.query(
      `INSERT INTO reports(case_id, status, duration_ms, healed, step_results, created_at) VALUES
        ($1, 'passed', 1000, false, '[{"aiUsage":{"calls":2}}]'::jsonb, now()),
        ($1, 'passed', 2000, false, '[]'::jsonb, now()),
        ($1, 'failed', 500, false, '[]'::jsonb, now()),
        ($2, 'failed', 30000, false, '[]'::jsonb, now()),
        ($2, 'failed', 40000, false, '[]'::jsonb, now()),
        ($2, 'passed', 60000, true, '[{"aiUsage":{"calls":3},"healed":true}]'::jsonb, now())`,
      [caseA, caseB],
    );

    // Solidification: 1 compiled + 1 uncompiled with instruction (pending aiTask) + 1 blank step
    await pool.query(
      `INSERT INTO test_steps(case_id, "order", source, instruction, compiled) VALUES
        ($1, 0, 'recorder', '点击登录', '[{"kind":"click"}]'::jsonb),
        ($1, 1, 'recorder', '视觉检查首页', '[]'::jsonb),
        ($1, 2, 'recorder', NULL, NULL)`,
      [caseA],
    );

    // Plan + two runs (run1 manual with RCA environment; run2 scheduled with skipped + RCA case)
    const plan = await pool.query(
      `INSERT INTO execution_plans(project_id, name) VALUES ($1, '回归计划') RETURNING id`,
      [projectId],
    );
    const planId = plan.rows[0]!.id;
    await pool.query(
      `INSERT INTO plan_cases(plan_id, case_id, "order") VALUES ($1, $2, 0), ($1, $3, 1)`,
      [planId, caseA, caseB],
    );
    const run1 = await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy, triggered_by, started_at)
       VALUES ($1, $2, 'failed', 'run_all', 'manual', now() - interval '2 hours') RETURNING id`,
      [planId, projectId],
    );
    const run2 = await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy, triggered_by, started_at)
       VALUES ($1, $2, 'failed', 'run_all', 'schedule', now() - interval '1 hour') RETURNING id`,
      [planId, projectId],
    );
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind, rca) VALUES
        ($1, $2, 0, 'failed', 'mechanical', '{"status":"analyzed","category":"environment","confidence":"high"}'::jsonb)`,
      [run1.rows[0]!.id, caseB],
    );
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind) VALUES
        ($1, $2, 0, 'skipped', 'mechanical'),
        ($1, $3, 1, 'failed', 'mechanical')`,
      [run2.rows[0]!.id, caseA, caseB],
    );
    await pool.query(
      `UPDATE plan_run_cases SET rca = '{"status":"analyzed","category":"case_issue","confidence":"low"}'::jsonb
       WHERE plan_run_id = $1 AND case_id = $2`,
      [run2.rows[0]!.id, caseB],
    );
    await pool.query(
      `INSERT INTO plan_schedules(plan_id, cron_expr) VALUES ($1, '0 9 * * 1-5')`,
      [planId],
    );

    const r = await request(app).get(`/api/projects/${projectId}/overview`);
    expect(r.status).toBe(200);

    // KPI: 6 runs = 3 passed / 3 failed; first passes 2; healed saves 1; AI calls 2+3=5
    expect(r.body.kpi.totalCases).toBe(2);
    expect(r.body.kpi.totalRuns7d).toBe(6);
    expect(r.body.kpi.passRate).toBeCloseTo(0.5, 5);
    expect(r.body.kpi.firstPassRate).toBeCloseTo(2 / 6, 5);
    expect(r.body.kpi.aiCalls7d).toBe(5);
    expect(r.body.kpi.aiHealedReports7d).toBe(1);
    // p95: sorted [500,1000,2000,30000,40000,60000] → 0.95 quantile linear interpolation = 55000
    expect(r.body.kpi.p95DurationMs).toBe(55000);
    // Solidification: 1 of 3 steps compiled; pending aiTask = uncompiled with instruction = 1
    expect(r.body.kpi.solidifyRate).toBeCloseTo(1 / 3, 5);
    expect(r.body.kpi.solidifyPendingSteps).toBe(2);
    expect(r.body.kpi.solidifyPendingAiTasks).toBe(1);

    // trend today bucket: total 6 / passed 3 / firstPassed 2 / failed 3
    expect(r.body.trend[6]).toMatchObject({ total: 6, passed: 3, firstPassed: 2, failed: 3 });
    // AI usage today bucket: calls 5 / healedSteps 1
    expect(r.body.aiUsage[6]).toMatchObject({ calls: 5, healedSteps: 1 });

    // Execution overview meters: passed/failed/blocked(skipped)/healed
    expect(r.body.executions).toEqual({ passed: 3, failed: 3, blocked: 1, healed: 1 });

    // RCA distribution: environment(high) + case_issue(low)
    expect(r.body.rca).toEqual({
      analyzed: 2,
      highConfidence: 1,
      byCategory: { case_issue: 1, environment: 1, system_defect: 0, other: 0 },
    });

    // Coverage: 2 requirements, 1 linked; 2 cases both linked (FK + hand-filled number); coverageTypes counts
    expect(r.body.coverage).toEqual({
      totalRequirements: 2,
      linkedRequirements: 1,
      uncoveredRequirements: 1,
      linkedCases: 2,
      totalCases: 2,
      byCoverageType: { functional: 2, boundary: 1 },
    });

    // topFailures: caseB 2 fails/3 runs (flaky) > caseA 1 fail/3 runs
    expect(r.body.topFailures).toHaveLength(2);
    expect(r.body.topFailures[0]).toMatchObject({
      caseId: caseB,
      failureCount: 2,
      totalRuns: 3,
      flakySuspected: true,
    });
    expect(r.body.topFailures[1]).toMatchObject({
      caseId: caseA,
      failureCount: 1,
      totalRuns: 3,
      flakySuspected: false,
    });

    // Plan table: latest run = run2 (schedule); latest RCA = run2's case_issue; 30d pass rate 0/2
    expect(r.body.plans).toHaveLength(1);
    expect(r.body.plans[0]).toMatchObject({
      id: planId,
      name: '回归计划',
      lastStatus: 'failed',
      triggeredBy: 'schedule',
      lastRcaCategory: 'case_issue',
      totalCases: 2,
      passRate: 0,
    });
    expect(r.body.schedules).toEqual({ enabledCount: 1 });
  });
});
