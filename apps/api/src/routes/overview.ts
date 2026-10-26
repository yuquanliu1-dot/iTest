import { Router } from 'express';
import { z } from 'zod';
import { eq, desc, and, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  testCases,
  groups,
  reports,
  planRuns,
  planCases,
  planRunCases,
  planSchedules,
  executionPlans,
} from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible } from '../services/projectAccess.js';
import { cache } from '../lib/cache.js';
import { overviewKey } from '../lib/cache-keys.js';

export const overviewRoute = Router();

const RangeSchema = z.enum(['7d', '30d']).default('7d');
const rangeDays = (r: '7d' | '30d') => (r === '7d' ? 7 : 30);

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function loadBase(projectId: string, days: number) {
  const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
  const gids = gs.map((g) => g.id);
  const cs = gids.length
    ? await db
        .select({
          id: testCases.id,
          priority: testCases.priority,
          requirementId: testCases.requirementId,
          requirementNo: testCases.requirementNo,
          coverageTypes: testCases.coverageTypes,
        })
        .from(testCases)
        .where(inArray(testCases.groupId, gids))
    : [];
  const since = new Date(Date.now() - days * 86_400_000);
  const caseFilter = cs.length ? inArray(reports.caseId, cs.map((c) => c.id)) : null;
  // 趋势/KPI 只需时间窗内报告(旧实现全量拉所有历史在 JS 里过滤,报告表涨了这里先爆)
  const rsWindow = caseFilter
    ? await db
        .select({
          id: reports.id,
          caseId: reports.caseId,
          caseTitle: testCases.title,
          status: reports.status,
          healed: reports.healed,
          durationMs: reports.durationMs,
          createdAt: reports.createdAt,
        })
        .from(reports)
        .leftJoin(testCases, eq(testCases.id, reports.caseId))
        .where(and(caseFilter, gte(reports.createdAt, since)))
        .orderBy(desc(reports.createdAt))
    : [];
  // recent 需要全时段最新 10 条(union 性质:两端各取 top10 再归并,合并 top10 不变)
  const recentRows = caseFilter
    ? await db
        .select({
          id: reports.id,
          caseId: reports.caseId,
          caseTitle: testCases.title,
          status: reports.status,
          durationMs: reports.durationMs,
          createdAt: reports.createdAt,
        })
        .from(reports)
        .leftJoin(testCases, eq(testCases.id, reports.caseId))
        .where(caseFilter)
        .orderBy(desc(reports.createdAt))
        .limit(10)
    : [];
  const planRecentRows = await db
    .select({
      id: planRuns.id,
      planId: planRuns.planId,
      planName: executionPlans.name,
      status: planRuns.status,
      durationMs: planRuns.durationMs,
      startedAt: planRuns.startedAt,
    })
    .from(planRuns)
    .innerJoin(executionPlans, eq(executionPlans.id, planRuns.planId))
    .where(eq(planRuns.projectId, projectId))
    .orderBy(desc(planRuns.startedAt))
    .limit(10);
  const caseRecent = recentRows.map((r) => ({
    id: r.id,
    caseId: r.caseId,
    caseTitle: r.caseTitle ?? '',
    status: r.status,
    durationMs: r.durationMs,
    createdAt: r.createdAt.toISOString(),
    kind: 'case' as const,
  }));
  const planRecent = planRecentRows.map((r) => ({
    id: r.id,
    caseId: r.planId,
    caseTitle: r.planName,
    status: r.status,
    durationMs: r.durationMs,
    createdAt: r.startedAt.toISOString(),
    kind: 'plan' as const,
  }));
  const recent = [...caseRecent, ...planRecent]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10);
  return {
    cs,
    rsWindow,
    recent,
  };
}

