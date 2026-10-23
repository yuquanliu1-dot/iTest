/**
 * 创建 plan_run 并 fire-and-forget 启动 runPlanAsync。
 * HTTP (`POST /plans/:id/run`) 和调度器 worker 都通过这个入口，避免两套重复逻辑。
 *
 * callerUser: 用于 projectVisibility 校验。null = 调度器调用，跳过用户级校验（计划本身
 * 已存在并被启用即可）。req.user 路径下传 { userId }，由 plansRoute / middleware 校验。
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { environmentObjects, executionPlans, planRuns } from '../db/schema.js';
import { findIncognitoCaseIds, runPlanAsync } from './runPlan.js';
import { assertProjectVisible } from '../services/projectAccess.js';
import type { AuthUser } from '../services/auth.service.js';
import { HttpError } from '../middleware/errorHandler.js';
import { logger } from '../logger.js';
import { getExecutionQueue, isExecutionQueueReady, EXEC_QUEUE_NAME, type ExecJob } from '../scheduler/execQueue.js';

export type PlanRunTriggerSource = 'manual' | 'schedule';

export interface EnqueuePlanRunOpts {
  planId: string;
  trigger: {
    source: PlanRunTriggerSource;
    userId?: string | null;
    scheduleId?: string | null;
  };
  /** 传 AuthUser 走 assertProjectVisible；null 表示调度器调用,跳过可见性校验。 */
  callerUser: AuthUser | null;
}

export interface EnqueuePlanRunResult {
  runId: string;
}

async function findIncognitoConflicts(planId: string): Promise<void> {
  const ids = await findIncognitoCaseIds(planId);
  if (ids.length > 0) {
    throw new HttpError(422, 'incognito_conflicts_with_login_prepare', `cases: ${ids.join(',')}`);
  }
}

/** 登录准备已开启但未指定登录用例 → 检查环境默认 web 服务对象是否有内嵌登录凭据(0041 起 login 并入 web)。 */
async function assertLoginPrepareHasSource(plan: {
  loginPrepareEnabled: boolean;
  loginCaseId: string | null;
  environmentId: string | null;
}): Promise<void> {
  if (!plan.loginPrepareEnabled) return;
  if (plan.loginCaseId) return; // 已指定登录用例,直接通过
  if (!plan.environmentId) {
    throw new HttpError(422, 'login_case_required', '登录准备已开启:需选择登录用例,或在计划环境中配置登录凭据');
  }
  // 与 resolveEnv 的 loginCfg 判据逐字段对齐:有效默认 web(isDefault→最早)payload 需 user 非空 + secret 三元组齐全。
  const objs = await db.select({ payload: environmentObjects.payload }).from(environmentObjects)
    .where(and(eq(environmentObjects.environmentId, plan.environmentId), eq(environmentObjects.objectType, 'web')))
    .orderBy(desc(environmentObjects.isDefault), asc(environmentObjects.createdAt), asc(environmentObjects.id))
    .limit(1);
  const p = (objs[0]?.payload ?? {}) as { user?: unknown; secret?: { c?: unknown; i?: unknown; t?: unknown } };
  const hasCred = typeof p.user === 'string' && p.user.length > 0
    && typeof p.secret?.c === 'string' && typeof p.secret?.i === 'string' && typeof p.secret?.t === 'string';
  if (!hasCred) {
    throw new HttpError(422, 'login_case_required', '登录准备已开启:需选择登录用例,或在计划环境的默认 web 服务对象中配置登录凭据(用户名+密码)');
  }
}

export async function enqueuePlanRun(opts: EnqueuePlanRunOpts): Promise<EnqueuePlanRunResult> {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, opts.planId)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  if (opts.callerUser) await assertProjectVisible(plan.projectId, opts.callerUser);
  await assertLoginPrepareHasSource(plan);
  if (plan.loginPrepareEnabled) await findIncognitoConflicts(plan.id);

  const ins = await db.insert(planRuns).values({
    planId: plan.id,
    projectId: plan.projectId,
    status: 'running',
    strategy: plan.strategy,
    loginPrepareEnabled: plan.loginPrepareEnabled,
    loginCaseId: plan.loginCaseId,
    detectionUrl: plan.detectionUrl,
    loginSuccessSelector: plan.loginSuccessSelector,
    loginUnauthorizedKeywords: plan.loginUnauthorizedKeywords,
    rcaEnabled: plan.rcaEnabled,
    totalCases: 0,
    triggeredBy: opts.trigger.source,
    triggeredByUserId: opts.trigger.userId ?? null,
    scheduleId: opts.trigger.scheduleId ?? null,
  }).returning();
  const runId = ins[0]!.id;

  const job: ExecJob = { kind: 'plan', planRunId: runId };
  if (isExecutionQueueReady()) {
    try {
      await getExecutionQueue().add(EXEC_QUEUE_NAME, job);
    } catch (e) {
      logger.warn({ err: e, planRunId: runId }, 'exec queue add failed; running inline');
      void runPlanAsync({ planRunId: runId }).catch((err) => logger.error({ err, planRunId: runId, trigger: opts.trigger.source }, 'runPlanAsync crashed'));
    }
  } else {
    // 无 redis：回落同步启动（调度 worker 启动失败不影响手动执行）
    void runPlanAsync({ planRunId: runId }).catch((err) => logger.error({ err, planRunId: runId, trigger: opts.trigger.source }, 'runPlanAsync crashed'));
  }
  return { runId };
}