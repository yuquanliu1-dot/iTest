/**
 * Batch solidification job: for web cases whose steps are all unsolidified, runs backend solidify (NL→DSL) → persists → mechanical acceptance.
 * No session agent involved: calls buildSolidifyCaseTool/buildVerifyCaseTool directly (pure caseId in / JSON out),
 * with a synthetic ctx (threadId=batch-<batchId>, emit=no-op, liveView=false to turn off the live view).
 *
 * Job granularity = one case (solidify+materialize+verify in the same job): loginStateCache is a per-process in-memory cache,
 * and BullMQ distributes across replicas — the login state warmed during the solidify AI phase only benefits the verify on this replica;
 * splitting the job would degrade into re-login per step.
 * Failure semantics = keep the already-persisted DSL + mark the failure (materialize runs before verify; verify failure doesn't roll back).
 * Row state machine: queued → solidifying → solidify_failed | materialize_failed | verifying → passed | verify_failed.
 */
import { and, asc, eq, inArray, like } from 'drizzle-orm';
import { db } from '../db/client.js';
import { aiStageCaseOps, groups, solidifyBatchCases, solidifyBatches, testCases, testSteps } from '../db/schema.js';
import { isVisualStep } from './aiActionMap.js';
import { buildSolidifyCaseTool } from '../pi/space/tools/solidifyCase.js';
import { buildVerifyCaseTool } from '../pi/space/tools/verifyCase.js';
import type { SpaceToolsContext } from '../pi/space/tools/context.js';
import { invalidateCasesCacheForCase } from '../services/cases.service.js';
import { logger } from '../logger.js';

/** In-progress row statuses (shared by re-trigger debounce and batch progress derivation). */
export const RUNNING_BATCH_STATUSES = ['queued', 'solidifying', 'verifying'] as const;

/** Batch derived summary (computed at read time; the batch table itself stores no status). */
export interface SolidifyBatchSummary {
  status: 'running' | 'passed' | 'failed' | 'partial';
  total: number;
  passed: number;
  failed: number;
  running: number;
}

/**
 * Batch status derived at read time: any running row = running; otherwise all passed = passed, all failed = failed, mixed = partial.
 * Shared by the single-batch query and the "in-flight batches list" endpoints, avoiding count drift between the two.
 */
export function deriveBatchSummary(rows: Array<{ status: string }>): SolidifyBatchSummary {
  const passed = rows.filter((r) => r.status === 'passed').length;
  const failed = rows.filter((r) => r.status.endsWith('_failed')).length;
  const running = rows.filter((r) => (RUNNING_BATCH_STATUSES as readonly string[]).includes(r.status)).length;
  const status = running > 0 ? 'running' : failed === 0 ? 'passed' : passed === 0 ? 'failed' : 'partial';
  return { status, total: rows.length, passed, failed, running };
}

/**
 * Batch solidification eligibility check: the requirement is "no step has ever been solidified". Rejections carry a human-readable reason (routes aggregate them into rejected).
 * ok carries projectId (for batch row ownership; test_cases has no project_id column — derived via the groups join).
 */
export async function checkBatchEligibility(
  caseId: string,
): Promise<{ ok: true; projectId: string } | { ok: false; reason: string }> {
  const row = (await db
    .select({ c: testCases, projectId: groups.projectId })
    .from(testCases)
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .where(eq(testCases.id, caseId)))[0];
  if (!row) return { ok: false, reason: '用例不存在' };
  const caseRow = row.c;
  if (caseRow.platform !== 'web') return { ok: false, reason: '仅支持 web 用例' };
  if (!caseRow.versionId) return { ok: false, reason: '用例未绑定版本' };
  const steps = await db.select().from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order));
  if (steps.length === 0) return { ok: false, reason: '用例没有步骤' };
  if (steps.some((s) => Array.isArray(s.compiled) && s.compiled.length > 0)) {
    return { ok: false, reason: '用例已有固化步骤（批量固化仅支持全部未固化的用例）' };
  }
  const hasVisual = steps.some((s) =>
    isVisualStep({ instruction: s.instruction, compiled: s.compiled, sensitive: s.sensitive }));
  if (!hasVisual) return { ok: false, reason: '没有可固化的视觉模式步骤（如全部为敏感步骤）' };
  const running = await db
    .select({ id: solidifyBatchCases.id })
    .from(solidifyBatchCases)
    .where(and(
      eq(solidifyBatchCases.caseId, caseId),
      inArray(solidifyBatchCases.status, [...RUNNING_BATCH_STATUSES]),
    ))
    .limit(1);
  if (running.length > 0) return { ok: false, reason: '已有进行中的固化任务' };
  return { ok: true, projectId: row.projectId };
}

/**
 * Persists solidification staging: writes the solidify-% staged rows (update_step carrying compiled) from the batch threadId
 * draft area into test_steps.compiled one by one, then deletes the staging (single-transaction atomic — a mid-way crash either lands everything or nothing).
 * Hand-written transaction instead of applyCaseOp: the latter enforces ctx.versionId strictly, which doesn't fit the synthetic ctx semantics.
 */
export async function materializeStagedOps(batchThreadId: string, caseId: string): Promise<number> {
  const n = await db.transaction(async (tx) => {
    const scope = and(
      eq(aiStageCaseOps.threadId, batchThreadId),
      eq(aiStageCaseOps.caseId, caseId),
      like(aiStageCaseOps.localId, 'solidify-%'),
    );
    const ops = await tx
      .select({ localId: aiStageCaseOps.localId, payload: aiStageCaseOps.payload })
      .from(aiStageCaseOps)
      .where(scope);
    if (ops.length === 0) throw new Error('固化工件缺失：草稿区没有任何 solidify 暂存');
    for (const opRow of ops) {
      const payload = opRow.payload as { action?: string; stepId?: string; compiled?: unknown[] };
      if (payload.action !== 'update_step' || !payload.stepId) {
        throw new Error(`固化工件异常：${opRow.localId} 不是 update_step 暂存`);
      }
      await tx.update(testSteps).set({ compiled: payload.compiled ?? null }).where(eq(testSteps.id, payload.stepId));
    }
    await tx.delete(aiStageCaseOps).where(scope);
    return ops.length;
  });
  // Persisting compiled changes the list page's "solidified" column; the cache must be invalidated
  await invalidateCasesCacheForCase(caseId);
  return n;
}

