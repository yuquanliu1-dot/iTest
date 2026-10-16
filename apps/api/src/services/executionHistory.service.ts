/** 执行历史查询 service(query_stats 工具的数据层)。
 *  范围语义:项目域——当前项目全部执行历史(含计划成员执行、无版本计划运行),结果标注所属版本。
 *  与 executions 列表页的"展示口径"(排除计划成员)不同:归因口径关注用例本身全历史。
 *  只读,无写路径。 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { executionPlans, groups, planRuns, projectVersions, reports, testCases } from '../db/schema.js';
import { resolveUsersByIds } from '../lib/creator.js';

/** days 天前的时间点(含当天当天,闭区间起点)。 */
function since(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/** 失败计数片段(orderBy 复用;必须括号包住 filter 再 ::int,否则 pg 返回 bigint→string) */
const failedCount = sql`(count(*) filter (where ${reports.status} = 'failed'))`;

export interface HistoryCaseStat {
  caseId: string;
  caseTitle: string;
  versionId: string;
  versionName: string | null;
  total: number;
  passed: number;
  healed: number;
  failed: number;
  avgDurationMs: number | null;
  lastStatus: string | null;
  lastRunAt: string | null;
}

/** 用例级聚合:执行数/通过(含自愈拆分)/失败/均耗时/最新状态,按失败数降序。含计划成员执行。 */
export async function caseStats(
  projectId: string,
  opts: { caseIds?: string[]; versionId?: string; days?: number } = {},
): Promise<HistoryCaseStat[]> {
  const conds = [eq(groups.projectId, projectId), gte(reports.createdAt, since(opts.days ?? 30))];
  if (opts.caseIds?.length) conds.push(inArray(reports.caseId, opts.caseIds));
  if (opts.versionId) conds.push(eq(testCases.versionId, opts.versionId));
  const rows = await db
    .select({
      caseId: testCases.id,
      caseTitle: testCases.title,
      versionId: testCases.versionId,
      total: sql<number>`(count(*))::int`,
      passed: sql<number>`(count(*) filter (where ${reports.status} = 'passed' and ${reports.healed} = false))::int`,
      healed: sql<number>`(count(*) filter (where ${reports.status} = 'passed' and ${reports.healed} = true))::int`,
      failed: sql<number>`${failedCount}::int`,
      avgDurationMs: sql<number | null>`(avg(${reports.durationMs}))::int`,
      lastStatus: sql<string | null>`(array_agg(${reports.status} order by ${reports.createdAt} desc))[1]`,
      lastRunAt: sql<string | null>`(max(${reports.createdAt}))::text`,
    })
    .from(reports)
    .innerJoin(testCases, eq(testCases.id, reports.caseId))
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .where(and(...conds))
    .groupBy(testCases.id, testCases.title, testCases.versionId)
    .orderBy(desc(failedCount));
  return attachVersionNames(rows);
}

/** 批量给行补 versionName(null versionId → null,由上层标注"无版本")。 */
async function attachVersionNames<T extends { versionId: string | null }>(
  rows: T[],
): Promise<Array<T & { versionName: string | null }>> {
  const ids = [...new Set(rows.map((r) => r.versionId).filter((v): v is string => !!v))];
  const map = new Map<string, string>();
  if (ids.length) {
    const vs = await db
      .select({ id: projectVersions.id, name: projectVersions.name })
      .from(projectVersions)
      .where(inArray(projectVersions.id, ids));
    for (const v of vs) map.set(v.id, v.name);
  }
  return rows.map((r) => ({ ...r, versionName: r.versionId ? (map.get(r.versionId) ?? null) : null }));
}

export interface HistoryOverview {
  days: number;
  caseReports: { total: number; passed: number; healed: number; failed: number; passRatePct: number | null };
  planRuns: { total: number; passed: number; failed: number; cancelled: number; running: number };
  topFailedCases: HistoryCaseStat[];
}

/** 项目执行概览:case 报告口径(通过=一次通过+自愈通过)/计划运行状态分布/失败 top5。 */
export async function historyOverview(
  projectId: string,
  opts: { days?: number; versionId?: string } = {},
): Promise<HistoryOverview> {
  const days = opts.days ?? 30;
  const caseConds = [eq(groups.projectId, projectId), gte(reports.createdAt, since(days))];
  if (opts.versionId) caseConds.push(eq(testCases.versionId, opts.versionId));
  const [agg] = await db
    .select({
      total: sql<number>`(count(*))::int`,
      passed: sql<number>`(count(*) filter (where ${reports.status} = 'passed' and ${reports.healed} = false))::int`,
      healed: sql<number>`(count(*) filter (where ${reports.status} = 'passed' and ${reports.healed} = true))::int`,
      failed: sql<number>`(count(*) filter (where ${reports.status} = 'failed'))::int`,
    })
    .from(reports)
    .innerJoin(testCases, eq(testCases.id, reports.caseId))
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .where(and(...caseConds));
  const planConds = [eq(planRuns.projectId, projectId), gte(planRuns.startedAt, since(days))];
  if (opts.versionId) planConds.push(eq(executionPlans.versionId, opts.versionId));
  const [pagg] = await db
    .select({
      total: sql<number>`(count(*))::int`,
      passed: sql<number>`(count(*) filter (where ${planRuns.status} = 'passed'))::int`,
      failed: sql<number>`(count(*) filter (where ${planRuns.status} = 'failed'))::int`,
      cancelled: sql<number>`(count(*) filter (where ${planRuns.status} = 'cancelled'))::int`,
      running: sql<number>`(count(*) filter (where ${planRuns.status} = 'running'))::int`,
    })
    .from(planRuns)
    .innerJoin(executionPlans, eq(executionPlans.id, planRuns.planId))
    .where(and(...planConds));
  const topFailedCases = (await caseStats(projectId, { days, versionId: opts.versionId })).slice(0, 5);
  return {
    days,
    caseReports: {
      ...agg,
      passRatePct: agg.total > 0 ? Math.round(((agg.passed + agg.healed) / agg.total) * 1000) / 10 : null,
    },
    planRuns: pagg,
    topFailedCases,
  };
}

export interface HistoryFailure {
  reportId: string;
  caseId: string;
  caseTitle: string;
  versionId: string;
  versionName: string | null;
  durationMs: number | null;
  summary: string | null;
  /** 最后断言信息:vision reason 优先,失败步 error 兜底(与 executions 列表页同款 SQL) */
  lastAssertion: string | null;
  /** 计划成员执行回溯到的 plan_run id;单用例执行为 null */
  planRunId: string | null;
  createdAt: string | null;
}

/** 失败报告明细(归因下钻原材料),最新在前。含计划成员执行。 */
export async function failureList(
  projectId: string,
  opts: { caseId?: string; days?: number; limit?: number } = {},
): Promise<HistoryFailure[]> {
  const conds = [
    eq(groups.projectId, projectId),
    eq(reports.status, 'failed'),
    gte(reports.createdAt, since(opts.days ?? 30)),
  ];
  if (opts.caseId) conds.push(eq(reports.caseId, opts.caseId));
  const rows = await db
    .select({
      reportId: reports.id,
      caseId: reports.caseId,
      caseTitle: testCases.title,
      versionId: testCases.versionId,
      durationMs: reports.durationMs,
      summary: reports.summary,
      lastAssertion: sql<string | null>`
        case
          when jsonb_typeof(${reports.stepResults}) = 'array' and jsonb_array_length(${reports.stepResults}) > 0 then
            (select coalesce(
               e -> 'visionAssert' ->> 'reason',
               case when e ->> 'status' = 'failed' then e ->> 'error' end
             )
             from jsonb_array_elements(${reports.stepResults}) with ordinality as t(e, ord)
             order by ord desc
             limit 1)
          else null
        end`,
      planRunId: sql<string | null>`(select pr.plan_run_id::text from plan_run_cases pr where pr.report_id = ${reports.id} limit 1)`,
      createdAt: sql<string | null>`${reports.createdAt}::text`,
    })
    .from(reports)
    .innerJoin(testCases, eq(testCases.id, reports.caseId))
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .where(and(...conds))
    .orderBy(desc(reports.createdAt))
    .limit(opts.limit ?? 20);
  return attachVersionNames(rows);
}

/** stepResults jsonb 里归因需要的字段子集(结构化挑选,不透传 screenshot/db/http 等大对象)。 */
export interface HistoryStep {
  order: number;
  status: string;
  durationMs: number;
  instruction?: string;
  error?: string;
  humanMessage?: string;
  failureReason?: string;
  visionAssertReason?: string;
  healed?: boolean;
  degraded?: boolean;
  cached?: boolean;
}

export interface HistoryReportDetail {
  reportId: string;
  caseId: string;
  caseTitle: string;
  versionId: string;
  versionName: string | null;
  status: string;
  healed: boolean;
  durationMs: number | null;
  summary: string | null;
  datasetRowIndex: number | null;
  platform: string;
  createdAt: string | null;
  steps: HistoryStep[];
}

/** 单报告详情(深度归因)。范围:reportId 必须属于当前项目,否则 null。 */
export async function reportDetail(projectId: string, reportId: string): Promise<HistoryReportDetail | null> {
  const rows = await db
    .select({
      reportId: reports.id,
      caseId: reports.caseId,
      caseTitle: testCases.title,
      versionId: testCases.versionId,
      status: reports.status,
      healed: reports.healed,
      durationMs: reports.durationMs,
      summary: reports.summary,
      datasetRowIndex: reports.datasetRowIndex,
      platform: reports.platform,
      createdAt: sql<string | null>`${reports.createdAt}::text`,
      stepResults: reports.stepResults,
    })
    .from(reports)
    .innerJoin(testCases, eq(testCases.id, reports.caseId))
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .where(and(eq(reports.id, reportId), eq(groups.projectId, projectId)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const raw = Array.isArray(r.stepResults) ? (r.stepResults as Array<Record<string, unknown>>) : [];
  const steps: HistoryStep[] = raw.map((s) => ({
    order: typeof s.order === 'number' ? s.order : 0,
    status: String(s.status ?? 'unknown'),
    durationMs: typeof s.durationMs === 'number' ? s.durationMs : 0,
    ...(typeof s.instruction === 'string' && s.instruction ? { instruction: s.instruction } : {}),
    ...(typeof s.error === 'string' && s.error ? { error: s.error } : {}),
    ...(typeof s.humanMessage === 'string' && s.humanMessage ? { humanMessage: s.humanMessage } : {}),
    ...(typeof s.failureReason === 'string' && s.failureReason ? { failureReason: s.failureReason } : {}),
    ...(s.visionAssert && typeof s.visionAssert === 'object' && typeof (s.visionAssert as Record<string, unknown>).reason === 'string'
      ? { visionAssertReason: (s.visionAssert as { reason: string }).reason }
      : {}),
    ...(s.healed === true ? { healed: true } : {}),
    ...(s.degraded === true ? { degraded: true } : {}),
    ...(s.cached === true ? { cached: true } : {}),
  }));
  const [named] = await attachVersionNames([{ versionId: r.versionId }]);
  return {
    reportId: r.reportId,
    caseId: r.caseId,
    caseTitle: r.caseTitle,
    versionId: r.versionId,
    versionName: named.versionName,
    status: r.status,
    healed: r.healed,
    durationMs: r.durationMs,
    summary: r.summary,
    datasetRowIndex: r.datasetRowIndex,
    platform: r.platform,
    createdAt: r.createdAt,
    steps,
  };
}

export interface HistoryPlanRun {
  runId: string;
  planId: string;
  planName: string;
  versionId: string | null;
  versionName: string | null;
  status: string;
  totalCases: number;
  passedCases: number | null;
  failedCases: number | null;
  skippedCases: number | null;
  durationMs: number | null;
  startedAt: string | null;
  triggeredBy: string | null;
}

/** 计划运行列表(最新在前)。versionId 来自 execution_plans(可空→versionName null=无版本)。 */
export async function planRunList(
  projectId: string,
  opts: { planId?: string; status?: string; days?: number; limit?: number } = {},
): Promise<HistoryPlanRun[]> {
  const conds = [eq(planRuns.projectId, projectId), gte(planRuns.startedAt, since(opts.days ?? 30))];
  if (opts.planId) conds.push(eq(planRuns.planId, opts.planId));
  if (opts.status) conds.push(eq(planRuns.status, opts.status));
  const rows = await db
    .select({
      runId: planRuns.id,
      planId: planRuns.planId,
      planName: executionPlans.name,
      versionId: executionPlans.versionId,
      status: planRuns.status,
      totalCases: planRuns.totalCases,
      passedCases: planRuns.passedCases,
      failedCases: planRuns.failedCases,
      skippedCases: planRuns.skippedCases,
      durationMs: planRuns.durationMs,
      startedAt: sql<string | null>`${planRuns.startedAt}::text`,
      triggeredById: planRuns.triggeredByUserId,
    })
    .from(planRuns)
    .innerJoin(executionPlans, eq(executionPlans.id, planRuns.planId))
    .where(and(...conds))
    .orderBy(desc(planRuns.startedAt))
    .limit(opts.limit ?? 20);
  const users = await resolveUsersByIds(rows.map((r) => r.triggeredById));
  const withNames = await attachVersionNames(rows);
  return withNames.map((r, i) => ({
    ...r,
    triggeredBy: rows[i]!.triggeredById ? users.get(rows[i]!.triggeredById)?.displayName ?? null : null,
  }));
}
