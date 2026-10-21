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
import { WebServiceMissing } from './envContext.js';
import { readAiFallbackSettings } from './aiFallback.js';

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
 * `preseed`（单用例执行路由用）：路由已提前插入 running 报告行拿 reportId（执行即跳报告页），
 *  传进来后本函数/各 runCaseOnce 按 rowIndex 匹配复用、不再二次插入；null 表示保持原插入语义。
 */
export interface PreseedReport {
  reportId: string;
  rowIndex: number | null;
}

/** 插入一条 running 报告行（与 runCaseOnce 原插入值完全一致），返回 reportId。
 *  单用例执行路由提前调用（执行转后台后响应必须带回 reportId），runCaseOnce 靠 preseed 复用。
 *  createdByUserId = 触发执行的人（报告创建人）。 */
export async function insertRunningReportRow(
  caseRow: typeof testCases.$inferSelect,
  rowPlan?: DatasetRowExec,
  createdByUserId?: string | null,
): Promise<string> {
  const inserted = await db
    .insert(reports)
    .values({
      caseId: caseRow.id,
      status: 'running',
      stepResults: [] as object,
      summary: 'execution in progress',
      platform: caseRow.platform,
      ...(createdByUserId ? { createdByUserId } : {}),
      ...(caseRow.mobileOs ? { mobileOs: caseRow.mobileOs } : {}),
      ...(caseRow.mobileDeviceTargetId ? { deviceTargetId: caseRow.mobileDeviceTargetId } : {}),
      ...(rowPlan ? { datasetRowIndex: rowPlan.rowIndex, datasetSnapshot: rowPlan.snapshot } : {}),
    })
    .returning();
  return inserted[0]!.id;
}

