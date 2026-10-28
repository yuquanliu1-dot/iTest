import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../middleware/errorHandler.js';
import { insertRunningReportRow, type PreseedReport } from '../execute/runCase.js';
import { DatasetConfigError } from '../services/datasets.service.js';
import { loadDatasetForRun } from '../services/datasets.service.js';
import { assertCaseVisible } from '../services/projectAccess.js';
import { handleLiveView, handleLiveReplay, handleLiveReplayMeta, replaySpeedOf } from '../execute/liveView.js';
import { db } from '../db/client.js';
import { testCases } from '../db/schema.js';
import { runCaseJob } from '../scheduler/execWorker.js';
import { getExecutionQueue, isExecutionQueueReady, EXEC_QUEUE_NAME } from '../scheduler/execQueue.js';
import { logger } from '../logger.js';

export const executeRoute = Router();

const Body = z.object({ caseId: z.string().uuid() });

/**
 * 单用例执行 → 后台执行 + 立即返回 reportId（执行即跳报告页）。
 * 报告行在执行开始前就落库（status='running'），前端跳到报告页时页面已可渲染，
 * 报告页在 running 期间连 MJPEG 实时画面、2s 轮询到完成。
 * 预检保持同步（case 不存在 404 / 数据集配置错误 400 仍在请求内抛出，不产生垃圾 report）；
 * 预检通过后的执行错误由报告承载（写入 failed report，不留 running 僵尸）。
 */
executeRoute.post('/cases/:caseId/execute', async (req, res) => {
  const { caseId } = Body.parse({ caseId: req.params.caseId });
  if (caseId !== req.params.caseId) throw new HttpError(400, 'bad_request', 'caseId mismatch');
  await assertCaseVisible(caseId, req.user!);
  const caseRow = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!caseRow) throw new HttpError(404, 'not_found', 'case not found');

  // 提前插入 running 报告行拿 reportId：数据集模式每行一条，非数据集单行。
  const preseed: PreseedReport[] = [];
  // 数据集模式下冻结本次实际执行的下标集合，随 job 下发 ——
  // worker 侧 loadDatasetForRun 再按同一集合过滤，保证 preseed 与执行行集必然一致
  // （否则数据集在预检与执行之间被改，会抛 preseed report missing）。
  let datasetRowIndexes: number[] | undefined;
  if (caseRow.datasetId) {
    let plan;
    try {
      plan = await loadDatasetForRun(caseRow.datasetId, { rowIndexes: caseRow.datasetRowIndexes ?? [] }); // 配置错误（无启用行/列名非法/解密失败/行越界）→ 400，不产生垃圾 report
    } catch (e) {
      if (e instanceof DatasetConfigError) throw new HttpError(400, 'dataset_config_error', e.message);
      throw e;
    }
    // 批次 id：同一次执行的所有行共用（报告详情页行切换器的分组键）。
    const batchId = randomUUID();
    for (const row of plan.rows) {
      preseed.push({ reportId: await insertRunningReportRow(caseRow, row, req.user!.userId, batchId), rowIndex: row.rowIndex });
    }
    datasetRowIndexes = plan.rows.map((r) => r.rowIndex);
  } else {
    preseed.push({ reportId: await insertRunningReportRow(caseRow, undefined, req.user!.userId), rowIndex: null });
  }

  // 后台执行：优先入队（多副本经 redis 由任一 exec worker 消费）；无 redis 回落 inline（行为与旧一致）。
  if (isExecutionQueueReady()) {
    try {
      await getExecutionQueue().add(EXEC_QUEUE_NAME, {
        kind: 'case',
        caseId,
        preseed,
        datasetRowIndexes,
        createdByUserId: req.user!.userId,
      });
    } catch (e) {
      // redis 假成功(配置了但连不上):add reject → 回落 inline,避免预置 running 报告行变僵尸。
      logger.warn({ err: e, caseId }, 'exec queue add failed; running inline');
      void runCaseJob({ caseId, preseed, datasetRowIndexes, createdByUserId: req.user!.userId });
    }
  } else {
    void runCaseJob({ caseId, preseed, datasetRowIndexes, createdByUserId: req.user!.userId });
  }

  res.json({ reportId: preseed[0]!.reportId, ...(preseed.length > 1 ? { reportIds: preseed.map((p) => p.reportId) } : {}) });
});

/** 单用例执行的实时画面（MJPEG）。鉴权与 execute 一致（用例可见性）；key 稳定，执行中才可连。
 *  ?replay=1 为本轮执行的录制回放（执行结束 30min 内，下次执行同 key 时覆盖）；&speed=N 为回放倍速；
 *  ?replay=meta 探测录制是否仍可回放（前端据此决定是否显示「回放」按钮）。 */
executeRoute.get('/cases/:caseId/live', async (req, res) => {
  const caseId = req.params.caseId!;
  await assertCaseVisible(caseId, req.user!);
  if (req.query.replay === 'meta') return handleLiveReplayMeta(res, `case:${caseId}`);
  if (req.query.replay === '1') return handleLiveReplay(req, res, `case:${caseId}`, { speed: replaySpeedOf(req.query) });
  handleLiveView(req, res, `case:${caseId}`);
});