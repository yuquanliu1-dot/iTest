import { Router } from 'express';
import { eq, desc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reports, planRuns, groups, testCases } from '../db/schema.js';

export const executionsRoute = Router();

interface CaseEntry {
  kind: 'case';
  id: string;
  caseId: string;
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

  let caseRows: CaseEntry[] = [];
  let planRows: PlanEntry[] = [];

  if (kind === 'case' || kind === 'all') {
    if (projectId) {
      const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
      const gids = gs.map((g) => g.id);
      const cs = gids.length ? await db.select({ id: testCases.id }).from(testCases).where(inArray(testCases.groupId, gids)) : [];
      caseRows = cs.length
        ? ((await db.select().from(reports).where(inArray(reports.caseId, cs.map((c) => c.id))).orderBy(desc(reports.createdAt))) as unknown as CaseEntry[]).map((r) => ({ ...r, kind: 'case' as const }))
        : [];
    } else {
      caseRows = ((await db.select().from(reports).orderBy(desc(reports.createdAt))) as unknown as CaseEntry[]).map((r) => ({ ...r, kind: 'case' as const }));
    }
  }

  if (kind === 'plan' || kind === 'all') {
    const q = projectId ? eq(planRuns.projectId, projectId) : undefined;
    const rows = q
      ? await db.select().from(planRuns).where(q).orderBy(desc(planRuns.startedAt))
      : await db.select().from(planRuns).orderBy(desc(planRuns.startedAt));
    planRows = (rows as any[]).map((r) => ({
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
