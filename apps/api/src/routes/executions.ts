import { Router } from 'express';
import { eq, desc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reports, planRuns, groups, testCases, executionPlans, projectVersions } from '../db/schema.js';
import { assertProjectVisible, visibleProjectIds } from '../services/projectAccess.js';

export const executionsRoute = Router();

interface CaseEntry {
  kind: 'case';
  id: string;
  caseId: string;
  caseTitle: string | null;
  versionId: string | null;
  versionName: string | null;
  status: string;
  durationMs: number | null;
  summary: string | null;
  createdAt: Date | string;
}
interface PlanEntry {
  kind: 'plan';
  id: string;
  planId: string;
  versionId: string | null;
  versionName: string | null;
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
    const cs = gids.length ? await db.select({ id: testCases.id, versionId: testCases.versionId }).from(testCases).where(inArray(testCases.groupId, gids)) : [];
    caseRows = cs.length
      ? ((await db
        .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, status: reports.status, durationMs: reports.durationMs, summary: reports.summary, createdAt: reports.createdAt })
        .from(reports)
        .leftJoin(testCases, eq(testCases.id, reports.caseId))
        .where(inArray(reports.caseId, cs.map((c) => c.id)))
        .orderBy(desc(reports.createdAt))) as unknown as CaseEntry[]).map((r) => {
          const c = cs.find((x) => x.id === r.caseId);
          return { ...r, versionId: c?.versionId ?? null, versionName: null, kind: 'case' as const };
        })
      : [];
    const vIds = Array.from(new Set(caseRows.map((r) => r.versionId).filter((v): v is string => !!v)));
    if (vIds.length) {
      const vrs = await db.select().from(projectVersions).where(inArray(projectVersions.id, vIds));
      const vName = new Map(vrs.map((v) => [v.id, v.name] as const));
      caseRows = caseRows.map((r) => ({ ...r, versionName: r.versionId ? vName.get(r.versionId) ?? null : null }));
    }
  }

  if (kind === 'plan' || kind === 'all') {
    const q = projectId
      ? eq(planRuns.projectId, projectId)
      : visiblePids && visiblePids.length > 0
        ? inArray(planRuns.projectId, visiblePids)
        : undefined;
    const rows = q
      ? await db
          .select({ id: planRuns.id, planId: planRuns.planId, status: planRuns.status, summary: planRuns.summary, totalCases: planRuns.totalCases, passedCases: planRuns.passedCases, failedCases: planRuns.failedCases, skippedCases: planRuns.skippedCases, durationMs: planRuns.durationMs, startedAt: planRuns.startedAt, versionId: executionPlans.versionId })
          .from(planRuns)
          .innerJoin(executionPlans, eq(executionPlans.id, planRuns.planId))
          .where(q)
          .orderBy(desc(planRuns.startedAt))
      : [];
    planRows = rows.map((r) => ({
      kind: 'plan' as const,
      id: r.id,
      planId: r.planId,
      versionId: r.versionId ?? null,
      versionName: null,
      status: r.status,
      summary: r.summary,
      totalCases: r.totalCases,
      passedCases: r.passedCases,
      failedCases: r.failedCases,
      skippedCases: r.skippedCases,
      durationMs: r.durationMs,
      createdAt: r.startedAt,
    }));
    const pVids = Array.from(new Set(planRows.map((r) => r.versionId).filter((v): v is string => !!v)));
    if (pVids.length) {
      const vrs = await db.select().from(projectVersions).where(inArray(projectVersions.id, pVids));
      const vName = new Map(vrs.map((v) => [v.id, v.name] as const));
      planRows = planRows.map((r) => ({ ...r, versionName: r.versionId ? vName.get(r.versionId) ?? null : null }));
    }
  }

  const merged: Entry[] = [...caseRows, ...planRows].sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    return tb - ta;
  });
  res.json(merged);
});
