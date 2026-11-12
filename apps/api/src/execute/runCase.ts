import { eq, asc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext } from 'playwright-core';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import { testCases, testSteps, reports, groups } from '../db/schema.js';
import { executeCaseReal, executeCaseInBrowser, maskSensitiveValues, type ExecStepResult } from './cdp.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';
import { loadDatasetForRun, type DatasetRowExec } from '../services/datasets.service.js';
import type { WindowStrategy, PreflightReport } from '@itest/shared';
import { WebEngine } from './webEngine.js';
import { MobileEngine } from './mobileEngine.js';
import { EngineUnavailable, type Engine, type EngineInput } from './engine.js';
import { WebServiceMissing } from './envContext.js';
import { readAiFallbackSettings } from './aiFallback.js';

/**
 * Executes a single case and writes the report. CDP failure → writes a CDPUnavailable failed report (no more mock fallback).
 * Returns reportId and final status; shared by the single-case route and execution plans.
 * Dataset binding (caseRow.datasetId): N enabled rows = N independent replays = N reports;
 * a single row failing doesn't interrupt (each row is an independent verification), and the final status aggregates to failed if any row failed.
 * Config errors (no enabled rows/illegal column name/decryption failure) throw DatasetConfigError directly — no garbage report is produced.
 * `storageState` reuses the cookie/localStorage exported by the login-preparation phase within an execution plan.
 * `forceFail` (for tests) writes a failed report directly before entering CDP, easing fail_fast behavior tests.
 * `envOverride` (plan-level) overrides the case's defaultEnvId, used in the execution-plan context.
 * `ownedBrowser`/`ownedContext` (plan-level loginPrepare chain) runs the login case in the caller-held chromium + context,
 *  so after a successful login the real storageState can be exported directly from the same ctx; the caller is responsible for closing.
 * `preseed` (used by the single-case execution route): the route has already inserted a running report row to get the reportId (execution jumps straight to the report page),
 *  and once passed in, this function/each runCaseOnce matches by rowIndex and reuses it without a second insert; null keeps the original insert semantics.
 */
export interface PreseedReport {
  reportId: string;
  rowIndex: number | null;
}

/** Inserts a running report row (exactly the values runCaseOnce originally inserted), returns reportId.
 *  Called early by the single-case execution route (after execution goes background, the response must carry the reportId); runCaseOnce reuses it via preseed.
 *  createdByUserId = who triggered the execution (the report creator).
 *  datasetBatchId = the dataset execution's batch id (shared by all rows of one runCase run; the report page row-switcher grouping key),
 *  set only for dataset rows (rowPlan present). */
export async function insertRunningReportRow(
  caseRow: typeof testCases.$inferSelect,
  rowPlan?: DatasetRowExec,
  createdByUserId?: string | null,
  datasetBatchId?: string | null,
): Promise<string> {
  const inserted = await db
    .insert(reports)
    .values({
      caseId: caseRow.id,
      status: 'running',
      stepResults: [] as object,
      summary: 'execution in progress',
      platform: caseRow.platform,
      ...(createdByUserId ? { createdByUserId } : {}),
      ...(caseRow.mobileOs ? { mobileOs: caseRow.mobileOs } : {}),
      ...(caseRow.mobileDeviceTargetId ? { deviceTargetId: caseRow.mobileDeviceTargetId } : {}),
      ...(rowPlan ? { datasetRowIndex: rowPlan.rowIndex, datasetSnapshot: rowPlan.snapshot } : {}),
      ...(rowPlan && datasetBatchId ? { datasetBatchId } : {}),
    })
    .returning();
  return inserted[0]!.id;
}

