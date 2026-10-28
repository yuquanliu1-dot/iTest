import { eq, asc } from 'drizzle-orm';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import {
  executionPlans,
  planCases,
  planRuns,
  planRunCases,
  testCases,
  users,
} from '../db/schema.js';
import { runCase } from './runCase.js';
import { loginPrepare } from './loginPrepare.js';
import { publishRunEvent, subscribeRunEvent } from '../sse/planRunBus.js';
import { registerLiveView } from './liveView.js';
import { st, type StLang } from '../i18n.js';

/** 单 planRun 的运行控制器：内存中保存 cancelRequested。 */
const runState = new Map<string, { cancelRequested: boolean; storageState?: unknown }>();

export function requestCancel(planRunId: string): void {
  const s = runState.get(planRunId);
  if (s) s.cancelRequested = true;
}

export async function isCancelRequested(planRunId: string): Promise<boolean> {
  // 同进程内存快速路径（cancel 路由先置内存再写 DB）；跨容器以 DB 为准。
  if (runState.get(planRunId)?.cancelRequested) return true;
  const row = (await db.select({ c: planRuns.cancelRequested }).from(planRuns).where(eq(planRuns.id, planRunId)).limit(1))[0];
  return row?.c ?? false;
}

interface RunPlanInput {
  planRunId: string;
}

interface StepEvent {
  type:
    | 'plan_run_login'
    | 'plan_run_case_start'
    | 'plan_run_case_complete'
    | 'plan_run_complete';
  caseId?: string;
  stepKind?: 'login_prepare' | 'business';
  status?: string;
  reportId?: string;
  summary?: string;
}

