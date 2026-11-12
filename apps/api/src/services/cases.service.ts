/**
 * Case/group domain service: shared by HTTP routes and the space AI tools.
 * Only data-integrity and ownership validation lives here (entity ∈ project/version/org);
 * user visibility (assertProjectVisible etc.) is the caller's job (HTTP boundary).
 */
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { caseTags, datasets, groups, planCases, planCaseGroups, productLines, projects, projectVersions, scenarios, tags, testCases, testSteps } from '../db/schema.js';
import type { AppRef } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';
import { resolveDatasetProjectId, resolveDeviceTargetProjectId, resolveEnvironmentProjectId, resolveVersionProjectId } from './projectAccess.js';
import { assertDatasetRowIndexes } from './datasets.service.js';
import { migrateAssertion, sanitizeAssertion } from '../lib/step-migration.js';
import { attachCreator } from '../lib/creator.js';
import { cache } from '../lib/cache.js';
import { casesForProjectKey } from '../lib/cache-keys.js';

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const STATUSES = ['draft', 'review', 'ready', 'deprecated'];

export async function groupProjectId(groupId: string): Promise<string | null> {
  const row = (await db.select({ projectId: groups.projectId }).from(groups).where(eq(groups.id, groupId)).limit(1))[0];
  return row?.projectId ?? null;
}

/** Invalidation entry for the case-list cache (GET /cases?projectId=). Silently skips when projectId is empty (entity no longer exists). */
export async function invalidateCasesCache(projectId: string | null | undefined): Promise<void> {
  if (!projectId) return;
  await cache.del(casesForProjectKey(projectId));
}

/** Resolves the owning project by caseId, then invalidates the list cache; silently skips when the case is gone. */
export async function invalidateCasesCacheForCase(caseId: string): Promise<void> {
  const row = (await db.select({ groupId: testCases.groupId }).from(testCases).where(eq(testCases.id, caseId)).limit(1))[0];
  if (!row) return;
  await invalidateCasesCache(await groupProjectId(row.groupId));
}

/** Verifies every tagId belongs to projectId's organization; missing → 404, cross-org → 400. */
export async function assertTagsBelongToOrg(tagIds: string[], projectId: string): Promise<void> {
  if (tagIds.length === 0) return;
  // The project's organization is derived from its product line (projects no longer has an organization_id column).
  const [proj] = await db
    .select({ organizationId: productLines.organizationId })
    .from(projects)
    .innerJoin(productLines, eq(productLines.id, projects.productLineId))
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!proj) throw new HttpError(404, 'not_found', 'project not found');
  const rows = await db.select({ id: tags.id, organizationId: tags.organizationId }).from(tags).where(inArray(tags.id, tagIds));
  const found = new Set(rows.map((r) => r.id));
  for (const id of tagIds) {
    if (!found.has(id)) throw new HttpError(404, 'not_found', `tag ${id} not found`);
  }
  const wrong = rows.filter((t) => t.organizationId !== proj.organizationId);
  if (wrong.length > 0) throw new HttpError(400, 'tag_org_mismatch', 'tag belongs to another organization');
}

/** Bulk-fetches all tags linked to caseIds, grouped by caseId. Returns an empty Map for an empty set. */
export async function tagsForCases(caseIds: string[]): Promise<Map<string, Array<{ id: string; name: string; color: string }>>> {
  const map = new Map<string, Array<{ id: string; name: string; color: string }>>();
  if (caseIds.length === 0) return map;
  const rows = await db
    .select({ caseId: caseTags.caseId, id: tags.id, name: tags.name, color: tags.color })
    .from(caseTags)
    .innerJoin(tags, eq(tags.id, caseTags.tagId))
    .where(inArray(caseTags.caseId, caseIds));
  for (const r of rows) {
    const arr = map.get(r.caseId) ?? [];
    arr.push({ id: r.id, name: r.name, color: r.color });
    map.set(r.caseId, arr);
  }
  return map;
}

function assertWindowCustom(v: { windowStrategy?: string; windowWidth?: number | null; windowHeight?: number | null }): void {
  if (v.windowStrategy === 'custom' && (!v.windowWidth || !v.windowHeight)) {
    throw new HttpError(400, 'window_required', 'windowWidth and windowHeight are required when windowStrategy is custom');
  }
}

