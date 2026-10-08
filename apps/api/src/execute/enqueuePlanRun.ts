/**
 * 创建 plan_run 并 fire-and-forget 启动 runPlanAsync。
 * HTTP (`POST /plans/:id/run`) 和调度器 worker 都通过这个入口，避免两套重复逻辑。
 *
 * callerUser: 用于 projectVisibility 校验。null = 调度器调用，跳过用户级校验（计划本身
 * 已存在并被启用即可）。req.user 路径下传 { userId }，由 plansRoute / middleware 校验。
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { environmentObjects, executionPlans, planRuns } from '../db/schema.js';
import { findIncognitoCaseIds, runPlanAsync } from './runPlan.js';
import { assertProjectVisible } from '../services/projectAccess.js';
import type { AuthUser } from '../services/auth.service.js';
import { HttpError } from '../middleware/errorHandler.js';
import { logger } from '../logger.js';

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

/** 登录准备已开启但未指定登录用例 → 检查环境是否有登录凭据;两者都没有才报错。 */
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
  const objs = await db.select({ id: environmentObjects.id }).from(environmentObjects)
    .where(and(eq(environmentObjects.environmentId, plan.environmentId), eq(environmentObjects.objectType, 'login')))
    .limit(1);
  if (objs.length === 0) {
    throw new HttpError(422, 'login_case_required', '登录准备已开启:需选择登录用例,或在计划环境中配置登录凭据');
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
    totalCases: 0,
    triggeredBy: opts.trigger.source,
    triggeredByUserId: opts.trigger.userId ?? null,
    scheduleId: opts.trigger.scheduleId ?? null,
  }).returning();
  const runId = ins[0]!.id;

  // fire-and-forget；worker 也走这里，行为一致
  void runPlanAsync({ planRunId: runId }).catch((e) => {
    logger.error({ err: e, planRunId: runId, trigger: opts.trigger.source }, 'runPlanAsync crashed');
  });
  return { runId };
}