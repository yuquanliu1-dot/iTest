import { Router } from 'express';
import { eq, asc, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { planRuns, planRunCases, executionPlans, testCases, reports } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { requestCancel, subscribeRun } from '../execute/runPlan.js';
import { sseHeaders } from '../sse/pi.js';
import { assertPlanRunVisible, assertProjectVisible } from '../services/projectAccess.js';
import { handleLiveView, handleLiveReplay, handleLiveReplayMeta, replaySpeedOf } from '../execute/liveView.js';
import { resolveUsersByIds } from '../lib/creator.js';

export const planRunsRoute = Router();

planRunsRoute.get('/:id', async (req, res) => {
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) throw new HttpError(404, 'not_found', 'plan run not found');
  await assertProjectVisible(run.projectId, req.user!);
  const caseRows = await db
    .select()
    .from(planRunCases)
    .where(eq(planRunCases.planRunId, run.id))
    .orderBy(asc(planRunCases.order));
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, run.planId)))[0];
  // 批量查 case 标题，避免 N+1
  const caseIds = Array.from(new Set(caseRows.map((c) => c.caseId)));
  const titleRows = caseIds.length
    ? await db.select({ id: testCases.id, title: testCases.title }).from(testCases).where(inArray(testCases.id, caseIds))
    : [];
  const titleMap = new Map(titleRows.map((t) => [t.id, t.title]));
  // 数据集迭代：批量取全部行 report 的状态，供前端展示「i/N 行通过」
  const reportIdList = caseRows.flatMap((c) => (Array.isArray(c.reportIds) ? c.reportIds : []));
  const statusRows = reportIdList.length
    ? await db.select({ id: reports.id, status: reports.status }).from(reports).where(inArray(reports.id, reportIdList))
    : [];
  const statusMap = new Map(statusRows.map((r) => [r.id, r.status]));
  // 批量取每份报告的最后断言（vision reason / 失败步 error），口径与 /executions 列表一致
  const allReportIds = Array.from(
    new Set([...reportIdList, ...caseRows.map((c) => c.reportId).filter((v): v is string => !!v)]),
  );
  const assertionRows = allReportIds.length
    ? await db
        .select({
          id: reports.id,
          // 最后断言：step_results 数组末位元素 —— vision reason 优先，否则失败步 error
          lastAssertion: sql<string | null>`
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
            end`,
        })
        .from(reports)
        .where(inArray(reports.id, allReportIds))
    : [];
  const assertionMap = new Map(assertionRows.map((r) => [r.id, r.lastAssertion]));
  const cases = caseRows.map((c) => {
    const ids = c.reportIds?.length ? c.reportIds : c.reportId ? [c.reportId] : [];
    // 数据集多行：优先展示首个失败行的断言；全过则取末行
    const assertions = ids.map((id) => assertionMap.get(id) ?? null);
    const failedIdx = ids.findIndex((id) => statusMap.get(id) === 'failed');
    const lastAssertion = (failedIdx >= 0 ? assertions[failedIdx] : assertions[assertions.length - 1]) ?? null;
    return {
      ...c,
      caseTitle: titleMap.get(c.caseId) ?? null,
      rowStatuses: (c.reportIds ?? []).map((id) => statusMap.get(id) ?? 'unknown'),
      lastAssertion,
    };
  });
  res.json({
    ...run,
    planName: plan?.name ?? null,
    cases,
    triggeredBy: run.triggeredByUserId ? (await resolveUsersByIds([run.triggeredByUserId])).get(run.triggeredByUserId) ?? null : null,
  });
});

planRunsRoute.post('/:id/cancel', async (req, res) => {
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) throw new HttpError(404, 'not_found', 'plan run not found');
  await assertProjectVisible(run.projectId, req.user!);
  requestCancel(run.id);
  await db.update(planRuns).set({ cancelRequested: true }).where(eq(planRuns.id, run.id));
  res.json({ ok: true });
});

planRunsRoute.post('/batch-delete', async (req, res) => {
  const body = z.object({ planRunIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  // 与 reports/batch-delete 一致：按可见性逐个校验，违规直接 404
  for (const id of body.planRunIds) await assertPlanRunVisible(id, req.user!);
  const deleted = await db
    .delete(planRuns)
    .where(inArray(planRuns.id, body.planRunIds))
    .returning({ id: planRuns.id });
  res.json({ count: deleted.length });
});

planRunsRoute.get('/:id/events', async (req, res) => {
  sseHeaders(res);
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) {
    res.status(404).end();
    return;
  }
  // EventSource 无法带自定义头，靠 cookie 鉴权；不可见一律断开
  try {
    await assertProjectVisible(run.projectId, req.user!);
  } catch {
    res.status(404).end();
    return;
  }
  const unsub = subscribeRun(run.id, res);
  // initial snapshot
  res.write(
    `data: ${JSON.stringify({
      type: 'plan_run_snapshot',
      status: run.status,
      summary: run.summary,
      totalCases: run.totalCases,
      passedCases: run.passedCases,
      failedCases: run.failedCases,
      skippedCases: run.skippedCases,
    })}\n\n`,
  );
  req.on('close', () => unsub());
});

/** 计划运行的实时画面（MJPEG）：runPlanAsync 注册的 `planrun:<id>` 源；运行中才可连。
 *  ?replay=1 为本轮运行的录制回放（执行结束 30min 内）；&speed=N 为回放倍速；
 *  ?replay=meta 探测录制是否仍可回放（前端据此决定是否显示「回放」按钮）。 */
planRunsRoute.get('/:id/live', async (req, res) => {
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) throw new HttpError(404, 'not_found', 'plan run not found');
  await assertProjectVisible(run.projectId, req.user!);
  if (req.query.replay === 'meta') return handleLiveReplayMeta(res, `planrun:${run.id}`);
  if (req.query.replay === '1') return handleLiveReplay(req, res, `planrun:${run.id}`, { speed: replaySpeedOf(req.query) });
  handleLiveView(req, res, `planrun:${run.id}`);
});