/** 执行历史查询 service(query_stats 工具的数据层)。
 *  范围语义:项目域——当前项目全部执行历史(含计划成员执行、无版本计划运行),结果标注所属版本。
 *  与 executions 列表页的"展示口径"(排除计划成员)不同:归因口径关注用例本身全历史。
 *  只读,无写路径。
 *  上下文预算:本层负责全部裁剪——字符串 clipText(1000 字)、db/sql rows ≤10 行、log lines ≤10 行、
 *  screenshot/compiled 等大对象不透传;工具层只做参数解析与 JSON 序列化。 */
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { executionPlans, groups, planRunCases, planRuns, projectVersions, reports, testCases } from '../db/schema.js';
import { resolveUsersByIds } from '../lib/creator.js';

/** days 天前的时间点(含当天当天,闭区间起点)。 */
function since(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/** 失败计数片段(orderBy 复用;必须括号包住 filter 再 ::int,否则 pg 返回 bigint→string) */
const failedCount = sql`(count(*) filter (where ${reports.status} = 'failed'))`;

/** 上下文预算:字符串统一截断阈值。 */
export const CLIP_LEN = 1000;

/** 字符串截断(上下文预算):超 max 字截断加省略号。 */
export function clipText(s: string, max = CLIP_LEN): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 失败列表/报告列表共用的「最后断言」SQL:vision reason 优先,失败步 error 兜底(与 executions 列表页同口径)。 */
const lastAssertionSql = sql<string | null>`
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
  end`;

/** report → plan_run 回溯 SQL:该报告所属的计划运行 id(单用例执行为 null)。 */
const planRunIdSql = sql<string | null>`(select pr.plan_run_id::text from plan_run_cases pr where pr.report_id = ${reports.id} limit 1)`;

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
  // 聚合无 groupBy 恒返回一行,非空断言与 user.service.ts 的 row! 惯例一致
  const agg = (await db
    .select({
      total: sql<number>`(count(*))::int`,
      passed: sql<number>`(count(*) filter (where ${reports.status} = 'passed' and ${reports.healed} = false))::int`,
      healed: sql<number>`(count(*) filter (where ${reports.status} = 'passed' and ${reports.healed} = true))::int`,
      failed: sql<number>`(count(*) filter (where ${reports.status} = 'failed'))::int`,
    })
    .from(reports)
    .innerJoin(testCases, eq(testCases.id, reports.caseId))
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .where(and(...caseConds)))[0]!;
  const planConds = [eq(planRuns.projectId, projectId), gte(planRuns.startedAt, since(days))];
  if (opts.versionId) planConds.push(eq(executionPlans.versionId, opts.versionId));
  const pagg = (await db
    .select({
      total: sql<number>`(count(*))::int`,
      passed: sql<number>`(count(*) filter (where ${planRuns.status} = 'passed'))::int`,
      failed: sql<number>`(count(*) filter (where ${planRuns.status} = 'failed'))::int`,
      cancelled: sql<number>`(count(*) filter (where ${planRuns.status} = 'cancelled'))::int`,
      running: sql<number>`(count(*) filter (where ${planRuns.status} = 'running'))::int`,
    })
    .from(planRuns)
    .innerJoin(executionPlans, eq(executionPlans.id, planRuns.planId))
    .where(and(...planConds)))[0]!;
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
      lastAssertion: lastAssertionSql,
      planRunId: planRunIdSql,
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

// ---------- stepResults jsonb 整形(纯函数,单测覆盖) ----------

/** 结构化行内对象的安全读取:非 null 对象才返回。 */
function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function numOf(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function strOf(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** 字符串值截断的对象浅拷贝(表头/单元格等 string map 通用)。 */
function clipRecord(r: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' ? clipText(v) : v]));
}

/** rows ≤10 行(超限置 truncated),单元格字符串 clip;保留上游已标记的 truncated。 */
function shapeRows(o: Record<string, unknown>): { rows: Record<string, unknown>[]; truncated?: boolean } {
  const raw = Array.isArray(o.rows) ? o.rows : [];
  const over = raw.length > 10;
  const rows = raw.slice(0, 10).map((r) => {
    const obj = asObj(r);
    return obj ? clipRecord(obj) : r;
  });
  return { rows, ...(o.truncated === true || over ? { truncated: true } : {}) };
}

interface HistoryAssertion {
  matched: boolean;
  expected?: string;
  match?: string;
  statusExpected?: number;
}

function shapeAssertion(v: unknown): HistoryAssertion | undefined {
  const o = asObj(v);
  if (!o) return undefined;
  return {
    matched: o.matched === true,
    ...(typeof o.expected === 'string' ? { expected: clipText(o.expected) } : {}),
    ...(typeof o.match === 'string' ? { match: o.match } : {}),
    ...(typeof o.statusExpected === 'number' ? { statusExpected: o.statusExpected } : {}),
  };
}

export interface HistoryStepDb {
  rowCount: number;
  durationMs: number;
  rows: Record<string, unknown>[];
  truncated?: boolean;
  assertion?: HistoryAssertion;
}

export interface HistoryStepSql extends HistoryStepDb {
  dbRef: string | null;
}

export interface HistoryStepLog {
  matchedLineCount: number;
  durationMs: number;
  lines: { ts?: string; raw: string }[];
  truncated?: boolean;
  assertion?: HistoryAssertion;
}

export interface HistoryStepHttp {
  request: { method: string; url: string; headers?: Record<string, unknown>; bodyPreview?: string };
  response?: { status: number; statusText?: string; durationMs: number; bodyText: string };
  transportFailure?: string;
  assertion?: HistoryAssertion;
  saved?: { varName: string; value: string };
}

export interface HistoryStepSyslog {
  protocol: string;
  host: string;
  port: number;
  facility: string;
  severity: string;
  packet: string;
  durationMs: number;
  bytes: number;
}

export interface HistoryStructured {
  db?: HistoryStepDb;
  sql?: HistoryStepSql;
  log?: HistoryStepLog;
  http?: HistoryStepHttp;
  syslog?: HistoryStepSyslog;
}

/** 单步五类结构化结果整形(结果详情挑选+截断;screenshot 等大对象不透传)。老报告缺字段→对应 key 缺省。 */
export function shapeStructured(s: Record<string, unknown>): HistoryStructured {
  const out: HistoryStructured = {};
  const db = asObj(s.db);
  if (db) {
    const rows = shapeRows(db);
    const a = shapeAssertion(db.assertion);
    out.db = {
      rowCount: numOf(db.rowCount),
      durationMs: numOf(db.durationMs),
      ...rows,
      ...(a ? { assertion: a } : {}),
    };
  }
  const sq = asObj(s.sql);
  if (sq) {
    const rows = shapeRows(sq);
    const a = shapeAssertion(sq.assertion);
    out.sql = {
      dbRef: typeof sq.dbRef === 'string' ? sq.dbRef : null,
      rowCount: numOf(sq.rowCount),
      durationMs: numOf(sq.durationMs),
      ...rows,
      ...(a ? { assertion: a } : {}),
    };
  }
  const lg = asObj(s.log);
  if (lg) {
    const rawLines = Array.isArray(lg.lines) ? lg.lines : [];
    const over = rawLines.length > 10;
    const lines = rawLines.slice(0, 10).map((l) => {
      const o = asObj(l);
      if (!o) return { raw: String(l) };
      return {
        ...(typeof o.ts === 'string' ? { ts: o.ts } : {}),
        raw: clipText(strOf(o.raw, String(o.raw ?? ''))),
      };
    });
    const a = shapeAssertion(lg.assertion);
    out.log = {
      matchedLineCount: numOf(lg.matchedLineCount),
      durationMs: numOf(lg.durationMs),
      lines,
      ...(lg.truncated === true || over ? { truncated: true } : {}),
      ...(a ? { assertion: a } : {}),
    };
  }
  const http = asObj(s.http);
  if (http) {
    const req = asObj(http.request);
    const res = asObj(http.response);
    const a = shapeAssertion(http.assertion);
    const saved = asObj(http.saved);
    out.http = {
      request: {
        method: strOf(req?.method),
        url: strOf(req?.url),
        ...(req && asObj(req.headers) ? { headers: clipRecord(asObj(req.headers)!) } : {}),
        ...(typeof req?.bodyPreview === 'string' ? { bodyPreview: clipText(req.bodyPreview) } : {}),
      },
      ...(res
        ? {
            response: {
              status: numOf(res.status),
              ...(typeof res.statusText === 'string' ? { statusText: res.statusText } : {}),
              durationMs: numOf(res.durationMs),
              bodyText: clipText(strOf(res.bodyText)),
            },
          }
        : {}),
      ...(typeof http.transportFailure === 'string' ? { transportFailure: clipText(http.transportFailure) } : {}),
      ...(a ? { assertion: a } : {}),
      ...(saved
        ? { saved: { varName: strOf(saved.varName), value: clipText(strOf(saved.value)) } }
        : {}),
    };
  }
  const sy = asObj(s.syslog);
  if (sy) {
    out.syslog = {
      protocol: strOf(sy.protocol),
      host: strOf(sy.host),
      port: numOf(sy.port),
      facility: strOf(sy.facility),
      severity: strOf(sy.severity),
      packet: clipText(strOf(sy.packet)),
      durationMs: numOf(sy.durationMs),
      bytes: numOf(sy.bytes),
    };
  }
  return out;
}

/** 任意 jsonb 深度字符串截断(rca/preflight/datasetSnapshot 等自产小对象通用;数组截 20 项)。 */
export function clipDeep(v: unknown): unknown {
  if (typeof v === 'string') return clipText(v);
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => clipDeep(x));
  const o = asObj(v);
  if (o) return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, clipDeep(x)]));
  return v;
}