/**
 * Batch solidification single-case job. Every path lands the row in a terminal state (catch as backstop), never leaving running zombies;
 * re-entry guard: a previous round's materialize already persisted (retry after a process crash) → skip solidify and go straight to acceptance.
 */
export async function runSolidifyBatchCaseJob(job: { batchId: string; caseId: string }): Promise<void> {
  const { batchId, caseId } = job;
  const rowKey = and(eq(solidifyBatchCases.batchId, batchId), eq(solidifyBatchCases.caseId, caseId));
  const batch = (await db.select().from(solidifyBatches).where(eq(solidifyBatches.id, batchId)))[0];
  // projectId derived via the groups join (test_cases has no project_id column)
  const loaded = (await db
    .select({ c: testCases, projectId: groups.projectId })
    .from(testCases)
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .where(eq(testCases.id, caseId)))[0];
  if (!batch || !loaded?.c.versionId) {
    logger.warn({ batchId, caseId }, 'solidify batch job skipped: batch/case row missing');
    return;
  }
  const caseRow = loaded.c;
  const ctx: SpaceToolsContext = {
    threadId: `batch-${batchId}`,
    versionId: caseRow.versionId,
    projectId: loaded.projectId,
    repo: { cwd: null, issue: null, noRepo: true },
    emit: () => {},
    createdByUserId: batch.createdByUserId,
    manager: false,
    liveView: false,
  };
  let phase: 'solidify' | 'materialize' | 'verify' = 'solidify';
  let solidifySteps: unknown = null;
  const finish = async (
    status: string,
    patch: { error?: string; solidifyResult?: unknown; verifyResult?: unknown } = {},
  ): Promise<void> => {
    await db.update(solidifyBatchCases).set({
      status,
      error: patch.error ?? null,
      ...(patch.solidifyResult !== undefined ? { solidifyResult: patch.solidifyResult } : {}),
      ...(patch.verifyResult !== undefined ? { verifyResult: patch.verifyResult } : {}),
      finishedAt: new Date(),
    }).where(rowKey);
  };
  try {
    await db.update(solidifyBatchCases).set({ status: 'solidifying', startedAt: new Date(), error: null }).where(rowKey);
    // Re-entry guard: materialize already persisted (crash retry) → go straight to acceptance
    const stepsNow = await db.select().from(testSteps).where(eq(testSteps.caseId, caseId));
    const alreadyCompiled = stepsNow.length > 0 && stepsNow.every((s) => Array.isArray(s.compiled) && s.compiled.length > 0);
    if (!alreadyCompiled) {
      const sr = await buildSolidifyCaseTool(ctx).execute({ caseId });
      const sdata = sr.ok ? (JSON.parse(sr.data ?? '{}') as {
        result?: string;
        steps?: Array<Record<string, unknown>>;
        failure?: { error?: string };
      }) : null;
      if (!sr.ok || sdata?.result !== 'solidified') {
        // solidify atomic semantics: execution failure / no solidifiable steps → nothing was staged
        const error = !sr.ok
          ? sr.error
          : sdata?.result === 'nothing-solidified'
            ? '没有步骤被固化（各步骤均无可固化内容）'
            : sdata?.failure?.error ?? `solidify 返回 ${sdata?.result ?? '未知结果'}`;
        await finish('solidify_failed', { error: String(error).slice(0, 500), solidifyResult: sdata?.steps ?? null });
        return;
      }
      solidifySteps = sdata.steps ?? null;
      phase = 'materialize';
      try {
        await materializeStagedOps(ctx.threadId, caseId);
      } catch (e) {
        await finish('materialize_failed', { error: (e as Error).message.slice(0, 500), solidifyResult: sdata.steps ?? null });
        return;
      }
    }
    phase = 'verify';
    await db.update(solidifyBatchCases).set({ status: 'verifying' }).where(rowKey);
    const vr = await buildVerifyCaseTool(ctx).execute({ caseId, mode: 'mechanical' });
    const vdata = vr.ok ? (JSON.parse(vr.data ?? '{}') as {
      result?: string;
      failure?: { humanMessage?: string; error?: string };
    }) : null;
    if (vr.ok && vdata?.result === 'passed') {
      await finish('passed', { solidifyResult: solidifySteps, verifyResult: vdata });
      return;
    }
    // verify failure doesn't roll back: the DSL is already in the DB (decision: "keep DSL + mark failure"); the reason goes to the batch report
    const reason = !vr.ok
      ? vr.error
      : vdata?.failure?.humanMessage ?? vdata?.failure?.error ?? `verify 返回 ${vdata?.result ?? '未知结果'}`;
    await finish('verify_failed', { error: String(reason).slice(0, 500), solidifyResult: solidifySteps, verifyResult: vdata ?? null });
  } catch (e) {
    logger.warn({ err: e, batchId, caseId, phase }, 'solidify batch job crashed');
    const failedStatus = phase === 'solidify' ? 'solidify_failed' : phase === 'materialize' ? 'materialize_failed' : 'verify_failed';
    await finish(failedStatus, { error: (e as Error).message.slice(0, 500) }).catch(() => undefined);
  }
}
