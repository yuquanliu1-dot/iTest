import { eq, asc } from 'drizzle-orm';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import {
  executionPlans,
  planCases,
  planRuns,
  planRunCases,
  testCases,
  users,
} from '../db/schema.js';
import { runCase } from './runCase.js';
import { loginPrepare } from './loginPrepare.js';
import { publishRunEvent, subscribeRunEvent } from '../sse/planRunBus.js';
import { registerLiveView } from './liveView.js';
import { st, type StLang } from '../i18n.js';

/** Per-planRun run controller: cancelRequested kept in memory. */
const runState = new Map<string, { cancelRequested: boolean; storageState?: unknown }>();

export function requestCancel(planRunId: string): void {
  const s = runState.get(planRunId);
  if (s) s.cancelRequested = true;
}

export async function isCancelRequested(planRunId: string): Promise<boolean> {
  // Same-process in-memory fast path (the cancel route sets memory first, then the DB); across containers the DB is authoritative.
  if (runState.get(planRunId)?.cancelRequested) return true;
  const row = (await db.select({ c: planRuns.cancelRequested }).from(planRuns).where(eq(planRuns.id, planRunId)).limit(1))[0];
  return row?.c ?? false;
}

interface RunPlanInput {
  planRunId: string;
}

interface StepEvent {
  type:
    | 'plan_run_login'
    | 'plan_run_case_start'
    | 'plan_run_case_complete'
    | 'plan_run_complete';
  caseId?: string;
  stepKind?: 'login_prepare' | 'business';
  status?: string;
  reportId?: string;
  summary?: string;
}

