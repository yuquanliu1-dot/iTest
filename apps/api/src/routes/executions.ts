import { Router } from 'express';
import { eq, desc, inArray, and, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reports, planRuns, groups, testCases, executionPlans, projectVersions, planRunCases } from '../db/schema.js';
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
  // 状态 / 版本 / 关键词 facet：statuses / versionIds 走 csv；q 模糊匹配 caseTitle（仅 case 行生效）
  const statusArr = typeof req.query.statuses === 'string' ? req.query.statuses.split(',').filter(Boolean) : [];
  const versionArr = typeof req.query.versionIds === 'string' ? req.query.versionIds.split(',').filter(Boolean) : [];
  const qTrim = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  // 用例 / 计划深链：前端从用例列表或计划列表点「查看报告」时附带，自动过滤
  const caseIdFilter = typeof req.query.caseId === 'string' && req.query.caseId ? req.query.caseId : '';
  const planIdFilter = typeof req.query.planId === 'string' && req.query.planId ? req.query.planId : '';

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
    // facet 拼装：版本在 case 侧基于 testCases.versionId，关键词基于 case 标题
    const caseFilters = [
      inArray(reports.caseId, cs.map((c) => c.id)),
      // 计划运行的成员用例执行历史不在此列表展示（点击计划运行行可看其成员用例）：
      // 排除挂在 plan_run_cases.report_id 上的报告，以及数据集迭代挂在 report_ids 数组中的报告。
      sql`not exists (
        select 1 from ${planRunCases} prc
        where prc.report_id = ${reports.id}
           or exists (
             select 1 from jsonb_array_elements_text(coalesce(prc.report_ids, '[]'::jsonb)) as rid(rid)
             where rid.rid = ${reports.id}::text
           )
      )`,
    ];
    if (statusArr.length) caseFilters.push(inArray(reports.status, statusArr));
    if (versionArr.length) caseFilters.push(inArray(testCases.versionId, versionArr));
    if (qTrim) caseFilters.push(sql`${testCases.title} ilike ${'%' + qTrim + '%'}`);
    if (caseIdFilter) caseFilters.push(eq(reports.caseId, caseIdFilter));
    caseRows = cs.length
      ? ((await db
        .select({ id: reports.id, caseId: reports.caseId, caseTitle: testCases.title, status: reports.status, durationMs: reports.durationMs, summary: reports.summary, createdAt: reports.createdAt })
        .from(reports)
        .leftJoin(testCases, eq(testCases.id, reports.caseId))
        .where(and(...caseFilters))
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
    const conds = projectId
      ? [eq(planRuns.projectId, projectId)]
      : visiblePids && visiblePids.length > 0
        ? [inArray(planRuns.projectId, visiblePids)]
        : [];
    if (statusArr.length) conds.push(inArray(planRuns.status, statusArr));
    // plan 行的 versionId 来自 executionPlans.versionId
    if (versionArr.length) conds.push(inArray(executionPlans.versionId, versionArr));
    if (planIdFilter) conds.push(eq(planRuns.planId, planIdFilter));
    const where = conds.length ? and(...conds) : undefined;
    const rows = where
      ? await db
          .select({ id: planRuns.id, planId: planRuns.planId, status: planRuns.status, summary: planRuns.summary, totalCases: planRuns.totalCases, passedCases: planRuns.passedCases, failedCases: planRuns.failedCases, skippedCases: planRuns.skippedCases, durationMs: planRuns.durationMs, startedAt: planRuns.startedAt, versionId: executionPlans.versionId })
          .from(planRuns)
          .innerJoin(executionPlans, eq(executionPlans.id, planRuns.planId))
          .where(where)
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
