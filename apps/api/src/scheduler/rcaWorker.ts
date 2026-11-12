/**
 * RCA worker: consumes the rca queue. Each planRun gets one purpose='rca' assistant thread, injected with the failed
 * case list; the AI classifies/gathers evidence case by case per the defect-rca skill, persisting via save_rca_result.
 * Timeout guard: runWithTimeout overall timeout → steer wrap-up → grace → abort; finally as fallback writes the timeout rows.
 * Crash recovery: process death never reaches finally; at startup sweepStaleRcaRuns back-marks leftover rows by thread age.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import { aiThreads, executionPlans, planRunCases, planRuns, reports, testCases } from '../db/schema.js';
import { cancelThread, ensureSpaceRecord, sendSpaceUserMessage } from '../pi/space/session.js';
import { buildRcaWorker, type RcaJob } from './rcaQueue.js';
import { cache } from '../lib/cache.js';
import { planRunDetailKey } from '../lib/cache-keys.js';

interface FailedCaseItem {
  planRunCaseId: string;
  caseId: string;
  caseTitle: string;
  reportId: string | null;
  error: string | null;
  failedSteps: Array<{ order: number; failureReason: string | null; humanMessage: string | null; error: string | null }>;
}

/** Task-list prompt: the defect-rca skill's workflow lives on the skill side; here we only provide the list and hard requirements. */
export function buildTaskPrompt(planName: string, runId: string, items: FailedCaseItem[]): string {
  const list = items.map((it, i) => {
    const steps = it.failedSteps.length
      ? it.failedSteps.map((s) => `第${s.order}步[${s.failureReason ?? '?'}] ${s.humanMessage ?? s.error ?? ''}`).join('；')
      : '（步骤数据缺失，用 query_stats 的 report_detail 补取）';
    return [
      `${i + 1}. ${it.caseTitle}`,
      `   - planRunCaseId: ${it.planRunCaseId}`,
      `   - caseId: ${it.caseId}`,
      `   - reportId: ${it.reportId ?? '无'}`,
      `   - 运行级 error: ${it.error ?? '无'}`,
      `   - 失败步骤摘要: ${steps}`,
    ].join('\n');
  }).join('\n');
  return [
    `本次计划运行「${planName}」（run ${runId.slice(0, 8)}）已结束，共 ${items.length} 个失败用例需要做根因分析。请加载 defect-rca skill 并严格按其工作流逐个处理。`,
    '',
    '## 失败用例清单',
    list,
    '',
    '## 硬性要求',
    '1. 每个用例先分类（system_defect / case_issue / environment / other），再决定是否深挖；',
    '2. 系统缺陷必须结合代码仓（./repo）取证到 file:line，代码仓未就绪就先做其它用例、稍后重试；',
    '3. 每个用例恰好调用一次 save_rca_result（planRunCaseId 用清单里的原值）；',
    '4. 全部处理完后发一条结案总结：各类数量 + 关键发现，不超过 10 行。',
  ].join('\n');
}

/** Collects all failed business cases of this run + the first report's failed-step summary (error truncated to 500 chars to keep the list from exploding). */
async function collectFailedCases(planRunId: string): Promise<FailedCaseItem[]> {
  const rows = await db
    .select({
      id: planRunCases.id,
      caseId: planRunCases.caseId,
      reportId: planRunCases.reportId,
      reportIds: planRunCases.reportIds,
      error: planRunCases.error,
      title: testCases.title,
    })
    .from(planRunCases)
    .leftJoin(testCases, eq(testCases.id, planRunCases.caseId))
    .where(and(eq(planRunCases.planRunId, planRunId), eq(planRunCases.status, 'failed'), eq(planRunCases.stepKind, 'business')));
  const out: FailedCaseItem[] = [];
  for (const r of rows) {
    const firstReport = r.reportId ?? (Array.isArray(r.reportIds) ? r.reportIds.find((id) => !!id) ?? null : null);
    let failedSteps: FailedCaseItem['failedSteps'] = [];
    if (firstReport) {
      const rep = (await db.select({ stepResults: reports.stepResults }).from(reports).where(eq(reports.id, firstReport)).limit(1))[0];
      const steps = Array.isArray(rep?.stepResults) ? (rep!.stepResults as Array<Record<string, unknown>>) : [];
      failedSteps = steps
        .filter((s) => s.status === 'failed')
        .map((s) => ({
          order: Number(s.order ?? 0),
          failureReason: (s.failureReason as string) ?? null,
          humanMessage: (s.humanMessage as string) ?? null,
          error: typeof s.error === 'string' && s.error.length > 500 ? `${s.error.slice(0, 500)}…` : (s.error as string) ?? null,
        }));
    }
    out.push({ planRunCaseId: r.id, caseId: r.caseId, caseTitle: r.title ?? '未知用例', reportId: firstReport, error: r.error, failedSteps });
  }
  return out;
}

