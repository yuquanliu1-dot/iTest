import { Router } from 'express';
import { z } from 'zod';
import { eq, desc, inArray, sql, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  testCases,
  groups,
  reports,
  planRuns,
  planCases,
  executionPlans,
  agentRuns,
} from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible } from '../services/projectAccess.js';

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
  const caseRows = cs.length
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
        .where(inArray(reports.caseId, cs.map((c) => c.id)))
        .orderBy(desc(reports.createdAt))
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
    .orderBy(desc(planRuns.startedAt));
  const caseRecent = caseRows.slice(0, 10).map((r) => ({
    id: r.id,
    caseId: r.caseId,
    caseTitle: r.caseTitle ?? '',
    status: r.status,
    durationMs: r.durationMs,
    createdAt: r.createdAt.toISOString(),
    kind: 'case' as const,
  }));
  const planRecent = planRecentRows.slice(0, 10).map((r) => ({
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
    caseIds: cs.map((c) => c.id),
    rs7d: caseRows.filter((r) => r.createdAt >= since),
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

overviewRoute.get('/:projectId/overview', async (req, res) => {
  const { projectId } = req.params;
  if (!projectId) throw new HttpError(400, 'bad_request', 'projectId required');
  const parsed = RangeSchema.safeParse(req.query.range);
  if (!parsed.success) throw new HttpError(400, 'bad_request', 'range must be 7d or 30d');
  await assertProjectVisible(projectId, req.user!);
  // ?versionId= 透传：当前 dashboard 不做范围过滤（保持 KPI 与图表语义稳定），
  // 仅允许前端带上来证明 URL 与上下文一致。
  void (typeof req.query.versionId === 'string' ? req.query.versionId : null);

  const days = rangeDays(parsed.data);
  const today = new Date();
  const { cs, caseIds, rs7d, recent } = await loadBase(projectId, days);

  const totalCases = cs.length;
  const passed = rs7d.filter((r) => r.status === 'passed').length;
  const totalRuns7d = rs7d.length;
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
  const plans = await Promise.all(
    planRows.map(async (p) => {
      const allRuns = await db
        .select({ status: planRuns.status, startedAt: planRuns.startedAt })
        .from(planRuns)
        .where(eq(planRuns.planId, p.id))
        .orderBy(desc(planRuns.startedAt));
      const last = allRuns[0];
      const last30 = allRuns.filter(
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
    }),
  );

  const agentSince = new Date(Date.now() - 7 * 86_400_000);
  const recentAgentRuns = caseIds.length
    ? await db
        .select()
        .from(agentRuns)
        .where(
          and(
            inArray(agentRuns.targetId, caseIds),
            eq(agentRuns.targetType, 'case2script'),
          ),
        )
    : [];
  const aiCalls7d = recentAgentRuns.filter((r) => r.startedAt >= agentSince).length;

  const trend = buildTrend(rs7d, today, days);
  const failMap = new Map<
    string,
    { caseId: string; caseTitle: string; failureCount: number; lastFailureAt: string }
  >();
  // Align topFailures window with the trend window (range-driven) for consistency.
  const sinceFailures = new Date(Date.now() - days * 86_400_000);
  for (const r of rs7d) {
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

  const aiActivity = recentAgentRuns.length === 0
    ? []
    : Array.from({ length: 7 }).map((_, i) => {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (6 - i));
        const k = dateKey(d);
        const todays = recentAgentRuns.filter((r) => dateKey(r.startedAt) === k);
        return { date: k, casesGenerated: todays.length, stepsGenerated: 0 };
      });

  res.json({
    kpi: { totalCases, totalPlans: planRows.length, passRate, totalRuns7d, aiCalls7d },
    trend,
    topFailures,
    priorityDistribution,
    plans,
    recordingActivity: [],
    aiActivity,
    recentRuns: recent,
  });
});
