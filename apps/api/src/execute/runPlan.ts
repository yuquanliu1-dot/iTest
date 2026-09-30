import { eq, asc } from 'drizzle-orm';
import { chromium, type BrowserContext } from 'playwright-core';
import { db } from '../db/client.js';
import {
  executionPlans,
  planCases,
  planRuns,
  planRunCases,
  testCases,
  reports,
} from '../db/schema.js';
import { runCase } from './runCase.js';
import { loginPrepare } from './loginPrepare.js';
import { publishRunEvent, subscribeRunEvent } from '../sse/planRunBus.js';
import { logger } from '../logger.js';

const STATUS = {
  RUNNING: 'running',
  PASSED: 'passed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

/** 单 planRun 的运行控制器：内存中保存 cancelRequested。 */
const runState = new Map<string, { cancelRequested: boolean }>();

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

/** 启动一次计划执行（异步）。调用方立即返回 planRunId。 */
export async function runPlanAsync(input: RunPlanInput): Promise<void> {
  const { planRunId } = input;
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, planRunId)))[0];
  if (!run) return;
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, run.planId)))[0];
  if (!plan) return;

  runState.set(planRunId, { cancelRequested: false });

  const cases = await db
    .select({ caseId: planCases.caseId, order: planCases.order })
    .from(planCases)
    .where(eq(planCases.planId, plan.id))
    .orderBy(asc(planCases.order));

  await db.update(planRuns).set({ totalCases: cases.length, startedAt: new Date() }).where(eq(planRuns.id, planRunId));

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // 登录准备
  if (run.loginPrepareEnabled) {
    const loginCaseId = run.loginCaseId;
    const firstCaseId = cases[0]?.caseId ?? null;
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
        loginCaseRunner: async (cid, _ctx) => {
          // 写入 plan_run_cases（step_kind=login_prepare, status=running）
          const ins = await db
            .insert(planRunCases)
            .values({ planRunId, caseId: cid, order: 0, status: 'running', stepKind: 'login_prepare' })
            .returning();
          const row = ins[0]!;
          publish(planRunId, { type: 'plan_run_login', caseId: cid, stepKind: 'login_prepare', status: 'running' });
          try {
            const r = await runCase(cid);
            await db
              .update(planRunCases)
              .set({
                status: r.status,
                reportId: r.reportId,
                finishedAt: new Date(),
                durationMs: 0,
                error: r.status === 'failed' ? 'login case failed' : null,
              })
              .where(eq(planRunCases.id, row.id));
            if (r.status !== 'passed') {
              publish(planRunId, { type: 'plan_run_case_complete', caseId: cid, stepKind: 'login_prepare', status: 'failed', reportId: r.reportId });
              return { passed: false, storageState: undefined };
            }
            publish(planRunId, { type: 'plan_run_case_complete', caseId: cid, stepKind: 'login_prepare', status: 'passed', reportId: r.reportId });
            // 简化：登录成功后从新启的 browser 中导出 storageState
            const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
            try {
              const ctx = await browser.newContext();
              return { passed: true, storageState: await ctx.storageState() };
            } finally {
              await browser.close().catch(() => undefined);
            }
          } catch (e) {
            await db
              .update(planRunCases)
              .set({ status: 'failed', finishedAt: new Date(), error: e instanceof Error ? e.message : String(e) })
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
  }

  // 业务用例串行执行
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
    const ins = await db
      .insert(planRunCases)
      .values({ planRunId, caseId: c.caseId, order: i + 1, status: 'running', stepKind: 'business' })
      .returning();
    publish(planRunId, { type: 'plan_run_case_start', caseId: c.caseId, stepKind: 'business', status: 'running' });
    try {
      const r = await runCase(c.caseId);
      await db
        .update(planRunCases)
        .set({ status: r.status, reportId: r.reportId, finishedAt: new Date(), error: r.status === 'failed' ? 'case failed' : null })
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
        .set({ status: 'failed', finishedAt: new Date(), error: e instanceof Error ? e.message : String(e) })
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