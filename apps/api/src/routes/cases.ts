import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testCases, groups, scenarios, projectVersions, projects, testSteps, solidifyBatches, solidifyBatchCases } from '../db/schema.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { assertCaseVisible, assertProductLineVisible, assertProjectVisible, assertVersionVisible, visibleProjectIds } from '../services/projectAccess.js';
import { copyCaseCore, createCase, deleteCase, getCaseDetail, groupProjectId, invalidateCasesCache, tagsForCases, updateCase } from '../services/cases.service.js';
import { attachCreators } from '../lib/creator.js';
import { cache } from '../lib/cache.js';
import { casesForProjectKey } from '../lib/cache-keys.js';
import { checkBatchEligibility, deriveBatchSummary, RUNNING_BATCH_STATUSES, runSolidifyBatchCaseJob } from '../execute/batchSolidify.js';
import { getExecutionQueue, isExecutionQueueReady, EXEC_QUEUE_NAME } from '../scheduler/execQueue.js';
import { logger } from '../logger.js';

export const casesRoute = Router();

const CaseBodyBase = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P1'),
  requirementId: z.string().uuid().optional(),
  groupId: z.string().uuid(),
  versionId: z.string().uuid().optional(),
  url: z.string().optional(),
  webServiceRef: z.string().max(64).nullable().optional(),
  windowStrategy: z.enum(['maximize', 'current', 'custom']).default('maximize'),
  windowWidth: z.number().int().min(200).max(10000).optional(),
  windowHeight: z.number().int().min(200).max(10000).optional(),
  incognito: z.boolean().default(false),
  tagIds: z.array(z.string().uuid()).optional(),
  /** Requirement number (free-text external number, not a requirements FK). */
  requirementNo: z.string().max(64).nullable().optional(),
  /** Track 1: case-level expected outcome description (natural language). After replay, the vision LLM judges it using the final screenshot. */
  expectedOutcome: z.string().max(4000).nullable().optional(),
});

const CaseStatusEnum = z.enum(['draft', 'review', 'ready', 'deprecated']);

function checkWindowStrategy(
  val: { windowStrategy?: string; windowWidth?: number; windowHeight?: number },
  ctx: z.RefinementCtx,
): void {
  if (val.windowStrategy === 'custom' && (!val.windowWidth || !val.windowHeight)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['windowWidth'],
      message: 'windowWidth and windowHeight are required when windowStrategy is custom',
    });
  }
}

const CreateBody = CaseBodyBase.superRefine(checkWindowStrategy);
const PatchBody = CaseBodyBase.partial()
  .extend({
    scenarioId: z.string().uuid().nullable().optional(),
    status: CaseStatusEnum.optional(),
    // Case description may be empty; cap aligned with expectedOutcome
    description: z.string().max(4000).nullable().optional(),
    // Case-level init URL may be empty (clears the override, falls back to the group/project inheritance chain).
    // Relative paths are accepted: same policy as the create endpoint (CaseBodyBase) — the execution layer joins a
    // relative url with the environment web service origin (spec 2026-10-16); the .url() "protocol required" check would otherwise make the UI unable to edit saved relative-path cases.
    url: z.string().nullable().optional(),
    webServiceRef: z.string().max(64).nullable().optional(),
    // Case default environment id; null = clear, undefined = leave unchanged
    defaultEnvId: z.string().uuid().nullable().optional(),
    // Bound dataset id; null = unbind, undefined = leave unchanged
    datasetId: z.string().uuid().nullable().optional(),
    // Dataset row selection: array of enabled row indexes. [] = all enabled rows; null = clear the selection.
    // Cross-field validation (dataset must be bound first / indexes within range) is done in the service layer (superRefine at the end of PatchBody).
    datasetRowIndexes: z.array(z.number().int().min(0)).max(500).nullable().optional(),
    // 2026-10-07: mobile support
    platform: z.enum(['web', 'mobile']).optional(),
    mobileOs: z.enum(['ios', 'android']).nullable().optional(),
    mobileDeviceTargetId: z.string().uuid().nullable().optional(),
    appRef: z.object({
      bundleId: z.string().min(1).max(256),
      appPath: z.string().optional(),
      launchArgs: z.array(z.string()).max(50).optional(),
    }).nullable().optional(),
  })
  .superRefine(checkWindowStrategy);

