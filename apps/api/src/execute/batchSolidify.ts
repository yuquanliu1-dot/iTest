/**
 * 批量固化 job：对「全部步骤未固化」的 web 用例做 后端 solidify（NL→DSL）→ 落库 → mechanical 验收。
 * 不经会话 agent：直接调用 buildSolidifyCaseTool/buildVerifyCaseTool（纯 caseId 进 / JSON 出），
 * 用合成 ctx（threadId=batch-<batchId>、emit=no-op、liveView=false 关实时画面）。
 *
 * job 粒度 = 单用例（solidify+materialize+verify 同一个 job）：loginStateCache 是进程内存缓存，
 * BullMQ 跨副本分发——solidify AI 相暖的登录态只对本副本的 verify 生效，拆 job 会退化成每步重新登录。
 * 失败语义 = 保留已落库 DSL + 标记失败（materialize 在 verify 之前，verify 失败不回滚）。
 * 行状态机：queued → solidifying → solidify_failed | materialize_failed | verifying → passed | verify_failed。
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

/** 进行中的行状态（重复触发防抖与批量进度派生共用）。 */
export const RUNNING_BATCH_STATUSES = ['queued', 'solidifying', 'verifying'] as const;

/** 批次派生汇总（读时计算，批次表本身不存 status）。 */
export interface SolidifyBatchSummary {
  status: 'running' | 'passed' | 'failed' | 'partial';
  total: number;
  passed: number;
  failed: number;
  running: number;
}

/**
 * 批次状态读时派生：有 running 行 = running；否则全过 = passed、全败 = failed、混合 = partial。
 * 单批次查询与「在途批次列表」两个端点共用，避免两处计数漂移。
 */
export function deriveBatchSummary(rows: Array<{ status: string }>): SolidifyBatchSummary {
  const passed = rows.filter((r) => r.status === 'passed').length;
  const failed = rows.filter((r) => r.status.endsWith('_failed')).length;
  const running = rows.filter((r) => (RUNNING_BATCH_STATUSES as readonly string[]).includes(r.status)).length;
  const status = running > 0 ? 'running' : failed === 0 ? 'passed' : passed === 0 ? 'failed' : 'partial';
  return { status, total: rows.length, passed, failed, running };
}

/**
 * 批量固化资格校验：需求口径 = 「所有步骤都没有固化过」。拒绝时给出人读原因（路由聚合回 rejected）。
 * ok 时带 projectId（batch 行归属用；test_cases 无 project_id 列，经分组 join 推导）。
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
 * 固化暂存落库：把 batch threadId 草稿区里 solidify-% 暂存（update_step 携带 compiled）
 * 逐条写进 test_steps.compiled，随后删暂存（单事务原子——中途崩溃要么全落、要么全不落）。
 * 自写事务而非 applyCaseOp：后者带 ctx.versionId 严格校验，合成 ctx 语义不符。
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
  // compiled 落库改变列表「固化」列,缓存必须失效
  await invalidateCasesCacheForCase(caseId);
  return n;
}

/**
 * 批量固化单用例 job。任何路径都把行落到终态（catch 兜底），不留 running 僵尸；
 * 重入守卫：前轮 materialize 已落库（进程崩溃后重试）→ 跳过 solidify 直接验收。
 */
export async function runSolidifyBatchCaseJob(job: { batchId: string; caseId: string }): Promise<void> {
  const { batchId, caseId } = job;
  const rowKey = and(eq(solidifyBatchCases.batchId, batchId), eq(solidifyBatchCases.caseId, caseId));
  const batch = (await db.select().from(solidifyBatches).where(eq(solidifyBatches.id, batchId)))[0];
  // projectId 经分组 join 推导（test_cases 无 project_id 列）
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
    // 重入守卫：materialize 已落库（崩溃重试）→ 直接进验收
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
        // solidify 原子语义：执行失败/无可固化步 → 未暂存任何修改
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
    // verify 失败不回滚：DSL 已在库（决策「保留 DSL + 标记失败」），原因留给批量报告
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