export interface HistoryStep {
  order: number;
  status: string;
  durationMs: number;
  startedAt?: string;
  instruction?: string;
  error?: string;
  humanMessage?: string;
  failureReason?: string;
  warning?: string;
  hitLocator?: { kind: string; value: string };
  visionAssert?: { passed: boolean; reason: string; expected?: string };
  aiUsage?: Record<string, unknown>;
  healed?: boolean;
  degraded?: boolean;
  cached?: boolean;
  db?: HistoryStepDb;
  sql?: HistoryStepSql;
  log?: HistoryStepLog;
  http?: HistoryStepHttp;
  syslog?: HistoryStepSyslog;
}

/** 单步整形纯函数:归因所需字段子集+统一截断;screenshot/tabIndex/compiled 等不透传。 */
export function shapeStep(s: Record<string, unknown>): HistoryStep {
  const out: HistoryStep = {
    order: typeof s.order === 'number' ? s.order : 0,
    status: String(s.status ?? 'unknown'),
    durationMs: typeof s.durationMs === 'number' ? s.durationMs : 0,
  };
  if (typeof s.startedAt === 'string') out.startedAt = s.startedAt;
  if (typeof s.instruction === 'string' && s.instruction) out.instruction = s.instruction;
  if (typeof s.error === 'string' && s.error) out.error = clipText(s.error);
  if (typeof s.humanMessage === 'string' && s.humanMessage) out.humanMessage = clipText(s.humanMessage);
  if (typeof s.warning === 'string' && s.warning) out.warning = clipText(s.warning);
  if (typeof s.failureReason === 'string' && s.failureReason) out.failureReason = s.failureReason;
  const hl = asObj(s.hitLocator);
  if (hl && typeof hl.kind === 'string' && typeof hl.value === 'string') {
    out.hitLocator = { kind: hl.kind, value: clipText(hl.value) };
  }
  const va = asObj(s.visionAssert);
  if (va && typeof va.reason === 'string') {
    out.visionAssert = {
      passed: va.passed === true,
      reason: clipText(va.reason),
      ...(typeof va.expected === 'string' ? { expected: clipText(va.expected) } : {}),
    };
  }
  const au = asObj(s.aiUsage);
  if (au && typeof au.calls === 'number') out.aiUsage = clipRecord(au);
  if (s.healed === true) out.healed = true;
  if (s.degraded === true) out.degraded = true;
  if (s.cached === true) out.cached = true;
  return { ...out, ...shapeStructured(s) };
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
  mobileOs: string | null;
  deviceName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
  /** 执行前检(URL 可达/登录态/origin),老报告可能缺省 */
  preflight?: Record<string, unknown>;
  /** 数据行快照(敏感值落库即 '******',可安全透传) */
  datasetSnapshot?: Record<string, unknown>;
  /** 计划成员执行回溯;单用例执行缺省 */
  planRunId?: string | null;
  planId?: string | null;
  /** 计划运行 RCA 结论(save_rca_result / worker 写) */
  rca?: Record<string, unknown> | null;
  /** 触发人显示名 */
  createdByName?: string | null;
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
      datasetSnapshot: reports.datasetSnapshot,
      platform: reports.platform,
      mobileOs: reports.mobileOs,
      deviceName: reports.deviceName,
      startedAt: sql<string | null>`${reports.startedAt}::text`,
      finishedAt: sql<string | null>`${reports.finishedAt}::text`,
      createdAt: sql<string | null>`${reports.createdAt}::text`,
      preflight: reports.preflight,
      createdByUserId: reports.createdByUserId,
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
  const steps = raw.map((s) => shapeStep(s));
  // 计划成员报告:回溯 planRunId/planId 与 RCA(与 routes/reports.ts GET /:id 同款两段匹配)
  const prcRows = await db
    .select({ planRunId: planRunCases.planRunId, reportId: planRunCases.reportId, reportIds: planRunCases.reportIds, rca: planRunCases.rca })
    .from(planRunCases)
    .where(eq(planRunCases.caseId, r.caseId))
    .limit(50);
  const link = prcRows.find((p) => p.reportId === reportId)
    ?? prcRows.find((p) => Array.isArray(p.reportIds) && p.reportIds.includes(reportId));
  let planId: string | null = null;
  if (link) {
    const pr = (await db.select({ planId: planRuns.planId }).from(planRuns).where(eq(planRuns.id, link.planRunId)).limit(1))[0];
    planId = pr?.planId ?? null;
  }
  const users = await resolveUsersByIds(r.createdByUserId ? [r.createdByUserId] : []);
  const named = (await attachVersionNames([{ versionId: r.versionId }]))[0]!;
  const preflight = asObj(r.preflight);
  const snapshot = asObj(r.datasetSnapshot);
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
    mobileOs: r.mobileOs,
    deviceName: r.deviceName,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    createdAt: r.createdAt,
    ...(preflight ? { preflight: clipDeep(preflight) as Record<string, unknown> } : {}),
    ...(snapshot ? { datasetSnapshot: clipDeep(snapshot) as Record<string, unknown> } : {}),
    ...(link ? { planRunId: link.planRunId, planId, rca: clipDeep(link.rca) as Record<string, unknown> | null } : {}),
    createdByName: r.createdByUserId ? users.get(r.createdByUserId)?.displayName ?? null : null,
    steps,
  };
}