/** Case list cache TTL: explicit invalidation on write paths + 30s fallback (minor drift sources like titles/version names/group names stay stale until expiry). */
const CASES_LIST_TTL_MS = 30_000;

type RawCaseRow = typeof testCases.$inferSelect;

/** Enrichment + mapping: scenarioTitle/versionName/tags/step solidification progress/project ownership/createdBy.
 *  The project branch's output goes into the cache as a whole (priority/scenarioId/versionIds/solidified filters are
 *  applied after the cache; the fields all four need are kept on the mapped rows). */
async function mapCaseRows(rows: RawCaseRow[]) {
  // Bring scenario titles back along so the frontend does not issue a detail request per case
  const sids = [...new Set(rows.map((r) => r.scenarioId).filter((v): v is string => !!v))];
  const sById = new Map<string, { id: string; title: string }>();
  if (sids.length > 0) {
    const scRows = await db
      .select({ id: scenarios.id, title: scenarios.title })
      .from(scenarios)
      .where(inArray(scenarios.id, sids));
    for (const s of scRows) sById.set(s.id, s);
  }
  // Same technique: batch-backfill tags (avoids N+1)
  const caseIds = rows.map((r) => r.id);
  const tagsByCase = await tagsForCases(caseIds);
  // Batch-backfill step solidification progress (total / non-null compiled count): shared by the list "solidified" column and the ?solidified=none filter
  const stepsByCase = new Map<string, { total: number; compiled: number }>();
  if (caseIds.length > 0) {
    const agg = await db
      .select({
        caseId: testSteps.caseId,
        total: sql<number>`count(*)::int`,
        compiled: sql<number>`count(${testSteps.compiled})::int`,
      })
      .from(testSteps)
      .where(inArray(testSteps.caseId, caseIds))
      .groupBy(testSteps.caseId);
    for (const a of agg) stepsByCase.set(a.caseId, { total: a.total, compiled: a.compiled });
  }
  // Batch-resolve version names: project-scoped fetches interleave versions, and the frontend needs names
  const vids = [...new Set(rows.map((r) => r.versionId).filter((v): v is string => !!v))];
  const vById = new Map<string, string>();
  if (vids.length > 0) {
    const vRows = await db
      .select({ id: projectVersions.id, name: projectVersions.name })
      .from(projectVersions)
      .where(inArray(projectVersions.id, vids));
    for (const v of vRows) vById.set(v.id, v.name);
  }
  // Batch-backfill owning project (under the product-line dimension the list interleaves projects; the frontend uses it to flag "cross-project" and filter by project)
  const gidsAll = [...new Set(rows.map((r) => r.groupId).filter((v): v is string => !!v))];
  const projectByGroup = new Map<string, { id: string; name: string }>();
  if (gidsAll.length > 0) {
    const gs = await db
      .select({ id: groups.id, projectId: groups.projectId, projectName: projects.name })
      .from(groups)
      .innerJoin(projects, eq(projects.id, groups.projectId))
      .where(inArray(groups.id, gidsAll));
    for (const g of gs) projectByGroup.set(g.id, { id: g.projectId, name: g.projectName });
  }
  return attachCreators(
    rows.map((r) => {
      const p = projectByGroup.get(r.groupId);
      return {
        ...r,
        scenarioTitle: r.scenarioId ? (sById.get(r.scenarioId)?.title ?? null) : null,
        versionName: vById.get(r.versionId) ?? null,
        tags: tagsByCase.get(r.id) ?? [],
        stepsTotal: stepsByCase.get(r.id)?.total ?? 0,
        stepsCompiled: stepsByCase.get(r.id)?.compiled ?? 0,
        projectId: p?.id ?? null,
        projectName: p?.name ?? null,
      };
    }),
  );
}

/** All raw case rows within a project (two-stage groups → cases query). */
async function loadProjectCaseRows(projectId: string): Promise<RawCaseRow[]> {
  const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
  const gids = gs.map((g) => g.id);
  return gids.length ? await db.select().from(testCases).where(inArray(testCases.groupId, gids)) : [];
}

