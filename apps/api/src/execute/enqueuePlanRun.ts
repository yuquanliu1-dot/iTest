/**
 * 创建 plan_run 并 fire-and-forget 启动 runPlanAsync。
 * HTTP (`POST /plans/:id/run`) 和调度器 worker 都通过这个入口，避免两套重复逻辑。
 *
 * callerUser: 用于 projectVisibility 校验。null = 调度器调用，跳过用户级校验（计划本身
 * 已存在并被启用即可）。req.user 路径下传 { userId }，由 plansRoute / middleware 校验。
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
  /** 传 AuthUser 走 assertProjectVisible；null 表示调度器调用,跳过可见性校验。 */
  callerUser: AuthUser | null;
}

export interface EnqueuePlanRunResult {
  runId: string;
}

/** 计划全部分组（按组序）。 */
async function loadGroups(planId: string) {
  return db.select().from(planCaseGroups).where(eq(planCaseGroups.planId, planId)).orderBy(asc(planCaseGroups.order));
}

/** 组登录来源校验（原计划级 assertLoginPrepareHasSource 的组级版）：组开登录必须有登录用例或组环境凭据。 */
async function assertGroupsLoginSource(groups: Array<typeof planCaseGroups.$inferSelect>): Promise<void> {
  for (const g of groups) {
    if (!g.loginPrepareEnabled) continue;
    if (g.loginCaseId) continue; // 已指定登录用例,直接通过
    if (!g.environmentId) {
      throw new HttpError(422, 'login_case_required', `分组「${g.name}」登录准备已开启:需选择登录用例,或在分组环境中配置登录凭据`);
    }
    // 与 resolveEnv 的 loginCfg 判据逐字段对齐:有效默认 web(isDefault→最早)payload 需 user 非空 + secret 三元组齐全。
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

/** 组级隐身/mobile 冲突：开登录的组内不得有 incognito 用例或非 deprecated mobile 用例。 */
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
    // 组结构快照：全部组配置字段按组序入 jsonb（老运行为 null,引擎兜底合成为单组）
    groups: groups.map((g) => ({
      id: g.id, name: g.name, order: g.order, environmentId: g.environmentId,
      loginPrepareEnabled: g.loginPrepareEnabled, loginCaseId: g.loginCaseId,
      loginDatasetRowIndexes: g.loginDatasetRowIndexes ?? null,
      detectionUrl: g.detectionUrl, loginSuccessSelector: g.loginSuccessSelector,
      loginUnauthorizedKeywords: g.loginUnauthorizedKeywords, failFast: g.failFast,
      targetConfig: g.targetConfig,
    })),
    // 旧 UI 兼容标量：任一组开启登录即 true；细粒度配置看 groups 快照
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
    // 无 redis：回落同步启动（调度 worker 启动失败不影响手动执行）
    void runPlanAsync({ planRunId: runId }).catch((err) => logger.error({ err, planRunId: runId, trigger: opts.trigger.source }, 'runPlanAsync crashed'));
  }
  return { runId };
}