function assertEnum(name: 'priority' | 'status', value: string, allowed: string[]): void {
  if (!allowed.includes(value)) throw new HttpError(400, `bad_${name}`, `invalid ${name}: ${value}`);
}

export interface CreateCaseInput {
  groupId: string;
  versionId: string;
  title: string;
  description?: string | null;
  priority?: string;
  url?: string | null;
  webServiceRef?: string | null;
  windowStrategy?: string;
  windowWidth?: number | null;
  windowHeight?: number | null;
  incognito?: boolean;
  requirementId?: string | null;
  /** Requirement number (free-text external number, not a requirements FK). Carried down by stage_case on the AI generation path. */
  requirementNo?: string | null;
  scenarioId?: string | null;
  tagIds?: string[];
  expectedOutcome?: string | null;
  /** This case's coverage types (a subset of COVERAGE_TYPE_KEYS); carried down by stage_case on the AI generation path. */
  coverageTypes?: string[];
  /** Bound dataset (space-assistant stage save path: the dataset is persisted first, then backfilled). */
  datasetId?: string | null;
  /** Creator (aligned with the plan_schedules.created_by_user_id convention); null when the caller doesn't pass it. */
  createdByUserId?: string | null;
}

export async function createCase(input: CreateCaseInput) {
  const pid = await groupProjectId(input.groupId);
  if (!pid) throw new HttpError(404, 'not_found', 'group not found');
  const vp = await resolveVersionProjectId(input.versionId);
  if (!vp) throw new HttpError(404, 'not_found', 'version not found');
  if (vp !== pid) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
  if (input.datasetId !== undefined && input.datasetId !== null) {
    const dsPid = await resolveDatasetProjectId(input.datasetId);
    if (!dsPid) throw new HttpError(404, 'not_found', 'dataset not found');
    if (dsPid !== pid) throw new HttpError(400, 'dataset_project_mismatch', 'dataset does not belong to this project');
  }
  if (input.priority !== undefined) assertEnum('priority', input.priority, PRIORITIES);
  assertWindowCustom(input);
  if (input.tagIds?.length) await assertTagsBelongToOrg(input.tagIds, pid);
  const { tagIds, ...values } = input;
  const created = (await db.insert(testCases).values(values).returning())[0]!;
  if (tagIds?.length) {
    await db.insert(caseTags).values(tagIds.map((tagId) => ({ caseId: created.id, tagId })));
  }
  await invalidateCasesCache(pid);
  const tagsByCase = await tagsForCases([created.id]);
  return { ...created, tags: tagsByCase.get(created.id) ?? [] };
}

export interface AiTaskInput {
  instruction: string;
  assertion?: string | null;
  /** Compiled DSL; missing/null counts as uncompiled, and the dispatcher blocks execution. */
  compiled?: unknown[] | null;
}

/** Creates a case and writes its steps.
 *  - Each step's instruction comes from input.instruction (natural language);
 *  - compiled is stored as-is: missing/null means "uncompiled", dispatcher throws compile-missing and the UI blocks execution.
 *    Vision mode must be explicitly supplied by the caller as [{kind:'aiTask',instruction}] — the server does no null→aiTask fallback,
 *    otherwise "abandoned / missed compilation" would silently become an executable AI step, masking the gap (same null semantics as stage-tools).
 *  - The old action column was DROPped in migration 0030; new code no longer writes it. */
export async function createCaseWithSteps(input: CreateCaseInput & { steps?: AiTaskInput[] }) {
  const created = await createCase(input);
  if (input.steps?.length) {
    const stepRows = input.steps.map((s) => {
      const compiled = (Array.isArray(s.compiled) ? s.compiled : null) as unknown[] | null;
      return {
        source: 'agent' as const,
        instruction: s.instruction,
        compiled,
        // Sanitize first: descriptive assertions ("login form renders correctly" etc.) → null, skipping the assertion at replay.
        // Then migrate: normalizes the old `{kind,text}` shape into the `{equals,target,match,locator}` dispatch understands.
        assertion: (() => {
          const clean = sanitizeAssertion(s.assertion);
          if (clean === null) return null;
          return migrateAssertion({ kind: 'assertText', text: clean }) as object;
        })(),
        sensitive: false,
      };
    });
    await db.insert(testSteps).values(
      stepRows.map((r, i) => ({
        caseId: created.id,
        order: i,
        source: r.source,
        instruction: r.instruction,
        compiled: r.compiled as unknown[] | null,
        assertion: r.assertion,
        sensitive: r.sensitive,
      })),
    );
  }
  return created;
}

