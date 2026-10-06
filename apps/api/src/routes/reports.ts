import { Router } from 'express';
import { eq, desc, inArray } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { db } from '../db/client.js';
import { reports, testCases, groups } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible, assertReportVisible, visibleProjectIds } from '../services/projectAccess.js';

export const reportsRoute = Router();

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

/** 清理报告对应的截图目录；目录不存在或权限不足时静默吞掉（不影响删除 API 成功） */
async function unlinkReportScreenshots(reportId: string): Promise<void> {
  await rm(join(SCREENSHOTS_DIR, reportId), { recursive: true, force: true }).catch(() => {});
}

reportsRoute.get('/', async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  if (projectId) {
    await assertProjectVisible(projectId, req.user!);
    const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
    const caseRows = gs.length
      ? await db.select({ id: testCases.id }).from(testCases).where(inArray(testCases.groupId, gs.map((g) => g.id)))
      : [];
    const rows = caseRows.length
      ? await db
        .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, status: reports.status, durationMs: reports.durationMs, stepResults: reports.stepResults, preflight: reports.preflight, summary: reports.summary, createdAt: reports.createdAt, datasetRowIndex: reports.datasetRowIndex, datasetSnapshot: reports.datasetSnapshot })
        .from(reports)
        .leftJoin(testCases, eq(testCases.id, reports.caseId))
        .where(inArray(reports.caseId, caseRows.map((c) => c.id)))
        .orderBy(desc(reports.createdAt))
      : [];
    res.json(rows);
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
      .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, status: reports.status, durationMs: reports.durationMs, stepResults: reports.stepResults, preflight: reports.preflight, summary: reports.summary, createdAt: reports.createdAt, datasetRowIndex: reports.datasetRowIndex, datasetSnapshot: reports.datasetSnapshot })
      .from(reports)
      .leftJoin(testCases, eq(testCases.id, reports.caseId))
      .where(inArray(reports.caseId, caseRows.map((c) => c.id)))
      .orderBy(desc(reports.createdAt))
    : [];
  res.json(rows);
});

reportsRoute.get('/:id', async (req, res) => {
  const rows = await db
    .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, status: reports.status, durationMs: reports.durationMs, stepResults: reports.stepResults, preflight: reports.preflight, summary: reports.summary, createdAt: reports.createdAt, datasetRowIndex: reports.datasetRowIndex, datasetSnapshot: reports.datasetSnapshot })
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
  res.json(report);
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
