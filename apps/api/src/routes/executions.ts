import { Router } from 'express';
import { eq, desc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reports, planRuns, groups, testCases } from '../db/schema.js';
import { assertProjectVisible, visibleProjectIds } from '../services/projectAccess.js';

export const executionsRoute = Router();

interface CaseEntry {
  kind: 'case';
  id: string;
  caseId: string;
  caseTitle: string | null;
  status: string;
  durationMs: number | null;
  summary: string | null;
  createdAt: Date | string;
}
interface PlanEntry {
  kind: 'plan';
  id: string;
  planId: string;
  status: string;
  summary: string | null;
  totalCases: number;
  passedCases: number | null;
  failedCases: number | null;
  skippedCases: number | null;
  durationMs: number | null;
  createdAt: Date | string;
}
type Entry = CaseEntry | PlanEntry;

executionsRoute.get('/', async (req, res) => {
  const { projectId, kind = 'all' } = req.query as { projectId?: string; kind?: 'case' | 'plan' | 'all' };

  if (projectId) await assertProjectVisible(projectId, req.user!);
  // 无 projectId 时按可见项目过滤
  const visiblePids = projectId ? null : await visibleProjectIds(req.user!);

  let caseRows: CaseEntry[] = [];
  let planRows: PlanEntry[] = [];

  if (kind === 'case' || kind === 'all') {
    let gids: string[] = [];
    if (projectId) {
      const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
      gids = gs.map((g) => g.id);
    } else if (visiblePids && visiblePids.length > 0) {
      const gs = await db.select().from(groups).where(inArray(groups.projectId, visiblePids));
      gids = gs.map((g) => g.id);
    }
    const cs = gids.length ? await db.select({ id: testCases.id }).from(testCases).where(inArray(testCases.groupId, gids)) : [];
    caseRows = cs.length
      ? ((await db
        .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, status: reports.status, durationMs: reports.durationMs, summary: reports.summary, createdAt: reports.createdAt })
        .from(reports)
        .leftJoin(testCases, eq(testCases.id, reports.caseId))
        .where(inArray(reports.caseId, cs.map((c) => c.id)))
        .orderBy(desc(reports.createdAt))) as unknown as CaseEntry[]).map((r) => ({ ...r, kind: 'case' as const }))
      : [];
  }

  if (kind === 'plan' || kind === 'all') {
    const q = projectId
      ? eq(planRuns.projectId, projectId)
      : visiblePids && visiblePids.length > 0
        ? inArray(planRuns.projectId, visiblePids)
        : undefined;
    const rows = q
      ? await db.select().from(planRuns).where(q).orderBy(desc(planRuns.startedAt))
      : [];
    planRows = rows.map((r) => ({
      ...r,
      kind: 'plan' as const,
      createdAt: r.startedAt,
    }));
  }

  const merged: Entry[] = [...caseRows, ...planRows].sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    return tb - ta;
  });
  res.json(merged);
});
