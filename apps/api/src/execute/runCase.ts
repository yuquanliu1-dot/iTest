import { eq, asc } from 'drizzle-orm';
import type { Browser, BrowserContext } from 'playwright-core';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import { testCases, testSteps, reports, groups } from '../db/schema.js';
import { executeCaseReal, executeCaseInBrowser, maskSensitiveValues, type ExecStepResult } from './cdp.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';
import { loadDatasetForRun, type DatasetRowExec } from '../services/datasets.service.js';
import type { WindowStrategy, PreflightReport } from '@itest/shared';
import { WebEngine } from './webEngine.js';
import { MobileEngine } from './mobileEngine.js';
import { EngineUnavailable, type Engine, type EngineInput } from './engine.js';

/**
 * 执行单条用例并落报告。CDP 失败 → 写入 CDPUnavailable 失败报告（不再降级 mock）。
 * 返回 reportId 与最终状态，供单用例路由和执行计划共用。
 * 数据集绑定（caseRow.datasetId）：N 个启用行 = N 次独立回放 = N 条 report；
 * 单行失败不中断（每行是独立验证），最终 status 聚合为任一行 failed 即 failed。
 * 配置错误（无启用行/列名非法/解密失败）直接抛 DatasetConfigError，不产生垃圾 report。
 * `storageState` 用于在执行计划中复用登录准备阶段导出的 cookie/localStorage。
 * `forceFail`（测试用）在进入 CDP 前直接写失败报告，便于 fail_fast 行为测试。
 * `envOverride`（计划级）覆盖用例 defaultEnvId，用于执行计划上下文。
 * `ownedBrowser`/`ownedContext`（计划级 loginPrepare 链路）让登录用例在 caller 持有的 chromium + context 中跑，
 *  这样登录成功后可直接从同一 ctx 导出真实 storageState；调用方负责关闭。
 */
export async function runCase(
  caseId: string,
  opts?: {
    storageState?: unknown;
    forceFail?: boolean;
    envOverride?: { envId: string } | null;
    ownedBrowser?: Browser;
    ownedContext?: BrowserContext;
  },
): Promise<{ reportId: string; status: string; reportIds?: string[] }> {
  const caseRow = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!caseRow) throw new Error('case not found');

  // 数据集绑定：前置校验（0 启用行/列名非法/解密失败）直接抛 DatasetConfigError —— 配置错误不产生垃圾 report。
  if (caseRow.datasetId) {
    const plan = await loadDatasetForRun(caseRow.datasetId);
    const reportIds: string[] = [];
    let finalStatus = 'passed';
    for (const row of plan.rows) {
      // 行失败不中断：任何单行错误已在 runCaseOnce 内记为该行 report failed，这里只聚合。
      const r = await runCaseOnce(caseId, caseRow, opts, row);
      reportIds.push(r.reportId);
      if (r.status !== 'passed') finalStatus = 'failed';
    }
    return { reportId: reportIds[0]!, status: finalStatus, reportIds };
  }
  return runCaseOnce(caseId, caseRow, opts);
}

/** 单次执行（数据集模式下每行调一次）。rowPlan 存在时：report 带 rowIndex/快照，执行器注入初始变量；
 *  且插入 report 之后的任何意外错误都在这里兜底为该行 failed report，不中断迭代、不留 running 僵尸。 */