casesRoute.get('/', async (req, res) => {
  const { priority, groupId, projectId, scenarioId, productLineId, solidified } = req.query as Record<string, string | undefined>;
  // versionIds filter: comma-separated or repeated params both work; narrowed only within visible projects, no extra visibility assertion needed
  const rawVersionIds = (req.query as Record<string, string | string[] | undefined>).versionIds;
  const versionIds = (Array.isArray(rawVersionIds) ? rawVersionIds : rawVersionIds != null ? [rawVersionIds] : [])
    .flatMap((v) => v.split(','))
    .filter((v) => v.length > 0);
  let rows;
  if (productLineId) {
    // Product-line dimension: pull cases of all projects in the line at once, feeding the plan "add case" pool
    // (the read entry for cross-project shared cases. Visibility inherits product line → org → visibleOrgIdsFor, see assertProductLineVisible).
    await assertProductLineVisible(productLineId, req.user!);
    const pids = (await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.productLineId, productLineId))).map((p) => p.id);
    const gs = pids.length
      ? await db.select().from(groups).where(inArray(groups.projectId, pids))
      : [];
    const gids = gs.map((g) => g.id);
    rows = await mapCaseRows(gids.length
      ? (await db.select().from(testCases).where(inArray(testCases.groupId, gids)))
      : []);
  } else if (projectId) {
    await assertProjectVisible(projectId, req.user!);
    // Read-through cache for the whole enriched list; the visibility assertion stays outside the cache (what's cached is data, not authorization results)
    rows = await cache.wrap(casesForProjectKey(projectId), CASES_LIST_TTL_MS, async () =>
      mapCaseRows(await loadProjectCaseRows(projectId)),
    );
  } else if (groupId) {
    const g = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
    if (!g[0]) throw new HttpError(404, 'not_found', 'group not found');
    await assertProjectVisible(g[0].projectId, req.user!);
    rows = await mapCaseRows(await db.select().from(testCases).where(eq(testCases.groupId, groupId)));
  } else {
    // No-param branch: filter by visible projects
    const visiblePids = await visibleProjectIds(req.user!);
    const gs = visiblePids.length
      ? await db.select().from(groups).where(inArray(groups.projectId, visiblePids))
      : [];
    const gids = gs.map((g) => g.id);
    rows = await mapCaseRows(gids.length
      ? (await db.select().from(testCases).where(inArray(testCases.groupId, gids)))
      : []);
  }
  if (priority) rows = rows.filter((r) => r.priority === priority);
  // scenarioId filter: 'none' matches scenarioId IS NULL; a UUID matches a concrete scenario
  if (scenarioId) {
    rows = scenarioId === 'none'
      ? rows.filter((r) => r.scenarioId == null)
      : rows.filter((r) => r.scenarioId === scenarioId);
  }
  if (versionIds.length > 0) {
    const vset = new Set(versionIds);
    rows = rows.filter((r) => r.versionId != null && vset.has(r.versionId));
  }
  // Only unsolidified: has steps and none solidified (the batch-solidify entry criterion; cases without steps don't count as "unsolidified")
  if (solidified === 'none') {
    rows = rows.filter((r) => r.stepsTotal > 0 && r.stepsCompiled === 0);
  }
  res.json(rows);
});

/**
 * List of in-flight batch-solidify batches (frontend 2s polling endpoint): within this user's visible
 * projects, all batches that still have running rows.
 * Purpose = the group page's top progress banner + the per-row "solidifying" badge: batches only accept
 * cases whose steps are all unsolidified; once solidification completes the row status turns terminal
 * → the batch drops out of this list automatically (banner disappears, badge reverts to n/N).
 * Purely terminal batches are no longer returned: completion info is carried by the single-batch endpoint (below).
 *
 * Must be registered before GET /:id — "/solidify-batches" is a single-segment path and would be matched first by /:id.
 */