export interface HistoryReportListItem {
  reportId: string;
  caseId: string;
  caseTitle: string;
  versionId: string;
  versionName: string | null;
  status: string;
  healed: boolean;
  durationMs: number | null;
  startedAt: string | null;
  platform: string;
  mobileOs: string | null;
  deviceName: string | null;
  summary: string | null;
  lastAssertion: string | null;
  planRunId: string | null;
  createdByName: string | null;
}

/** 报告列表(通过+失败都可查,最新在前)——report_detail 的发现入口。含计划成员执行。 */
export async function reportList(
  projectId: string,
  opts: { caseId?: string; status?: string; days?: number; limit?: number } = {},
): Promise<HistoryReportListItem[]> {
  const conds = [eq(groups.projectId, projectId), gte(reports.createdAt, since(opts.days ?? 30))];
  if (opts.caseId) conds.push(eq(reports.caseId, opts.caseId));
  if (opts.status) conds.push(eq(reports.status, opts.status));
  const rows = await db
    .select({
      reportId: reports.id,
      caseId: reports.caseId,
      caseTitle: testCases.title,
      versionId: testCases.versionId,
      status: reports.status,
      healed: reports.healed,
      durationMs: reports.durationMs,
      startedAt: sql<string | null>`${reports.startedAt}::text`,
      platform: reports.platform,
      mobileOs: reports.mobileOs,
      deviceName: reports.deviceName,
      summary: reports.summary,
      lastAssertion: lastAssertionSql,
      planRunId: planRunIdSql,
      createdByUserId: reports.createdByUserId,
    })
    .from(reports)
    .innerJoin(testCases, eq(testCases.id, reports.caseId))
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .where(and(...conds))
    .orderBy(desc(reports.createdAt))
    .limit(Math.min(Math.max(opts.limit ?? 20, 1), 100));
  const users = await resolveUsersByIds(rows.map((r) => r.createdByUserId).filter((v): v is string => !!v));
  const named = await attachVersionNames(rows);
  return named.map((r) => ({
    reportId: r.reportId,
    caseId: r.caseId,
    caseTitle: r.caseTitle,
    versionId: r.versionId,
    versionName: r.versionName,
    status: r.status,
    healed: r.healed,
    durationMs: r.durationMs,
    startedAt: r.startedAt,
    platform: r.platform,
    mobileOs: r.mobileOs,
    deviceName: r.deviceName,
    summary: r.summary ? clipText(r.summary, 200) : null,
    lastAssertion: r.lastAssertion ? clipText(r.lastAssertion, 500) : null,
    planRunId: r.planRunId,
    createdByName: r.createdByUserId ? users.get(r.createdByUserId)?.displayName ?? null : null,
  }));
}