export async function runCase(
  caseId: string,
  opts?: {
    storageState?: unknown;
    forceFail?: boolean;
    envOverride?: { envId: string } | null;
    ownedBrowser?: Browser;
    ownedContext?: BrowserContext;
    /** playground 实时画面源：透传给执行器，页面切换时跟随（计划运行/单用例执行）。 */
    liveView?: import('./liveView.js').LiveViewHandle;
    /** 路由已预置的 running 报告行（执行即跳报告页）；提供后跳过本函数内的报告插入。 */
    preseed?: PreseedReport[];
    /** 报告创建人 = 触发执行的人；preseed 路径已在路由落库，此处仅覆盖非 preseed 插入。 */
    createdByUserId?: string | null;
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
    liveView?: import('./liveView.js').LiveViewHandle;
    preseed?: PreseedReport[];
    createdByUserId?: string | null;
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

  // preseed（路由已预置该行的 running 报告行）→ 按 rowIndex 匹配复用 reportId，不二次插入。
  // 匹配不上（数据集在预检与后台执行之间被改）抛错，由数据集行兜底/路由 catch 记为 failed。
  let reportId: string;
  if (opts?.preseed) {
    const match = opts.preseed.find((p) => (p.rowIndex ?? null) === (rowPlan?.rowIndex ?? null));
    if (!match) throw new Error(`preseed report missing for dataset row ${rowPlan?.rowIndex ?? 'none'}`);
    reportId = match.reportId;
  } else {
    reportId = await insertRunningReportRow(caseRow, rowPlan, opts?.createdByUserId);
  }

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
    liveView?: import('./liveView.js').LiveViewHandle;
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

  // 初始导航:绝对 url 直通;相对 url 由环境 web 服务拼 origin(spec 2026-10-16)。
  // WebServiceMissing 与 EnvMissing 同呈现:单步失败报告。
  let resolved: string | null = null;
  let caseWebOrigin: string | null = null;
  try {
    resolved = envCtx
      ? await resolveCaseUrl(caseRow, { envCtx })
      : await resolveCaseUrl(caseRow, { defaultEnvFallback: true });
  } catch (e) {
    if (e instanceof WebServiceMissing) {
      const stepResults: ExecStepResult[] = [{
        order: 1, status: 'failed', durationMs: 0,
        error: e.message, failureReason: 'WebServiceMissing', humanMessage: e.message,
      }];
      await db.update(reports)
        .set({ status: 'failed', durationMs: 0, stepResults: stepResults as object, summary: e.message })
        .where(eq(reports.id, reportId));
      if (envCtx) envCtx.close().catch(() => undefined);
      return { reportId, status: 'failed' };
    }
    throw e;
  }
  // 绝对 url 直通用例:bad webServiceRef 不参与初始导航,容忍为 null(T7 相对 navigate 步骤级再报错)。
  // WebServiceMissing 消息此刻丢弃是刻意的——相对 url 用例已在上方 resolveCaseUrl 抛过,不会到这里。
  if (envCtx) {
    try {
      caseWebOrigin = envCtx.resolveWebOrigin(caseRow.webServiceRef ?? null);
    } catch {
      caseWebOrigin = null;
    }
  }
  const targetUrl = resolved && /^https?:\/\//.test(resolved) ? resolved : undefined;

  const startedAt = Date.now();
  let stepResults: ExecStepResult[];
  let preflightReport: PreflightReport | undefined;
  let status: 'passed' | 'failed';
  const isMobile = caseRow.platform === 'mobile';
  // 增量落库：每步结束把当前累计结果刷进报告行（status 仍为 running），让报告页 2s
  // 轮询逐步看到结果，而不是等整段跑完才一次性出现。
  // 写入是 fire-and-forget（失败只记日志，不打断执行），但末尾终态写入前必须等它们落定，
  // 否则迟到的增量写会用旧快照盖掉终态 stepResults。failed 步骤同样增量落库，
  // 这样「跑到失败那步停下」也能立刻看到失败原因。
  const liveSteps: ExecStepResult[] = [];
  const pendingWrites: Promise<unknown>[] = [];
  const onStep = (r: ExecStepResult) => {
    liveSteps.push(r);
    const snapshot = liveSteps.slice();
    pendingWrites.push(
      db
        .update(reports)
        .set({ stepResults: snapshot as object })
        .where(eq(reports.id, reportId))
        .catch((e) => logger.warn({ err: e, reportId, order: r.order }, 'incremental stepResults persist failed')),
    );
  };
  try {
    // 回放 AI 降级开关（全局设置）：每次执行读一次，注入 executor 供 dispatcher 触达；全关时不透传。
    const aiFallback = await readAiFallbackSettings();
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
      // AI 降级兜底用：行级自然语言指令（正常机械回放不读）。
      instruction: s.instruction,
    }));
    // web_<name> 系统变量：环境 web 服务 origin（覆盖同名数据集变量；web_ 为保留前缀）。
    const webVars: Record<string, string> = {};
    for (const w of envCtx?.webServices ?? []) {
      if (w.name) webVars[`web_${w.name}`] = w.origin;
    }
    const initialVars = rowPlan ? { ...rowPlan.vars, ...webVars } : (Object.keys(webVars).length ? webVars : undefined);
    const execCtx = {
      reportId,
      projectId,
      envCtx,
      // Track 1：把用例级 expectedOutcome / title / url 传给 cdp，触发最后 vision 判定。
      expectedOutcome: caseRow.expectedOutcome ?? null,
      caseTitle: caseRow.title,
      caseUrl: caseRow.url ?? null,
      ...(rowPlan
        ? { sensitiveVarKeys: rowPlan.sensitiveVarKeys }
        : {}),
      ...(initialVars ? { initialVars } : {}),
      ...(caseWebOrigin ? { caseWebOrigin } : {}),
      ...(caseRow.webServiceRef ? { caseWebServiceRef: caseRow.webServiceRef } : {}),
      ...(opts?.liveView ? { liveView: opts.liveView } : {}),
      ...(aiFallback.compileMissing || aiFallback.locatorFailed ? { aiFallback } : {}),
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
        ...(rowPlan ? { sensitiveVarKeys: rowPlan.sensitiveVarKeys } : {}),
        ...(initialVars ? { initialVars } : {}),
        ...(caseWebOrigin ? { caseWebOrigin } : {}),
      };
      try {
        await engine.prepare(engineInput);
        stepResults = await engine.execute(engineInput, targetUrl, (r: PreflightReport) => { preflightReport = r; }, onStep);
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
        onStep,
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
        ...(opts?.liveView ? { liveView: opts.liveView } : {}),
        ...(rowPlan ? { sensitiveVarKeys: rowPlan.sensitiveVarKeys } : {}),
        ...(initialVars ? { initialVars } : {}),
        ...(caseWebOrigin ? { caseWebOrigin } : {}),
        ...(caseRow.webServiceRef ? { caseWebServiceRef: caseRow.webServiceRef } : {}),
        ...(aiFallback.compileMissing || aiFallback.locatorFailed ? { aiFallback } : {}),
      };
      try {
        await engine.prepare(engineInput);
        stepResults = await engine.execute(engineInput, targetUrl, (r: PreflightReport) => { preflightReport = r; }, onStep);
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
  // 等所有增量写落定再写终态：否则迟到的增量快照会用旧数据盖掉终态 stepResults。
  await Promise.all(pendingWrites);
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
