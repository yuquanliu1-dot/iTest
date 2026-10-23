import { Router } from 'express';
import { eq, desc, inArray } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { db } from '../db/client.js';
import { reports, testCases, groups, planRunCases } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible, assertReportVisible, visibleProjectIds } from '../services/projectAccess.js';
import { attachCreators, attachCreator } from '../lib/creator.js';

export const reportsRoute = Router();

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

/** 清理报告对应的截图目录；目录不存在或权限不足时静默吞掉（不影响删除 API 成功） */
async function unlinkReportScreenshots(reportId: string): Promise<void> {
  await rm(join(SCREENSHOTS_DIR, reportId), { recursive: true, force: true }).catch(() => {});
}

reportsRoute.get('/', async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  // 列表瘦身:stepResults/datasetSnapshot/preflight 重列只在详情接口(GET /:id)消费,
  // 前端列表页(实走 /executions)零引用——列表带这些 JSONB 列等于每次全量拖step明细。
  if (projectId) {
    await assertProjectVisible(projectId, req.user!);
    const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
    const caseRows = gs.length
      ? await db.select({ id: testCases.id }).from(testCases).where(inArray(testCases.groupId, gs.map((g) => g.id)))
      : [];
    const rows = caseRows.length
      ? await db
        .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, status: reports.status, durationMs: reports.durationMs, summary: reports.summary, createdAt: reports.createdAt, datasetRowIndex: reports.datasetRowIndex, platform: reports.platform, mobileOs: reports.mobileOs, deviceName: reports.deviceName, deviceTargetId: reports.deviceTargetId, healed: reports.healed, createdByUserId: reports.createdByUserId })
        .from(reports)
        .leftJoin(testCases, eq(testCases.id, reports.caseId))
        .where(inArray(reports.caseId, caseRows.map((c) => c.id)))
        .orderBy(desc(reports.createdAt))
      : [];
    res.json(await attachCreators(rows));
    return;
  }
  // 无参：按可见项目过滤
  const visiblePids = await visibleProjectIds(req.user!);
  const gs = visiblePids.length
    ? await db.select().from(groups).where(inArray(groups.projectId, visiblePids))
    : [];
  const caseRows = gs.length
    ? await db.select({ id: testCases.id }).from(testCases).where(inArray(testCases.groupId, gs.map((g) => g.id)))
    : [];
  const rows = caseRows.length
    ? await db
      .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, status: reports.status, durationMs: reports.durationMs, summary: reports.summary, createdAt: reports.createdAt, datasetRowIndex: reports.datasetRowIndex, platform: reports.platform, mobileOs: reports.mobileOs, deviceName: reports.deviceName, deviceTargetId: reports.deviceTargetId, healed: reports.healed, createdByUserId: reports.createdByUserId })
      .from(reports)
      .leftJoin(testCases, eq(testCases.id, reports.caseId))
      .where(inArray(reports.caseId, caseRows.map((c) => c.id)))
      .orderBy(desc(reports.createdAt))
    : [];
  res.json(await attachCreators(rows));
});

reportsRoute.get('/:id', async (req, res) => {
  const rows = await db
    .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, status: reports.status, durationMs: reports.durationMs, stepResults: reports.stepResults, preflight: reports.preflight, summary: reports.summary, createdAt: reports.createdAt, startedAt: reports.startedAt, finishedAt: reports.finishedAt, datasetRowIndex: reports.datasetRowIndex, datasetSnapshot: reports.datasetSnapshot, platform: reports.platform, mobileOs: reports.mobileOs, deviceName: reports.deviceName, deviceTargetId: reports.deviceTargetId, healed: reports.healed, createdByUserId: reports.createdByUserId })
    .from(reports)
    .leftJoin(testCases, eq(testCases.id, reports.caseId))
    .where(eq(reports.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'report not found');
  // report → case → group → project 链路判定可见性
  const report = rows[0]!;
  const c = (await db.select().from(testCases).where(eq(testCases.id, report.caseId)))[0];
  if (!c) throw new HttpError(404, 'not_found', 'report not found');
  const g = (await db.select().from(groups).where(eq(groups.id, c.groupId)))[0];
  if (!g) throw new HttpError(404, 'not_found', 'report not found');
  try {
    await assertProjectVisible(g.projectId, req.user!);
  } catch {
    throw new HttpError(404, 'not_found', 'report not found');
  }
  // 计划运行成员报告：在响应里附带 planRunId + planId，前端从计划运行详情进来时显示「返回计划运行」按钮
  const prcRows = await db
    .select({ planRunId: planRunCases.planRunId, reportId: planRunCases.reportId, reportIds: planRunCases.reportIds, caseId: planRunCases.caseId, rca: planRunCases.rca })
    .from(planRunCases)
    .where(eq(planRunCases.caseId, report.caseId))
    .limit(50);
  // 限同一个 case：避免 dataset 多行时跨 plan_run 拿到多个候选
  const link = prcRows.find((r) => r.reportId === report.id)
    ?? prcRows.find((r) => Array.isArray(r.reportIds) && r.reportIds.includes(report.id));
  if (!link) {
    res.json(await attachCreator(report));
    return;
  }
  // planId 来自 planRuns.planId，多查一次避免 join 整张表
  const { planRuns } = await import('../db/schema.js');
  const planRun = (await db.select({ planId: planRuns.planId }).from(planRuns).where(eq(planRuns.id, link.planRunId)))[0];
  res.json(await attachCreator({ ...report, planRunId: link.planRunId, planId: planRun?.planId ?? null, rca: link.rca ?? null }));
});

reportsRoute.delete('/:id', async (req, res) => {
  await assertReportVisible(req.params.id!, req.user!);
  const deleted = await db
    .delete(reports)
    .where(eq(reports.id, req.params.id))
    .returning({ id: reports.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'report not found');
  await unlinkReportScreenshots(req.params.id!);
  res.json({ ok: true });
});

reportsRoute.post('/batch-delete', async (req, res) => {
  const body = z.object({ reportIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  // 与 cases 一致：先按可见性逐个校验，违规直接 404（不区分存在性与可见性）
  for (const id of body.reportIds) await assertReportVisible(id, req.user!);
  const deleted = await db
    .delete(reports)
    .where(inArray(reports.id, body.reportIds))
    .returning({ id: reports.id });
  // 截图清理并行执行；个别失败不影响 API 成功（文件可能本来就不存在）
  await Promise.all(deleted.map((d) => unlinkReportScreenshots(d.id).catch(() => {})));
  res.json({ count: deleted.length });
});
