import { eq, and, asc } from 'drizzle-orm';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import {
  executionPlans,
  planCases,
  planRuns,
  planRunCases,
  testCases,
} from '../db/schema.js';
import { runCase } from './runCase.js';
import { loginPrepare } from './loginPrepare.js';
import { publishRunEvent, subscribeRunEvent } from '../sse/planRunBus.js';
import { HttpError } from '../middleware/errorHandler.js';
import { registerLiveView } from './liveView.js';

/** 单 planRun 的运行控制器：内存中保存 storageState 与 cancelRequested。 */
const runState = new Map<string, { cancelRequested: boolean; storageState?: unknown }>();

export function requestCancel(planRunId: string): void {
  const s = runState.get(planRunId);
  if (s) s.cancelRequested = true;
}

export function isCancelRequested(planRunId: string): boolean {
  return runState.get(planRunId)?.cancelRequested ?? false;
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

export function subscribeRun(runId: string, res: import('express').Response): () => void {
  return subscribeRunEvent(runId, res);
}

function publish(runId: string, evt: StepEvent) {
  publishRunEvent(runId, evt);
}

/** 登录准备与 incognito 互斥：返回该 plan 下开启 incognito 的 caseId 列表。 */
export async function findIncognitoCaseIds(planId: string): Promise<string[]> {
  const rows = await db
    .select({ id: testCases.id })
    .from(testCases)
    .innerJoin(planCases, eq(planCases.caseId, testCases.id))
    .where(and(eq(planCases.planId, planId), eq(testCases.incognito, true)));
  return rows.map((r) => r.id);
}

/** 启动一次计划执行（异步）。调用方立即返回 planRunId。 */
export async function runPlanAsync(input: RunPlanInput): Promise<void> {
  const { planRunId } = input;
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, planRunId)))[0];
  if (!run) return;
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, run.planId)))[0];
  if (!plan) return;

  runState.set(planRunId, { cancelRequested: false });
  // playground 实时画面：整个计划运行一个画面源，逐用例 setPage 跟随（含登录准备/登录用例共用浏览器）。
  const live = registerLiveView(`planrun:${planRunId}`);

  const cases = await db
    .select({ caseId: planCases.caseId, order: planCases.order, status: testCases.status, platform: testCases.platform })
    .from(planCases)
    .innerJoin(testCases, eq(testCases.id, planCases.caseId))
    .where(eq(planCases.planId, plan.id))
    .orderBy(asc(planCases.order));

  await db.update(planRuns).set({ totalCases: cases.length, startedAt: new Date() }).where(eq(planRuns.id, planRunId));

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // Plan-level env override: validate the env exists & belongs to the plan's project (no 500 on mismatch —
  // fall back to per-case defaultEnv). The ctx is closed immediately — per-case runCase will re-resolve
  // the same envId to obtain a fresh pg.Pool when it actually needs one.
  let planEnv: { envId: string } | undefined;
  let loginCred: import('./envContext.js').LoginCtx | undefined;
  if (plan.environmentId) {
    try {
      const { resolveEnv } = await import('./envContext.js');
      const ctx = await resolveEnv(
        { planEnvId: plan.environmentId },
        { expectedProjectId: plan.projectId },
      );
      planEnv = { envId: ctx.envId };
      loginCred = ctx.login;
      await ctx.close();
    } catch (e) {
      logger.warn(
        { err: e, planId: plan.id },
        'plan env resolve failed; cases will use their own defaultEnv',
      );
      planEnv = undefined;
    }
  }

  // 登录准备
  let loginBrowser: import('playwright-core').Browser | undefined;
  let loginCtx: import('playwright-core').BrowserContext | undefined;
  try {
  if (run.loginPrepareEnabled) {
    const incognitoIds = await findIncognitoCaseIds(plan.id);
    if (incognitoIds.length > 0) {
      await finalizeRun(planRunId, 'failed', {
        passed: 0, failed: 0, skipped: cases.length,
        summary: `incognito 模式与登录准备互斥：${incognitoIds.join(',')}`,
      });
      publish(planRunId, { type: 'plan_run_complete', status: 'failed', summary: 'incognito × loginPrepare 互斥' });
      runState.delete(planRunId);
      return;
    }
    const loginCaseId = run.loginCaseId;
    const firstMobile = cases.find((c) => c.status !== 'deprecated' && c.platform === 'mobile');
    if (firstMobile) {
      throw new HttpError(422, 'login_prepare_skips_mobile', '登录准备仅对 web 业务用例生效；mobile case 不参与,请关闭 loginPrepare 或移除 mobile case');
    }
    const firstCaseId = cases.find((c) => c.status !== 'deprecated')?.caseId ?? null;
    const result = await loginPrepare(
      {
        enabled: true,
        caseId: loginCaseId,
        detectionUrl: run.detectionUrl,
        successSelector: run.loginSuccessSelector,
        unauthorizedKeywords: run.loginUnauthorizedKeywords as string[] | null,
        firstCaseId,
      },
      {
        // 未配登录用例且环境配置了登录凭据时，走自动填表登录（探测/填表页纳入实时画面）
        autoLogin: !loginCaseId && loginCred ? loginCred : undefined,
        liveView: live,
        loginCaseRunner: async (cid, ctx, browser) => {
          // 写入 plan_run_cases（step_kind=login_prepare, status=running）
          const ins = await db
            .insert(planRunCases)
            .values({ planRunId, caseId: cid, order: 0, status: 'running', stepKind: 'login_prepare' })
            .returning();
          const row = ins[0]!;
          publish(planRunId, { type: 'plan_run_login', caseId: cid, stepKind: 'login_prepare', status: 'running' });
          const loginT0 = Date.now();
          try {
            // 在 caller 持有的 chromium + ctx 中跑登录用例：登录后该 ctx 真实携带 cookie，
            // 从同一 ctx 导出 storageState 喂给后续业务用例。如果登录用例失败或抛错，takeOwnership 不设，
            // 让 loginPrepare 走 finally 关 browser。
            const r = await runCase(cid, {
              ...(planEnv ? { envOverride: { envId: planEnv.envId } } : {}),
              ownedBrowser: browser,
              ownedContext: ctx,
              liveView: live,
              createdByUserId: run.triggeredByUserId,
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
            // 从登录用例跑过的 ctx 导出真实 storageState；caller take ownership 后业务用例循环会关 browser。
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
    if (result.status === 'failed') {
      await finalizeRun(planRunId, 'failed', { passed, failed, skipped: cases.length, summary: `登录准备失败：${result.reason ?? 'unknown'}` });
      publish(planRunId, { type: 'plan_run_complete', status: 'failed', summary: '登录准备失败' });
      runState.delete(planRunId);
      return;
    }
    // 把登录准备产出的 storageState 缓存到内存中，供业务用例注入 context。
    if (result.storageState) {
      runState.get(planRunId)!.storageState = result.storageState;
    }
  }

  // 业务用例串行执行
  const loginState = runState.get(planRunId)?.storageState;
  // 测试钩子：FORCE_FAIL_CASE_IDS=uuid1,uuid2 让对应 caseId 强制失败，便于 fail_fast/cancel 测试。
  const forceFailIds = new Set(
    (process.env.FORCE_FAIL_CASE_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  for (let i = 0; i < cases.length; i++) {
    if (isCancelRequested(planRunId)) {
      const remaining = cases.length - i;
      for (let j = i; j < cases.length; j++) {
        await db.insert(planRunCases).values({
          planRunId,
          caseId: cases[j]!.caseId,
          order: j + 1,
          status: 'skipped',
          stepKind: 'business',
        });
      }
      skipped += remaining;
      break;
    }
    const c = cases[i]!;
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
      });
      publish(planRunId, { type: 'plan_run_case_complete', caseId: c.caseId, stepKind: 'business', status: 'skipped' });
      skipped += 1;
      continue;
    }
    if (c.platform === 'mobile') continue; // mobile case 不走 loginPrepare 注入的 web storageState；后续由 runCase 路由到 MobileEngine
    const ins = await db
      .insert(planRunCases)
      .values({ planRunId, caseId: c.caseId, order: i + 1, status: 'running', stepKind: 'business' })
      .returning();
    publish(planRunId, { type: 'plan_run_case_start', caseId: c.caseId, stepKind: 'business', status: 'running' });
    const t0 = Date.now();
    try {
      const r = await runCase(c.caseId, {
        storageState: loginState,
        forceFail: forceFailIds.has(c.caseId),
        ...(planEnv ? { envOverride: { envId: planEnv.envId } } : {}),
        liveView: live,
        createdByUserId: run.triggeredByUserId,
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
        if (run.strategy === 'fail_fast') {
          for (let j = i + 1; j < cases.length; j++) {
            await db.insert(planRunCases).values({
              planRunId,
              caseId: cases[j]!.caseId,
              order: j + 1,
              status: 'skipped',
              stepKind: 'business',
            });
          }
          skipped += cases.length - i - 1;
          break;
        }
      }
    } catch (e) {
      await db
        .update(planRunCases)
        .set({ status: 'failed', finishedAt: new Date(), durationMs: Date.now() - t0, error: e instanceof Error ? e.message : String(e) })
        .where(eq(planRunCases.id, ins[0]!.id));
      failed += 1;
      publish(planRunId, { type: 'plan_run_case_complete', caseId: c.caseId, stepKind: 'business', status: 'failed' });
      if (run.strategy === 'fail_fast') {
        for (let j = i + 1; j < cases.length; j++) {
          await db.insert(planRunCases).values({
            planRunId,
            caseId: cases[j]!.caseId,
            order: j + 1,
            status: 'skipped',
            stepKind: 'business',
          });
        }
        skipped += cases.length - i - 1;
        break;
      }
    }
  }

  const finalStatus = isCancelRequested(planRunId) ? 'cancelled' : failed > 0 ? 'failed' : 'passed';
  await finalizeRun(planRunId, finalStatus, { passed, failed, skipped, summary: `${passed} 通过 / ${failed} 失败 / ${skipped} 跳过` });
  publish(planRunId, { type: 'plan_run_complete', status: finalStatus, summary: `${passed} 通过 / ${failed} 失败 / ${skipped} 跳过` });
  runState.delete(planRunId);
  } finally {
    // 登录准备 take ownership 后由本函数负责关浏览器+context；异常路径（登录 prepare 失败早返回）
    // 也会走到这里，确保不留 chromium 残留进程。
    if (loginCtx) await loginCtx.close().catch(() => undefined);
    if (loginBrowser) await loginBrowser.close().catch(() => undefined);
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