/** Guard order: run switch → plan.versionId (no version = no assistant space) → thread dedup (idempotency) → failed list non-empty.
 *  The thread row is inserted first; session creation / first-message failure only logs without deleting the row; the failed list gets back-marked timeout via fillTimeoutRows. */
export async function processRcaJob(data: RcaJob): Promise<void> {
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, data.planRunId)).limit(1))[0];
  if (!run || !run.rcaEnabled || (run.failedCases ?? 0) <= 0) return;
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, run.planId)).limit(1))[0];
  if (!plan?.versionId) return; // no version → no assistant space
  const dup = await db.select({ id: aiThreads.id }).from(aiThreads)
    .where(and(eq(aiThreads.purpose, 'rca'), eq(aiThreads.planRunId, run.id))).limit(1);
  if (dup.length > 0) return; // idempotency: this run already has an analysis thread
  const failed = await collectFailedCases(run.id);
  if (failed.length === 0) return;

  const threadId = randomUUID();
  let outcome: 'done' | 'timeout' | 'error' = 'done';
  await db.insert(aiThreads).values({
    id: threadId,
    kind: 'version',
    versionId: plan.versionId,
    purpose: 'rca',
    planRunId: run.id,
    title: `根因分析 · ${plan.name} · run#${run.id.slice(0, 8)}`,
    piThreadId: '', // createSpaceSessionFactory backfills sessionFile once the session is up
    createdByUserId: run.triggeredByUserId,
  });
  try {
    await ensureSpaceRecord(threadId);
    await runWithTimeout(threadId, () => sendSpaceUserMessage(threadId, buildTaskPrompt(plan.name, run.id, failed)));
  } catch (e) {
    outcome = 'error';
    logger.error({ err: e, planRunId: run.id, threadId }, 'rca session failed');
  } finally {
    await fillTimeoutRows(run.id, threadId, outcome);
  }
}

/** Fallback marking: batch-writes status on this run's failed business rows that still have no rca (isNull(rca) guarantees not overwriting conclusions the AI already persisted).
 *  outcome decides the wording — done (session ended normally but missed persisting) / timeout / error (session crashed mid-run). */
async function fillTimeoutRows(
  planRunId: string,
  threadId: string,
  outcome: 'done' | 'timeout' | 'error' = 'timeout',
): Promise<number> {
  const summary = outcome === 'done' ? '分析会话结束仍未落库'
    : outcome === 'error' ? '分析会话异常中断' : '分析超时未完成';
  const rows = await db.update(planRunCases).set({
    rca: { status: 'timeout', summary, analyzedAt: new Date().toISOString(), threadId },
  }).where(and(
    eq(planRunCases.planRunId, planRunId),
    eq(planRunCases.status, 'failed'),
    eq(planRunCases.stepKind, 'business'),
    isNull(planRunCases.rca),
  )).returning({ id: planRunCases.id });
  if (rows.length > 0) {
    // The terminal run-detail cache carries cases[].rca; it must be invalidated once rca is persisted, or the frontend won't see conclusions for up to 5min
    await cache.del(planRunDetailKey(planRunId));
  }
  return rows.length;
}