casesRoute.get('/solidify-batches', async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  // Visibility: with projectId run the assertion (missing and invisible both 404); without it, filter by the set of visible projects.
  let pids: string[];
  if (projectId) {
    await assertProjectVisible(projectId, req.user!);
    pids = [projectId];
  } else {
    pids = await visibleProjectIds(req.user!);
  }
  if (pids.length === 0) {
    res.json({ batches: [] });
    return;
  }
  // Batches with running rows (distinct)
  const runningBatches = await db
    .selectDistinct({ batchId: solidifyBatches.id, projectId: solidifyBatches.projectId, createdAt: solidifyBatches.createdAt })
    .from(solidifyBatches)
    .innerJoin(solidifyBatchCases, eq(solidifyBatchCases.batchId, solidifyBatches.id))
    .where(and(inArray(solidifyBatches.projectId, pids), inArray(solidifyBatchCases.status, [...RUNNING_BATCH_STATUSES])));
  if (runningBatches.length === 0) {
    res.json({ batches: [] });
    return;
  }
  // All rows of these batches (terminal rows included, for computing passed/failed and showing details)
  const rows = await db
    .select({
      batchId: solidifyBatchCases.batchId,
      caseId: solidifyBatchCases.caseId,
      status: solidifyBatchCases.status,
      error: solidifyBatchCases.error,
      title: testCases.title,
    })
    .from(solidifyBatchCases)
    .innerJoin(testCases, eq(testCases.id, solidifyBatchCases.caseId))
    .where(inArray(solidifyBatchCases.batchId, runningBatches.map((b) => b.batchId)));
  const batches = runningBatches.map((b) => {
    const cases = rows.filter((r) => r.batchId === b.batchId);
    return {
      batchId: b.batchId,
      projectId: b.projectId,
      createdAt: b.createdAt,
      ...deriveBatchSummary(cases),
      cases: cases.map(({ batchId: _bid, ...c }) => c),
    };
  });
  res.json({ batches });
});

casesRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const pid = await groupProjectId(body.groupId);
  if (!pid) throw new HttpError(404, 'not_found', 'group not found');
  await assertProjectVisible(pid, req.user!);
  // versionId is required: every frontend entry passes the version explicitly, there is no default-version fallback; if passed it must belong to the same project
  const versionId = body.versionId;
  if (!versionId) throw new HttpError(400, 'version_required', 'versionId is required');
  const { projectId: vp } = await assertVersionVisible(versionId, req.user!);
  if (vp !== pid) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
  res.json(await createCase({ ...body, versionId, createdByUserId: req.user!.userId }));
});

casesRoute.get('/:id', async (req, res) => {
  await assertCaseVisible(req.params.id!, req.user!);
  const detail = await getCaseDetail(req.params.id!);
  if (!detail) throw new HttpError(404, 'not_found', 'case not found');
  res.json(detail);
});

casesRoute.patch('/:id', async (req, res) => {
  const body = PatchBody.parse(req.body);
  await assertCaseVisible(req.params.id!, req.user!);
  if (body.groupId !== undefined) {
    // The move target group must be visible too
    const pid = await groupProjectId(body.groupId);
    if (!pid) throw new HttpError(404, 'not_found', 'group not found');
    await assertProjectVisible(pid, req.user!);
  }
  if (body.defaultEnvId !== undefined && body.defaultEnvId !== null) {
    const { assertEnvironmentVisible } = await import('../services/projectAccess.js');
    await assertEnvironmentVisible(body.defaultEnvId, req.user!);
  }
  if (body.datasetId !== undefined && body.datasetId !== null) {
    const { assertDatasetVisible } = await import('../services/projectAccess.js');
    await assertDatasetVisible(body.datasetId, req.user!);
  }
  // 2026-10-07: on mobile platform, mobileOs/mobileDeviceTargetId/appRef must all be present (merged with existing fields)
  // platform=web clears the mobile fields
  if (body.platform !== undefined) {
    const existing = await getCaseDetail(req.params.id!);
    if (body.platform === 'mobile') {
      const mOs = body.mobileOs ?? existing?.mobileOs ?? null;
      const mDt = body.mobileDeviceTargetId ?? existing?.mobileDeviceTargetId ?? null;
      const aRef = body.appRef ?? existing?.appRef ?? null;
      if (!mOs || !mDt || !aRef?.bundleId) {
        throw new HttpError(400, 'mobile_config_required', 'mobile case requires mobileOs, mobileDeviceTargetId, appRef.bundleId');
      }
    } else {
      // platform=web: clear mobile fields (avoid leaving mobile config on a web case)
      body.mobileOs = null;
      body.mobileDeviceTargetId = null;
      body.appRef = null;
    }
  }
  if (body.mobileDeviceTargetId !== undefined && body.mobileDeviceTargetId !== null) {
    const { assertDeviceTargetVisible } = await import('../services/projectAccess.js');
    await assertDeviceTargetVisible(body.mobileDeviceTargetId, req.user!);
  }
  // scenario matching / env ownership / tag org checks are enforced by the service as fallback
  res.json(await updateCase(req.params.id!, body));
});

