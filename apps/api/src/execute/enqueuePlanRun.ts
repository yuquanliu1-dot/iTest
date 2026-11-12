/**
 * Creates the plan_run and fire-and-forget starts runPlanAsync.
 * Both HTTP (`POST /plans/:id/run`) and the scheduler worker go through this entry, avoiding two copies of duplicated logic.
 *
 * callerUser: used for projectVisibility validation. null = scheduler invocation, skipping user-level validation (the plan
 * merely needs to exist and be enabled). The req.user path passes { userId } down; plansRoute / middleware validate it.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { environmentObjects, executionPlans, planCaseGroups, planCases, planRuns, testCases } from '../db/schema.js';
import { runPlanAsync } from './runPlan.js';
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
  /** Passing an AuthUser runs assertProjectVisible; null means scheduler invocation, skipping visibility validation. */
  callerUser: AuthUser | null;
}

export interface EnqueuePlanRunResult {
  runId: string;
}

/** All groups of the plan (in group order). */
async function loadGroups(planId: string) {
  return db.select().from(planCaseGroups).where(eq(planCaseGroups.planId, planId)).orderBy(asc(planCaseGroups.order));
}

/** Group-level login source validation (the group-level version of the former plan-level assertLoginPrepareHasSource): a group with login enabled must have a login case or group environment credentials. */
async function assertGroupsLoginSource(groups: Array<typeof planCaseGroups.$inferSelect>): Promise<void> {
  for (const g of groups) {
    if (!g.loginPrepareEnabled) continue;
    if (g.loginCaseId) continue; // login case already designated, pass directly
    if (!g.environmentId) {
      throw new HttpError(422, 'login_case_required', `分组「${g.name}」登录准备已开启:需选择登录用例,或在分组环境中配置登录凭据`);
    }
    // Field-by-field aligned with resolveEnv's loginCfg criteria: a valid default web (isDefault → earliest) payload needs a non-empty user + the full secret triple.
    const objs = await db.select({ payload: environmentObjects.payload }).from(environmentObjects)
      .where(and(eq(environmentObjects.environmentId, g.environmentId), eq(environmentObjects.objectType, 'web')))
      .orderBy(desc(environmentObjects.isDefault), asc(environmentObjects.createdAt), asc(environmentObjects.id))
      .limit(1);
    const p = (objs[0]?.payload ?? {}) as { user?: unknown; secret?: { c?: unknown; i?: unknown; t?: unknown } };
    const hasCred = typeof p.user === 'string' && p.user.length > 0
      && typeof p.secret?.c === 'string' && typeof p.secret?.i === 'string' && typeof p.secret?.t === 'string';
    if (!hasCred) {
      throw new HttpError(422, 'login_case_required', `分组「${g.name}」登录准备已开启:需选择登录用例,或在分组环境的默认 web 服务对象中配置登录凭据(用户名+密码)`);
    }
  }
}

/** Group-level incognito/mobile conflicts: a group with login enabled must not contain incognito cases or non-deprecated mobile cases. */
async function assertGroupsCaseConflicts(planId: string, groups: Array<typeof planCaseGroups.$inferSelect>): Promise<void> {
  const loginGroupIds = groups.filter((g) => g.loginPrepareEnabled).map((g) => g.id);
  if (loginGroupIds.length === 0) return;
  const rows = await db
    .select({ caseId: planCases.caseId, groupId: planCases.groupId, incognito: testCases.incognito, platform: testCases.platform, status: testCases.status })
    .from(planCases)
    .innerJoin(testCases, eq(testCases.id, planCases.caseId))
    .where(and(eq(planCases.planId, planId), inArray(planCases.groupId, loginGroupIds)));
  const nameOf = new Map(groups.map((g) => [g.id, g.name]));
  const incognito = rows.filter((r) => r.incognito);
  if (incognito.length > 0) {
    throw new HttpError(422, 'incognito_conflicts_with_login_prepare', `分组「${nameOf.get(incognito[0]!.groupId!)}」: cases ${incognito.map((r) => r.caseId).join(',')}`);
  }
  const mobile = rows.filter((r) => r.platform === 'mobile' && r.status !== 'deprecated');
  if (mobile.length > 0) {
    throw new HttpError(422, 'login_prepare_skips_mobile', `分组「${nameOf.get(mobile[0]!.groupId!)}」登录准备仅对 web 用例生效;请关闭该组登录或移出 mobile 用例`);
  }
}

export async function enqueuePlanRun(opts: EnqueuePlanRunOpts): Promise<EnqueuePlanRunResult> {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, opts.planId)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  if (opts.callerUser) await assertProjectVisible(plan.projectId, opts.callerUser);
  const groups = await loadGroups(plan.id);
  await assertGroupsLoginSource(groups);
  await assertGroupsCaseConflicts(plan.id, groups);

  const ins = await db.insert(planRuns).values({
    planId: plan.id,
    projectId: plan.projectId,
    status: 'running',
    strategy: plan.strategy,
    // Group structure snapshot: every group config field enters the jsonb in group order (null on old runs; the engine falls back to synthesizing a single group)
    groups: groups.map((g) => ({
      id: g.id, name: g.name, order: g.order, environmentId: g.environmentId,
      loginPrepareEnabled: g.loginPrepareEnabled, loginCaseId: g.loginCaseId,
      loginDatasetRowIndexes: g.loginDatasetRowIndexes ?? null,
      detectionUrl: g.detectionUrl, loginSuccessSelector: g.loginSuccessSelector,
      loginUnauthorizedKeywords: g.loginUnauthorizedKeywords, failFast: g.failFast,
      targetConfig: g.targetConfig,
    })),
    // Legacy-UI compatibility scalar: true as soon as any group enables login; fine-grained config lives in the groups snapshot
    loginPrepareEnabled: groups.some((g) => g.loginPrepareEnabled),
    loginCaseId: null,
    detectionUrl: null,
    loginSuccessSelector: null,
    loginUnauthorizedKeywords: null,
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
    // No redis: fall back to synchronous start (scheduler worker startup failure doesn't affect manual execution)
    void runPlanAsync({ planRunId: runId }).catch((err) => logger.error({ err, planRunId: runId, trigger: opts.trigger.source }, 'runPlanAsync crashed'));
  }
  return { runId };
}
