/** Execution-history query service (the query_stats tool's data layer).
 *  Scope semantics: project domain — the current project's full execution history (including plan-member executions and
 *  version-less plan runs), results annotated with the owning version.
 *  Unlike the executions list page's "display criteria" (plan members excluded): the attribution criteria cares about a case's full history.
 *  Read-only, no write paths.
 *  Context budget: this layer owns all trimming — strings clipText (1000 chars), db/sql rows ≤10, log lines ≤10,
 *  large objects like screenshot/compiled are never passed through; the tool layer only does parameter parsing + JSON serialization. */
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { executionPlans, groups, planRunCases, planRuns, projectVersions, reports, testCases } from '../db/schema.js';
import { resolveUsersByIds } from '../lib/creator.js';

/** The point in time `days` days ago (today included; closed-interval start). */
function since(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/** Failed-count fragment (reused by orderBy; the filter must be parenthesized before ::int, otherwise pg returns bigint→string) */
const failedCount = sql`(count(*) filter (where ${reports.status} = 'failed'))`;

/** Context budget: the uniform string truncation threshold. */
export const CLIP_LEN = 1000;

/** String truncation (context budget): clipped at max chars with an ellipsis appended. */
export function clipText(s: string, max = CLIP_LEN): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** The "last assertion" SQL shared by failure/report lists: vision reason first, failed-step error as fallback (same criteria as the executions list page). */
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

/** report → plan_run backtracking SQL: the plan run id the report belongs to (null for single-case executions). */
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

/** Case-level aggregation: execution count / passed (with self-heal split) / failed / avg duration / latest status, sorted by failed count desc. Includes plan-member executions. */
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

/** Bulk-fills versionName onto rows (null versionId → null; upper layers label it "no version"). */
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

/** Project execution overview: case-report criteria (passed = first-run passed + self-heal passed) / plan-run status distribution / top-5 failures. */
export async function historyOverview(
  projectId: string,
  opts: { days?: number; versionId?: string } = {},
): Promise<HistoryOverview> {
  const days = opts.days ?? 30;
  const caseConds = [eq(groups.projectId, projectId), gte(reports.createdAt, since(days))];
  if (opts.versionId) caseConds.push(eq(testCases.versionId, opts.versionId));
  // Aggregation without groupBy always returns one row; the non-null assertion matches user.service.ts's row! convention
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
  /** Last assertion info: vision reason first, failed-step error as fallback (same SQL as the executions list page) */
  lastAssertion: string | null;
  /** The plan_run id backtracked for plan-member executions; null for single-case executions */
  planRunId: string | null;
  createdAt: string | null;
}

/** Failed-report details (the raw material for attribution drill-down), newest first. Includes plan-member executions. */
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

// ---------- stepResults jsonb shaping (pure functions, unit-tested) ----------

/** Safe read of a structured inline object: returns only non-null objects. */
function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function numOf(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function strOf(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Shallow copy with string values truncated (generic for string maps like headers/cells). */
function clipRecord(r: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' ? clipText(v) : v]));
}

/** rows ≤10 rows (over-limit sets truncated), cell strings clipped; an upstream-marked truncated is preserved. */
function shapeRows(o: Record<string, unknown>): { rows: Record<string, unknown>[]; truncated?: boolean } {
  const raw = Array.isArray(o.rows) ? o.rows : [];
  const over = raw.length > 10;
  const rows = raw.slice(0, 10).map((r) => {
    const obj = asObj(r);
    return obj ? clipRecord(obj) : r;
  });
  return { rows, ...(o.truncated === true || over ? { truncated: true } : {}) };
}

/** The "actually executed SQL + bound params" in db/sql results: absent in old reports, params clipped item by item. */
function shapeSqlText(o: Record<string, unknown>): { sql?: string; params?: unknown[] } {
  const out: { sql?: string; params?: unknown[] } = {};
  if (typeof o.sql === 'string') out.sql = clipText(o.sql);
  if (Array.isArray(o.params)) {
    out.params = o.params.map((p) => (typeof p === 'string' ? clipText(p) : p));
  }
  return out;
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

/** The generic shape of database query results (the sql step's base shape; after queryDb's 2026-11-08 retirement there is no separate db field). */
export interface HistoryStepDb {
  rowCount: number;
  durationMs: number;
  rows: Record<string, unknown>[];
  /** The actually executed SQL (placeholder form). Absent in old reports. */
  sql?: string;
  /** Bound parameter values. Absent in old reports. */
  params?: unknown[];
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
  sql?: HistoryStepSql;
  log?: HistoryStepLog;
  http?: HistoryStepHttp;
  syslog?: HistoryStepSyslog;
}

/** Shapes a single step's structured results (picks result details + truncates; large objects like screenshot never pass through). Old reports missing fields → the corresponding key is omitted. */
export function shapeStructured(s: Record<string, unknown>): HistoryStructured {
  const out: HistoryStructured = {};
  const sq = asObj(s.sql);
  if (sq) {
    const rows = shapeRows(sq);
    const a = shapeAssertion(sq.assertion);
    out.sql = {
      dbRef: typeof sq.dbRef === 'string' ? sq.dbRef : null,
      rowCount: numOf(sq.rowCount),
      durationMs: numOf(sq.durationMs),
      ...rows,
      ...shapeSqlText(sq),
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

/** Depth-first string truncation over any jsonb (generic for self-produced small objects like rca/preflight/datasetSnapshot; arrays clipped to 20 items). */
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
  sql?: HistoryStepSql;
  log?: HistoryStepLog;
  http?: HistoryStepHttp;
  syslog?: HistoryStepSyslog;
}

/** Single-step shaping pure function: the field subset attribution needs + uniform truncation; screenshot/tabIndex/compiled etc. never pass through. */
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
  /** Preflight (URL reachable / login state / origin), may be absent in old reports */
  preflight?: Record<string, unknown>;
  /** Dataset row snapshot (sensitive values stored as '******', safe to pass through) */
  datasetSnapshot?: Record<string, unknown>;
  /** Backtracked plan-member execution; absent for single-case executions */
  planRunId?: string | null;
  planId?: string | null;
  /** Plan-run RCA conclusion (written by save_rca_result / the worker) */
  rca?: Record<string, unknown> | null;
  /** The trigger's display name */
  createdByName?: string | null;
  steps: HistoryStep[];
}

/** Single-report detail (deep attribution). Scope: reportId must belong to the current project, otherwise null. */
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
  // Plan-member reports: backtrack planRunId/planId and RCA (same two-stage matching as routes/reports.ts GET /:id)
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

/** Report list (passed + failed both queryable, newest first) — the discovery entry for report_detail. Includes plan-member executions. */
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
  /** Trigger source: 'manual' one-click execution / 'schedule' scheduler-triggered */
  triggerSource: string;
  triggeredBy: string | null;
  totalCases: number;
  passedCases: number | null;
  failedCases: number | null;
  skippedCases: number | null;
  cases: HistoryPlanRunCase[];
}

/** Single plan-run detail: run summary + per-case pass/fail (error/rca). Scope: runId must belong to the current project, otherwise null.
 *  Doesn't reuse routes/planRuns.ts's assembly (it couples the 5min terminal-state cache and SSE branches); the tool side can just query the DB simply. */
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

/** Plan-run list (newest first). versionId comes from execution_plans (nullable → versionName null = no version). */
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