async function runCaseOnce(
  caseId: string,
  caseRow: typeof testCases.$inferSelect,
  opts: {
    storageState?: unknown;
    forceFail?: boolean;
    envOverride?: { envId: string } | null;
    ownedBrowser?: Browser;
    ownedContext?: BrowserContext;
  } | undefined,
  rowPlan?: DatasetRowExec,
): Promise<{ reportId: string; status: string }> {
  // Resolve projectId for project-scoped attachment resolution during playback.
  const group = caseRow.groupId
    ? (await db.select({ projectId: groups.projectId }).from(groups).where(eq(groups.id, caseRow.groupId)))[0]
    : undefined;
  const projectId = group?.projectId;

  const steps = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, caseId))
    .orderBy(asc(testSteps.order));

  const inserted = await db
    .insert(reports)
    .values({
      caseId,
      status: 'running',
      stepResults: [] as object,
      summary: 'execution in progress',
      platform: caseRow.platform,
      ...(caseRow.mobileOs ? { mobileOs: caseRow.mobileOs } : {}),
      ...(caseRow.mobileDeviceTargetId ? { deviceTargetId: caseRow.mobileDeviceTargetId } : {}),
      ...(rowPlan ? { datasetRowIndex: rowPlan.rowIndex, datasetSnapshot: rowPlan.snapshot } : {}),
    })
    .returning();
  const reportId = inserted[0]!.id;

  // 非数据集模式保持原语义：内部错误照常上抛（由 HTTP 边界处理）。
  if (!rowPlan) return runCaseOnceInner(caseId, caseRow, opts, projectId, steps, reportId, undefined);
  // 数据集行兜底：report 已落库，之后任何意外错误（解密/URL 解析/最终落库等）不抛出迭代循环，
  // 而是记为该行 InternalError failed report —— 满足「任何单行错误一律 failed，继续下一行」。
  try {
    return await runCaseOnceInner(caseId, caseRow, opts, projectId, steps, reportId, rowPlan);
  } catch (e) {
    let msg = e instanceof Error ? e.message : String(e);
    if (rowPlan.sensitiveVarKeys.length > 0) {
      msg = maskSensitiveValues(msg, rowPlan.vars, rowPlan.sensitiveVarKeys);
    }
    logger.warn({ err: e, caseId, reportId }, 'dataset row crashed after report insert; writing InternalError failed report');
    await db
      .update(reports)
      .set({
        status: 'failed',
        stepResults: [
          {
            order: 1,
            status: 'failed',
            durationMs: 0,
            error: msg,
            failureReason: 'InternalError',
            humanMessage: '执行器内部错误，该行已记为失败',
          },
        ] as object,
        summary: msg,
      })
      .where(eq(reports.id, reportId))
      .catch(() => undefined);
    return { reportId, status: 'failed' };
  }
}