async function copyOneCase(caseId: string, targetGroupId: string, targetVersionId: string | null, user: NonNullable<Express.Request['user']>): Promise<unknown> {
  const src = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!src) throw new HttpError(404, 'not_found', 'case not found');
  // Source case and the target group's project must both be visible
  await assertCaseVisible(caseId, user);
  const targetGroup = (await db.select().from(groups).where(eq(groups.id, targetGroupId)))[0];
  if (targetGroup) await assertProjectVisible(targetGroup.projectId, user);
  // targetVersionId omitted → copy within the same version; otherwise it must belong to targetGroup.projectId
  if (targetVersionId) {
    const { projectId: vp } = await assertVersionVisible(targetVersionId, user);
    if (targetGroup && vp !== targetGroup.projectId) throw new HttpError(400, 'version_mismatch', 'version does not belong to target project');
  }
  return copyCaseCore({ caseId, targetGroupId, targetVersionId }, user.userId);
}

casesRoute.post('/:id/copy', async (req, res) => {
  const body = z.object({ targetGroupId: z.string().uuid(), targetVersionId: z.string().uuid().optional() }).parse(req.body);
  const g = await db.select().from(groups).where(eq(groups.id, body.targetGroupId));
  if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  await assertProjectVisible(g[0]!.projectId, req.user!);
  res.json(await copyOneCase(req.params.id!, body.targetGroupId, body.targetVersionId ?? null, req.user!));
});

casesRoute.post('/copy', async (req, res) => {
  const body = z.object({
    caseIds: z.array(z.string().uuid()).min(1),
    targetGroupId: z.string().uuid(),
    targetVersionId: z.string().uuid().optional(),
  }).parse(req.body);
  const g = await db.select().from(groups).where(eq(groups.id, body.targetGroupId));
  if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  await assertProjectVisible(g[0]!.projectId, req.user!);
  for (const id of body.caseIds) {
    await copyOneCase(id, body.targetGroupId, body.targetVersionId ?? null, req.user!);
  }
  res.json({ count: body.caseIds.length });
});

casesRoute.delete('/:id', async (req, res) => {
  await assertCaseVisible(req.params.id!, req.user!);
  await deleteCase(req.params.id!);
  res.json({ ok: true });
});

