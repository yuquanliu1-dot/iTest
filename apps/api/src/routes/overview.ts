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
  executionPlans,
} from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible } from '../services/projectAccess.js';
import { cache } from '../lib/cache.js';
import { overviewKey } from '../lib/cache-keys.js';

export const overviewRoute = Router();

const RangeSchema = z.enum(['7d', '30d']).default('7d');
const rangeDays = (r: '7d' | '30d') => (r === '7d' ? 7 : 30);

const PRIORITY_MAP: Record<string, 'urgent' | 'high' | 'medium' | 'low'> = {
  P0: 'urgent',
  P1: 'high',
  P2: 'medium',
  P3: 'low',
};

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
        .select({ id: testCases.id, priority: testCases.priority })
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
  rs: Array<{ createdAt: Date; status: string }>,
  today: Date,
  days: number,
) {
  const map = new Map<string, { passed: number; failed: number; total: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    map.set(dateKey(d), { passed: 0, failed: 0, total: 0 });
  }
  for (const r of rs) {
    const k = dateKey(r.createdAt);
    const bucket = map.get(k);
    if (!bucket) continue;
    bucket.total += 1;
    if (r.status === 'passed') bucket.passed += 1;
    else if (r.status === 'failed') bucket.failed += 1;
  }
  return [...map.entries()].map(([date, v]) => ({ date, ...v }));
}

async function buildOverview(projectId: string, days: number, today: Date) {
  const since = new Date(Date.now() - days * 86_400_000);
  const { cs, rsWindow, recent } = await loadBase(projectId, days);

  const totalCases = cs.length;
  const passed = rsWindow.filter((r) => r.status === 'passed').length;
  const totalRuns7d = rsWindow.length;
  const passRate = totalRuns7d === 0 ? 0 : passed / totalRuns7d;

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
        .select({ planId: planRuns.planId, status: planRuns.status, startedAt: planRuns.startedAt })
        .from(planRuns)
        .where(inArray(planRuns.planId, planIds))
        .orderBy(desc(planRuns.startedAt))
    : [];
  const runsByPlan = new Map<string, Array<{ status: string; startedAt: Date }>>();
  for (const r of allRuns) {
    const arr = runsByPlan.get(r.planId) ?? [];
    arr.push({ status: r.status, startedAt: r.startedAt });
    runsByPlan.set(r.planId, arr);
  }
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
    };
  });

  const aiCalls7d = 0;

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
    .slice(0, 5);

  const priorityDistribution = (['urgent', 'high', 'medium', 'low'] as const).map((p) => ({
    priority: p,
    count: cs.filter((c) => PRIORITY_MAP[c.priority ?? ''] === p).length,
  }));

  const aiActivity: Array<{ date: string; casesGenerated: number; stepsGenerated: number }> = Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (6 - i));
    return { date: dateKey(d), casesGenerated: 0, stepsGenerated: 0 };
  });

  return {
    kpi: { totalCases, totalPlans: planRows.length, passRate, totalRuns7d, aiCalls7d },
    trend,
    topFailures,
    priorityDistribution,
    plans,
    recordingActivity,
    aiActivity,
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
