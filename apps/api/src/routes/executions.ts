import { Router } from 'express';
import { eq, desc, inArray, and, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reports, planRuns, groups, testCases, executionPlans, projectVersions, planRunCases, projects } from '../db/schema.js';
import { assertProjectVisible, assertProductLineVisible, visibleProjectIds } from '../services/projectAccess.js';
import { resolveUsersByIds, type ResolvedUser } from '../lib/creator.js';

export const executionsRoute = Router();

/**
 * Plan-run member-case execution history is not shown in this list (clicking a plan run row reveals its member cases):
 * exclude reports attached to plan_run_cases.report_id, reports attached to the report_ids array of dataset
 * iterations, and cases "currently executing as a plan member" (runCase inserts the report as soon as it starts,
 * but report_id is only backfilled after the case finishes — reports in this transient window have no plan link,
 * yet a plan_run_cases row with status=running already exists, which identifies them precisely. Login cases run
 * first, and are exactly the ones users most easily see in this window in day-to-day monitoring).
 *
 * The hit query and the "fill in same-batch members" query share one exclusion semantic (a drift between the two would make batch member counts disagree).
 */
const planMemberExclusion = sql`not exists (
  select 1 from ${planRunCases} prc
  where prc.report_id = ${reports.id}
     or exists (
       select 1 from jsonb_array_elements_text(coalesce(prc.report_ids, '[]'::jsonb)) as rid(rid)
       where rid.rid = ${reports.id}::text
     )
     or exists (
       select 1 from ${planRunCases} prc_active
       where prc_active.case_id = ${reports.caseId}
         and prc_active.status = 'running'
     )
)`;

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
  /** Last assertion info: takes the last element of step_results — the vision verdict reason (pass/fail) or the failed step's error; null when there is no assertion. */
  lastAssertion: string | null;
  /** Self-heal passed marker: passed and AI self-heal succeeded after the aiTask cache forked; failed is always false. */
  healed: boolean;
  createdAt: Date | string;
  /** Executor (i.e. the report creator = the user who triggered execution); lists uniformly return createdBy. */
  createdById: string | null;
  createdBy: ResolvedUser | null;
  /** Dataset batch id (shared by all rows of one dataset execution); null for non-dataset executions. */
  datasetBatchId: string | null;
  /** Number of batch members this record represents (non-dataset execution = 1). */
  batchSize: number;
  /** Passed / failed member counts within the batch (computed from the whole batch's true values, unaffected by filters). */
  batchPassed: number;
  batchFailed: number;
  /** All member report ids within the batch (expanded into N report deletions on batch delete). */
  memberReportIds: string[];
}

/** First-pass query row: the report matching the filters (includes the batch key). */
interface HitRow {
  id: string;
  caseId: string;
  caseTitle: string | null;
  status: string;
  durationMs: number | null;
  summary: string | null;
  lastAssertion: string | null;
  createdAt: Date;
  healed: boolean;
  createdById: string | null;
  datasetBatchId: string | null;
  datasetRowIndex: number | null;
}

/** Second-pass query row: all members of the same batch (no filter conditions), for computing stats over the whole batch. */
interface MemberRow {
  id: string;
  caseId: string;
  status: string;
  durationMs: number | null;
  createdAt: Date;
  healed: boolean;
  createdById: string | null;
  datasetBatchId: string | null;
  datasetRowIndex: number | null;
  summary: string | null;
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
  /** Executor = the plan-run trigger; lists uniformly return createdBy. */
  createdById: string | null;
  createdBy: ResolvedUser | null;
  /** Owning plan name (from innerJoin executionPlans; non-null in theory, kept nullable as fallback) */
  planName: string | null;
}
type Entry = CaseEntry | PlanEntry;