// Timeout constants and runWithTimeout: overall timeout defaults to 30min; on expiry steer wrap-up first, grace defaults to 3min then abort.
// Tunable via env (RCA_TIMEOUT_MS / RCA_GRACE_MS); Task 6's timeout tests set them to 200ms to drive it.
const RCA_TIMEOUT_MS = Number(process.env.RCA_TIMEOUT_MS) || 30 * 60_000;
const RCA_GRACE_MS = Number(process.env.RCA_GRACE_MS) || 3 * 60_000;

async function runWithTimeout(threadId: string, fn: () => Promise<void>): Promise<'done' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutP = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), RCA_TIMEOUT_MS); });
    const r = await Promise.race([fn().then(() => 'done' as const), timeoutP]);
    if (r === 'done') return 'done';
    logger.warn({ threadId }, 'rca timeout; steering wrap-up');
    try {
      await Promise.race([
        sendSpaceUserMessage(threadId, '整体分析已超时：立即停止取证，把已完成结论逐一 save_rca_result 落库并发一句结案总结；未分析的不用补。', 'steer'),
        new Promise((resolve) => { timer = setTimeout(resolve, RCA_GRACE_MS); }),
      ]);
    } catch { /* steer failure is treated as timeout */ }
    cancelThread(threadId);
    return 'timeout';
  } finally {
    // Covers the fn-throws/early-return paths, leaving no 30min dangling timer
    if (timer) clearTimeout(timer);
  }
}

/**
 * Crash-recovery sweep: on process death finally never runs, so pre-crash run failure rows hang with rca=NULL forever.
 * A session's max lifetime is RCA_TIMEOUT_MS + RCA_GRACE_MS; adding a 5min margin still lands before that moment, so such rca threads
 * are necessarily dead — back-mark them timeout. Younger threads may be another replica's live analysis (multi-replica prod), never touch them.
 */
export async function sweepStaleRcaRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - (RCA_TIMEOUT_MS + RCA_GRACE_MS + 5 * 60_000));
  const dead = await db.select({ id: aiThreads.id, planRunId: aiThreads.planRunId }).from(aiThreads)
    .where(and(eq(aiThreads.purpose, 'rca'), lt(aiThreads.createdAt, cutoff)));
  let filled = 0;
  for (const t of dead) {
    if (!t.planRunId) continue;
    filled += await fillTimeoutRows(t.planRunId, t.id, 'timeout');
  }
  if (filled > 0) logger.warn({ filled, cutoff: cutoff.toISOString() }, 'rca crash-recovery sweep filled stale rows');
  return filled;
}

let _worker: Worker<RcaJob> | null = null;

/** Called at API process startup. Runs the crash-recovery sweep first (including inline mode without redis), then decides whether to build a worker based on REDIS_URL. */
export async function startRcaWorker(): Promise<void> {
  try {
    await sweepStaleRcaRuns();
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'rca crash-recovery sweep failed');
  }
  if (!process.env.REDIS_URL) {
    logger.warn('REDIS_URL not set; rca queue disabled (inline analysis)');
    return;
  }
  try {
    _worker = buildRcaWorker(processRcaJob);
    _worker.on('ready', () => logger.info('rca worker ready'));
    _worker.on('error', (err) => logger.warn({ err: err.message }, 'rca worker error'));
    _worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err: err.message }, 'rca job failed'));
    logger.info('rca worker started');
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'rca worker init failed; continuing inline');
    _worker = null;
    return;
  }
  registerShutdown();
}

let _shutdownRegistered = false;
function registerShutdown(): void {
  if (_shutdownRegistered) return;
  _shutdownRegistered = true;
  const stop = async (sig: string) => {
    if (!_worker) return;
    logger.info({ sig }, 'shutting down rca worker');
    try { await _worker.close(); } catch (e) { logger.warn({ err: (e as Error).message }, 'rca worker close failed'); }
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}