/** report 插入之后的执行主体（runCaseOnce 完成前置查询与 report 落库后调用）。 */
async function runCaseOnceInner(
  caseId: string,
  caseRow: typeof testCases.$inferSelect,
  opts: {
    storageState?: unknown;
    forceFail?: boolean;
    envOverride?: { envId: string } | null;
    ownedBrowser?: Browser;
    ownedContext?: BrowserContext;
  } | undefined,
  projectId: string | undefined,
  steps: (typeof testSteps.$inferSelect)[],
  reportId: string,
  rowPlan: DatasetRowExec | undefined,
): Promise<{ reportId: string; status: string }> {
  // 确定性测试钩子：不启动浏览器，直接落失败报告。
  if (opts?.forceFail) {
    const stepResults: ExecStepResult[] = [];
    await db
      .update(reports)
      .set({ status: 'failed', durationMs: 0, stepResults: stepResults as object, summary: 'forced fail (test hook)' })
      .where(eq(reports.id, reportId));
    return { reportId, status: 'failed' };
  }

  const caseWindow = {
    strategy: caseRow.windowStrategy as WindowStrategy,
    width: caseRow.windowWidth ?? undefined,
    height: caseRow.windowHeight ?? undefined,
  };
  const incognito = !!caseRow.incognito;

  // Resolve envCtx before any CDP launch: planEnv > case defaultEnv > version link > project default.
  // EnvMissing/EnvProjectMismatch are surfaced as a single failed stepResult (no 500). DecryptError propagates.
  const { resolveEnv } = await import('./envContext.js');
  let envCtx: import('./envContext.js').EnvCtx | undefined;
  try {
    envCtx = await resolveEnv(
      {
        planEnvId: opts?.envOverride?.envId ?? null,
        caseEnvId: caseRow.defaultEnvId ?? null,
        versionId: caseRow.versionId ?? null,
      },
      projectId ? { expectedProjectId: projectId } : undefined,
    );
  } catch (e) {
    const errName = e instanceof Error ? e.name : '';
    if (errName === 'EnvMissing' || errName === 'EnvProjectMismatch') {
      const failureReason = errName as 'EnvMissing' | 'EnvProjectMismatch';
      const humanMessage =
        errName === 'EnvProjectMismatch'
          ? '环境所属项目与当前用例不匹配'
          : '缺少环境配置，请到项目环境页配置默认环境';
      const stepResults: ExecStepResult[] = [{
        order: 1,
        status: 'failed',
        durationMs: 0,
        error: e instanceof Error ? e.message : String(e),
        failureReason,
        humanMessage,
      }];
      await db
        .update(reports)
        .set({
          status: 'failed',
          durationMs: 0,
          stepResults: stepResults as object,
          summary: e instanceof Error ? e.message : String(e),
        })
        .where(eq(reports.id, reportId));
      return { reportId, status: 'failed' };
    }
    throw e;
  }

  // 初始导航由用例级 init URL（test_cases.url → 分组.default_url → 已解析环境.base_url）保证。
  // 回放前 always goto 一次，执行器内部对首条同 URL navigate 做去重（cdp.ts init-goto dedupe），
  // 避免与录制残留的首步重复。
  const resolved = await resolveCaseUrl(caseRow, { envBaseUrl: envCtx?.baseUrl });
  const targetUrl = resolved && /^https?:\/\//.test(resolved) ? resolved : undefined;

  const startedAt = Date.now();
  let stepResults: ExecStepResult[];
  let preflightReport: PreflightReport | undefined;
  let status: 'passed' | 'failed';
  const isMobile = caseRow.platform === 'mobile';
  try {
    const stepInput = steps.map((s) => ({
      order: s.order,
      assertion: s.assertion,
      delayMs: s.delayMs,
      id: s.id,
      tabRef: s.tabRef,
      componentKind: s.componentKind,
      sensitive: s.sensitive,
      // 2026-10-06:dispatcher 唯一回放依据 compiled;action 列已于 0030 DROP。
      compiled: s.compiled as unknown[] | null | undefined,
    }));
    const execCtx = {
      reportId,
      projectId,
      envCtx,
      // Track 1：把用例级 expectedOutcome / title / url 传给 cdp，触发最后 vision 判定。
      expectedOutcome: caseRow.expectedOutcome ?? null,
      caseTitle: caseRow.title,
      caseUrl: caseRow.url ?? null,
      ...(rowPlan
        ? { initialVars: rowPlan.vars, sensitiveVarKeys: rowPlan.sensitiveVarKeys }
        : {}),
    };
    // mobile 用例：直接走 MobileEngine；web 用例：登录准备链路（ownedBrowser）走 executeCaseInBrowser 复用 ctx,
    // 其余走 WebEngine.execute → executeCaseReal（保留 storageState/incognito 注入语义）。
    const mobileOs = (caseRow.mobileOs === 'ios' || caseRow.mobileOs === 'android')
      ? caseRow.mobileOs
      : null;
    if (isMobile) {
      const engine = new MobileEngine();
      const engineInput: EngineInput = {
        caseId,
        caseTitle: caseRow.title,
        caseUrl: caseRow.url ?? null,
        expectedOutcome: caseRow.expectedOutcome ?? null,
        steps: stepInput,
        envCtx,
        reportId,
        projectId,
        caseWindow,
        incognito,
        appRef: caseRow.appRef ?? null,
        deviceTargetId: caseRow.mobileDeviceTargetId ?? null,
        mobileOs,
        ...(rowPlan ? { initialVars: rowPlan.vars, sensitiveVarKeys: rowPlan.sensitiveVarKeys } : {}),
      };
      try {
        await engine.prepare(engineInput);
        stepResults = await engine.execute(engineInput, targetUrl, (r: PreflightReport) => { preflightReport = r; });
        const failed = stepResults.filter((r) => r.status === 'failed').length;
        status = failed === 0 ? 'passed' : 'failed';
      } catch (e) {
        if (e instanceof EngineUnavailable) {
          stepResults = [{
            order: 1, status: 'failed', durationMs: 0,
            error: e.message, failureReason: 'EngineUnavailable',
            humanMessage: '移动端引擎不可用：' + e.message,
          }];
          status = 'failed';
        } else {
          logger.warn({ err: e, caseId, reportId }, 'mobile engine execution failed; writing CDPUnavailable failed report');
          stepResults = [{
            order: 1, status: 'failed', durationMs: 0,
            error: e instanceof Error ? e.message : String(e),
            failureReason: 'CDPUnavailable',
            humanMessage: '执行失败',
          }];
          status = 'failed';
        }
      } finally {
        try { await engine.release(engineInput); } catch { /* swallow */ }
        if (envCtx && !opts?.ownedBrowser) envCtx.close().catch(() => undefined);
      }
    } else if (opts?.ownedBrowser && opts?.ownedContext) {
      // 计划级 loginPrepare 链路：在 caller 持有的 chromium + context 中跑（不再注入 storageState，
      // context 已含登录 cookie；再注入反而覆盖）。浏览器与 context 由 caller 管理。
      stepResults = await executeCaseInBrowser(
        caseId,
        stepInput,
        execCtx,
        opts.ownedBrowser,
        opts.ownedContext,
        targetUrl,
        (r) => {
          preflightReport = r;
        },
        caseWindow,
      );
      const failed = stepResults.filter((r) => r.status === 'failed').length;
      status = failed === 0 ? 'passed' : 'failed';
    } else {
      const engine = new WebEngine();
      const engineInput: EngineInput = {
        caseId,
        caseTitle: caseRow.title,
        caseUrl: caseRow.url ?? null,
        expectedOutcome: caseRow.expectedOutcome ?? null,
        steps: stepInput,
        envCtx,
        reportId,
        projectId,
        caseWindow,
        incognito,
        ...(opts?.storageState ? { storageState: opts.storageState } : {}),
        appRef: caseRow.appRef ?? null,
        deviceTargetId: caseRow.mobileDeviceTargetId ?? null,
        mobileOs,
        ...(rowPlan ? { initialVars: rowPlan.vars, sensitiveVarKeys: rowPlan.sensitiveVarKeys } : {}),
      };
      try {
        await engine.prepare(engineInput);
        stepResults = await engine.execute(engineInput, targetUrl, (r: PreflightReport) => { preflightReport = r; });
        const failed = stepResults.filter((r) => r.status === 'failed').length;
        status = failed === 0 ? 'passed' : 'failed';
      } catch (e) {
        logger.warn({ err: e, caseId, reportId }, 'CDP execution failed; writing CDPUnavailable failed report');
        const msg = e instanceof Error ? e.message : String(e);
        stepResults = [
          {
            order: 1,
            status: 'failed',
            durationMs: 0,
            error: msg,
            failureReason: 'CDPUnavailable',
            humanMessage: '真实浏览器不可用，已尝试 DOM 降级仍失败',
          },
        ];
        status = 'failed';
      } finally {
        try { await engine.release(engineInput); } catch { /* swallow */ }
        if (envCtx && !opts?.ownedBrowser) envCtx.close().catch(() => undefined);
      }
    }
  } finally {
    // caller owned browser 路径下浏览器生命周期由 caller 管；envCtx 仍在本函数内关闭，
    // 因为每个用例各自解析独立 pg.Pool（不做共享），立即关避免长连接泄漏。
    if (envCtx && !opts?.ownedBrowser) envCtx.close().catch(() => undefined);
  }

  const durationMs = Date.now() - startedAt;
  // 移动端报表补 deviceName：deviceTargets service 在 Task 5 引入,这里用 dynamic import 兜底:
  // service 尚未实现(MVP 阶段顺序容忍)或解析失败时静默跳过,deviceName 保持 null。
  let deviceName: string | null = null;
  if (caseRow.platform === 'mobile' && caseRow.mobileDeviceTargetId) {
    try {
      const { resolveDeviceTarget } = await import('../services/deviceTargets.service.js');
      const t = await resolveDeviceTarget(caseRow.mobileDeviceTargetId);
      if (t) deviceName = t.name;
    } catch {
      // service 还未实现(MVP 阶段顺序容忍)
    }
  }
  await db
    .update(reports)
    .set({
      status,
      durationMs,
      stepResults: stepResults as object,
      summary: buildSummary(stepResults, preflightReport),
      preflight: preflightReport ?? null,
      ...(deviceName ? { deviceName } : {}),
      // 双通过率口径：passed 且有步骤 healed（aiTask 缓存分叉后 AI 自愈成功）
      healed: status === 'passed' && stepResults.some((r) => r.healed === true),
    })
    .where(eq(reports.id, reportId));

  return { reportId, status };
}

function buildSummary(steps: ExecStepResult[], preflight: PreflightReport | undefined): string {
  const passed = steps.filter((r) => r.status === 'passed').length;
  const base = `${steps.length} steps, ${passed} passed, ${steps.length - passed} failed`;
  if (!preflight) return base;
  const tags: string[] = [];
  if (!preflight.urlReachable) tags.push('URLUnreachable');
  if (!preflight.loggedIn) tags.push('NotLoggedIn');
  if (preflight.originMismatch) tags.push('OriginMismatch');
  return tags.length ? `${base} · preflight: ${tags.join(',')}` : base;
}