export async function runCase(
  caseId: string,
  opts?: {
    storageState?: unknown;
    forceFail?: boolean;
    envOverride?: { envId: string } | null;
    /** Group-level unified override: deviceTargetId / browser context (plan_case_groups.target_config). */
    targetOverride?: { deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null;
    ownedBrowser?: Browser;
    ownedContext?: BrowserContext;
    /** playground live view source: passed through to the executor, following page switches (plan runs / single-case execution). */
    liveView?: import('./liveView.js').LiveViewHandle;
    /** Running report row pre-inserted by the route (execution jumps straight to the report page); when provided, the report insert inside this function is skipped. */
    preseed?: PreseedReport[];
    /** Report creator = who triggered the execution; the preseed path already persisted it at the route, so this only covers non-preseed inserts. */
    createdByUserId?: string | null;
    /** Dataset batch id (row-switcher grouping key): the dataset branch generates it itself when absent; on the preseed path the route already persisted it — don't pass. */
    datasetBatchId?: string | null;
    /**
     * The plan's project id (passed in by the execution-plan chain). Decides whether the environment guard applies:
     * same-project cases keep the strong check "the environment must belong to this project"; cases shared in across product lines are exempt,
     * otherwise they'd fail one by one for "the environment belongs to another project". Semantics documented at the resolveEnv call site.
     */
    planProjectId?: string | null;
    /** Callback as soon as the report row is persisted (reportId + dataset row index; null for non-dataset).
     *  Plan runs use it to backfill report_id into plan_run_cases immediately — otherwise report_id waits for the whole case
     *  to finish before backfill, the frontend gets no report id during execution, the page can only show「排队等待执行」,
     *  and steps only appear in one shot after the case ends. */
    onReportCreated?: (reportId: string, rowIndex: number | null) => void | Promise<void>;
    /** Dataset row selection (enabled row indexes). When passed, uses the passed value (the set frozen at the execution route's precheck);
     *  when absent, falls back to the case-stored datasetRowIndexes (plan-run path). [] = all enabled rows. */
    datasetRowIndexes?: number[];
    /** Abort checkpoint (plan-run cancellation): injected into the executor's step loop and AI turns; stops on hit. */
    shouldAbort?: () => boolean | Promise<boolean>;
  },
): Promise<{ reportId: string; status: string; reportIds?: string[] }> {
  const caseRow = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!caseRow) throw new Error('case not found');

  // Dataset binding: precheck failures (0 enabled rows/illegal column name/decryption failure) throw DatasetConfigError directly — config errors produce no garbage report.
  if (caseRow.datasetId) {
    // Row selection: the execution route's frozen final index set wins; otherwise fall back to the case-stored selection (plan-run path).
    const rowIndexes = opts?.datasetRowIndexes ?? caseRow.datasetRowIndexes ?? [];
    const plan = await loadDatasetForRun(caseRow.datasetId, { rowIndexes });
    // Batch id: generated here on non-preseed paths (plan run / batch solidify etc.); the preseed route already persisted it with the insert — no need to pass again.
    const batchId = opts?.preseed ? undefined : randomUUID();
    const reportIds: string[] = [];
    let finalStatus = 'passed';
    for (const row of plan.rows) {
      // Row failure doesn't interrupt: any single-row error was already recorded as that row's failed report inside runCaseOnce; this only aggregates.
      const r = await runCaseOnce(caseId, caseRow, { ...opts, datasetBatchId: batchId }, row);
      reportIds.push(r.reportId);
      if (r.status !== 'passed') finalStatus = 'failed';
    }
    return { reportId: reportIds[0]!, status: finalStatus, reportIds };
  }
  return runCaseOnce(caseId, caseRow, opts);
}

/** Single execution (called once per row in dataset mode). With rowPlan present: the report carries rowIndex/a snapshot and the executor injects initial variables;
 *  and any unexpected error after the report insert is caught here as that row's failed report — no iteration interruption, no running zombies left behind. */
