import { Router } from 'express';
import { eq, and, asc, inArray, sql } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { db } from '../db/client.js';
import { planRuns, planRunCases, executionPlans, testCases, reports } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { requestCancel, subscribeRun } from '../execute/runPlan.js';
import { sseHeaders } from '../sse/pi.js';
import { assertPlanRunVisible, assertProjectVisible } from '../services/projectAccess.js';
import { handleLiveView, handleLiveReplay, handleLiveReplayMeta, replaySpeedOf } from '../execute/liveView.js';
import { resolveUsersByIds } from '../lib/creator.js';
import { cache } from '../lib/cache.js';
import { planRunDetailKey } from '../lib/cache-keys.js';

export const planRunsRoute = Router();

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

/** 清理报告对应的截图目录；目录不存在或权限不足时静默吞掉（不影响删除 API 成功） */
async function unlinkReportScreenshots(reportId: string): Promise<void> {
  await rm(join(SCREENSHOTS_DIR, reportId), { recursive: true, force: true }).catch(() => {});
}

/** 收集一次计划运行产出的全部报告 id：plan_run_cases.report_id 与 report_ids 数组里的每个 id。 */
async function collectRunReportIds(planRunIds: string[]): Promise<string[]> {
  const rows = await db
    .select({ reportId: planRunCases.reportId, reportIds: planRunCases.reportIds })
    .from(planRunCases)
    .where(inArray(planRunCases.planRunId, planRunIds));
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.reportId) ids.add(r.reportId);
    for (const id of Array.isArray(r.reportIds) ? r.reportIds : []) if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * 删除计划运行及其成员报告。
 *
 * 成员报告必须一并删：plan_run_cases 才是「这份报告属于某次计划运行」的唯一链接，
 * 运行删掉后链接消失，报告会以「独立用例执行」的形态重新出现在执行历史的单用例列表里
 * （executions 的 case 分支靠 not exists 排除 plan 成员报告）——用户看到的等于「删了运行、
 * 报告却还在」。
 *
 * 报告删掉后其 screenshots/<reportId>/ 目录一并清理，避免磁盘堆积。
 */
async function deleteRunsWithReports(planRunIds: string[]): Promise<number> {
  const reportIds = await collectRunReportIds(planRunIds);
  const deleted = await db
    .delete(planRuns)
    .where(inArray(planRuns.id, planRunIds))
    .returning({ id: planRuns.id });
  if (reportIds.length) {
    // report_id 外键是 ON DELETE SET NULL，删报告后 plan_run_cases 的链接被置空；
    // 此刻 plan_runs 已删，成员行随之级联消失，不留悬挂引用。
    await db.delete(reports).where(inArray(reports.id, reportIds));
    await Promise.all(reportIds.map((id) => unlinkReportScreenshots(id).catch(() => {})));
  }
  // 终态详情缓存失效:删除后重访必须立即可 404,不能返回幽灵快照
  await Promise.all(deleted.map((d) => cache.del(planRunDetailKey(d.id))));
  return deleted.length;
}

/** 运行中的计划运行不允许删除：执行器还会往成员表和报告表继续写，删了库等于删一半。 */
async function assertNotRunning(planRunIds: string[]): Promise<void> {
  const running = await db
    .select({ id: planRuns.id })
    .from(planRuns)
    .where(and(inArray(planRuns.id, planRunIds), eq(planRuns.status, 'running')));
  if (running.length > 0) {
    throw new HttpError(409, 'plan_run_running', 'plan run is still running');
  }
}

const PLAN_RUN_TERMINAL_STATUSES = ['passed', 'failed', 'cancelled'];
const PLAN_RUN_DETAIL_TTL_MS = 5 * 60_000;

/**
 * 组装运行详情 payload;运行不存在返回 null(wrap 不缓存 null,删除后立即可 404)。
 * 终态快照仍可能因 rca 落库/成员报告删除而变化——前者由 rcaWorker/saveRcaResult 显式失效,
 * 后者靠 TTL 兜底(已知取舍,见 planRunDetailKey)。
 */
async function buildPlanRunDetail(runId: string) {
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, runId)))[0];
  if (!run) return null;
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
  return {
    ...run,
    planName: plan?.name ?? null,
    cases,
    triggeredBy: run.triggeredByUserId ? (await resolveUsersByIds([run.triggeredByUserId])).get(run.triggeredByUserId) ?? null : null,
  };
}

planRunsRoute.get('/:id', async (req, res) => {
  const run = (await db.select({ id: planRuns.id, projectId: planRuns.projectId, status: planRuns.status }).from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) throw new HttpError(404, 'not_found', 'plan run not found');
  // 可见性必须在缓存之外:缓存的是数据不是鉴权结果,跨组织用户不得命中他人 payload
  await assertProjectVisible(run.projectId, req.user!);
  // 运行中(轮询期)实时组装不缓存;终态快照缓存 5min,前端 2s 轮询/重访共享同一份
  const payload = PLAN_RUN_TERMINAL_STATUSES.includes(run.status)
    ? await cache.wrap(planRunDetailKey(run.id), PLAN_RUN_DETAIL_TTL_MS, () => buildPlanRunDetail(run.id))
    : await buildPlanRunDetail(run.id);
  if (!payload) throw new HttpError(404, 'not_found', 'plan run not found');
  res.json(payload);
});

planRunsRoute.post('/:id/cancel', async (req, res) => {
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) throw new HttpError(404, 'not_found', 'plan run not found');
  await assertProjectVisible(run.projectId, req.user!);
  requestCancel(run.id);
  await db.update(planRuns).set({ cancelRequested: true }).where(eq(planRuns.id, run.id));
  res.json({ ok: true });
});

planRunsRoute.delete('/:id', async (req, res) => {
  const id = req.params.id!;
  await assertPlanRunVisible(id, req.user!);
  await assertNotRunning([id]);
  const count = await deleteRunsWithReports([id]);
  if (count === 0) throw new HttpError(404, 'not_found', 'plan run not found');
  res.json({ ok: true });
});

planRunsRoute.post('/batch-delete', async (req, res) => {
  const body = z.object({ planRunIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  // 与 reports/batch-delete 一致：按可见性逐个校验，违规直接 404
  for (const id of body.planRunIds) await assertPlanRunVisible(id, req.user!);
  await assertNotRunning(body.planRunIds);
  const count = await deleteRunsWithReports(body.planRunIds);
  res.json({ count });
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