export interface UpdateCasePatch {
  title?: string;
  description?: string | null;
  priority?: string;
  status?: string;
  url?: string | null;
  webServiceRef?: string | null;
  groupId?: string;
  scenarioId?: string | null;
  defaultEnvId?: string | null;
  datasetId?: string | null;
  /** Dataset row selection: an array of enabled-row indexes. [] = all enabled rows; null = clears the selection (equivalent to []). */
  datasetRowIndexes?: number[] | null;
  windowStrategy?: string;
  windowWidth?: number | null;
  windowHeight?: number | null;
  incognito?: boolean;
  tagIds?: string[];
  expectedOutcome?: string | null;
  requirementNo?: string | null;
  // 2026-10-07: mobile support
  platform?: 'web' | 'mobile';
  mobileOs?: 'ios' | 'android' | null;
  mobileDeviceTargetId?: string | null;
  appRef?: AppRef | null;
}

export async function updateCase(caseId: string, patch: UpdateCasePatch) {
  const existing = (await db.select().from(testCases).where(eq(testCases.id, caseId)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'case not found');
  // The case's current project always follows its group; when moving groups, the target group must stay in the same project
  const currentPid = await groupProjectId(existing.groupId);
  if (!currentPid) throw new HttpError(404, 'not_found', 'group not found');
  let targetPid = currentPid;
  if (patch.groupId !== undefined) {
    const nextPid = await groupProjectId(patch.groupId);
    if (!nextPid) throw new HttpError(404, 'not_found', 'group not found');
    if (nextPid !== currentPid) throw new HttpError(400, 'cross_project_move', 'cannot move a case to a group in another project');
    targetPid = nextPid;
  }
  if (patch.priority !== undefined) assertEnum('priority', patch.priority, PRIORITIES);
  if (patch.status !== undefined) assertEnum('status', patch.status, STATUSES);
  assertWindowCustom(patch);
  if (patch.scenarioId !== undefined && patch.scenarioId !== null) {
    const sc = (
      await db.select({ requirementId: scenarios.requirementId }).from(scenarios).where(eq(scenarios.id, patch.scenarioId)).limit(1)
    )[0];
    if (!sc) throw new HttpError(404, 'not_found', 'scenario not found');
    if (existing.requirementId !== sc.requirementId) {
      throw new HttpError(400, 'scenario_mismatch', "scenario does not belong to this case's requirement");
    }
  }
  if (patch.defaultEnvId !== undefined && patch.defaultEnvId !== null) {
    const envPid = await resolveEnvironmentProjectId(patch.defaultEnvId);
    if (!envPid) throw new HttpError(404, 'not_found', 'environment not found');
    if (envPid !== targetPid) throw new HttpError(400, 'env_project_mismatch', 'environment does not belong to this project');
  }
  if (patch.datasetId !== undefined && patch.datasetId !== null) {
    const dsPid = await resolveDatasetProjectId(patch.datasetId);
    if (!dsPid) throw new HttpError(404, 'not_found', 'dataset not found');
    if (dsPid !== targetPid) throw new HttpError(400, 'dataset_project_mismatch', 'dataset does not belong to this project');
  }
  // Dataset row selection interacts with datasetId:
  //  - selection explicitly sent → the request wins (the frontend's "switch dataset then pick rows, save once" must persist)
  //  - no selection sent and the dataset changed (including unbinding) → clear (the index space belongs to the old dataset)
  //  - selected indexes must fall within the target dataset's enabled-row range
  //  null = clear (normalized to []); undefined = untouched.
  let datasetRowIndexes = patch.datasetRowIndexes;
  if (datasetRowIndexes === undefined) {
    if (patch.datasetId !== undefined && patch.datasetId !== existing.datasetId) {
      datasetRowIndexes = [];
    }
  } else if (datasetRowIndexes === null) {
    datasetRowIndexes = [];
  }
  if (datasetRowIndexes && datasetRowIndexes.length > 0) {
    await assertDatasetRowIndexes(patch.datasetId ?? existing.datasetId, datasetRowIndexes);
  }
  // 2026-10-07: mobile device target cross-project assertion (service-level fallback)
  if (patch.mobileDeviceTargetId !== undefined && patch.mobileDeviceTargetId !== null) {
    const dtPid = await resolveDeviceTargetProjectId(patch.mobileDeviceTargetId);
    if (!dtPid) throw new HttpError(404, 'not_found', 'device target not found');
    if (dtPid !== targetPid) throw new HttpError(400, 'device_target_project_mismatch', 'device target does not belong to this project');
  }
  if (patch.tagIds !== undefined) await assertTagsBelongToOrg(patch.tagIds, targetPid);
  // Dataset switched/unbound: this case's row-level overrides in every plan are cleared together (the index space belongs to the old dataset).
  // Plan level is set null (following case level), triggered alongside the case-level clear; case deletion needs nothing (plan_cases.caseId FK CASCADE).
  // When the case is referenced by a group's login prepare, login_dataset_row_indexes is cleared by the same criteria.
  if (patch.datasetId !== undefined && patch.datasetId !== existing.datasetId) {
    await db.update(planCases).set({ datasetRowIndexes: null }).where(eq(planCases.caseId, caseId));
    await db.update(planCaseGroups).set({ loginDatasetRowIndexes: null }).where(eq(planCaseGroups.loginCaseId, caseId));
  }
  const { tagIds, datasetRowIndexes: _ignored, ...rest } = patch;
  const updated = (await db.update(testCases).set({
    ...rest,
    ...(datasetRowIndexes !== undefined ? { datasetRowIndexes } : {}),
    updatedAt: new Date(),
  }).where(eq(testCases.id, caseId)).returning())[0]!;
  if (tagIds !== undefined) {
    await db.delete(caseTags).where(eq(caseTags.caseId, caseId));
    if (tagIds.length > 0) {
      await db.insert(caseTags).values(tagIds.map((tagId) => ({ caseId, tagId })));
    }
  }
  const tagsByCase = await tagsForCases([caseId]);
  await invalidateCasesCache(targetPid);
  return { ...updated, tags: tagsByCase.get(caseId) ?? [] };
}

export async function deleteCase(caseId: string): Promise<void> {
  // Project ownership must be resolved before the delete: once the row is gone the group chain is broken and invalidation has nothing to work from
  const existing = (await db.select({ groupId: testCases.groupId }).from(testCases).where(eq(testCases.id, caseId)).limit(1))[0];
  const deleted = await db.delete(testCases).where(eq(testCases.id, caseId)).returning({ id: testCases.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  await invalidateCasesCache(existing ? await groupProjectId(existing.groupId) : null);
}

/** Single-step patch: the write-back channel for the AI compile assistant.
 *  - Only instruction / compiled allowed; all other columns (sensitive values / source / order / tab_ref) go through the existing
 *    write paths, avoiding a bypass of the tools-registry boundary.
 *  - After persisting, returns the row + old instruction concatenated with the short instruction (keeps the old value when the new instruction is empty). */
export async function updateCaseStep(stepId: string, patch: { compiled?: unknown[] | null; instruction?: string }) {
  const row = (await db.select().from(testSteps).where(eq(testSteps.id, stepId)).limit(1))[0];
  if (!row) throw new HttpError(404, 'not_found', 'step not found');
  const set: Partial<{ compiled: unknown[] | null; instruction: string }> = {};
  if (patch.compiled !== undefined) set.compiled = patch.compiled === null ? null : patch.compiled;
  if (patch.instruction !== undefined) set.instruction = patch.instruction;
  if (Object.keys(set).length === 0) return row;
  const [updated] = await db.update(testSteps).set(set).where(eq(testSteps.id, stepId)).returning();
  await invalidateCasesCacheForCase(row.caseId);
  return updated ?? row;
}

/** Single-step insert (AI assistant + later reordering): inserts after afterOrder (when given), otherwise appends to the end.
 *  Reuses the testSteps order column's contiguous-compact semantics; after persisting, steps after afterOrder get order +1. */
export async function insertCaseStep(
  caseId: string,
  body: { instruction: string; compiled?: unknown[] | null; afterOrder?: number; source?: string },
) {
  const rows = await db
    .select({ id: testSteps.id, order: testSteps.order })
    .from(testSteps)
    .where(eq(testSteps.caseId, caseId))
    .orderBy(asc(testSteps.order));
  const maxOrder = rows.length > 0 ? Math.max(...rows.map((r) => r.order)) : 0;
  const targetOrder = body.afterOrder !== undefined ? body.afterOrder + 1 : maxOrder + 1;
  const [inserted] = await db
    .insert(testSteps)
    .values({
      caseId,
      order: targetOrder,
      source: body.source ?? 'agent',
      instruction: body.instruction,
      compiled: body.compiled ?? null,
    })
    .returning();
  // Compact the following steps' order (shift every row from targetOrder on by +1)
  const after = rows.filter((r) => r.order >= targetOrder);
  for (let i = 0; i < after.length; i++) {
    await db.update(testSteps).set({ order: targetOrder + 1 + i }).where(eq(testSteps.id, after[i]!.id));
  }
  await invalidateCasesCacheForCase(caseId);
  return inserted!;
}

/** Detail: steps sanitized (secret-triplet columns stripped) + resolved entry URL + tags. Returns null when missing. */
export async function getCaseDetail(caseId: string) {
  const row = (await db.select().from(testCases).where(eq(testCases.id, caseId)).limit(1))[0];
  if (!row) return null;
  const steps = await db.select().from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order));
  const sanitizedSteps = steps.map(({ secretCiphertext: _sc, secretIv: _si, secretTag: _st, ...rest }) => rest);
  const resolvedUrl = await resolveCaseUrl(row, { defaultEnvFallback: true });
  const tagsByCase = await tagsForCases([caseId]);
  return attachCreator({ ...row, steps: sanitizedSteps, resolvedUrl, tags: tagsByCase.get(caseId) ?? [] });
}

export async function searchCasesInVersion(versionId: string, o: { keyword?: string; groupId?: string; limit?: number } = {}) {
  const rows = await db
    .select({
      id: testCases.id,
      title: testCases.title,
      description: testCases.description,
      expectedOutcome: testCases.expectedOutcome,
      priority: testCases.priority,
      status: testCases.status,
      groupId: testCases.groupId,
      scenarioId: testCases.scenarioId,
      url: testCases.url,
      webServiceRef: testCases.webServiceRef,
      defaultEnvId: testCases.defaultEnvId,
      updatedAt: testCases.updatedAt,
    })
    .from(testCases)
    .where(eq(testCases.versionId, versionId))
    .orderBy(asc(testCases.createdAt));
  let out = rows;
  if (o.groupId) out = out.filter((r) => r.groupId === o.groupId);
  const kw = o.keyword?.trim().toLowerCase();
  if (kw) {
    // Recall covers more than titles: when the AI searches for similar cases before authoring, business objects/action words often land in
    // step instructions, expected outcomes, and tags. Pull this version's step texts and tag names back in one shot and match in memory;
    // the return shape is unchanged (list items still don't carry full step text).
    const ids = out.map((r) => r.id);
    const [stepRows, tagRows] = await Promise.all([
      ids.length
        ? db.select({ caseId: testSteps.caseId, instruction: testSteps.instruction }).from(testSteps).where(inArray(testSteps.caseId, ids))
        : Promise.resolve([] as Array<{ caseId: string; instruction: string | null }>),
      ids.length
        ? db.select({ caseId: caseTags.caseId, name: tags.name }).from(caseTags).innerJoin(tags, eq(tags.id, caseTags.tagId)).where(inArray(caseTags.caseId, ids))
        : Promise.resolve([] as Array<{ caseId: string; name: string }>),
    ]);
    const stepText = new Map<string, string>();
    for (const s of stepRows) stepText.set(s.caseId, `${stepText.get(s.caseId) ?? ''}\n${s.instruction ?? ''}`);
    const tagText = new Map<string, string>();
    for (const t of tagRows) tagText.set(t.caseId, `${tagText.get(t.caseId) ?? ''}\n${t.name}`);
    out = out.filter(
      (r) =>
        r.title.toLowerCase().includes(kw) ||
        (r.description ?? '').toLowerCase().includes(kw) ||
        (r.expectedOutcome ?? '').toLowerCase().includes(kw) ||
        (stepText.get(r.id) ?? '').includes(kw) ||
        (tagText.get(r.id) ?? '').includes(kw),
    );
  }
  const limited = out.slice(0, o.limit ?? 50);
  return await Promise.all(
    limited.map(async (r) => ({
      // description/expectedOutcome only feed recall matching, not list items (full text via get; the list shape stays unchanged)
      id: r.id,
      title: r.title,
      priority: r.priority,
      status: r.status,
      groupId: r.groupId,
      scenarioId: r.scenarioId,
      url: r.url,
      webServiceRef: r.webServiceRef ?? null,
      defaultEnvId: r.defaultEnvId,
      updatedAt: r.updatedAt,
      resolvedUrl: await resolveCaseUrl(r, { defaultEnvFallback: true }),
    })),
  );
}

export async function createGroup(projectId: string, input: { name: string }) {
  const p = (await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!p) throw new HttpError(404, 'not_found', 'project not found');
  return (await db
    .insert(groups)
    .values({ projectId, name: input.name })
    .returning())[0]!;
}

export async function getGroup(groupId: string) {
  return (await db.select().from(groups).where(eq(groups.id, groupId)).limit(1))[0] ?? null;
}

export async function updateGroup(groupId: string, patch: { name: string }) {
  return (await db.update(groups).set({ name: patch.name, updatedAt: new Date() }).where(eq(groups.id, groupId)).returning())[0]!;
}

/** Case count under a group (the not_empty gate before delete, aligned with the web 409 semantics). */
export async function countGroupCases(groupId: string): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)` }).from(testCases).where(eq(testCases.groupId, groupId));
  return Number(rows[0]?.count ?? 0);
}

export async function deleteGroup(groupId: string): Promise<void> {
  const deleted = await db.delete(groups).where(eq(groups.id, groupId)).returning({ id: groups.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'group not found');
}

export async function listVersionsForProject(projectId: string) {
  return db
    .select({ id: projectVersions.id, name: projectVersions.name, ref: projectVersions.ref, refKind: projectVersions.refKind })
    .from(projectVersions)
    .where(eq(projectVersions.projectId, projectId))
    .orderBy(asc(projectVersions.createdAt));
}

function nextCopyTitle(base: string, existing: string[]): string {
  const taken = new Set(existing);
  const first = `${base} 副本`;
  if (!taken.has(first)) return first;
  let n = 1;
  while (taken.has(`${base} 副本${n}`)) n++;
  return `${base} 副本${n}`;
}

export interface CopyCaseInput {
  caseId: string;
  targetGroupId: string;
  /** null = keep the source case's version (same-version copy). */
  targetVersionId: string | null;
}

/** Copies a case to the target group (may cross versions): clones steps (instruction/compiled/assertion) and tag links, appending "副本 N" (copy N) to the title.
 *  Purely mechanical copying; source/target existence and visibility are the caller's job (HTTP boundary checks per-user, AI tools check project ownership).
 *  createdByUserId = the user performing the copy (the copy's creator). */
export async function copyCaseCore({ caseId, targetGroupId, targetVersionId }: CopyCaseInput, createdByUserId?: string | null) {
  const src = (await db.select().from(testCases).where(eq(testCases.id, caseId)).limit(1))[0];
  if (!src) throw new HttpError(404, 'not_found', 'case not found');
  const siblings = await db.select({ title: testCases.title }).from(testCases).where(eq(testCases.groupId, targetGroupId));
  const title = nextCopyTitle(src.title, siblings.map((s) => s.title));
  // The target group's project: project-bound objects (dataset/device/environment) travel with the copy only if they live in the target project.
  const targetGroupRow = (await db
    .select({ projectId: groups.projectId })
    .from(groups)
    .where(eq(groups.id, targetGroupId))
    .limit(1))[0];
  const targetProjectId = targetGroupRow?.projectId ?? null;
  /** Whether the source object belongs to the target project; on cross-project copies these bindings are all nulled, so the copy never points at another project's resources. */
  const ownedByTarget = async (ownerProjectId: string | null | undefined): Promise<boolean> =>
    !!targetProjectId && !!ownerProjectId && ownerProjectId === targetProjectId;
  // Dataset binding travels with the copy: carried only when the source dataset is in the same project as the target group (not carried cross-project; nulled, falling back to single-run).
  let datasetId: string | null = null;
  // Row selection travels with the dataset binding: the same dataset shares one index space, so losing the binding cross-project drops the selection too.
  let datasetRowIndexes: number[] = [];
  if (src.datasetId) {
    const srcDs = (await db
      .select({ projectId: datasets.projectId })
      .from(datasets)
      .where(eq(datasets.id, src.datasetId))
      .limit(1))[0];
    if (await ownedByTarget(srcDs?.projectId)) {
      datasetId = src.datasetId;
      datasetRowIndexes = [...(src.datasetRowIndexes ?? [])];
    }
  }
  // Same for the default environment: environments are project-scoped resources; a cross-project reference gets blocked at execution by "environment does not belong to this project".
  let defaultEnvId: string | null = null;
  if (src.defaultEnvId) {
    const envPid = await resolveEnvironmentProjectId(src.defaultEnvId);
    if (await ownedByTarget(envPid)) defaultEnvId = src.defaultEnvId;
  }
  // Same for the device target (mobile).
  let mobileDeviceTargetId: string | null = null;
  if (src.mobileDeviceTargetId) {
    const dtPid = await resolveDeviceTargetProjectId(src.mobileDeviceTargetId);
    if (await ownedByTarget(dtPid)) mobileDeviceTargetId = src.mobileDeviceTargetId;
  }
  const inserted = await db
    .insert(testCases)
    .values({
      title,
      description: src.description,
      // The requirement number is this case's own descriptive attribute; travels with the copy.
      requirementNo: src.requirementNo,
      priority: src.priority,
      groupId: targetGroupId,
      versionId: targetVersionId ?? src.versionId,
      url: src.url,
      datasetId,
      datasetRowIndexes,
      // Case-level semantics travel with the copy: expected outcome and coverage types describe this case itself.
      expectedOutcome: src.expectedOutcome,
      coverageTypes: src.coverageTypes,
      // Window/incognito mode: execution parameters, equally valid cross-project.
      windowStrategy: src.windowStrategy,
      windowWidth: src.windowWidth,
      windowHeight: src.windowHeight,
      incognito: src.incognito,
      // Mobile config: the device target is a project-scoped resource, carried only when it lives in the target project (nulled otherwise);
      // appRef/bundleId identify the app itself and remain usable cross-project.
      platform: src.platform,
      mobileOs: src.mobileOs,
      mobileDeviceTargetId,
      appRef: src.appRef,
      // Environment-side bindings (default env / named web service) point at project-scoped environment objects:
      // nulled on cross-project copies — otherwise the copy would point at another project's environment and execution fails with "environment does not belong to this project".
      defaultEnvId,
      webServiceRef: defaultEnvId ? src.webServiceRef : null,
      ...(createdByUserId ? { createdByUserId } : {}),
    })
    .returning();
  const newCase = inserted[0]!;
  const steps = await db.select().from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order));
  if (steps.length > 0) {
    await db.insert(testSteps).values(
      steps.map((s) => ({
        caseId: newCase.id,
        order: s.order,
        source: s.source,
        instruction: s.instruction,
        compiled: s.compiled,
        assertion: s.assertion,
        // The sensitive step's ciphertext triplet is cloned too: otherwise the copy's sensitive fields become "sensitive but valueless" and the recorder can't fetch the ciphertext.
        sensitive: s.sensitive,
        secretCiphertext: s.secretCiphertext,
        secretIv: s.secretIv,
        secretTag: s.secretTag,
        mobileOs: s.mobileOs,
        tabRef: s.tabRef,
        delayMs: s.delayMs,
        componentKind: s.componentKind,
      })),
    );
  }
  const srcTagRows = await db.select({ tagId: caseTags.tagId }).from(caseTags).where(eq(caseTags.caseId, caseId));
  if (srcTagRows.length > 0) {
    await db.insert(caseTags).values(srcTagRows.map((r) => ({ caseId: newCase.id, tagId: r.tagId })));
  }
  // On cross-project copies the source project's list is unchanged; only the target project needs invalidation
  await invalidateCasesCache(targetProjectId);
  return newCase;
}