executionsRoute.get('/', async (req, res) => {
  const { projectId, productLineId, kind = 'all' } = req.query as { projectId?: string; productLineId?: string; kind?: 'case' | 'plan' | 'all' };
  // Status / version / keyword facets: statuses / versionIds come as csv; q fuzzy-matches caseTitle (only effective on case rows)
  const statusArr = typeof req.query.statuses === 'string' ? req.query.statuses.split(',').filter(Boolean) : [];
  const versionArr = typeof req.query.versionIds === 'string' ? req.query.versionIds.split(',').filter(Boolean) : [];
  const qTrim = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  // Case / plan deep link: attached when the frontend clicks "view report" from the case list or plan list; auto-filters
  const caseIdFilter = typeof req.query.caseId === 'string' && req.query.caseId ? req.query.caseId : '';
  const planIdFilter = typeof req.query.planId === 'string' && req.query.planId ? req.query.planId : '';

  if (projectId) await assertProjectVisible(projectId, req.user!);
  // Without projectId, filter by visible projects
  const visiblePids = projectId ? null : await visibleProjectIds(req.user!);
  // Product-line scope (execution history's "product-line execution library"): case reports + plan runs of all projects in the line.
  // Mutually exclusive with projectId (the frontend scope switch decides which one is passed); visibility inherits product line → org (same as the cases list branch).
  let linePids: string[] | null = null;
  if (productLineId) {
    await assertProductLineVisible(productLineId, req.user!);
    linePids = (await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.productLineId, productLineId))).map((p) => p.id);
  }
  const scopePids = linePids ?? (projectId ? [projectId] : visiblePids);

  let caseRows: CaseEntry[] = [];
  let planRows: PlanEntry[] = [];

  if (kind === 'case' || kind === 'all') {
    let gids: string[] = [];
    if (scopePids && scopePids.length > 0) {
      const gs = await db.select().from(groups).where(inArray(groups.projectId, scopePids));
      gids = gs.map((g) => g.id);
    }
    const cs = gids.length ? await db.select({ id: testCases.id, versionId: testCases.versionId }).from(testCases).where(inArray(testCases.groupId, gids)) : [];
    // Facet assembly: version is based on testCases.versionId on the case side, keyword on the case title
    const caseFilters = [
      inArray(reports.caseId, cs.map((c) => c.id)),
      planMemberExclusion,
    ];
    if (statusArr.length) caseFilters.push(inArray(reports.status, statusArr));
    if (versionArr.length) caseFilters.push(inArray(testCases.versionId, versionArr));
    if (qTrim) caseFilters.push(sql`${testCases.title} ilike ${'%' + qTrim + '%'}`);
    if (caseIdFilter) caseFilters.push(eq(reports.caseId, caseIdFilter));
    const hitRows: HitRow[] = cs.length
      ? await db
        .select({
          id: reports.id,
          caseId: reports.caseId,
          caseTitle: testCases.title,
          status: reports.status,
          durationMs: reports.durationMs,
          summary: reports.summary,
          // Last assertion: the last element of the step_results array — when vision passes, reason sits on the last step;
          // a vision-failed step is appended last (order=-1), and an ordinary step failure that interrupts also lands last.
          // coalesce takes the vision reason, otherwise the failed step's error.
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
          createdAt: reports.createdAt,
          healed: reports.healed,
          createdById: reports.createdByUserId,
          datasetBatchId: reports.datasetBatchId,
          datasetRowIndex: reports.datasetRowIndex,
        })
        .from(reports)
        .leftJoin(testCases, eq(testCases.id, reports.caseId))
        .where(and(...caseFilters))
        .orderBy(desc(reports.createdAt))
      : [];

    // Dataset batch roll-up: one dataset execution = N reports (same dataset_batch_id) and should occupy a single
    // list row just like a plan run. The first pass only fetches members "matching the filters"; here we query all
    // members of the same batch again (no filter conditions), so stats (batch passed/failed counts, duration, status)
    // are computed from the whole batch's true values rather than from the few rows that matched.
    const hitBatchIds = Array.from(new Set(hitRows.map((r) => r.datasetBatchId).filter((v): v is string => !!v)));
    const membersByBatch = new Map<string, MemberRow[]>();
    if (hitBatchIds.length && cs.length) {
      const memberRows = await db
        .select({
          id: reports.id,
          caseId: reports.caseId,
          status: reports.status,
          durationMs: reports.durationMs,
          createdAt: reports.createdAt,
          healed: reports.healed,
          createdById: reports.createdByUserId,
          datasetBatchId: reports.datasetBatchId,
          datasetRowIndex: reports.datasetRowIndex,
          summary: reports.summary,
        })
        .from(reports)
        .where(and(
          inArray(reports.datasetBatchId, hitBatchIds),
          inArray(reports.caseId, cs.map((c) => c.id)),
          planMemberExclusion,
        ));
      for (const m of memberRows) {
        if (!m.datasetBatchId) continue;
        const arr = membersByBatch.get(m.datasetBatchId) ?? [];
        arr.push(m);
        membersByBatch.set(m.datasetBatchId, arr);
      }
    }

    const emittedBatches = new Set<string>();
    caseRows = [];
    for (const h of hitRows) {
      const c = cs.find((x) => x.id === h.caseId);
      const base = { ...h, versionId: c?.versionId ?? null, versionName: null, kind: 'case' as const };
      if (!h.datasetBatchId) {
        caseRows.push({
          ...base,
          datasetBatchId: null,
          batchSize: 1,
          batchPassed: h.status === 'passed' ? 1 : 0,
          batchFailed: h.status === 'failed' ? 1 : 0,
          memberReportIds: [h.id],
          // Executor is backfilled after batch resolution in the merge stage
          createdBy: null,
        });
        continue;
      }
      if (emittedBatches.has(h.datasetBatchId)) continue; // One row per batch
      emittedBatches.add(h.datasetBatchId);
      const members = membersByBatch.get(h.datasetBatchId) ?? [h];
      // Members ordered by row index ascending (ties by persistence time) — the anchor is the first, and memberReportIds expands in the same order
      const ordered = [...members].sort((a, b) => {
        const ia = a.datasetRowIndex ?? Number.MAX_SAFE_INTEGER;
        const ib = b.datasetRowIndex ?? Number.MAX_SAFE_INTEGER;
        if (ia !== ib) return ia - ib;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
      // Anchor = smallest row index (ties take the earliest persisted): clicking into the detail page lands on the batch's first row, with the row switcher ready accordingly
      const anchor = ordered[0]!;
      const anyRunning = members.some((m) => m.status === 'running');
      const allPassed = members.every((m) => m.status === 'passed');
      const rolledStatus = anyRunning ? 'running' : allPassed ? 'passed' : 'failed';
      const multi = members.length > 1;
      caseRows.push({
        ...base,
        id: anchor.id,
        status: rolledStatus,
        durationMs: members.reduce((sum, m) => sum + (m.durationMs ?? 0), 0),
        summary: anchor.summary,
        // Single-row batches keep the assertion text; a single assertion is meaningless for a multi-row batch, expressed via passed/failed counts instead
        lastAssertion: multi ? null : h.lastAssertion,
        healed: rolledStatus === 'passed' && members.some((m) => m.healed),
        createdAt: members.reduce((mx, m) => (new Date(m.createdAt).getTime() > new Date(mx).getTime() ? m.createdAt : mx), anchor.createdAt),
        createdById: anchor.createdById ?? h.createdById,
        datasetBatchId: h.datasetBatchId,
        batchSize: members.length,
        batchPassed: members.filter((m) => m.status === 'passed').length,
        batchFailed: members.filter((m) => m.status === 'failed').length,
        memberReportIds: ordered.map((m) => m.id),
        // Executor is backfilled after batch resolution in the merge stage
        createdBy: null,
      });
    }

    const vIds = Array.from(new Set(caseRows.map((r) => r.versionId).filter((v): v is string => !!v)));
    if (vIds.length) {
      const vrs = await db.select().from(projectVersions).where(inArray(projectVersions.id, vIds));
      const vName = new Map(vrs.map((v) => [v.id, v.name] as const));
      caseRows = caseRows.map((r) => ({ ...r, versionName: r.versionId ? vName.get(r.versionId) ?? null : null }));
    }
  }

  if (kind === 'plan' || kind === 'all') {
    // scopePids empty (no visible projects / no projects in the line) → empty set, same semantics as the case branch
    const conds = scopePids && scopePids.length > 0 ? [inArray(planRuns.projectId, scopePids)] : [];
    if (statusArr.length) conds.push(inArray(planRuns.status, statusArr));
    // The plan row's versionId comes from executionPlans.versionId
    if (versionArr.length) conds.push(inArray(executionPlans.versionId, versionArr));
    if (planIdFilter) conds.push(eq(planRuns.planId, planIdFilter));
    // The caseId deep link keeps working on the plan tab (otherwise the URL's caseId silently stops applying and switching
    // tabs degrades to a project-wide plan list): take plan runs that "ran this case as a member". That way switching to the
    // plan tab lands exactly on the batch of reports excluded by not exists in the case branch — the most common deep-link
    // destination from the case detail page.
    if (caseIdFilter) {
      conds.push(
        inArray(
          planRuns.id,
          db.select({ planRunId: planRunCases.planRunId }).from(planRunCases).where(eq(planRunCases.caseId, caseIdFilter)),
        ),
      );
    }
    const where = conds.length ? and(...conds) : undefined;
    const rows = where
      ? await db
          .select({ id: planRuns.id, planId: planRuns.planId, planName: executionPlans.name, status: planRuns.status, summary: planRuns.summary, totalCases: planRuns.totalCases, passedCases: planRuns.passedCases, failedCases: planRuns.failedCases, skippedCases: planRuns.skippedCases, durationMs: planRuns.durationMs, startedAt: planRuns.startedAt, versionId: executionPlans.versionId, createdById: planRuns.triggeredByUserId })
          .from(planRuns)
          .innerJoin(executionPlans, eq(executionPlans.id, planRuns.planId))
          .where(where)
          .orderBy(desc(planRuns.startedAt))
      : [];
    planRows = rows.map((r) => ({
      kind: 'plan' as const,
      id: r.id,
      planId: r.planId,
      planName: r.planName ?? null,
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
      createdById: r.createdById ?? null,
      // Executors are uniformly backfilled after batch resolution in the merge stage
      createdBy: null,
    }));
    const pVids = Array.from(new Set(planRows.map((r) => r.versionId).filter((v): v is string => !!v)));
    if (pVids.length) {
      const vrs = await db.select().from(projectVersions).where(inArray(projectVersions.id, pVids));
      const vName = new Map(vrs.map((v) => [v.id, v.name] as const));
      planRows = planRows.map((r) => ({ ...r, versionName: r.versionId ? vName.get(r.versionId) ?? null : null }));
    }
  }

  const actorIds = Array.from(
    new Set([...caseRows, ...planRows].map((r) => r.createdById).filter((v): v is string => !!v)),
  );
  const actorMap = await resolveUsersByIds(actorIds);
  const merged: Entry[] = [...caseRows, ...planRows]
    .map((r) => ({ ...r, createdBy: r.createdById ? (actorMap.get(r.createdById) ?? null) : null }))
    .sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      return tb - ta;
    });
  res.json(merged);
});