function buildTrend(
  rs: Array<{ createdAt: Date; status: string; healed: boolean | null }>,
  today: Date,
  days: number,
) {
  const map = new Map<
    string,
    { passed: number; firstPassed: number; failed: number; total: number }
  >();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    map.set(dateKey(d), { passed: 0, firstPassed: 0, failed: 0, total: 0 });
  }
  for (const r of rs) {
    const k = dateKey(r.createdAt);
    const bucket = map.get(k);
    if (!bucket) continue;
    bucket.total += 1;
    if (r.status === 'passed') {
      bucket.passed += 1;
      if (!r.healed) bucket.firstPassed += 1;
    } else if (r.status === 'failed') {
      bucket.failed += 1;
    }
  }
  return [...map.entries()].map(([date, v]) => ({ date, ...v }));
}

function buildDayBuckets(
  today: Date,
  days: number,
): Array<{ date: string; calls: number; healedSteps: number }> {
  const buckets: Array<{ date: string; calls: number; healedSteps: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    buckets.push({ date: dateKey(d), calls: 0, healedSteps: 0 });
  }
  return buckets;
}

async function buildOverview(projectId: string, days: number, today: Date) {
  const since = new Date(Date.now() - days * 86_400_000);
  const { cs, rsWindow, recent } = await loadBase(projectId, days);

  const totalCases = cs.length;
  const passedCount = rsWindow.filter((r) => r.status === 'passed').length;
  const firstPassedCount = rsWindow.filter((r) => r.status === 'passed' && !r.healed).length;
  const healedReports = rsWindow.filter((r) => r.status === 'passed' && r.healed === true).length;
  const failedCount = rsWindow.filter((r) => r.status === 'failed').length;
  const totalRuns7d = rsWindow.length;
  const passRate = totalRuns7d === 0 ? 0 : passedCount / totalRuns7d;
  const firstPassRate = totalRuns7d === 0 ? 0 : firstPassedCount / totalRuns7d;

  const planRows = await db
    .select()
    .from(executionPlans)
    .where(eq(executionPlans.projectId, projectId));
  const planIds = planRows.map((p) => p.id);
  const caseCountRows = planIds.length
    ? await db
        .select({
          planId: planCases.planId,
          count: sql<number>`count(*)::int`,
        })
        .from(planCases)
        .where(inArray(planCases.planId, planIds))
        .groupBy(planCases.planId)
    : [];
  const caseCountMap = new Map(caseCountRows.map((r) => [r.planId, r.count]));
  // 每 plan 全量 runs 的 N+1 合并为一次查询,按 plan 分组后各算 last 与 30d 通过率
  const allRuns = planIds.length
    ? await db
        .select({
          planId: planRuns.planId,
          status: planRuns.status,
          startedAt: planRuns.startedAt,
          triggeredBy: planRuns.triggeredBy,
        })
        .from(planRuns)
        .where(inArray(planRuns.planId, planIds))
        .orderBy(desc(planRuns.startedAt))
    : [];
  const runsByPlan = new Map<
    string,
    Array<{ status: string; startedAt: Date; triggeredBy: string }>
  >();
  for (const r of allRuns) {
    const arr = runsByPlan.get(r.planId) ?? [];
    arr.push({ status: r.status, startedAt: r.startedAt, triggeredBy: r.triggeredBy });
    runsByPlan.set(r.planId, arr);
  }
  // 最近一次 RCA 类别(DISTINCT ON 取每 plan 最新一条带 rca 的用例结果)
  const rcaRows = planIds.length
    ? await db.execute(sql`
        SELECT DISTINCT ON (run.plan_id) run.plan_id AS plan_id, prc.rca->>'category' AS category
        FROM plan_run_cases prc
        JOIN plan_runs run ON run.id = prc.plan_run_id
        WHERE run.project_id = ${projectId} AND prc.rca IS NOT NULL
        ORDER BY run.plan_id, run.started_at DESC
      `)
    : { rows: [] as unknown[] };
  const lastRcaMap = new Map(
    (
      rcaRows.rows as Array<{ plan_id: string; category: string | null }>
    ).map((r) => [r.plan_id, r.category ?? 'other']),
  );

  const plans = planRows.map((p) => {
    const allRunsOfPlan = runsByPlan.get(p.id) ?? [];
    const last = allRunsOfPlan[0];
    const last30 = allRunsOfPlan.filter(
      (r) => r.startedAt >= new Date(Date.now() - 30 * 86_400_000),
    );
    const passed30 = last30.filter((r) => r.status === 'passed').length;
    const pr = last30.length === 0 ? 0 : passed30 / last30.length;
    return {
      id: p.id,
      name: p.name,
      lastStatus: (last?.status as 'passed' | 'failed' | 'running' | 'queued') ?? null,
      lastRunAt: last?.startedAt.toISOString() ?? null,
      passRate: pr,
      totalCases: caseCountMap.get(p.id) ?? 0,
      lastRcaCategory: lastRcaMap.get(p.id) ?? null,
      triggeredBy: (last?.triggeredBy as 'manual' | 'schedule') ?? null,
    };
  });

  // 定时计划数(plan_schedules enabled,挂在本项目计划下)
  const scheduleCountRows = planIds.length
    ? await db
        .select({ count: sql<number>`count(*)::int` })
        .from(planSchedules)
        .innerJoin(executionPlans, eq(executionPlans.id, planSchedules.planId))
        .where(and(inArray(executionPlans.id, planIds), eq(planSchedules.enabled, true)))
    : [];
  const schedulesEnabled = scheduleCountRows[0]?.count ?? 0;

  // AI 用量:窗口内报告逐条聚合 step_results 里的 aiUsage.calls 与自愈步数,按日分桶
  const aiUsageRows = rsWindow.length
    ? await db.execute(sql`
        SELECT r.created_at AS created_at,
               COALESCE((SELECT SUM((s->'aiUsage'->>'calls')::int)
                         FROM jsonb_array_elements(COALESCE(r.step_results, '[]'::jsonb)) s
                         WHERE s->'aiUsage'->>'calls' IS NOT NULL), 0) AS calls,
               COALESCE((SELECT COUNT(*)
                         FROM jsonb_array_elements(COALESCE(r.step_results, '[]'::jsonb)) s
                         WHERE (s->>'healed')::boolean IS TRUE), 0) AS healed_steps
        FROM reports r
        JOIN test_cases c ON c.id = r.case_id
        JOIN "groups" g ON g.id = c.group_id
        WHERE g.project_id = ${projectId} AND r.created_at >= ${since}
      `)
    : { rows: [] as unknown[] };
  const aiUsage = buildDayBuckets(today, days);
  const aiUsageDayMap = new Map(aiUsage.map((b) => [b.date, b]));
  for (const row of aiUsageRows.rows as Array<{
    created_at: Date;
    calls: string | number;
    healed_steps: string | number;
  }>) {
    const bucket = aiUsageDayMap.get(dateKey(new Date(row.created_at)));
    if (!bucket) continue;
    bucket.calls += Number(row.calls) || 0;
    bucket.healedSteps += Number(row.healed_steps) || 0;
  }
  const aiCalls7d = aiUsage.reduce((acc, b) => acc + b.calls, 0);

  // 步骤固化率:项目全量步骤中 compiled 非空占比;pending aiTask = 未固化且 instruction 非空
  const solidifyRows = await db.execute(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE jsonb_array_length(COALESCE(s.compiled, '[]'::jsonb)) > 0)::int AS solidified,
           count(*) FILTER (WHERE jsonb_array_length(COALESCE(s.compiled, '[]'::jsonb)) = 0
                            AND COALESCE(s.instruction, '') <> '')::int AS pending_ai
    FROM test_steps s
    JOIN test_cases c ON c.id = s.case_id
    JOIN "groups" g ON g.id = c.group_id
    WHERE g.project_id = ${projectId}
  `);
  const solidifyRow = (
    solidifyRows.rows as Array<{ total: number; solidified: number; pending_ai: number }>
  )[0] ?? { total: 0, solidified: 0, pending_ai: 0 };
  const solidifyRate = solidifyRow.total === 0 ? 0 : solidifyRow.solidified / solidifyRow.total;

  // p95 耗时(窗口内,排除进行中/无时长报告)
  const p95Rows = await db.execute(sql`
    SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms) AS p95
    FROM reports r
    JOIN test_cases c ON c.id = r.case_id
    JOIN "groups" g ON g.id = c.group_id
    WHERE g.project_id = ${projectId} AND r.created_at >= ${since} AND r.duration_ms IS NOT NULL
  `);
  const p95Raw = (p95Rows.rows as Array<{ p95: string | number | null }>)[0]?.p95;
  const p95DurationMs = p95Raw == null ? null : Math.round(Number(p95Raw));

  // 阻塞数:窗口内计划运行中被跳过的用例结果
  const blockedRows = await db.execute(sql`
    SELECT count(*)::int AS blocked
    FROM plan_run_cases prc
    JOIN plan_runs run ON run.id = prc.plan_run_id
    WHERE run.project_id = ${projectId} AND run.started_at >= ${since} AND prc.status = 'skipped'
  `);
  const blocked = (blockedRows.rows as Array<{ blocked: number }>)[0]?.blocked ?? 0;

  // RCA 根因分布(窗口内计划运行产生的 RCA 结果)
  const rcaDistRows = await db.execute(sql`
    SELECT COALESCE(prc.rca->>'category', 'other') AS category,
           count(*)::int AS count,
           count(*) FILTER (WHERE prc.rca->>'confidence' = 'high')::int AS high
    FROM plan_run_cases prc
    JOIN plan_runs run ON run.id = prc.plan_run_id
    WHERE run.project_id = ${projectId} AND run.started_at >= ${since} AND prc.rca IS NOT NULL
    GROUP BY 1
  `);
  const rcaByCategory = { case_issue: 0, environment: 0, system_defect: 0, other: 0 };
  let rcaAnalyzed = 0;
  let rcaHighConfidence = 0;
  for (const row of rcaDistRows.rows as Array<{
    category: string;
    count: number;
    high: number;
  }>) {
    const count = Number(row.count);
    rcaAnalyzed += count;
    rcaHighConfidence += Number(row.high);
    if (row.category === 'case_issue' || row.category === 'environment' || row.category === 'system_defect') {
      rcaByCategory[row.category] = count;
    } else {
      rcaByCategory.other += count;
    }
  }

  // 需求覆盖:关联 = requirementId 外键 或 requirementNo 手填编号
  const linkedCases = cs.filter(
    (c) => c.requirementId != null || (c.requirementNo ?? '') !== '',
  ).length;
  const coverageTypeCounts: Record<string, number> = {};
  for (const c of cs) {
    for (const t of (c.coverageTypes as string[] | null) ?? []) {
      coverageTypeCounts[t] = (coverageTypeCounts[t] ?? 0) + 1;
    }
  }
  const reqRows = await db.execute(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM test_cases c
             JOIN "groups" g ON g.id = c.group_id
             WHERE c.requirement_id = rq.id AND g.project_id = ${projectId}
           ))::int AS linked
    FROM requirements rq
    WHERE rq.project_id = ${projectId}
  `);
  const reqRow = (reqRows.rows as Array<{ total: number; linked: number }>)[0] ?? {
    total: 0,
    linked: 0,
  };

  // 录制活动:按 compiled DSL kind 聚合项目内全部步骤动作(全量,非时间窗)。
  const recordingRows = await db.execute(sql`
    SELECT a->>'kind' AS kind, count(*)::int AS count
    FROM test_steps s
    JOIN test_cases c ON c.id = s.case_id
    JOIN "groups" g ON g.id = c.group_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.compiled, '[]'::jsonb)) AS a
    WHERE g.project_id = ${projectId}
    GROUP BY a->>'kind'
    ORDER BY count DESC, kind ASC
  `);
  const recordingActivity = (recordingRows.rows as Array<{ kind: string; count: number }>).map(
    (r) => ({ kind: r.kind, count: Number(r.count) }),
  );

  const trend = buildTrend(rsWindow, today, days);
  const totalRunsByCase = new Map<string, number>();
  for (const r of rsWindow) {
    totalRunsByCase.set(r.caseId, (totalRunsByCase.get(r.caseId) ?? 0) + 1);
  }
  const failMap = new Map<
    string,
    { caseId: string; caseTitle: string; failureCount: number; lastFailureAt: string }
  >();
  // Align topFailures window with the trend window (range-driven) for consistency.
  const sinceFailures = since;
  for (const r of rsWindow) {
    if (r.status !== 'failed' || r.createdAt < sinceFailures) continue;
    const cur = failMap.get(r.caseId);
    if (cur) {
      cur.failureCount += 1;
      if (r.createdAt.toISOString() > cur.lastFailureAt) cur.lastFailureAt = r.createdAt.toISOString();
    } else {
      failMap.set(r.caseId, {
        caseId: r.caseId,
        caseTitle: (r as { caseTitle?: string }).caseTitle ?? '',
        failureCount: 1,
        lastFailureAt: r.createdAt.toISOString(),
      });
    }
  }
  const topFailures = [...failMap.values()]
    .sort((a, b) => b.failureCount - a.failureCount || (b.lastFailureAt > a.lastFailureAt ? 1 : -1))
    .slice(0, 5)
    .map((f) => {
      const totalRuns = totalRunsByCase.get(f.caseId) ?? f.failureCount;
      const passCount = totalRuns - f.failureCount;
      return {
        ...f,
        totalRuns,
        // 疑似 flaky:窗口内多次执行且失败/通过交替出现(非稳定失败)
        flakySuspected: totalRuns >= 3 && f.failureCount >= 2 && passCount >= 1,
      };
    });

  return {
    kpi: {
      totalCases,
      totalPlans: planRows.length,
      passRate,
      firstPassRate,
      totalRuns7d,
      aiCalls7d,
      aiHealedReports7d: healedReports,
      p95DurationMs,
      solidifyRate,
      solidifyPendingSteps: solidifyRow.total - solidifyRow.solidified,
      solidifyPendingAiTasks: solidifyRow.pending_ai,
    },
    trend,
    topFailures,
    executions: {
      passed: passedCount,
      failed: failedCount,
      blocked,
      healed: healedReports,
    },
    rca: {
      analyzed: rcaAnalyzed,
      highConfidence: rcaHighConfidence,
      byCategory: rcaByCategory,
    },
    coverage: {
      totalRequirements: Number(reqRow.total),
      linkedRequirements: Number(reqRow.linked),
      uncoveredRequirements: Math.max(0, Number(reqRow.total) - Number(reqRow.linked)),
      linkedCases,
      totalCases,
      byCoverageType: coverageTypeCounts,
    },
    plans,
    schedules: { enabledCount: schedulesEnabled },
    recordingActivity,
    aiUsage,
    recentRuns: recent,
  };
}

overviewRoute.get('/:projectId/overview', async (req, res) => {
  const { projectId } = req.params;
  if (!projectId) throw new HttpError(400, 'bad_request', 'projectId required');
  const parsed = RangeSchema.safeParse(req.query.range);
  if (!parsed.success) throw new HttpError(400, 'bad_request', 'range must be 7d or 30d');
  await assertProjectVisible(projectId, req.user!);
  // ?versionId= 透传：当前 dashboard 不做范围过滤（保持 KPI 与图表语义稳定），
  // 仅允许前端带上来证明 URL 与上下文一致。
  void (typeof req.query.versionId === 'string' ? req.query.versionId : null);

  // dashboard 语义容忍 1min 陈旧:60s TTL-only,无写失效网(执行完 KPI 最多滞后 60s);
  // 换取不碰任何写路径。可见性断言在缓存之外。
  const payload = await cache.wrap(
    overviewKey(projectId, parsed.data),
    60_000,
    () => buildOverview(projectId, rangeDays(parsed.data), new Date()),
  );
  res.json(payload);
});