export interface HistoryPlanRunCase {
  caseId: string;
  caseTitle: string;
  status: string;
  stepKind: string;
  reportId: string | null;
  error: string | null;
  durationMs: number | null;
  startedAt: string | null;
  rca: Record<string, unknown> | null;
}

export interface HistoryPlanRunDetail {
  runId: string;
  planId: string;
  planName: string;
  versionId: string | null;
  versionName: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  summary: string | null;
  /** 触发来源:'manual' 一键执行 / 'schedule' 调度触发 */
  triggerSource: string;
  triggeredBy: string | null;
  totalCases: number;
  passedCases: number | null;
  failedCases: number | null;
  skippedCases: number | null;
  cases: HistoryPlanRunCase[];
}

/** 单次计划运行明细:run 概要 + 单用例成败(error/rca)。范围:runId 必须属于当前项目,否则 null。
 *  不复用 routes/planRuns.ts 的组装(其耦合 5min 终态缓存与 SSE 分支),工具侧简单查库即可。 */
export async function planRunDetail(projectId: string, runId: string): Promise<HistoryPlanRunDetail | null> {
  const rows = await db
    .select({
      runId: planRuns.id,
      planId: planRuns.planId,
      planName: executionPlans.name,
      versionId: executionPlans.versionId,
      status: planRuns.status,
      startedAt: sql<string | null>`${planRuns.startedAt}::text`,
      finishedAt: sql<string | null>`${planRuns.finishedAt}::text`,
      durationMs: planRuns.durationMs,
      summary: planRuns.summary,
      triggerSource: planRuns.triggeredBy,
      triggeredById: planRuns.triggeredByUserId,
      totalCases: planRuns.totalCases,
      passedCases: planRuns.passedCases,
      failedCases: planRuns.failedCases,
      skippedCases: planRuns.skippedCases,
    })
    .from(planRuns)
    .innerJoin(executionPlans, eq(executionPlans.id, planRuns.planId))
    .where(and(eq(planRuns.id, runId), eq(planRuns.projectId, projectId)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const caseRows = await db
    .select({
      caseId: planRunCases.caseId,
      caseTitle: testCases.title,
      status: planRunCases.status,
      stepKind: planRunCases.stepKind,
      reportId: planRunCases.reportId,
      error: planRunCases.error,
      durationMs: planRunCases.durationMs,
      startedAt: sql<string | null>`${planRunCases.startedAt}::text`,
      rca: planRunCases.rca,
    })
    .from(planRunCases)
    .innerJoin(testCases, eq(testCases.id, planRunCases.caseId))
    .where(eq(planRunCases.planRunId, runId))
    .orderBy(asc(planRunCases.order));
  const users = await resolveUsersByIds(r.triggeredById ? [r.triggeredById] : []);
  const named = (await attachVersionNames([{ versionId: r.versionId }]))[0]!;
  return {
    runId: r.runId,
    planId: r.planId,
    planName: r.planName,
    versionId: r.versionId,
    versionName: named.versionName,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    summary: r.summary,
    triggerSource: r.triggerSource,
    triggeredBy: r.triggeredById ? users.get(r.triggeredById)?.displayName ?? null : null,
    totalCases: r.totalCases,
    passedCases: r.passedCases,
    failedCases: r.failedCases,
    skippedCases: r.skippedCases,
    cases: caseRows.map((c) => ({
      caseId: c.caseId,
      caseTitle: c.caseTitle,
      status: c.status,
      stepKind: c.stepKind,
      reportId: c.reportId,
      error: c.error ? clipText(c.error) : null,
      durationMs: c.durationMs,
      startedAt: c.startedAt,
      rca: clipDeep(c.rca) as Record<string, unknown> | null,
    })),
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
  finishedAt: string | null;
  summary: string | null;
  triggerSource: string;
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
      finishedAt: sql<string | null>`${planRuns.finishedAt}::text`,
      summary: planRuns.summary,
      triggerSource: planRuns.triggeredBy,
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
    runId: r.runId,
    planId: r.planId,
    planName: r.planName,
    versionId: r.versionId,
    versionName: r.versionName,
    status: r.status,
    totalCases: r.totalCases,
    passedCases: r.passedCases,
    failedCases: r.failedCases,
    skippedCases: r.skippedCases,
    durationMs: r.durationMs,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    summary: r.summary ? clipText(r.summary, 200) : null,
    triggerSource: r.triggerSource,
    triggeredBy: rows[i]!.triggeredById ? users.get(rows[i]!.triggeredById)?.displayName ?? null : null,
  }));
}
