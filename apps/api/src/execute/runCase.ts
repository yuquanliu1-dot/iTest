import { eq, asc } from 'drizzle-orm';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import { testCases, testSteps, reports, groups } from '../db/schema.js';
import { executeCaseReal, type ExecStepResult } from './cdp.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';
import type { WindowStrategy, PreflightReport } from '@itest/shared';

/**
 * 执行单条用例并落报告。CDP 失败 → 写入 CDPUnavailable 失败报告（不再降级 mock）。
 * 返回 reportId 与最终状态，供单用例路由和执行计划共用。
 * `storageState` 用于在执行计划中复用登录准备阶段导出的 cookie/localStorage。
 * `forceFail`（测试用）在进入 CDP 前直接写失败报告，便于 fail_fast 行为测试。
 * `envOverride`（计划级）覆盖用例 defaultEnvId，用于执行计划上下文。
 */
export async function runCase(
  caseId: string,
  opts?: { storageState?: unknown; forceFail?: boolean; envOverride?: { envId: string } | null },
): Promise<{ reportId: string; status: string }> {
  const caseRow = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!caseRow) throw new Error('case not found');

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
    .values({ caseId, status: 'running', stepResults: [] as object, summary: 'execution in progress' })
    .returning();
  const reportId = inserted[0]!.id;

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

  // Resolve envCtx before any CDP launch: planEnv > case defaultEnv. EnvMissing/EnvProjectMismatch
  // are surfaced as a single failed stepResult (no 500). DecryptError propagates as a real error.
  const { resolveEnv } = await import('./envContext.js');
  let envCtx: import('./envContext.js').EnvCtx | undefined;
  try {
    envCtx = await resolveEnv(
      {
        planEnvId: opts?.envOverride?.envId ?? null,
        caseEnvId: caseRow.defaultEnvId ?? null,
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
          : '缺少环境配置，请到项目设置配置测试环境';
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

  // 初始导航由用例级 init URL（test_cases.url → 分组 → 项目）保证。回放前 always goto 一次，
  // 执行器内部对首条同 URL navigate 做去重（cdp.ts init-goto dedupe），避免与录制残留的首步重复。
  const resolved = await resolveCaseUrl(caseRow);
  const targetUrl = resolved && /^https?:\/\//.test(resolved) ? resolved : undefined;

  const startedAt = Date.now();
  let stepResults: ExecStepResult[];
  let preflightReport: PreflightReport | undefined;
  let status: 'passed' | 'failed';
  try {
    stepResults = await executeCaseReal(
      caseId,
      steps.map((s) => ({
        order: s.order,
        action: s.action,
        assertion: s.assertion,
        delayMs: s.delayMs,
        id: s.id,
        tabRef: s.tabRef,
        componentKind: s.componentKind,
        sensitive: s.sensitive,
      })),
      { reportId, projectId, envCtx },
      targetUrl,
      opts?.storageState,
      (r) => {
        preflightReport = r;
      },
      caseWindow,
      incognito,
    );
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
    if (envCtx) envCtx.close().catch(() => undefined);
  }

  const durationMs = Date.now() - startedAt;
  await db
    .update(reports)
    .set({
      status,
      durationMs,
      stepResults: stepResults as object,
      summary: buildSummary(stepResults, preflightReport),
      preflight: preflightReport ?? null,
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
