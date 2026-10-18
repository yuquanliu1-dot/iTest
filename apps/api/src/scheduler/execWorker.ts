/**
 * 执行 worker：消费 exec 队列。job 粒度 = 一次完整 planRun 或一次单用例执行(含数据集全部行),
 * storageState 不跨容器(execute/runPlan.ts 进程内 Map),只要 job 不拆碎即成立。
 */
import { eq } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import { reports } from '../db/schema.js';
import { runPlanAsync } from '../execute/runPlan.js';
import { runCase, type PreseedReport } from '../execute/runCase.js';
import { registerLiveView } from '../execute/liveView.js';
import { buildExecutionWorker, type ExecJob } from './execQueue.js';

/** 单用例执行共用体：worker 与 execute.ts 的 inline 回落都走它(DRY,防两处行为分叉)。
 *  runCase 内部已兜底数据集行错误;真抛(随机崩溃)把预置报告全改 failed 防僵尸。 */
export async function runCaseJob(data: { caseId: string; preseed?: PreseedReport[]; createdByUserId?: string | null }): Promise<void> {
  const live = registerLiveView(`case:${data.caseId}`);
  try {
    await runCase(data.caseId, {
      liveView: live,
      preseed: data.preseed,
      createdByUserId: data.createdByUserId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: e, caseId: data.caseId }, 'background case execute failed; writing failed reports');
    for (const p of data.preseed ?? []) {
      await db
        .update(reports)
        .set({
          status: 'failed',
          stepResults: [{ order: 1, status: 'failed', durationMs: 0, error: msg, failureReason: 'InternalError' }] as object,
          summary: msg,
        })
        .where(eq(reports.id, p.reportId))
        .catch(() => undefined);
    }
  } finally {
    live.close();
  }
}

/** 队列 job 处理器。错误已在 runPlan 内部各阶段兜底/runCaseJob 写 failed 报告,这里再吞一层只记日志,防止意外重跑半成品。 */
async function processExecJob(data: ExecJob): Promise<void> {
  try {
    if (data.kind === 'plan') {
      await runPlanAsync({ planRunId: data.planRunId });
    } else {
      await runCaseJob({ caseId: data.caseId, preseed: data.preseed, createdByUserId: data.createdByUserId });
    }
  } catch (e) {
    logger.error({ err: e, kind: data.kind, runId: 'planRunId' in data ? data.planRunId : data.caseId }, 'exec job crashed');
  }
}

let _worker: Worker<ExecJob> | null = null;

export function getExecWorker(): Worker<ExecJob> | null {
  return _worker;
}

/** API 进程启动时调用(REDIS_URL 缺失/连接失败 → 优雅降级到 inline 执行,与 scheduler 守门一致)。 */
export async function startExecutionWorker(): Promise<void> {
  if (!process.env.REDIS_URL) {
    logger.warn('REDIS_URL not set; execution queue disabled (inline execution)');
    return;
  }
  try {
    _worker = buildExecutionWorker(processExecJob);
    _worker.on('ready', () => logger.info('exec worker ready'));
    _worker.on('error', (err) => logger.warn({ err: err.message }, 'exec worker error'));
    _worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err: err.message }, 'exec job failed'));
    logger.info('exec worker started');
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'exec worker init failed; continuing inline');
    _worker = null;
  }
  registerShutdown();
}

let _shutdownRegistered = false;
function registerShutdown(): void {
  if (_shutdownRegistered) return;
  _shutdownRegistered = true;
  const stop = async (sig: string) => {
    if (!_worker) return;
    logger.info({ sig }, 'shutting down exec worker');
    try { await _worker.close(); } catch (e) { logger.warn({ err: (e as Error).message }, 'exec worker close failed'); }
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

/** 仅供测试：停 worker + 断 exec queue 连接。 */
export async function __stopExecWorkerForTests(): Promise<void> {
  if (_worker) { await _worker.close(); _worker = null; }
  const { __closeExecutionQueue } = await import('./execQueue.js');
  await __closeExecutionQueue();
}