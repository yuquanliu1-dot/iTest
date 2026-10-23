/**
 * RCA worker:消费 rca 队列。每个 planRun 建一个 purpose='rca' 的助手线程,注入失败
 * 用例清单,AI 按 defect-rca skill 逐用例分类/取证,经 save_rca_result 落库。
 * 超时护栏:runWithTimeout 整体超时 → steer 收尾 → 宽限 → abort;finally 兜底写 timeout 行。
 * 崩溃恢复:进程死亡走不到 finally,启动时 sweepStaleRcaRuns 按线程年龄补标残留行。
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import { aiThreads, executionPlans, planRunCases, planRuns, reports, testCases } from '../db/schema.js';
import { cancelThread, ensureSpaceRecord, sendSpaceUserMessage } from '../pi/space/session.js';
import { buildRcaWorker, type RcaJob } from './rcaQueue.js';

interface FailedCaseItem {
  planRunCaseId: string;
  caseId: string;
  caseTitle: string;
  reportId: string | null;
  error: string | null;
  failedSteps: Array<{ order: number; failureReason: string | null; humanMessage: string | null; error: string | null }>;
}

/** 任务清单 prompt：defect-rca skill 的工作流由 skill 侧承载,这里只给清单与硬性要求。 */
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

/** 汇集本 run 全部失败业务用例 + 首个报告的失败步骤摘要（error 截 500 字防爆清单）。 */
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

/** 守卫顺序:run 开关 → plan.versionId(无版本=无助手空间) → 线程查重(幂等) → 失败清单非空。
 *  线程行先插入;会话创建/首发消息失败只记日志不删行,失败清单经 fillTimeoutRows 兜底标 timeout。 */
export async function processRcaJob(data: RcaJob): Promise<void> {
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, data.planRunId)).limit(1))[0];
  if (!run || !run.rcaEnabled || (run.failedCases ?? 0) <= 0) return;
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, run.planId)).limit(1))[0];
  if (!plan?.versionId) return; // 无版本 → 无助手空间
  const dup = await db.select({ id: aiThreads.id }).from(aiThreads)
    .where(and(eq(aiThreads.purpose, 'rca'), eq(aiThreads.planRunId, run.id))).limit(1);
  if (dup.length > 0) return; // 幂等：本 run 已有分析线程
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
    piThreadId: '', // 会话起好后 createSpaceSessionFactory 回填 sessionFile
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

/** 兜底标行为:本 run 仍未落 rca 的失败业务行批量写 status(isNull(rca) 保证不覆盖 AI 已落结论)。
 *  outcome 决定文案——done(会话正常结束但漏落)/timeout(超时)/error(会话异常中断)。 */
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
  return rows.length;
}

// 超时常量与 runWithTimeout:整体超时默认 30min,到点先 steer 收尾,宽限默认 3min 后 abort。
// env 可调(RCA_TIMEOUT_MS / RCA_GRACE_MS),Task 6 的超时测试会设成 200ms 驱动。
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
    } catch { /* steer 失败按超时处理 */ }
    cancelThread(threadId);
    return 'timeout';
  } finally {
    // 覆盖 fn 抛错/提前返回的路径,不留 30min 悬挂定时器
    if (timer) clearTimeout(timer);
  }
}

/**
 * 崩溃恢复扫补:进程死亡时 finally 不会执行,崩溃前的 run 失败行会永远悬着 rca=NULL。
 * 现场存活上限是 RCA_TIMEOUT_MS + RCA_GRACE_MS,再加 5min 余量仍早于该时刻的 rca 线程
 * 必然已死——补标 timeout。年轻线程可能是另一副本的活分析(生产多副本),绝不碰。
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

/** API 进程启动时调用。先崩溃扫补(含无 redis 的 inline 模式),再视 REDIS_URL 决定是否建 worker。 */
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