/** The group shape inside the execution engine: frozen into the plan_runs.groups snapshot at enqueue; old runs synthesize it from scalar login snapshots. */
export interface PlanGroupExec {
  id: string;
  name: string;
  order: number;
  environmentId: string | null;
  loginPrepareEnabled: boolean;
  loginCaseId: string | null;
  /** Login-case row override three states: null = follow case-level; [] = all rows; non-empty = subset */
  loginDatasetRowIndexes: number[] | null;
  detectionUrl: string | null;
  loginSuccessSelector: string | null;
  loginUnauthorizedKeywords: unknown;
  failFast: boolean;
  targetConfig: { deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null;
}

/** Login-reuse signature: storageState is reused only when environment + login config + target_config (+ failFast, per the plan-test criterion) are fully identical. */
export function loginSignature(g: PlanGroupExec): string {
  return JSON.stringify([
    g.environmentId, g.loginPrepareEnabled, g.loginCaseId, g.loginDatasetRowIndexes ?? null, g.detectionUrl,
    g.loginSuccessSelector, g.loginUnauthorizedKeywords ?? null, g.targetConfig ?? null, g.failFast,
  ]);
}

/** The plan_run_cases row's group-ownership columns; the legacy synthesized group doesn't persist group_id (old runs have no group concept). */
const groupMetaOf = (g: PlanGroupExec) => ({
  groupId: g.id === 'legacy' ? null : g.id,
  groupName: g.name,
  groupOrder: g.order,
});

export function subscribeRun(runId: string, res: import('express').Response): () => void {
  return subscribeRunEvent(runId, res);
}

function publish(runId: string, evt: StepEvent) {
  publishRunEvent(runId, evt);
}

/** Look up the triggering user's language preference (fall back to zh-CN when not triggered or user missing). */
async function resolveRunLang(triggeredByUserId: string | null | undefined): Promise<StLang> {
  if (!triggeredByUserId) return 'zh-CN';
  const row = (await db.select({ lang: users.languagePreference }).from(users).where(eq(users.id, triggeredByUserId)).limit(1))[0];
  return (row?.lang === 'en-US' ? 'en-US' : 'zh-CN') as StLang;
}

/**
 * Builds the "backfill plan_run_cases as soon as the report row is persisted" callback.
 *
 * Why the backfill is mandatory: report_id used to be written into plan_run_cases only after the case finished. During execution the frontend had no
 * report id → the plan-run detail page could only show「排队等待执行」, and steps appeared in one shot only after the whole case ended
 * (measured 2026-10-26). After the backfill, the frontend can locate the report while running and watch steps arrive via 2s polling.
 *
 * Criterion:
 * - Non-dataset case (rowIndex=null) → report_id = that report's id;
 * - Dataset case (rowIndex set) → report_ids accumulates all row report ids, and report_id always points at the first row
 *   (consistent with the final-state backfill criterion: final reportId = reportIds[0]).
 */
function makeReportLinker(planRunCaseId: string): (reportId: string, rowIndex: number | null) => Promise<void> {
  const reportIds: string[] = [];
  return async (reportId, rowIndex) => {
    if (rowIndex === null) {
      await db.update(planRunCases).set({ reportId }).where(eq(planRunCases.id, planRunCaseId));
      return;
    }
    reportIds.push(reportId);
    await db
      .update(planRunCases)
      .set({ reportId: reportIds[0]!, reportIds: [...reportIds] })
      .where(eq(planRunCases.id, planRunCaseId));
  };
}

/**
 * Starts one plan execution (async). The caller returns planRunId immediately.
 *
 * Two-tier loop: outer by group (run.groups snapshot; old runs synthesize a single group), inner serial over the group's cases.
 * Failure semantics at two levels: within a group decided by group.failFast (first failure skips the rest of this group);
 * between groups decided by plan.strategy (on fail_fast, an earlier group's failure → subsequent groups skipped whole, evaluated at group boundaries).
 * Login reuse: consecutive groups with the same signature (environment + login config + target_config) and a previous success → reuse storageState, no login row generated.
 */
export async function runPlanAsync(input: RunPlanInput): Promise<void> {
  const { planRunId } = input;
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, planRunId)))[0];
  if (!run) return;
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, run.planId)))[0];
  if (!plan) return;

  const lang = await resolveRunLang(run.triggeredByUserId);

  runState.set(planRunId, { cancelRequested: false });
  // playground live feed: one view source for the whole plan run, following case by case via setPage (including the login-preparation/login case's shared browser).
  const live = registerLiveView(`planrun:${planRunId}`);

  // —— Group structure: prefer the run.groups snapshot (frozen at enqueue); old runs with groups=null/empty → synthesize a single group from the scalar login snapshot ——
  let groups: PlanGroupExec[] = Array.isArray(run.groups) ? (run.groups as PlanGroupExec[]) : [];
  if (groups.length === 0) {
    groups = [{
      id: 'legacy',
      name: '默认分组',
      order: 1,
      environmentId: null, // old runs' plan-level environment is deprecated; each case walks its own default chain
      loginPrepareEnabled: run.loginPrepareEnabled,
      loginCaseId: run.loginCaseId,
      loginDatasetRowIndexes: null, // old runs have no login-row override concept
      detectionUrl: run.detectionUrl,
      loginSuccessSelector: run.loginSuccessSelector,
      loginUnauthorizedKeywords: run.loginUnauthorizedKeywords,
      failFast: false,
      targetConfig: null,
    }];
  }

  // Cases aggregated by group (plan_cases read live at execution — same semantics as the original "frozen at start").
  const pcs = await db
    .select({
      groupId: planCases.groupId,
      caseId: planCases.caseId,
      order: planCases.order,
      status: testCases.status,
      platform: testCases.platform,
      incognito: testCases.incognito,
      // Plan-level row override three states: null = follow case-level; [] = all rows; non-empty = subset (read live from plan_cases, not part of the snapshot)
      datasetRowIndexes: planCases.datasetRowIndexes,
    })
    .from(planCases)
    .innerJoin(testCases, eq(testCases.id, planCases.caseId))
    .where(eq(planCases.planId, plan.id))
    .orderBy(asc(planCases.order));
  const groupOfId = new Map(groups.map((g) => [g.id, g]));
  const legacyGroup = groups.find((g) => g.id === 'legacy');
  const fallbackGroupId = legacyGroup?.id ?? groups[0]!.id;
  const casesByGroup = new Map<string, typeof pcs>();
  for (const g of groups) casesByGroup.set(g.id, []);
  for (const pc of pcs) {
    // groupId not in the snapshot's groups (group changed mid-run/old data) → fall into legacy or the first group
    const gid = pc.groupId && groupOfId.has(pc.groupId) ? pc.groupId : fallbackGroupId;
    casesByGroup.get(gid)!.push(pc);
  }

  const allBusiness = groups.flatMap((g) => casesByGroup.get(g.id)!);
  await db.update(planRuns).set({ totalCases: allBusiness.length, startedAt: new Date() }).where(eq(planRuns.id, planRunId));

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  // Test hook: FORCE_FAIL_CASE_IDS=uuid1,uuid2 forces the matching caseIds to fail, easing fail_fast/cancel tests.
  const forceFailIds = new Set(
    (process.env.FORCE_FAIL_CASE_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  let prevLogin: { signature: string; storageState?: unknown } | undefined;
  let abortedByPlanStrategy = false;
  let anyLoginFailure = false;

  try {
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi]!;
      const gCases = casesByGroup.get(group.id)!;
      const groupMeta = groupMetaOf(group);

      // Cancellation: mark all remaining cases from this group skipped, then end
      if (await isCancelRequested(planRunId)) {
        for (let g2 = gi; g2 < groups.length; g2++) {
          const rest = casesByGroup.get(groups[g2]!.id)!;
          for (let j = 0; j < rest.length; j++) {
            await db.insert(planRunCases).values({
              planRunId,
              caseId: rest[j]!.caseId,
              order: j + 1,
              status: 'skipped',
              stepKind: 'business',
              error: 'cancelled',
              ...groupMetaOf(groups[g2]!),
            });
          }
          skipped += rest.length;
        }
        break;
      }
      // Plan-level fail_fast: an earlier group failed → skip this whole group from here on
      if (abortedByPlanStrategy) {
        for (let j = 0; j < gCases.length; j++) {
          await db.insert(planRunCases).values({
            planRunId,
            caseId: gCases[j]!.caseId,
            order: j + 1,
            status: 'skipped',
            stepKind: 'business',
            error: 'skipped: plan fail_fast',
            ...groupMeta,
          });
        }
        skipped += gCases.length;
        continue;
      }

      // —— Group environment resolution (on failure only warn and fall back; cases in the group walk their own default chains one by one, same as the original plan-env semantics) ——
      // The guard stays: group.environmentId was validated by the group endpoint to belong to this project; this is the fallback re-check.
      let groupEnv: { envId: string } | undefined;
      let groupWebOrigin: string | null | undefined;
      let loginCred: import('./envContext.js').LoginCtx | undefined;
      if (group.environmentId) {
        try {
          const { resolveEnv } = await import('./envContext.js');
          const ctx = await resolveEnv(
            { planEnvId: group.environmentId },
            { expectedProjectId: plan.projectId },
          );
          groupWebOrigin = ctx.resolveWebOrigin();
          groupEnv = { envId: ctx.envId };
          loginCred = ctx.login;
          await ctx.close();
        } catch (e) {
          logger.warn(
            { err: e, planId: plan.id, group: group.name },
            'group env resolve failed; cases will use their own defaultEnv',
          );
          groupEnv = undefined;
        }
      }

      // —— Group login preparation (same signature and previous success → reuse storageState, no login row generated) ——
      let loginState: unknown;
      let loginPrepareFailed = false;
      let loginBrowser: import('playwright-core').Browser | undefined;
      let loginCtx: import('playwright-core').BrowserContext | undefined;
      const sig = loginSignature(group);
      try {
        if (group.loginPrepareEnabled && prevLogin?.signature === sig && prevLogin.storageState) {
          loginState = prevLogin.storageState;
        } else if (group.loginPrepareEnabled) {
          // In-group conflicts (enqueue already 422s the HTTP entry; this covers runs inserted into the DB directly) are handled as "login preparation failed",
          // no longer failing the whole run/throwing 422 like the old engine.
          const incognitoHit = gCases.some((c) => c.incognito);
          const mobileHit = gCases.find((c) => c.status !== 'deprecated' && c.platform === 'mobile');
          if (incognitoHit || mobileHit) {
            loginPrepareFailed = true;
            logger.warn(
              { planRunId, planId: plan.id, group: group.name, incognitoHit, mobileHit: !!mobileHit },
              'login prepare conflicts with group cases (incognito/mobile); group cases will be skipped',
            );
          } else {
            const firstCaseId = gCases.find((c) => c.status !== 'deprecated' && c.platform !== 'mobile')?.caseId ?? null;
            const result = await loginPrepare(
              {
                enabled: true,
                caseId: group.loginCaseId,
                detectionUrl: group.detectionUrl,
                successSelector: group.loginSuccessSelector,
                unauthorizedKeywords: group.loginUnauthorizedKeywords as string[] | null,
                firstCaseId,
              },
              {
                // When no login case is configured and the group environment has login credentials, take the auto-form-fill login path (detection/fill pages join the live feed)
                autoLogin: !group.loginCaseId && loginCred ? loginCred : undefined,
                defaultWebOrigin: groupWebOrigin ?? null,
                liveView: live,
                loginCaseRunner: async (cid, ctx, browser) => {
                  // Write plan_run_cases (step_kind=login_prepare, status=running)
                  const ins = await db
                    .insert(planRunCases)
                    .values({ planRunId, caseId: cid, order: 0, status: 'running', stepKind: 'login_prepare', ...groupMeta })
                    .returning();
                  const row = ins[0]!;
                  publish(planRunId, { type: 'plan_run_login', caseId: cid, stepKind: 'login_prepare', status: 'running' });
                  const loginT0 = Date.now();
                  try {
                    // Run the login case in the caller-held chromium + ctx: after login the ctx genuinely carries cookies,
                    // and the storageState exported from the same ctx feeds the subsequent business cases. If the login case fails or throws, takeOwnership isn't set,
                    // letting loginPrepare close the browser in its finally.
                    const r = await runCase(cid, {
                      ...(groupEnv ? { envOverride: { envId: groupEnv.envId } } : {}),
                      // Login-case row override three states: null→undefined→fall back to case-level; [] passed as-is→all rows; non-empty→subset
                      datasetRowIndexes: group.loginDatasetRowIndexes ?? undefined,
                      ownedBrowser: browser,
                      ownedContext: ctx,
                      liveView: live,
                      createdByUserId: run.triggeredByUserId,
                      planProjectId: plan.projectId,
                      // Abort checkpoint: the step loop/AI turns poll the cancel flag and stop on hit (the login case is stoppable too).
                      shouldAbort: () => isCancelRequested(planRunId),
                      // Same as business cases: backfill report_id as soon as the report row is persisted, so the frontend sees login steps progress during execution.
                      onReportCreated: makeReportLinker(row.id),
                    });
                    await db
                      .update(planRunCases)
                      .set({
                        status: r.status,
                        reportId: r.reportId,
                        finishedAt: new Date(),
                        durationMs: Date.now() - loginT0,
                        error: r.status === 'failed' ? 'login case failed' : null,
                      })
                      .where(eq(planRunCases.id, row.id));
                    if (r.status !== 'passed') {
                      publish(planRunId, { type: 'plan_run_case_complete', caseId: cid, stepKind: 'login_prepare', status: 'failed', reportId: r.reportId });
                      return { passed: false, storageState: undefined };
                    }
                    publish(planRunId, { type: 'plan_run_case_complete', caseId: cid, stepKind: 'login_prepare', status: 'passed', reportId: r.reportId });
                    // Export the real storageState from the ctx the login case ran in; the browser is closed uniformly at the end of the group loop.
                    loginBrowser = browser;
                    loginCtx = ctx;
                    return { passed: true, storageState: await ctx.storageState(), takeOwnership: true };
                  } catch (e) {
                    await db
                      .update(planRunCases)
                      .set({ status: 'failed', finishedAt: new Date(), durationMs: Date.now() - loginT0, error: e instanceof Error ? e.message : String(e) })
                      .where(eq(planRunCases.id, row.id));
                    return { passed: false, storageState: undefined };
                  }
                },
              },
            );
            if (result.status === 'skipped') {
              logger.info(
                { planRunId, planId: plan.id, group: group.name, reason: result.reason },
                'group login prepare skipped',
              );
            }
            if (result.status === 'failed') {
              loginPrepareFailed = true;
              logger.warn(
                { planRunId, planId: plan.id, group: group.name, reason: result.reason },
                'group login prepare failed; group cases will be skipped',
              );
            } else if (result.storageState) {
              loginState = result.storageState;
              prevLogin = { signature: sig, storageState: result.storageState };
            }
          }
        }

        // —— In-group business cases run serially ——
        let groupFailed = false;
        if (loginPrepareFailed) {
          // Login preparation failed → all of this group's business cases are skipped, proceed to the group boundary evaluation
          for (let j = 0; j < gCases.length; j++) {
            await db.insert(planRunCases).values({
              planRunId,
              caseId: gCases[j]!.caseId,
              order: j + 1,
              status: 'skipped',
              stepKind: 'business',
              error: 'login prepare failed',
              ...groupMeta,
            });
          }
          skipped += gCases.length;
          groupFailed = true;
          anyLoginFailure = true;
        } else {
          for (let i = 0; i < gCases.length; i++) {
            if (await isCancelRequested(planRunId)) {
              for (let j = i; j < gCases.length; j++) {
                await db.insert(planRunCases).values({
                  planRunId,
                  caseId: gCases[j]!.caseId,
                  order: j + 1,
                  status: 'skipped',
                  stepKind: 'business',
                  error: 'cancelled',
                  ...groupMeta,
                });
              }
              skipped += gCases.length - i;
              break;
            }
            const c = gCases[i]!;
            if (c.status === 'deprecated') {
              await db.insert(planRunCases).values({
                planRunId,
                caseId: c.caseId,
                order: i + 1,
                status: 'skipped',
                stepKind: 'business',
                finishedAt: new Date(),
                durationMs: 0,
                error: 'case deprecated',
                ...groupMeta,
              });
              publish(planRunId, { type: 'plan_run_case_complete', caseId: c.caseId, stepKind: 'business', status: 'skipped' });
              skipped += 1;
              continue;
            }
            if (c.platform === 'mobile') continue; // mobile cases don't get the group-level web storageState injected; runCase routes them to MobileEngine below
            const ins = await db
              .insert(planRunCases)
              .values({ planRunId, caseId: c.caseId, order: i + 1, status: 'running', stepKind: 'business', ...groupMeta })
              .returning();
            publish(planRunId, { type: 'plan_run_case_start', caseId: c.caseId, stepKind: 'business', status: 'running' });
            const t0 = Date.now();
            try {
              const r = await runCase(c.caseId, {
                storageState: loginState,
                forceFail: forceFailIds.has(c.caseId),
                ...(groupEnv ? { envOverride: { envId: groupEnv.envId } } : {}),
                targetOverride: group.targetConfig ?? null,
                // Plan-level row override: null→undefined→fall back to case-level; [] passed as-is→all rows (overriding case-level subsets); non-empty→subset
                datasetRowIndexes: c.datasetRowIndexes ?? undefined,
                liveView: live,
                createdByUserId: run.triggeredByUserId,
                planProjectId: plan.projectId,
                // Abort checkpoint: the step loop/AI turns poll the cancel flag and stop on hit, no longer waiting for the whole case to finish.
                shouldAbort: () => isCancelRequested(planRunId),
                onReportCreated: makeReportLinker(ins[0]!.id),
              });
              await db
                .update(planRunCases)
                .set({
                  status: r.status,
                  reportId: r.reportId,
                  ...(r.reportIds ? { reportIds: r.reportIds } : {}),
                  finishedAt: new Date(),
                  durationMs: Date.now() - t0,
                  error: r.status === 'failed' ? 'case failed' : null,
                })
                .where(eq(planRunCases.id, ins[0]!.id));
              publish(planRunId, { type: 'plan_run_case_complete', caseId: c.caseId, stepKind: 'business', status: r.status, reportId: r.reportId });
              if (r.status === 'passed') passed += 1;
              else {
                failed += 1;
                groupFailed = true;
                // In-group fail_fast: only the rest of this group is skipped (plan-level strategy is evaluated at group boundaries, not interrupting the current group)
                if (group.failFast) {
                  for (let j = i + 1; j < gCases.length; j++) {
                    await db.insert(planRunCases).values({
                      planRunId,
                      caseId: gCases[j]!.caseId,
                      order: j + 1,
                      status: 'skipped',
                      stepKind: 'business',
                      error: 'skipped: group fail_fast',
                      ...groupMeta,
                    });
                  }
                  skipped += gCases.length - i - 1;
                  break;
                }
              }
            } catch (e) {
              await db
                .update(planRunCases)
                .set({ status: 'failed', finishedAt: new Date(), durationMs: Date.now() - t0, error: e instanceof Error ? e.message : String(e) })
                .where(eq(planRunCases.id, ins[0]!.id));
              failed += 1;
              groupFailed = true;
              publish(planRunId, { type: 'plan_run_case_complete', caseId: c.caseId, stepKind: 'business', status: 'failed' });
              if (group.failFast) {
                for (let j = i + 1; j < gCases.length; j++) {
                  await db.insert(planRunCases).values({
                    planRunId,
                    caseId: gCases[j]!.caseId,
                    order: j + 1,
                    status: 'skipped',
                    stepKind: 'business',
                    error: 'skipped: group fail_fast',
                    ...groupMeta,
                  });
                }
                skipped += gCases.length - i - 1;
                break;
              }
            }
          }
        }

        // Group boundary evaluation: any case failed || login preparation failed → this group counts as failed; on plan fail_fast, subsequent groups are skipped whole
        if (groupFailed && run.strategy === 'fail_fast') {
          abortedByPlanStrategy = true;
        }
      } finally {
        // Group-level login browser (after loginPrepare takes ownership, this loop closes it): dropped on group switch, the exception path closes it too,
        // ensuring no chromium leftover processes.
        if (loginCtx) await loginCtx.close().catch(() => undefined);
        if (loginBrowser) await loginBrowser.close().catch(() => undefined);
      }
    }

    const finalStatus = (await isCancelRequested(planRunId)) ? 'cancelled' : failed > 0 || anyLoginFailure ? 'failed' : 'passed';
    const finalSummary = st(lang, 'planRun.summary', { passed, failed, skipped });
    await finalizeRun(planRunId, finalStatus, { passed, failed, skipped, summary: finalSummary });
    publish(planRunId, { type: 'plan_run_complete', status: finalStatus, summary: finalSummary });
    // RCA: with the switch on and business failures present → enqueue root-cause analysis (async, doesn't block the run's finish; dynamic import prevents a cycle)
    try {
      const { enqueueRcaForPlanRun } = await import('../scheduler/rcaQueue.js');
      void enqueueRcaForPlanRun(planRunId).catch((e) => logger.warn({ err: e, planRunId }, 'rca enqueue failed'));
    } catch { /* queue module load failure doesn't affect the run's finish */ }
    runState.delete(planRunId);
  } finally {
    live.close();
  }
}

async function finalizeRun(
  planRunId: string,
  status: 'passed' | 'failed' | 'cancelled',
  counts: { passed: number; failed: number; skipped: number; summary: string },
) {
  const finishedAt = new Date();
  const startedAt = (await db.select({ s: planRuns.startedAt }).from(planRuns).where(eq(planRuns.id, planRunId)))[0]?.s ?? finishedAt;
  await db
    .update(planRuns)
    .set({
      status,
      finishedAt,
      durationMs: finishedAt.getTime() - new Date(startedAt).getTime(),
      passedCases: counts.passed,
      failedCases: counts.failed,
      skippedCases: counts.skipped,
      summary: counts.summary,
    })
    .where(eq(planRuns.id, planRunId));
}
