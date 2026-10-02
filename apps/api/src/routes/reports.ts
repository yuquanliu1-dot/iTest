import { Router } from 'express';
import { eq, desc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reports, testCases, groups } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible, visibleProjectIds } from '../services/projectAccess.js';

export const reportsRoute = Router();

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
        .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, agentRunId: reports.agentRunId, status: reports.status, durationMs: reports.durationMs, stepResults: reports.stepResults, preflight: reports.preflight, summary: reports.summary, createdAt: reports.createdAt })
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
      .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, agentRunId: reports.agentRunId, status: reports.status, durationMs: reports.durationMs, stepResults: reports.stepResults, preflight: reports.preflight, summary: reports.summary, createdAt: reports.createdAt })
      .from(reports)
      .leftJoin(testCases, eq(testCases.id, reports.caseId))
      .where(inArray(reports.caseId, caseRows.map((c) => c.id)))
      .orderBy(desc(reports.createdAt))
    : [];
  res.json(rows);
});

reportsRoute.get('/:id', async (req, res) => {
  const rows = await db
    .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, agentRunId: reports.agentRunId, status: reports.status, durationMs: reports.durationMs, stepResults: reports.stepResults, preflight: reports.preflight, summary: reports.summary, createdAt: reports.createdAt })
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