/** 执行引擎里的组形状：enqueue 时定格进 plan_runs.groups 快照；老运行由标量登录快照合成。 */
export interface PlanGroupExec {
  id: string;
  name: string;
  order: number;
  environmentId: string | null;
  loginPrepareEnabled: boolean;
  loginCaseId: string | null;
  detectionUrl: string | null;
  loginSuccessSelector: string | null;
  loginUnauthorizedKeywords: unknown;
  failFast: boolean;
  targetConfig: { deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null;
}

/** 登录复用签名：环境 + 登录配置 + target_config（+ failFast，按计划测试口径）完全一致才复用 storageState。 */
export function loginSignature(g: PlanGroupExec): string {
  return JSON.stringify([
    g.environmentId, g.loginPrepareEnabled, g.loginCaseId, g.detectionUrl,
    g.loginSuccessSelector, g.loginUnauthorizedKeywords ?? null, g.targetConfig ?? null, g.failFast,
  ]);
}

/** plan_run_cases 行的组归属列；legacy 合成组不落 group_id（老运行无组概念）。 */
const groupMetaOf = (g: PlanGroupExec) => ({
  groupId: g.id === 'legacy' ? null : g.id,
  groupName: g.name,
  groupOrder: g.order,
});

export function subscribeRun(runId: string, res: import('express').Response): () => void {
  return subscribeRunEvent(runId, res);
}

function publish(runId: string, evt: StepEvent) {
  publishRunEvent(runId, evt);
}

/** 查触发执行用户的语言偏好(未触发或用户不存在回落 zh-CN)。 */
async function resolveRunLang(triggeredByUserId: string | null | undefined): Promise<StLang> {
  if (!triggeredByUserId) return 'zh-CN';
  const row = (await db.select({ lang: users.languagePreference }).from(users).where(eq(users.id, triggeredByUserId)).limit(1))[0];
  return (row?.lang === 'en-US' ? 'en-US' : 'zh-CN') as StLang;
}

/**
 * 造一个「报告行落库即回填 plan_run_cases」的回调。
 *
 * 为什么必须回填：report_id 原先只在用例跑完后才写入 plan_run_cases。执行期间前端拿不到
 * 报告 id → 计划运行详情页只能显示「排队等待执行」，步骤要等整条用例结束才一次性出现
 * （2026-10-26 实测）。回填后前端能在 running 期间定位报告，2s 轮询逐步看到步骤。
 *
 * 口径：
 * - 非数据集用例（rowIndex=null）→ report_id = 该报告 id；
 * - 数据集用例（rowIndex 有值）→ report_ids 累积所有行报告 id，report_id 恒指向首行
 *   （与终态回填口径一致：终态 reportId = reportIds[0]）。
 */
function makeReportLinker(planRunCaseId: string): (reportId: string, rowIndex: number | null) => Promise<void> {
  const reportIds: string[] = [];
  return async (reportId, rowIndex) => {
    if (rowIndex === null) {
      await db.update(planRunCases).set({ reportId }).where(eq(planRunCases.id, planRunCaseId));
      return;
    }
    reportIds.push(reportId);
    await db
      .update(planRunCases)
      .set({ reportId: reportIds[0]!, reportIds: [...reportIds] })
      .where(eq(planRunCases.id, planRunCaseId));
  };
}

/**
 * 启动一次计划执行（异步）。调用方立即返回 planRunId。
 *
 * 双层循环：外层按组（run.groups 快照，老运行合成单组），内层组内用例串行。
 * 失败语义两级：组内由 group.failFast 决定（首例失败跳过本组剩余）；
 * 组间由 plan.strategy 决定（fail_fast 时前组失败 → 后续组整组跳过，组边界评估）。
 * 登录复用：连续组签名（环境+登录配置+target_config）相同且上次成功 → 复用 storageState，不生成登录行。
 */
export async function runPlanAsync(input: RunPlanInput): Promise<void> {
  const { planRunId } = input;
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, planRunId)))[0];
  if (!run) return;
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, run.planId)))[0];
  if (!plan) return;

  const lang = await resolveRunLang(run.triggeredByUserId);

  runState.set(planRunId, { cancelRequested: false });
  // playground 实时画面：整个计划运行一个画面源，逐用例 setPage 跟随（含登录准备/登录用例共用浏览器）。
  const live = registerLiveView(`planrun:${planRunId}`);

  // —— 组结构：优先 run.groups 快照（enqueue 定格）；老运行 groups=null/空 → 标量登录快照合成单组 ——
  let groups: PlanGroupExec[] = Array.isArray(run.groups) ? (run.groups as PlanGroupExec[]) : [];
  if (groups.length === 0) {
    groups = [{
      id: 'legacy',
      name: '默认分组',
      order: 1,
      environmentId: null, // 老运行计划级环境已废弃，逐用例走默认链
      loginPrepareEnabled: run.loginPrepareEnabled,
      loginCaseId: run.loginCaseId,
      detectionUrl: run.detectionUrl,
      loginSuccessSelector: run.loginSuccessSelector,
      loginUnauthorizedKeywords: run.loginUnauthorizedKeywords,
      failFast: false,
      targetConfig: null,
    }];
  }

  // 用例按组聚合（执行时实时读 plan_cases —— 与原「启动时定格」语义一致）。
  const pcs = await db
    .select({
      groupId: planCases.groupId,
      caseId: planCases.caseId,
      order: planCases.order,
      status: testCases.status,
      platform: testCases.platform,
      incognito: testCases.incognito,
    })
    .from(planCases)
    .innerJoin(testCases, eq(testCases.id, planCases.caseId))
    .where(eq(planCases.planId, plan.id))
    .orderBy(asc(planCases.order));
  const groupOfId = new Map(groups.map((g) => [g.id, g]));
  const legacyGroup = groups.find((g) => g.id === 'legacy');
  const fallbackGroupId = legacyGroup?.id ?? groups[0]!.id;
  const casesByGroup = new Map<string, typeof pcs>();
  for (const g of groups) casesByGroup.set(g.id, []);
  for (const pc of pcs) {
    // groupId 不在快照组里（执行中改组/老数据）→ 归 legacy 或第一组兜底
    const gid = pc.groupId && groupOfId.has(pc.groupId) ? pc.groupId : fallbackGroupId;
    casesByGroup.get(gid)!.push(pc);
  }

  const allBusiness = groups.flatMap((g) => casesByGroup.get(g.id)!);
  await db.update(planRuns).set({ totalCases: allBusiness.length, startedAt: new Date() }).where(eq(planRuns.id, planRunId));

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  // 测试钩子：FORCE_FAIL_CASE_IDS=uuid1,uuid2 让对应 caseId 强制失败，便于 fail_fast/cancel 测试。
  const forceFailIds = new Set(
    (process.env.FORCE_FAIL_CASE_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  let prevLogin: { signature: string; storageState?: unknown } | undefined;
  let abortedByPlanStrategy = false;
  let anyLoginFailure = false;

  try {
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi]!;
      const gCases = casesByGroup.get(group.id)!;
      const groupMeta = groupMetaOf(group);

      // 取消：本组起所有剩余用例标记 skipped，结束
      if (await isCancelRequested(planRunId)) {
        for (let g2 = gi; g2 < groups.length; g2++) {
          const rest = casesByGroup.get(groups[g2]!.id)!;
          for (let j = 0; j < rest.length; j++) {
            await db.insert(planRunCases).values({
              planRunId,
              caseId: rest[j]!.caseId,
              order: j + 1,
              status: 'skipped',
              stepKind: 'business',
              error: 'cancelled',
              ...groupMetaOf(groups[g2]!),
            });
          }
          skipped += rest.length;
        }
        break;
      }
      // 计划级 fail_fast：前面组失败 → 本组起整组跳过
      if (abortedByPlanStrategy) {
        for (let j = 0; j < gCases.length; j++) {
          await db.insert(planRunCases).values({
            planRunId,
            caseId: gCases[j]!.caseId,
            order: j + 1,
            status: 'skipped',
            stepKind: 'business',
            error: 'skipped: plan fail_fast',
            ...groupMeta,
          });
        }
        skipped += gCases.length;
        continue;
      }

      // —— 组环境解析（失败仅 warn 回落，组内用例逐条走自己的默认链，与原 plan env 语义一致）——
      // guard 保持：group.environmentId 由组端点校验过属于本项目，这里是兜底复核。
      let groupEnv: { envId: string } | undefined;
      let groupWebOrigin: string | null | undefined;
      let loginCred: import('./envContext.js').LoginCtx | undefined;
      if (group.environmentId) {
        try {
          const { resolveEnv } = await import('./envContext.js');
          const ctx = await resolveEnv(
            { planEnvId: group.environmentId },
            { expectedProjectId: plan.projectId },
          );
          groupWebOrigin = ctx.resolveWebOrigin();
          groupEnv = { envId: ctx.envId };
          loginCred = ctx.login;
          await ctx.close();
        } catch (e) {
          logger.warn(
            { err: e, planId: plan.id, group: group.name },
            'group env resolve failed; cases will use their own defaultEnv',
          );
          groupEnv = undefined;
        }
      }

      // —— 组登录准备（签名相同且上次成功 → 复用 storageState，不生成登录行）——
      let loginState: unknown;
      let loginPrepareFailed = false;
      let loginBrowser: import('playwright-core').Browser | undefined;
      let loginCtx: import('playwright-core').BrowserContext | undefined;
      const sig = loginSignature(group);
      try {
        if (group.loginPrepareEnabled && prevLogin?.signature === sig && prevLogin.storageState) {
          loginState = prevLogin.storageState;
        } else if (group.loginPrepareEnabled) {
          // 组内冲突（enqueue 已对 HTTP 入口 422；此处兜底直接落库的运行）按「登录准备失败」处理，
          // 不再像旧引擎那样把整个 run 打失败/抛 422。
          const incognitoHit = gCases.some((c) => c.incognito);
          const mobileHit = gCases.find((c) => c.status !== 'deprecated' && c.platform === 'mobile');
          if (incognitoHit || mobileHit) {
            loginPrepareFailed = true;
            logger.warn(
              { planRunId, planId: plan.id, group: group.name, incognitoHit, mobileHit: !!mobileHit },
              'login prepare conflicts with group cases (incognito/mobile); group cases will be skipped',
            );
          } else {
            const firstCaseId = gCases.find((c) => c.status !== 'deprecated' && c.platform !== 'mobile')?.caseId ?? null;
            const result = await loginPrepare(
              {
                enabled: true,
                caseId: group.loginCaseId,
                detectionUrl: group.detectionUrl,
                successSelector: group.loginSuccessSelector,
                unauthorizedKeywords: group.loginUnauthorizedKeywords as string[] | null,
                firstCaseId,
              },
              {
                // 未配登录用例且组环境配置了登录凭据时，走自动填表登录（探测/填表页纳入实时画面）
                autoLogin: !group.loginCaseId && loginCred ? loginCred : undefined,
                defaultWebOrigin: groupWebOrigin ?? null,
                liveView: live,
                loginCaseRunner: async (cid, ctx, browser) => {
                  // 写入 plan_run_cases（step_kind=login_prepare, status=running）
                  const ins = await db
                    .insert(planRunCases)
                    .values({ planRunId, caseId: cid, order: 0, status: 'running', stepKind: 'login_prepare', ...groupMeta })
                    .returning();
                  const row = ins[0]!;
                  publish(planRunId, { type: 'plan_run_login', caseId: cid, stepKind: 'login_prepare', status: 'running' });
                  const loginT0 = Date.now();
                  try {
                    // 在 caller 持有的 chromium + ctx 中跑登录用例：登录后该 ctx 真实携带 cookie，
                    // 从同一 ctx 导出 storageState 喂给后续业务用例。如果登录用例失败或抛错，takeOwnership 不设，
                    // 让 loginPrepare 走 finally 关 browser。
                    const r = await runCase(cid, {
                      ...(groupEnv ? { envOverride: { envId: groupEnv.envId } } : {}),
                      ownedBrowser: browser,
                      ownedContext: ctx,
                      liveView: live,
                      createdByUserId: run.triggeredByUserId,
                      planProjectId: plan.projectId,
                      // 同业务用例：报告行一落库就回填 report_id，执行期间前端即可看到登录步骤逐步推进。
                      onReportCreated: makeReportLinker(row.id),
                    });
                    await db
                      .update(planRunCases)
                      .set({
                        status: r.status,
                        reportId: r.reportId,
                        finishedAt: new Date(),
                        durationMs: Date.now() - loginT0,
                        error: r.status === 'failed' ? 'login case failed' : null,
                      })
                      .where(eq(planRunCases.id, row.id));
                    if (r.status !== 'passed') {
                      publish(planRunId, { type: 'plan_run_case_complete', caseId: cid, stepKind: 'login_prepare', status: 'failed', reportId: r.reportId });
                      return { passed: false, storageState: undefined };
                    }
                    publish(planRunId, { type: 'plan_run_case_complete', caseId: cid, stepKind: 'login_prepare', status: 'passed', reportId: r.reportId });
                    // 从登录用例跑过的 ctx 导出真实 storageState；组循环末尾统一关 browser。
                    loginBrowser = browser;
                    loginCtx = ctx;
                    return { passed: true, storageState: await ctx.storageState(), takeOwnership: true };
                  } catch (e) {
                    await db
                      .update(planRunCases)
                      .set({ status: 'failed', finishedAt: new Date(), durationMs: Date.now() - loginT0, error: e instanceof Error ? e.message : String(e) })
                      .where(eq(planRunCases.id, row.id));
                    return { passed: false, storageState: undefined };
                  }
                },
              },
            );
            if (result.status === 'failed') {
              loginPrepareFailed = true;
              logger.warn(
                { planRunId, planId: plan.id, group: group.name, reason: result.reason },
                'group login prepare failed; group cases will be skipped',
              );
            } else if (result.storageState) {
              loginState = result.storageState;
              prevLogin = { signature: sig, storageState: result.storageState };
            }
          }
        }

        // —— 组内业务用例串行执行 ——
        let groupFailed = false;
        if (loginPrepareFailed) {
          // 登录准备失败 → 本组业务用例全部跳过，进组边界评估
          for (let j = 0; j < gCases.length; j++) {
            await db.insert(planRunCases).values({
              planRunId,
              caseId: gCases[j]!.caseId,
              order: j + 1,
              status: 'skipped',
              stepKind: 'business',
              error: 'login prepare failed',
              ...groupMeta,
            });
          }
          skipped += gCases.length;
          groupFailed = true;
          anyLoginFailure = true;
        } else {
          for (let i = 0; i < gCases.length; i++) {
            if (await isCancelRequested(planRunId)) {
              for (let j = i; j < gCases.length; j++) {
                await db.insert(planRunCases).values({
                  planRunId,
                  caseId: gCases[j]!.caseId,
                  order: j + 1,
                  status: 'skipped',
                  stepKind: 'business',
                  error: 'cancelled',
                  ...groupMeta,
                });
              }
              skipped += gCases.length - i;
              break;
            }
            const c = gCases[i]!;
            if (c.status === 'deprecated') {
              await db.insert(planRunCases).values({
                planRunId,
                caseId: c.caseId,
                order: i + 1,
                status: 'skipped',
                stepKind: 'business',
                finishedAt: new Date(),
                durationMs: 0,
                error: 'case deprecated',
                ...groupMeta,
              });
              publish(planRunId, { type: 'plan_run_case_complete', caseId: c.caseId, stepKind: 'business', status: 'skipped' });
              skipped += 1;
              continue;
            }
            if (c.platform === 'mobile') continue; // mobile case 不注入组级 web storageState；后续由 runCase 路由到 MobileEngine
            const ins = await db
              .insert(planRunCases)
              .values({ planRunId, caseId: c.caseId, order: i + 1, status: 'running', stepKind: 'business', ...groupMeta })
              .returning();
            publish(planRunId, { type: 'plan_run_case_start', caseId: c.caseId, stepKind: 'business', status: 'running' });
            const t0 = Date.now();
            try {
              const r = await runCase(c.caseId, {
                storageState: loginState,
                forceFail: forceFailIds.has(c.caseId),
                ...(groupEnv ? { envOverride: { envId: groupEnv.envId } } : {}),
                targetOverride: group.targetConfig ?? null,
                liveView: live,
                createdByUserId: run.triggeredByUserId,
                planProjectId: plan.projectId,
                onReportCreated: makeReportLinker(ins[0]!.id),
              });
              await db
                .update(planRunCases)
                .set({
                  status: r.status,
                  reportId: r.reportId,
                  ...(r.reportIds ? { reportIds: r.reportIds } : {}),
                  finishedAt: new Date(),
                  durationMs: Date.now() - t0,
                  error: r.status === 'failed' ? 'case failed' : null,
                })
                .where(eq(planRunCases.id, ins[0]!.id));
              publish(planRunId, { type: 'plan_run_case_complete', caseId: c.caseId, stepKind: 'business', status: r.status, reportId: r.reportId });
              if (r.status === 'passed') passed += 1;
              else {
                failed += 1;
                groupFailed = true;
                // 组内 fail_fast：只跳过本组剩余（计划级 strategy 在组边界评估，不打断当前组）
                if (group.failFast) {
                  for (let j = i + 1; j < gCases.length; j++) {
                    await db.insert(planRunCases).values({
                      planRunId,
                      caseId: gCases[j]!.caseId,
                      order: j + 1,
                      status: 'skipped',
                      stepKind: 'business',
                      error: 'skipped: group fail_fast',
                      ...groupMeta,
                    });
                  }
                  skipped += gCases.length - i - 1;
                  break;
                }
              }
            } catch (e) {
              await db
                .update(planRunCases)
                .set({ status: 'failed', finishedAt: new Date(), durationMs: Date.now() - t0, error: e instanceof Error ? e.message : String(e) })
                .where(eq(planRunCases.id, ins[0]!.id));
              failed += 1;
              groupFailed = true;
              publish(planRunId, { type: 'plan_run_case_complete', caseId: c.caseId, stepKind: 'business', status: 'failed' });
              if (group.failFast) {
                for (let j = i + 1; j < gCases.length; j++) {
                  await db.insert(planRunCases).values({
                    planRunId,
                    caseId: gCases[j]!.caseId,
                    order: j + 1,
                    status: 'skipped',
                    stepKind: 'business',
                    error: 'skipped: group fail_fast',
                    ...groupMeta,
                  });
                }
                skipped += gCases.length - i - 1;
                break;
              }
            }
          }
        }

        // 组边界评估：任一用例失败 || 登录准备失败 → 本组视为失败；计划 fail_fast 时后续组整组跳过
        if (groupFailed && run.strategy === 'fail_fast') {
          abortedByPlanStrategy = true;
        }
      } finally {
        // 组级登录浏览器（loginPrepare take ownership 后由本循环负责关）：换组即弃，异常路径同样收口，
        // 确保不留 chromium 残留进程。
        if (loginCtx) await loginCtx.close().catch(() => undefined);
        if (loginBrowser) await loginBrowser.close().catch(() => undefined);
      }
    }

    const finalStatus = (await isCancelRequested(planRunId)) ? 'cancelled' : failed > 0 || anyLoginFailure ? 'failed' : 'passed';
    const finalSummary = st(lang, 'planRun.summary', { passed, failed, skipped });
    await finalizeRun(planRunId, finalStatus, { passed, failed, skipped, summary: finalSummary });
    publish(planRunId, { type: 'plan_run_complete', status: finalStatus, summary: finalSummary });
    // RCA:开关打开且有业务失败 → 入队根因分析(异步,不阻塞运行收尾;动态 import 防环)
    try {
      const { enqueueRcaForPlanRun } = await import('../scheduler/rcaQueue.js');
      void enqueueRcaForPlanRun(planRunId).catch((e) => logger.warn({ err: e, planRunId }, 'rca enqueue failed'));
    } catch { /* 队列模块加载失败不影响运行收尾 */ }
    runState.delete(planRunId);
  } finally {
    live.close();
  }
}

async function finalizeRun(
  planRunId: string,
  status: 'passed' | 'failed' | 'cancelled',
  counts: { passed: number; failed: number; skipped: number; summary: string },
) {
  const finishedAt = new Date();
  const startedAt = (await db.select({ s: planRuns.startedAt }).from(planRuns).where(eq(planRuns.id, planRunId)))[0]?.s ?? finishedAt;
  await db
    .update(planRuns)
    .set({
      status,
      finishedAt,
      durationMs: finishedAt.getTime() - new Date(startedAt).getTime(),
      passedCases: counts.passed,
      failedCases: counts.failed,
      skippedCases: counts.skipped,
      summary: counts.summary,
    })
    .where(eq(planRuns.id, planRunId));
}
