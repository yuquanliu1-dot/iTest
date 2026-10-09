/**
 * verify_case 工具：生成/修改用例后在真实被测系统上实测验证（spec: 2026-10-09-verify-case-design）。
 * 编排：读用例 → resolveEnv → (可选)凭证自动登录 → executeCaseInBrowser 失败即停
 * → 失败页元素清单（复用 inspectPage 提取器）→ 结构化反馈供 agent 自修正 compiled。
 * 验证不落 report（结果只回对话上下文）；副作用与正式执行一致（spec 已确认接受）。
 */
import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { testCases, testSteps } from '../../../db/schema.js';
import { executeCaseInBrowser } from '../../../execute/cdp.js';
import type { ExecContext, ExecStepResult } from '../../../execute/cdp.js';
import { resolveEnv } from '../../../execute/envContext.js';
import { resolveCaseUrl } from '../../../lib/resolve-url.js';
import { loginInContext } from '../../autoLogin.js';
import { extractPageElements } from '../../inspectPage.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

const VERIFY_TIMEOUT_MS = 120_000;

export function buildVerifyCaseTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'verify_case',
    description:
      '在真实被测系统上逐步验证用例的 compiled 步骤可执行性：自动用环境 login 凭据登录（未配置则跳过登录直跑），失败即停并返回失败步骤详情与失败页可交互元素清单。依据清单修正 locator 后可再次调用（同一用例建议最多 3 轮）。验证会产生真实副作用（与正式执行一致）。',
    parameters: Type.Object({
      caseId: Type.String({ minLength: 1 }),
    }),
    promptGuidelines: [
      '含 compiled 步骤的用例创建/修改后，环境可用时调用 verify_case 实测验证，不要只凭源码分析就声称用例可运行。',
      'verify_case 失败时：读取 failure.page.elements，只能用清单中真实存在的选择器修正对应步骤的 locator/动作，禁止臆造；修正（upsert_case/stage_case_op）后重新验证。',
      '同一用例验证最多重试 3 轮；仍失败则保留用例，如实向用户说明失败步骤与原因，不要无限循环。',
      '环境未配置 login 凭据而验证因登录页失败时，引导用户到项目环境页配置 login 凭据，不要伪造登录步骤。',
    ],
    execute: async (input) => {
      const { caseId } = input as { caseId: string };
      // 最外层兜底：db 查询 / chromium launch / resolveCaseUrl 等未预料异常一律转 ok:false
      // （ToolExecutor 契约：不向 agent 循环抛异常）
      try {
        // ── 前置校验（不启动浏览器）──
        const caseRow = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
        if (!caseRow) return { ok: false, error: `用例不存在: ${caseId}` };
        if (caseRow.platform === 'mobile') {
          return { ok: false, error: 'verify_case 暂不支持移动端用例（v1 仅支持 web）' };
        }
        const steps = await db
          .select()
          .from(testSteps)
          .where(eq(testSteps.caseId, caseId))
          .orderBy(asc(testSteps.order));
        if (steps.length === 0) return { ok: false, error: '用例没有可验证的步骤' };

        // ── 环境解析（case defaultEnv > version link > 项目默认）──
        let envCtx: Awaited<ReturnType<typeof resolveEnv>>;
        try {
          envCtx = await resolveEnv(
            { caseEnvId: caseRow.defaultEnvId ?? null, versionId: caseRow.versionId ?? ctx.versionId },
            { expectedProjectId: ctx.projectId },
          );
        } catch (e) {
          const errName = e instanceof Error ? e.name : '';
          if (errName === 'EnvMissing') return { ok: false, error: '缺少环境配置，请到项目环境页配置默认环境' };
          if (errName === 'EnvProjectMismatch') return { ok: false, error: '环境所属项目与当前用例不匹配' };
          return { ok: false, error: `环境解析失败: ${(e as Error).message}` };
        }

        const resolvedUrl = await resolveCaseUrl(caseRow, { envBaseUrl: envCtx.baseUrl });
        const targetUrl = resolvedUrl && /^https?:\/\//.test(resolvedUrl) ? resolvedUrl : undefined;

        // ── 浏览器 + (可选)登录 → 逐步执行（失败即停）──
        let browser: Browser | undefined;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          if (browser) void browser.close().catch(() => undefined);
        }, VERIFY_TIMEOUT_MS);
        try {
          browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
          const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            viewport: { width: 1280, height: 800 },
          });

          let login: 'logged-in' | 'not-needed' = 'not-needed';
          if (envCtx.login) {
            const loginUrl = envCtx.login.loginUrl || envCtx.baseUrl || '';
            if (!loginUrl) {
              return { ok: false, error: '环境未配置 loginUrl/baseUrl，无法自动登录；请到环境页补全 login 凭据的登录页地址' };
            }
            try {
              login = await loginInContext(context, envCtx.login, loginUrl);
            } catch (e) {
              return { ok: false, error: `登录失败: ${(e as Error).message}` };
            }
          }

          let failurePage: Awaited<ReturnType<typeof extractPageElements>> | null = null;
          const stepInput = steps.map((s) => ({
            order: s.order,
            assertion: s.assertion,
            delayMs: s.delayMs,
            id: s.id,
            tabRef: s.tabRef,
            componentKind: s.componentKind,
            sensitive: s.sensitive,
            compiled: s.compiled as unknown[] | null | undefined,
          }));
          const execCtx: ExecContext = {
            reportId: `verify-${randomUUID()}`,
            projectId: ctx.projectId,
            envCtx,
            expectedOutcome: null, // v1 跳过用例级 vision 判定
            caseTitle: caseRow.title,
            caseUrl: caseRow.url ?? null,
          };
          let stepResults: ExecStepResult[];
          try {
            stepResults = await executeCaseInBrowser(
              caseId,
              stepInput,
              execCtx,
              browser,
              context,
              targetUrl,
              undefined,
              undefined,
              async (page) => {
                failurePage = await extractPageElements(page).catch(() => null);
              },
            );
          } catch (e) {
            if (timedOut) return { ok: false, error: `验证超时（${VERIFY_TIMEOUT_MS / 1000}s）已终止` };
            return { ok: false, error: `验证执行失败: ${(e as Error).message}` };
          }

          // ── 结果组装（成功精简、失败信息密集）──
          const stepsSummary = stepResults.map((r) => ({
            order: r.order,
            status: r.status,
            durationMs: r.durationMs,
            ...(r.hitLocator ? { hitLocator: r.hitLocator } : {}),
          }));
          const failedIndex = stepResults.findIndex((r) => r.status === 'failed');
          if (failedIndex < 0) {
            return {
              ok: true,
              data: JSON.stringify({
                result: 'passed',
                caseId,
                envId: envCtx.envId,
                targetUrl: targetUrl ?? null,
                login,
                steps: stepsSummary,
              }),
            };
          }
          const failed = stepResults[failedIndex]!;
          const failedStep = stepInput[failedIndex];
          return {
            ok: true,
            data: JSON.stringify({
              result: 'failed',
              caseId,
              envId: envCtx.envId,
              targetUrl: targetUrl ?? null,
              login,
              steps: stepsSummary,
              failure: {
                stepOrder: failed.order,
                action: failedStep?.compiled ?? null,
                error: failed.error ?? null,
                failureReason: failed.failureReason ?? null,
                humanMessage: failed.humanMessage ?? null,
                screenshot: failed.screenshot ?? null,
                page: failurePage,
                note: 'page.elements 为失败页当前可见的可交互元素；修正 locator 只能使用其中真实存在的选择器。快照不含操作后才出现的元素。',
              },
            }),
          };
        } finally {
          clearTimeout(timer);
          if (browser) await browser.close().catch(() => undefined);
          await envCtx.close().catch(() => undefined);
        }
      } catch (e) {
        return { ok: false, error: `验证失败: ${(e as Error).message}` };
      }
    },
  };
}