async function runCaseOnce(
  caseId: string,
  caseRow: typeof testCases.$inferSelect,
  opts: {
    storageState?: unknown;
    forceFail?: boolean;
    envOverride?: { envId: string } | null;
    ownedBrowser?: Browser;
    ownedContext?: BrowserContext;
    liveView?: import('./liveView.js').LiveViewHandle;
    preseed?: PreseedReport[];
    createdByUserId?: string | null;
    datasetBatchId?: string | null;
    planProjectId?: string | null;
    onReportCreated?: (reportId: string, rowIndex: number | null) => void | Promise<void>;
    shouldAbort?: () => boolean | Promise<boolean>;
  } | undefined,
  rowPlan?: DatasetRowExec,
): Promise<{ reportId: string; status: string }> {
  // Resolve projectId for project-scoped attachment resolution during playback.
  const group = caseRow.groupId
    ? (await db.select({ projectId: groups.projectId }).from(groups).where(eq(groups.id, caseRow.groupId)))[0]
    : undefined;
  const projectId = group?.projectId;

  const steps = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, caseId))
    .orderBy(asc(testSteps.order));

  // preseed (the route pre-inserted this row's running report row) → match by rowIndex and reuse the reportId, no second insert.
  // On no match (the dataset changed between precheck and background execution) throw; the dataset-row fallback/route catch records it as failed.
  let reportId: string;
  if (opts?.preseed) {
    const match = opts.preseed.find((p) => (p.rowIndex ?? null) === (rowPlan?.rowIndex ?? null));
    if (!match) throw new Error(`preseed report missing for dataset row ${rowPlan?.rowIndex ?? 'none'}`);
    reportId = match.reportId;
  } else {
    reportId = await insertRunningReportRow(caseRow, rowPlan, opts?.createdByUserId, opts?.datasetBatchId);
  }

  // The report row is persisted (status=running): notify the caller immediately so the plan run can backfill report_id into
  // plan_run_cases — the frontend locates the report from this and polls every 2s, seeing step results progressively.
  // Backfill failure shouldn't interrupt execution (the frontend degrades to "one-shot display after the case ends", same as today), so exceptions are swallowed.
  if (opts?.onReportCreated) {
    try {
      await opts.onReportCreated(reportId, rowPlan?.rowIndex ?? null);
    } catch (e) {
      logger.warn({ err: e, caseId, reportId }, 'onReportCreated callback failed; report linkage may lag');
    }
  }

  // Non-dataset mode keeps the original semantics: internal errors still propagate (handled at the HTTP boundary).
  if (!rowPlan) return runCaseOnceInner(caseId, caseRow, opts, projectId, steps, reportId, undefined);
  // Dataset row fallback: the report is persisted, so any later unexpected error (decryption/URL resolution/final persist etc.) doesn't escape the iteration loop
  // but is recorded as that row's InternalError failed report — satisfying "any single-row error is failed, continue to the next row".
  try {
    return await runCaseOnceInner(caseId, caseRow, opts, projectId, steps, reportId, rowPlan);
  } catch (e) {
    let msg = e instanceof Error ? e.message : String(e);
    if (rowPlan.sensitiveVarKeys.length > 0) {
      msg = maskSensitiveValues(msg, rowPlan.vars, rowPlan.sensitiveVarKeys);
    }
    logger.warn({ err: e, caseId, reportId }, 'dataset row crashed after report insert; writing InternalError failed report');
    await db
      .update(reports)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        stepResults: [
          {
            order: 1,
            status: 'failed',
            durationMs: 0,
            startedAt: new Date().toISOString(),
            error: msg,
            failureReason: 'InternalError',
            humanMessage: '执行器内部错误，该行已记为失败',
          },
        ] as object,
        summary: msg,
      })
      .where(eq(reports.id, reportId))
      .catch(() => undefined);
    return { reportId, status: 'failed' };
  }
}

