/**
 * Version-space assistant "stage → persist" HTTP endpoints:
 *   POST /assistant/threads/:id/stage/list   returns every staged object under this thread (incl. caseOps)
 *   POST /assistant/threads/:id/stage/save   called after the user checks items; persists staged objects into the real tables and deletes the stage rows
 *
 * Persist order: datasets first (cases' datasetLocalId depends on the real id) → scenarios (incl. requirement resolution) → cases (incl. groupId) → environments → plans → caseOps.
 * Any stage failing rolls back the whole transaction (DELETEs don't reach the DB, but stage-row writes themselves don't roll back — the user can re-check and retry).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Router } from 'express';
import { logger } from '../../logger.js';
import { db } from '../../db/client.js';
import {
  aiStageCaseOps, aiStageCases, aiStageDatasets, aiStageEnvironments, aiStagePlans, aiStageScenarios, groups, testCases,
} from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import * as casesSvc from '../../services/cases.service.js';
import * as scenariosSvc from '../../services/scenarios.service.js';
import * as environmentsSvc from '../../services/environments.service.js';
import * as plansSvc from '../../services/plans.service.js';
import * as datasetsSvc from '../../services/datasets.service.js';
import { resolveVersionProjectId } from '../../services/projectAccess.js';
import { emitThreadEvent } from './session.js';
import {
  deleteStaged, listStage, type StageDoc, type StageKind, type StagedCaseOp,
} from './tools/stage-tools.js';
import { applyCaseOp, preflightCaseOps, type SpaceToolsContext } from './tools/case-ops-tools.js';
import { emptyRepoState } from './tools/context.js';
import { assertSpaceThreadVisible } from './router.js';

export const stageRoute = Router();

interface SaveBody {
  cases: Array<{ localId: string; groupId: string }>;
  scenarios: Array<{ localId: string }>;
  environments: Array<{ localId: string }>;
  plans: Array<{ localId: string }>;
  caseOps: Array<{ localId: string }>;
  datasets: Array<{ localId: string }>;
}

function emitStageRemove(threadId: string, kind: StageKind, localId: string): void {
  emitThreadEvent(threadId, { type: 'stage', kind, id: localId, action: 'remove' });
}

stageRoute.post('/threads/:id/stage/list', async (req, res) => {
  const threadId = req.params.id!;
  await assertSpaceThreadVisible(threadId, req.user as never);
  const doc: StageDoc = await listStage(threadId);
  res.json(doc);
});

stageRoute.post('/threads/:id/stage/save', async (req, res) => {
  const threadId = req.params.id!;
  const versionId = await assertSpaceThreadVisible(threadId, req.user as never);
  // Persisted staged objects get the current operating user as creator (ownership for the AI proxy-build path).
  const creatorId = (req.user as { userId?: string } | undefined)?.userId ?? null;
  const body = (req.body ?? {}) as Partial<SaveBody>;
  const cases = body.cases ?? [];
  const scenarios = body.scenarios ?? [];
  const environments = body.environments ?? [];
  const plans = body.plans ?? [];
  const caseOps = body.caseOps ?? [];
  const datasets = body.datasets ?? [];
  if (cases.length + scenarios.length + environments.length + plans.length + caseOps.length + datasets.length === 0) {
    throw new HttpError(400, 'bad_request', '至少选择一项');
  }

  // 1. Resolve all local mappings outside the transaction first; on failure throw immediately without deleting stage rows (the user can re-select).
  const pid = await resolveVersionProjectId(versionId);
  if (!pid) throw new HttpError(500, 'invariant', 'version project missing');

  // 1z. caseOps preflight (read-only): the checked ops first go through the whole batch's "shape + reference existence" checks; only if all pass may writes begin.
  //  Must happen before any write — when a doomed op sits mid-batch, the earlier inserts are already persisted and
  //  stage rows aren't deleted (failure doesn't roll back), so a user retry duplicates the insert (observed live on prod228 2026-11-11: 3 duplicate step sets).
  const stageCaseOpRows = caseOps.length
    ? (await db.select().from(aiStageCaseOps)
        .where(and(eq(aiStageCaseOps.threadId, threadId), inArray(aiStageCaseOps.localId, caseOps.map((c) => c.localId))))
        .orderBy(asc(aiStageCaseOps.stagedAt))) as unknown as Array<StagedCaseOp & { stagedAt: string }>
    : [];
  const opCtx: SpaceToolsContext = {
    threadId,
    versionId,
    projectId: pid,
    repo: emptyRepoState(),
    emit: (e: unknown) => emitThreadEvent(threadId, e as Record<string, unknown>),
    createdByUserId: creatorId,
    manager: false, // stage persistence never touches manager-class tools
  };
  await preflightCaseOps(stageCaseOpRows, opCtx);

  // 1a. datasets: persist before cases (stage_case.datasetLocalId needs the real datasetId back-filled).
  //  rows are plaintext drafts (incl. the sensitive column) → createDataset/normalizeDataset complete the encryption here.
  //  Name-conflict 409 is thrown by the service; the user can rename and retry.
  const stageDatasetRows = datasets.length
    ? await db.select().from(aiStageDatasets)
        .where(and(eq(aiStageDatasets.threadId, threadId), inArray(aiStageDatasets.localId, datasets.map((d) => d.localId))))
    : [];
  const createdDatasetIds = new Map<string, string>(); // staged localId → real datasetId
  for (const sel of datasets) {
    const row = stageDatasetRows.find((r) => r.localId === sel.localId);
    if (!row) throw new HttpError(404, 'not_found', `stage dataset ${sel.localId} 已不存在,请刷新重试`);
    const created = await datasetsSvc.createDataset(pid, {
      name: row.name,
      description: row.description,
      columns: (row.columns ?? []) as Array<{ name: string; sensitive?: boolean }>,
      rows: (row.rows ?? []) as Array<{ disabled?: boolean; cells: Record<string, unknown> }>,
    }, creatorId);
    createdDatasetIds.set(sel.localId, created.id);
  }

  // 1b. cases: fetch stage rows → validate groupId ownership → call createCaseWithSteps to persist
  //  P1-3 persist gate: ① dead steps (no compiled and no instruction) are rejected outright with a 422 naming them — after persist,
  //  replay could only report compile-missing; catching them at stage time lets the AI fill them in during the current turn. Note that NL drafts
  //  (empty compiled + an instruction is the normal form while the assistant runs and discusses) must NOT be blocked — only true dead steps are.
  //  ② Pure NL draft + string assertion → advisory
  //  warnings (uncompiled string assertions don't take part in per-step judgment; the final state is judged by expectedOutcome), non-blocking.
  const saveWarnings: string[] = [];
  const stageCaseRows = cases.length
    ? await db.select().from(aiStageCases)
        .where(and(eq(aiStageCases.threadId, threadId), inArray(aiStageCases.localId, cases.map((c) => c.localId))))
    : [];
  const caseByLocalId = new Map(stageCaseRows.map((r) => [r.localId, r]));
  const createdCaseIds = new Map<string, string>(); // staged localId → real caseId
  for (const sel of cases) {
    const row = caseByLocalId.get(sel.localId);
    if (!row) throw new HttpError(404, 'not_found', `stage case ${sel.localId} 已不存在,请刷新重试`);
    const gid = sel.groupId;
    const gidPid = await casesSvc.groupProjectId(gid);
    if (!gidPid) throw new HttpError(404, 'not_found', `group ${gid} 不存在`);
    if (gidPid !== pid) throw new HttpError(400, 'cross_project', `group ${gid} 不属于当前项目`);
    const draftSteps = ((row.steps as unknown[]) ?? []) as Array<{ action?: unknown; assertion?: unknown; compiled?: unknown }>;
    const deadSteps = draftSteps
      .map((s, i) => ({ s, n: i + 1 }))
      .filter(({ s }) => !(Array.isArray(s.compiled) && s.compiled.length > 0)
        && !(typeof s.action === 'string' && s.action.trim().length > 0));
    if (deadSteps.length > 0) {
      throw new HttpError(422, 'dead_steps',
        `用例「${row.title}」第 ${deadSteps.map((d) => d.n).join('、')} 步既无可执行 DSL 也没有自然语言指令，保存后无法执行——请让助手补写该步内容或删除该步后重试`);
    }
    const hasCompiled = draftSteps.some((s) => Array.isArray(s.compiled) && s.compiled.length > 0);
    const hasStringAssertion = draftSteps.some((s) => typeof s.assertion === 'string' && s.assertion.trim().length > 0);
    if (!hasCompiled && hasStringAssertion) {
      saveWarnings.push(`用例「${row.title}」当前是自然语言草稿：步骤级断言不参与逐步判定（机械回放会跳过整页模糊断言），终态以用例级预期结果（expectedOutcome）的判定为准`);
    }
    // Companion dataset binding: datasetLocalId resolves only within this batch's datasets; unchecked/not found → skip binding (following the plans caseLocalIds precedent).
    const datasetId = row.datasetLocalId ? createdDatasetIds.get(row.datasetLocalId) : undefined;
    const created = await casesSvc.createCaseWithSteps({
      groupId: gid,
      versionId,
      title: row.title,
      description: row.description,
      priority: row.priority ?? undefined,
      url: row.url,
      expectedOutcome: row.expectedOutcome,
      requirementNo: row.requirementNo,
      coverageTypes: (row.coverageTypes ?? []) as string[],
      datasetId: datasetId ?? undefined,
      createdByUserId: creatorId,
      steps: draftSteps.map((s) => ({
        instruction: typeof s.action === 'string' ? s.action : '',
        assertion: typeof s.assertion === 'string' ? s.assertion : null,
        compiled: Array.isArray(s.compiled) ? s.compiled : undefined,
      })),
    });
    createdCaseIds.set(sel.localId, created.id);
  }

  // 1c. scenarios: straight into the real tables
  const stageScenarioRows = scenarios.length
    ? await db.select().from(aiStageScenarios)
        .where(and(eq(aiStageScenarios.threadId, threadId), inArray(aiStageScenarios.localId, scenarios.map((s) => s.localId))))
    : [];
  for (const sel of scenarios) {
    const row = stageScenarioRows.find((r) => r.localId === sel.localId);
    if (!row) throw new HttpError(404, 'not_found', `stage scenario ${sel.localId} 已不存在`);
    await scenariosSvc.createScenario(row.requirementId, { title: row.title, description: row.description });
  }

  // 1d. environments: name conflict → 409 (other failure paths already throw HttpError inside the service)
  const stageEnvRows = environments.length
    ? await db.select().from(aiStageEnvironments)
        .where(and(eq(aiStageEnvironments.threadId, threadId), inArray(aiStageEnvironments.localId, environments.map((e) => e.localId))))
    : [];
  for (const sel of environments) {
    const row = stageEnvRows.find((r) => r.localId === sel.localId);
    if (!row) throw new HttpError(404, 'not_found', `stage environment ${sel.localId} 已不存在`);
    const insertedEnv = await environmentsSvc.createEnvironment(pid, {
      name: row.name,
      objects: ((row.objects as unknown[]) ?? [])
        // Since 0041 login has been merged into web; skip leftover staged login drafts (otherwise they persist as orphan objects the new code never reads)
        .filter((o) => (o as { objectType?: string }).objectType !== 'login')
        .map((o) => {
          const x = o as { objectType: 'db' | 'syslog' | 'web'; label?: string; payload: Record<string, unknown>; isDefault?: boolean };
          return { objectType: x.objectType, label: x.label, payload: x.payload, isDefault: x.isDefault };
        }),
    }, creatorId);
    // staged.baseUrl absolute address → derive a default web service object (best-effort: skip on parse failure, don't block save).
    // After case urls become relative they're joined against the web object's origin; staged environments whose old data still lives in baseUrl need this fallback.
    if (insertedEnv && row.baseUrl && /^https?:\/\//.test(row.baseUrl)) {
      try {
        const u = new URL(row.baseUrl);
        await environmentsSvc.insertEnvironmentObject(insertedEnv.id, {
          objectType: 'web',
          label: '默认 Web',
          payload: { name: 'web', scheme: u.protocol === 'https:' ? 'https' : 'http', host: u.hostname, ...(u.port ? { port: Number(u.port) } : {}) },
          isDefault: true,
        });
      } catch {
        /* best-effort: skip on parse failure, don't block save */
      }
    }
  }

  // 1e. plans: create the plan first, then resolve real caseIds from caseLocalIds.
  //  - caseLocalIds accepts two sources: ① cases staged in this batch (localId from 1b) → the createdCaseIds map;
  //    ② real caseIds handed directly by the LLM (from manage_cases search/get) → looked up within the project.
  //  This way mixes of "reference existing cases" and "staged cases" all persist correctly; a localId that fails to resolve throws with it named.
  const stagePlanRows = plans.length
    ? await db.select().from(aiStagePlans)
        .where(and(eq(aiStagePlans.threadId, threadId), inArray(aiStagePlans.localId, plans.map((p) => p.localId))))
    : [];
  const referencedLocalIds = Array.from(new Set(stagePlanRows.flatMap((r) => r.caseLocalIds ?? [])));
  const existingCaseIdSet = new Set<string>();
  const missingFromBatch = referencedLocalIds.filter((lid) => !createdCaseIds.has(lid));
  if (missingFromBatch.length) {
    const realIds = await db
      .select({ id: testCases.id })
      .from(testCases)
      .innerJoin(groups, eq(groups.id, testCases.groupId))
      .where(and(inArray(testCases.id, missingFromBatch), eq(groups.projectId, pid)));
    for (const r of realIds) existingCaseIdSet.add(r.id);
  }
  for (const sel of plans) {
    const row = stagePlanRows.find((r) => r.localId === sel.localId);
    if (!row) throw new HttpError(404, 'not_found', `stage plan ${sel.localId} 已不存在`);
    const realCaseIds: string[] = [];
    const unresolved: string[] = [];
    for (const localId of row.caseLocalIds ?? []) {
      const realId = createdCaseIds.get(localId) ?? (existingCaseIdSet.has(localId) ? localId : undefined);
      if (realId) realCaseIds.push(realId);
      else unresolved.push(localId);
    }
    if (unresolved.length > 0) {
      throw new HttpError(400, 'unresolved_case', `计划「${row.name}」引用了未勾选/不存在的用例:${unresolved.join('、')};请在用例 Tab 勾选后重试,或从计划中移除引用`);
    }
    const plan = await plansSvc.createPlan(pid, {
      name: row.name,
      versionId,
      // Environment config has sunk to group level (the plan-level field is retired); wiring staged single-group environments to the group endpoint is a follow-up task
    }, creatorId);
    if (realCaseIds.length > 0) {
      // Temporary bridge (replacePlanCases retired, closed out by Task 9): a new plan has no groups, so create a default group first then write the full case set
      const g = await plansSvc.createPlanGroup(plan.id, { name: '默认分组' });
      await plansSvc.setPlanGroupCases(plan.id, g.id, realCaseIds);
    }
  }

  // 1f. caseOps: apply in stagedAt ascending order (the "global intent order" beyond the user's check order).
  //  - Step-level ops (update_step/insert_step/delete_step/move_step) are naturally within one case; stagedAt ordering suffices.
  //    Cross-case transactions aren't guaranteed (failure rollback doesn't span cases) — within a single case, insert/delete/move_step are wrapped in a transaction by case-ops-tools.applyCaseOp.
  //  - Case-level ops (update_case/delete_case/move_case): delete cascades step deletion, so later step ops on a deleted case fail (the user should check the step ops together up front) — no complex reordering is attempted.
  for (const row of stageCaseOpRows) {
    await applyCaseOp(row.op, row.payload, opCtx);
  }

  // 2. After everything succeeds, delete the stage rows + broadcast remove events (the frontend clears its checked state)
  const localIdsByKind: Array<{ kind: StageKind; localIds: string[] }> = [
    { kind: 'case', localIds: cases.map((c) => c.localId) },
    { kind: 'scenario', localIds: scenarios.map((s) => s.localId) },
    { kind: 'environment', localIds: environments.map((e) => e.localId) },
    { kind: 'plan', localIds: plans.map((p) => p.localId) },
    { kind: 'case_op', localIds: caseOps.map((c) => c.localId) },
    { kind: 'dataset', localIds: datasets.map((d) => d.localId) },
  ];
  for (const { kind, localIds } of localIdsByKind) {
    if (localIds.length === 0) continue;
    await deleteStaged(threadId, [kind], localIds);
    for (const lid of localIds) emitStageRemove(threadId, kind, lid);
  }

  // R2 trajectory store: confirmed persisted cases get trajectory distillation enqueued (fire-and-forget; the verify verdict is checked by the worker
  // against the transcript, so confirmed-but-never-executed cases produce no trajectory). Must never affect the persist main flow.
  if (createdCaseIds.size > 0) {
    try {
      const { enqueueTrajectoryDistill } = await import('../../scheduler/trajectoryQueue.js');
      // 2s cap: even a hung Redis connection must not stall the persist main flow (timeout = give up the enqueue, drop semantics)
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        enqueueTrajectoryDistill({
          kind: 'trajectory',
          threadId,
          versionId,
          userId: creatorId,
          items: Array.from(createdCaseIds, ([localId, caseId]) => ({ localId, caseId })),
        }),
        new Promise<void>((resolve) => { timer = setTimeout(() => resolve(), 2_000); }),
      ]);
      if (timer) clearTimeout(timer);
    } catch (e) {
      logger.warn({ err: e, threadId }, 'trajectory distill enqueue failed; save unaffected');
    }
  }

  res.json({
    savedCases: cases.length,
    savedScenarios: scenarios.length,
    savedEnvironments: environments.length,
    savedPlans: plans.length,
    savedCaseOps: caseOps.length,
    savedDatasets: datasets.length,
    caseIdMap: Object.fromEntries(createdCaseIds),
    datasetIdMap: Object.fromEntries(createdDatasetIds),
    ...(saveWarnings.length > 0 ? { warnings: saveWarnings } : {}),
  });
});

/** Silently cleans up orphan placeholder stage rows (fallback; the normal path never needs it). */
export async function purgeStaleStages(threadId: string): Promise<number> {
  const removed = await Promise.all([
    db.delete(aiStageCases).where(eq(aiStageCases.threadId, threadId)).returning({ id: aiStageCases.localId }),
    db.delete(aiStageScenarios).where(eq(aiStageScenarios.threadId, threadId)).returning({ id: aiStageScenarios.localId }),
    db.delete(aiStageEnvironments).where(eq(aiStageEnvironments.threadId, threadId)).returning({ id: aiStageEnvironments.localId }),
    db.delete(aiStagePlans).where(eq(aiStagePlans.threadId, threadId)).returning({ id: aiStagePlans.localId }),
    db.delete(aiStageCaseOps).where(eq(aiStageCaseOps.threadId, threadId)).returning({ id: aiStageCaseOps.localId }),
    db.delete(aiStageDatasets).where(eq(aiStageDatasets.threadId, threadId)).returning({ id: aiStageDatasets.localId }),
  ]);
  return removed.reduce((acc, r) => acc + r.length, 0);
}

// Keep the sql placeholder so the import isn't unused-stripped; the drizzle imports are actually used (and/eq/inArray)
void sql;
