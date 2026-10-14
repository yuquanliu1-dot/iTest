import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { runCase, insertRunningReportRow, type PreseedReport } from '../execute/runCase.js';
import { DatasetConfigError } from '../services/datasets.service.js';
import { loadDatasetForRun } from '../services/datasets.service.js';
import { assertCaseVisible } from '../services/projectAccess.js';
import { registerLiveView, handleLiveView, handleLiveReplay, handleLiveReplayMeta, replaySpeedOf } from '../execute/liveView.js';
import { db } from '../db/client.js';
import { testCases, reports } from '../db/schema.js';
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
  if (caseRow.datasetId) {
    let plan;
    try {
      plan = await loadDatasetForRun(caseRow.datasetId); // 配置错误（无启用行/列名非法/解密失败）→ 400，不产生垃圾 report
    } catch (e) {
      if (e instanceof DatasetConfigError) throw new HttpError(400, 'dataset_config_error', e.message);
      throw e;
    }
    for (const row of plan.rows) {
      preseed.push({ reportId: await insertRunningReportRow(caseRow, row, req.user!.userId), rowIndex: row.rowIndex });
    }
  } else {
    preseed.push({ reportId: await insertRunningReportRow(caseRow, undefined, req.user!.userId), rowIndex: null });
  }

  // 后台执行；live 源的生命周期绑定到整段 run（含数据集全部行）。
  const live = registerLiveView(`case:${caseId}`);
  void runCase(caseId, { liveView: live, preseed })
    .catch(async (e) => {
      // 预检通过后 runCase 理论上不再外抛（内部错误已兜底为 failed report）；万一抛了把预置报告改 failed 防僵尸。
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ err: e, caseId }, 'background case execute failed; writing failed reports');
      for (const p of preseed) {
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
    })
    .finally(() => live.close());

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