casesRoute.post('/batch-delete', async (req, res) => {
  const body = z.object({ caseIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  // Same as single delete: validate visibility one by one first, violations 404 immediately
  for (const id of body.caseIds) {
    await assertCaseVisible(id, req.user!);
  }
  // Project ownership is resolved before deletion (the group chain breaks after row deletion)
  const owners = await db.select({ groupId: testCases.groupId }).from(testCases).where(inArray(testCases.id, body.caseIds));
  const deleted = await db
    .delete(testCases)
    .where(inArray(testCases.id, body.caseIds))
    .returning({ id: testCases.id });
  const pids = new Set(await Promise.all(owners.map((o) => groupProjectId(o.groupId))));
  await Promise.all([...pids].map((pid) => invalidateCasesCache(pid)));
  res.json({ count: deleted.length });
});

casesRoute.post('/batch-status', async (req, res) => {
  const body = z
    .object({
      caseIds: z.array(z.string().uuid()).min(1),
      status: CaseStatusEnum,
    })
    .parse(req.body);
  // Same as batch-delete: validate visibility one by one first, violations 404 immediately
  for (const id of body.caseIds) {
    await assertCaseVisible(id, req.user!);
  }
  const updated = await db
    .update(testCases)
    .set({ status: body.status, updatedAt: new Date() })
    .where(inArray(testCases.id, body.caseIds))
    .returning({ id: testCases.id, groupId: testCases.groupId });
  const pids = new Set(await Promise.all(updated.map((u) => groupProjectId(u.groupId))));
  await Promise.all([...pids].map((pid) => invalidateCasesCache(pid)));
  res.json({ count: updated.length });
});

/**
 * Batch backend solidification: fully-unsolidified web cases NL→DSL + mechanical acceptance, executed in the
 * background case by case (job granularity = a single case; solidify+materialize+verify share one job because
 * loginStateCache is an in-process memory cache — splitting across replicas would degrade to re-login on every step).
 * Per-case eligibility checks give human-readable reasons; all rejected → 422, no batch created; some rejected → 200 + rejected list surfaced by the frontend.
 */
casesRoute.post('/batch-solidify', async (req, res) => {
  const body = z.object({ caseIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  // Same as batch-delete: validate visibility one by one first, violations 404 immediately
  for (const id of body.caseIds) {
    await assertCaseVisible(id, req.user!);
  }
  const rejected: Array<{ caseId: string; reason: string }> = [];
  let batchProjectId: string | null = null;
  const accepted: string[] = [];
  for (const id of [...new Set(body.caseIds)]) {
    const c = await checkBatchEligibility(id);
    if (!c.ok) {
      rejected.push({ caseId: id, reason: c.reason });
      continue;
    }
    // The batch is attached to a single project (the trigger entry is the group page, so in practice all same-project); cross-project mixed selections put foreign-project cases into rejected
    if (batchProjectId === null) batchProjectId = c.projectId;
    else if (batchProjectId !== c.projectId) {
      rejected.push({ caseId: id, reason: '与其它用例不在同一项目，请分项目触发' });
      continue;
    }
    accepted.push(id);
  }
  // All rejected still returns 200 (batchId=null): the api client throws ApiError on non-2xx and would drop the
  // rejected details; the frontend decides whether to poll by checking batchId for null (same contract as the partial-reject 200)
  if (accepted.length === 0 || batchProjectId === null) {
    res.json({ batchId: null, accepted: [], rejected });
    return;
  }
  const batch = (
    await db.insert(solidifyBatches).values({ projectId: batchProjectId, createdByUserId: req.user!.userId }).returning({ id: solidifyBatches.id })
  )[0]!;
  await db.insert(solidifyBatchCases).values(accepted.map((caseId) => ({ batchId: batch.id, caseId })));
  // Enqueue per case; without redis (or on add reject) fall back to inline, same pattern as execute.ts
  for (const caseId of accepted) {
    if (isExecutionQueueReady()) {
      try {
        await getExecutionQueue().add(EXEC_QUEUE_NAME, { kind: 'solidify', batchId: batch.id, caseId });
      } catch (e) {
        logger.warn({ err: e, batchId: batch.id, caseId }, 'exec queue add failed; running solidify inline');
        void runSolidifyBatchCaseJob({ batchId: batch.id, caseId });
      }
    } else {
      void runSolidifyBatchCaseJob({ batchId: batch.id, caseId });
    }
  }
  res.json({ batchId: batch.id, accepted, rejected });
});

/**
 * Batch-solidify progress query (frontend 2s polling endpoint). Batch status is derived at read time:
 * any running row = running; otherwise all passed = passed, all failed = failed, mixed = partial.
 */
casesRoute.get('/solidify-batches/:id', async (req, res) => {
  const batch = (await db.select().from(solidifyBatches).where(eq(solidifyBatches.id, req.params.id!)).limit(1))[0];
  if (!batch) throw new HttpError(404, 'not_found', 'batch not found');
  await assertProjectVisible(batch.projectId, req.user!);
  const rows = await db
    .select({
      caseId: solidifyBatchCases.caseId,
      status: solidifyBatchCases.status,
      error: solidifyBatchCases.error,
      title: testCases.title,
    })
    .from(solidifyBatchCases)
    .innerJoin(testCases, eq(testCases.id, solidifyBatchCases.caseId))
    .where(eq(solidifyBatchCases.batchId, batch.id));
  res.json({ batchId: batch.id, ...deriveBatchSummary(rows), cases: rows });
});