/** The execution body after the report insert (called by runCaseOnce after its pre-queries and report persist). */
async function runCaseOnceInner(
  caseId: string,
  caseRow: typeof testCases.$inferSelect,
  opts: {
    storageState?: unknown;
    forceFail?: boolean;
    envOverride?: { envId: string } | null;
    /** Group-level unified override: deviceTargetId / browser context (plan_case_groups.target_config). */
    targetOverride?: { deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null;
    ownedBrowser?: Browser;
    ownedContext?: BrowserContext;
    liveView?: import('./liveView.js').LiveViewHandle;
    planProjectId?: string | null;
    shouldAbort?: () => boolean | Promise<boolean>;
  } | undefined,
  projectId: string | undefined,
  steps: (typeof testSteps.$inferSelect)[],
  reportId: string,
  rowPlan: DatasetRowExec | undefined,
): Promise<{ reportId: string; status: string }> {
  // Deterministic test hook: no browser launch, writes the failed report directly.
  if (opts?.forceFail) {
    const stepResults: ExecStepResult[] = [];
    await db
      .update(reports)
      .set({ status: 'failed', durationMs: 0, finishedAt: new Date(), stepResults: stepResults as object, summary: 'forced fail (test hook)' })
      .where(eq(reports.id, reportId));
    return { reportId, status: 'failed' };
  }

  const caseWindow = {
    strategy: caseRow.windowStrategy as WindowStrategy,
    width: caseRow.windowWidth ?? undefined,
    height: caseRow.windowHeight ?? undefined,
  };
  // Group-level targetOverride (plan_case_groups.target_config) takes priority over the case row:
  // browserContext overrides incognito; deviceTargetId overrides mobileDeviceTargetId.
  const incognito = opts?.targetOverride?.browserContext
    ? opts.targetOverride.browserContext === 'incognito'
    : !!caseRow.incognito;
  const deviceTargetId = opts?.targetOverride?.deviceTargetId ?? caseRow.mobileDeviceTargetId ?? null;

  // Resolve envCtx before any CDP launch: planEnv > case defaultEnv > version link > project default.
  // EnvMissing/EnvProjectMismatch are surfaced as a single failed stepResult (no 500). DecryptError propagates.
  //
  // expectedProjectId always receives "the case's own project" — it's the basis for the resolve chain's last step "fall back to querying that project's default environment";
  // turning it off would leave cross-project cases with neither the plan environment nor their own project's default environment.
  // What actually needs exemption is only the "ownership re-check": the plan environment hangs under the plan's own project, and a case shared in across product lines receiving it is
  // expected behavior — blocking it as-is would fail every case with EnvProjectMismatch. allowCrossProjectEnv is exactly that exemption switch.
  const sameProjectAsPlan = !opts?.planProjectId || opts.planProjectId === projectId;
  const { resolveEnv } = await import('./envContext.js');
  let envCtx: import('./envContext.js').EnvCtx | undefined;
  try {
    envCtx = await resolveEnv(
      {
        planEnvId: opts?.envOverride?.envId ?? null,
        caseEnvId: caseRow.defaultEnvId ?? null,
        versionId: caseRow.versionId ?? null,
      },
      projectId ? { expectedProjectId: projectId, allowCrossProjectEnv: !sameProjectAsPlan } : undefined,
    );
  } catch (e) {
    const errName = e instanceof Error ? e.name : '';
    if (errName === 'EnvMissing' || errName === 'EnvProjectMismatch') {
      const failureReason = errName as 'EnvMissing' | 'EnvProjectMismatch';
      const humanMessage =
        errName === 'EnvProjectMismatch'
          ? '环境所属项目与当前用例不匹配'
          : '缺少环境配置，请到项目环境页配置默认环境';
      const stepResults: ExecStepResult[] = [{
        order: 1,
        status: 'failed',
        durationMs: 0,
        startedAt: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
        failureReason,
        humanMessage,
      }];
      await db
        .update(reports)
        .set({
          status: 'failed',
          durationMs: 0,
          finishedAt: new Date(),
          stepResults: stepResults as object,
          summary: e instanceof Error ? e.message : String(e),
        })
        .where(eq(reports.id, reportId));
      return { reportId, status: 'failed' };
    }
    throw e;
  }

  // Initial navigation: absolute url passes through; relative url joins the origin from the environment's web service (spec 2026-10-16).
  // WebServiceMissing is presented the same as EnvMissing: a single failed step report.
  let resolved: string | null = null;
  let caseWebOrigin: string | null = null;
  try {
    resolved = envCtx
      ? await resolveCaseUrl(caseRow, { envCtx })
      : await resolveCaseUrl(caseRow, { defaultEnvFallback: true });
  } catch (e) {
    if (e instanceof WebServiceMissing) {
      const stepResults: ExecStepResult[] = [{
        order: 1, status: 'failed', durationMs: 0,
        startedAt: new Date().toISOString(),
        error: e.message, failureReason: 'WebServiceMissing', humanMessage: e.message,
      }];
      await db.update(reports)
        .set({ status: 'failed', durationMs: 0, finishedAt: new Date(), stepResults: stepResults as object, summary: e.message })
        .where(eq(reports.id, reportId));
      if (envCtx) envCtx.close().catch(() => undefined);
      return { reportId, status: 'failed' };
    }
    throw e;
  }
  // Absolute-url pass-through cases: a bad webServiceRef doesn't participate in initial navigation, tolerated as null (T7 reports it at step level for relative navigate steps).
  // Dropping the WebServiceMissing message here is deliberate — relative-url cases already threw at resolveCaseUrl above and never reach here.
  if (envCtx) {
    try {
      caseWebOrigin = envCtx.resolveWebOrigin(caseRow.webServiceRef ?? null);
    } catch {
      caseWebOrigin = null;
    }
  }
  const targetUrl = resolved && /^https?:\/\//.test(resolved) ? resolved : undefined;

  const startedAt = Date.now();
  // Persist started_at: the moment steps actually start running (after environment/URL resolution; same baseline as duration_ms).
  // Persist immediately rather than at the final state — during running, the report page can already show「执行开始」; when a worker dies leaving a zombie row
  // there's also evidence to check (the frontend falls back to createdAt to display「请求于」).
  await db.update(reports).set({ startedAt: new Date(startedAt) }).where(eq(reports.id, reportId));
  let stepResults: ExecStepResult[];
  let preflightReport: PreflightReport | undefined;
  let status: 'passed' | 'failed';
  const isMobile = caseRow.platform === 'mobile';
  // Incremental persistence: each finished step flushes the accumulated results into the report row (status still running), so the report page's 2s
  // polling sees results progressively instead of one shot after the whole run.
  // Writes are fire-and-forget (failures only log, never interrupt execution), but before the final-state write at the end they must be awaited,
  // otherwise a late incremental write would overwrite the final stepResults with an old snapshot. Failed steps are persisted incrementally too,
  // so "stopping at the failed step" shows the failure reason immediately as well.
  const liveSteps: ExecStepResult[] = [];
  const pendingWrites: Promise<unknown>[] = [];
  const onStep = (r: ExecStepResult) => {
    liveSteps.push(r);
    const snapshot = liveSteps.slice();
    pendingWrites.push(
      db
        .update(reports)
        .set({ stepResults: snapshot as object })
        .where(eq(reports.id, reportId))
        .catch((e) => logger.warn({ err: e, reportId, order: r.order }, 'incremental stepResults persist failed')),
    );
  };
  try {
    // Replay AI-fallback switches (global settings): read once per execution, injected into the executor for the dispatcher to reach; not passed through when all are off.
    const aiFallback = await readAiFallbackSettings();
    const stepInput = steps.map((s) => ({
      order: s.order,
      assertion: s.assertion,
      delayMs: s.delayMs,
      id: s.id,
      tabRef: s.tabRef,
      componentKind: s.componentKind,
      sensitive: s.sensitive,
      // 2026-10-06: the dispatcher's sole replay basis is compiled; the action column was DROPped in 0030.
      compiled: s.compiled as unknown[] | null | undefined,
      // For the AI-fallback path: row-level natural-language instruction (normal mechanical replay doesn't read it).
      instruction: s.instruction,
    }));
    // web_<name> system variables: the environment web services' origins (override same-named dataset variables; web_ is a reserved prefix).
    const webVars: Record<string, string> = {};
    for (const w of envCtx?.webServices ?? []) {
      if (w.name) webVars[`web_${w.name}`] = w.origin;
    }
    const initialVars = rowPlan ? { ...rowPlan.vars, ...webVars } : (Object.keys(webVars).length ? webVars : undefined);
    const execCtx = {
      reportId,
      projectId,
      envCtx,
      // Track 1: pass the case-level expectedOutcome / title / url to cdp, triggering the final vision verdict.
      expectedOutcome: caseRow.expectedOutcome ?? null,
      caseTitle: caseRow.title,
      caseUrl: caseRow.url ?? null,
      ...(rowPlan
        ? { sensitiveVarKeys: rowPlan.sensitiveVarKeys }
        : {}),
      ...(initialVars ? { initialVars } : {}),
      ...(caseWebOrigin ? { caseWebOrigin } : {}),
      ...(caseRow.webServiceRef ? { caseWebServiceRef: caseRow.webServiceRef } : {}),
      ...(opts?.liveView ? { liveView: opts.liveView } : {}),
      ...(aiFallback.locatorFailed ? { aiFallback } : {}),
      ...(opts?.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}),
    };
    // Mobile cases: go straight through MobileEngine; web cases: the login-preparation chain (ownedBrowser) goes through executeCaseInBrowser reusing the ctx,
    // the rest go through WebEngine.execute → executeCaseReal (preserving the storageState/incognito injection semantics).
    const mobileOs = (caseRow.mobileOs === 'ios' || caseRow.mobileOs === 'android')
      ? caseRow.mobileOs
      : null;
    if (isMobile) {
      const engine = new MobileEngine();
      const engineInput: EngineInput = {
        caseId,
        caseTitle: caseRow.title,
        caseUrl: caseRow.url ?? null,
        expectedOutcome: caseRow.expectedOutcome ?? null,
        steps: stepInput,
        envCtx,
        reportId,
        projectId,
        caseWindow,
        incognito,
        appRef: caseRow.appRef ?? null,
        deviceTargetId,
        mobileOs,
        ...(rowPlan ? { sensitiveVarKeys: rowPlan.sensitiveVarKeys } : {}),
        ...(initialVars ? { initialVars } : {}),
        ...(caseWebOrigin ? { caseWebOrigin } : {}),
      };
      try {
        await engine.prepare(engineInput);
        stepResults = await engine.execute(engineInput, targetUrl, (r: PreflightReport) => { preflightReport = r; }, onStep);
        const failed = stepResults.filter((r) => r.status === 'failed').length;
        status = failed === 0 ? 'passed' : 'failed';
      } catch (e) {
        if (e instanceof EngineUnavailable) {
          stepResults = [{
            order: 1, status: 'failed', durationMs: 0,
            startedAt: new Date().toISOString(),
            error: e.message, failureReason: 'EngineUnavailable',
            humanMessage: '移动端引擎不可用：' + e.message,
          }];
          status = 'failed';
        } else {
          logger.warn({ err: e, caseId, reportId }, 'mobile engine execution failed; writing CDPUnavailable failed report');
          stepResults = [{
            order: 1, status: 'failed', durationMs: 0,
            startedAt: new Date().toISOString(),
            error: e instanceof Error ? e.message : String(e),
            failureReason: 'CDPUnavailable',
            humanMessage: '执行失败',
          }];
          status = 'failed';
        }
      } finally {
        try { await engine.release(engineInput); } catch { /* swallow */ }
        if (envCtx && !opts?.ownedBrowser) envCtx.close().catch(() => undefined);
      }
    } else if (opts?.ownedBrowser && opts?.ownedContext) {
      // Plan-level loginPrepare chain: runs in the caller-held chromium + context (no storageState injection anymore —
      // the context already holds the login cookies; injecting again would overwrite them). The browser and context are managed by the caller.
      stepResults = await executeCaseInBrowser(
        caseId,
        stepInput,
        execCtx,
        opts.ownedBrowser,
        opts.ownedContext,
        targetUrl,
        (r) => {
          preflightReport = r;
        },
        caseWindow,
        onStep,
      );
      const failed = stepResults.filter((r) => r.status === 'failed').length;
      status = failed === 0 ? 'passed' : 'failed';
    } else {
      const engine = new WebEngine();
      const engineInput: EngineInput = {
        caseId,
        caseTitle: caseRow.title,
        caseUrl: caseRow.url ?? null,
        expectedOutcome: caseRow.expectedOutcome ?? null,
        steps: stepInput,
        envCtx,
        reportId,
        projectId,
        caseWindow,
        incognito,
        ...(opts?.storageState ? { storageState: opts.storageState } : {}),
        appRef: caseRow.appRef ?? null,
        deviceTargetId,
        mobileOs,
        ...(opts?.liveView ? { liveView: opts.liveView } : {}),
        ...(rowPlan ? { sensitiveVarKeys: rowPlan.sensitiveVarKeys } : {}),
        ...(initialVars ? { initialVars } : {}),
        ...(caseWebOrigin ? { caseWebOrigin } : {}),
        ...(caseRow.webServiceRef ? { caseWebServiceRef: caseRow.webServiceRef } : {}),
        ...(aiFallback.locatorFailed ? { aiFallback } : {}),
        ...(opts?.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}),
      };
      try {
        await engine.prepare(engineInput);
        stepResults = await engine.execute(engineInput, targetUrl, (r: PreflightReport) => { preflightReport = r; }, onStep);
        const failed = stepResults.filter((r) => r.status === 'failed').length;
        status = failed === 0 ? 'passed' : 'failed';
      } catch (e) {
        logger.warn({ err: e, caseId, reportId }, 'CDP execution failed; writing CDPUnavailable failed report');
        const msg = e instanceof Error ? e.message : String(e);
        stepResults = [
          {
            order: 1,
            status: 'failed',
            durationMs: 0,
            startedAt: new Date().toISOString(),
            error: msg,
            failureReason: 'CDPUnavailable',
            humanMessage: '真实浏览器不可用，已尝试 DOM 降级仍失败',
          },
        ];
        status = 'failed';
      } finally {
        try { await engine.release(engineInput); } catch { /* swallow */ }
        if (envCtx && !opts?.ownedBrowser) envCtx.close().catch(() => undefined);
      }
    }
  } finally {
    // On the caller-owned-browser path the browser lifecycle is the caller's; envCtx is still closed inside this function,
    // because each case resolves its own pg.Pool (no sharing) — closing immediately avoids long-connection leaks.
    if (envCtx && !opts?.ownedBrowser) envCtx.close().catch(() => undefined);
  }

  const durationMs = Date.now() - startedAt;
  // Mobile reports supplement deviceName: the deviceTargets service arrives with Task 5; dynamic import is the fallback here:
  // when the service isn't implemented yet (MVP-stage ordering tolerance) or resolution fails, skip silently and deviceName stays null.
  let deviceName: string | null = null;
  if (caseRow.platform === 'mobile' && caseRow.mobileDeviceTargetId) {
    try {
      const { resolveDeviceTarget } = await import('../services/deviceTargets.service.js');
      const t = await resolveDeviceTarget(caseRow.mobileDeviceTargetId);
      if (t) deviceName = t.name;
    } catch {
      // service not implemented yet (MVP-stage ordering tolerance)
    }
  }
  // Wait for all incremental writes to settle before writing the final state: otherwise a late incremental snapshot would overwrite the final stepResults with stale data.
  await Promise.all(pendingWrites);
  await db
    .update(reports)
    .set({
      status,
      durationMs,
      startedAt: new Date(startedAt),
      finishedAt: new Date(),
      stepResults: stepResults as object,
      summary: buildSummary(stepResults, preflightReport),
      preflight: preflightReport ?? null,
      ...(deviceName ? { deviceName } : {}),
      // Dual pass-rate criterion: passed and some step healed (AI self-heal succeeded after the aiTask cache divergence)
      healed: status === 'passed' && stepResults.some((r) => r.healed === true),
    })
    .where(eq(reports.id, reportId));

  return { reportId, status };
}

function buildSummary(steps: ExecStepResult[], preflight: PreflightReport | undefined): string {
  const passed = steps.filter((r) => r.status === 'passed').length;
  const base = `${steps.length} steps, ${passed} passed, ${steps.length - passed} failed`;
  if (!preflight) return base;
  const tags: string[] = [];
  if (!preflight.urlReachable) tags.push('URLUnreachable');
  if (!preflight.loggedIn) tags.push('NotLoggedIn');
  if (preflight.originMismatch) tags.push('OriginMismatch');
  return tags.length ? `${base} · preflight: ${tags.join(',')}` : base;
}
