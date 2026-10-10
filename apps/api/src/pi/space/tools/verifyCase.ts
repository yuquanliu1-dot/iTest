/**
 * verify_case 工具：生成/修改用例后在真实被测系统上实测验证（全 AI 驱动，无硬编码登录）。
 * 编排：读用例 → resolveEnv → resolveCaseUrl → launch → 逐步骤 runAiTask（LLM 看截图+元素清单
 * 自主操作浏览器）→ 失败即停 → 失败页元素清单（复用 inspectPage 提取器）→ 结构化反馈供 agent 自修正。
 * 登录/验证码/改密弹窗等场景由 LLM 按页面实际状态自主判断处理；凭据经占位符注入、执行时刻替换，
 * 不进 LLM 上下文/返回值/日志。验证不落 report（结果只回对话上下文）；副作用与正式执行一致（spec 已确认接受）。
 */
import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { asc, eq, and } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { testCases, testSteps, aiStageCaseOps } from '../../../db/schema.js';
import { runAiTask } from '../../../execute/aiTask.js';
import { writeStepScreenshot } from '../../../execute/cdp.js';
import { runCaseVisionAssert } from '../../../execute/visionAssert.js';
import { resolveEnv } from '../../../execute/envContext.js';
import { resolveCaseUrl } from '../../../lib/resolve-url.js';
import { decrypt } from '../../../lib/secret-crypto.js';
import { resolveLlmClient } from '../../../agent/llmSettings.js';
import { tryParseJson } from '../../../agent/llm-client.js';
import { extractPageElements } from '../../inspectPage.js';
import { computeCaseOverlay } from './case-ops-tools.js';
import { getLoginState, loginStateKey, saveLoginState } from './loginStateCache.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

// AI 轮次慢于编译回放，watchdog 从 120s 放宽到 300s；单步对话轮上限独立收紧。
const VERIFY_TIMEOUT_MS = 300_000;
const STEP_MAX_TURNS = 5;

/** 凭据占位符：提示词里只有字面量，valueSub 在动作执行时刻替换为真实值。 */
const USER_PH = '__ITEST_USERNAME__';
const PASSWORD_PH = '__ITEST_PASSWORD__';
const SECRET_PH = '__ITEST_STEP_SECRET__';

interface AiStepResult {
  order: number;
  status: 'passed' | 'failed';
  durationMs: number;
  warning?: string;
  screenshot?: string;
  error?: string;
  failureReason?: 'StepReportedFailed' | 'AiTaskAborted' | 'SecretMissing' | 'LocatorMismatch';
}

/** compiled 保真校验：verify_case 的 AI 可以临场绕开坏 locator，但正式回放是逐字执行 compiled 的——
 *  校验不通过必须在验证阶段就判失败，逼 AI 用真实选择器修正，而不是"AI 能过=用例能跑"。
 *  时机：click/hover 在步骤前校验（元素此时就该在页面上）；断言类、fill、check、select、extract 在 AI 通过后校验
 *  （这些动作结束时元素理应仍在）。navigate/aiTask/waitFor 无从或不必校验，跳过。
 *  locator 数组为候选或关系：任一命中即通过（与回放 tryFirstMatch 语义一致）；全部可探测候选均未命中才判失败。
 *  候选探测异常（选择器不合法）按该候选落空处理——回放对 count 异常也是捕获后继续下一候选，两边语义一致。
 *  role 等构建成本高的策略不探测、视为可信（占比小）。 */
async function checkCompiledLocators(
  page: import('playwright-core').Page,
  compiled: unknown,
  mode: 'pre' | 'post',
): Promise<string | null> {
  const actions = (Array.isArray(compiled) ? compiled : []) as Array<{
    kind?: string;
    locator?: Array<{ strategy?: string; value?: string }>;
  }>;
  for (const a of actions) {
    if (!a.kind) continue;
    const timing = a.kind === 'click' || a.kind === 'hover' ? 'pre' : 'post';
    if (a.kind === 'navigate' || a.kind === 'aiTask' || a.kind === 'waitFor') continue;
    if (timing !== mode) continue;
    const locs = Array.isArray(a.locator) ? a.locator : [];
    if (locs.length === 0) continue;
    // 结构性错误与命中无关，直接判失败
    for (const l of locs) {
      if (l.strategy === 'accessibilityId' || l.strategy === 'label' || l.strategy === 'predicate') {
        return `compiled 定位校验不通过: strategy '${l.strategy}' 为移动端专用，web 回放不支持`;
      }
      if (typeof l.value !== 'string' || !l.value) {
        return `compiled 定位校验不通过: ${a.kind} 的 locator 缺少 value`;
      }
    }
    // 候选或关系：按序探测，任一命中即通过（剩余候选不再探测）；全部落空才判失败
    let hit = false;
    let probed = 0;
    const misses: string[] = [];
    for (const l of locs) {
      const value = l.value as string;
      // 与回放 tryFirstMatch 同策略映射；role 等构建成本高的策略跳过（占比小）。
      const probe = (): Promise<number> => {
        switch (l.strategy) {
          case 'css': return page.locator(value).count();
          case 'text': return page.getByText(value).count();
          case 'xpath': return page.locator(`xpath=${value}`).count();
          case 'testId': return page.getByTestId(value).count();
          default: return Promise.resolve(-1); // 跳过
        }
      };
      if (l.strategy !== 'css' && l.strategy !== 'text' && l.strategy !== 'xpath' && l.strategy !== 'testId') continue;
      probed++;
      try {
        let n = await probe();
        if (n === 0) {
          // a11y 树滞后兜底，与回放 count=0 短重试一次同思路
          await page.waitForTimeout(150);
          n = await probe();
        }
        if (n > 0) {
          hit = true;
          break;
        }
        misses.push(`${l.strategy}=${l.value} 命中 0 个元素`);
      } catch (e) {
        misses.push(`${l.strategy}=${l.value} 探测异常: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    if (probed > 0 && !hit) {
      return `compiled 定位校验不通过（回放将失败）: ${a.kind} 全部 ${probed} 个候选均未命中 — ${misses.join('；')}`;
    }
  }
  return null;
}

/** 单步执行指令：自然语言 + compiled 参考 + 占位符凭据段（仅配置了 login 时）+ 输出契约。 */
function buildStepInstruction(
  step: { order: number; instruction: string | null; compiled: unknown; assertion: unknown },
  total: number,
  sec: { hasLogin: boolean; hasSecret: boolean },
): string {
  const lines: string[] = [];
  lines.push('你是网页测试执行器，在当前浏览器页面上完成下面这一步测试操作，完成后按输出契约结束。');
  lines.push('');
  lines.push(`## 步骤（第 ${step.order} 步 / 共 ${total} 步）`);
  lines.push(`- 自然语言：${step.instruction ?? '（无，以编译动作为准）'}`);
  lines.push('- 编译动作（compiled DSL，供参考；若页面实际与它不符，以实际页面为准自行调整）：');
  lines.push(JSON.stringify(step.compiled));
  if (step.assertion != null) lines.push(`- 断言（预期结果，完成后自行核实）：${JSON.stringify(step.assertion)}`);
  if (sec.hasLogin) {
    lines.push('');
    lines.push('## 登录凭据');
    lines.push('若当前页面是登录页（由你根据页面内容自行判断），先用占位符完成登录再执行本步：');
    lines.push(`- 用户名输入框 fill 的 value 用字面量 ${USER_PH}`);
    lines.push(`- 密码输入框 fill 的 value 用字面量 ${PASSWORD_PH}`);
    lines.push('平台会把占位符替换为真实值；你不得猜测、拼接或输出真实凭据。');
    lines.push('登录后若出现强制改密/绑定等弹窗，按页面提示处理（能跳过则跳过）后继续本步。');
  }
  if (sec.hasSecret) {
    lines.push(`本步含加密敏感字段，填入时 value 一律用字面量 ${SECRET_PH}（平台替换为真实值，你不得猜测）。`);
  }
  lines.push('');
  lines.push('## 输出契约');
  lines.push('done.summary 必须是该 JSON 对象序列化后的文本：');
  lines.push('{"status":"passed"|"failed","reason":"<一句话中文>","login":"logged-in"|"not-needed"}');
  lines.push('- passed：本步操作（含触发的登录）已按页面实际状态完成；failed 写清原因。');
  lines.push('- login：本轮你实际执行了登录填表并提交 → 必须填 "logged-in"（即使登录发生在本步骤开头）；确实没有登录任何表单 → "not-needed"。');
  lines.push('中途无法继续时直接输出 {"fail":"原因"}。');
  return lines.join('\n');
}

export function buildVerifyCaseTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'verify_case',
    description:
      '在真实被测系统上逐步验证用例的 compiled 步骤可执行性（全 AI 驱动：模型看截图与元素清单自主操作浏览器，登录/验证码/弹窗由模型按页面实际状态自主处理），失败即停并返回失败步骤详情与失败页可交互元素清单。依据清单修正 locator 后可再次调用（同一用例建议最多 3 轮）。验证会产生真实副作用（与正式执行一致）。',
    parameters: Type.Object({
      caseId: Type.String({ minLength: 1 }),
    }),
    promptGuidelines: [
      '含 compiled 步骤的用例创建/修改后，环境可用时调用 verify_case 实测验证，不要只凭源码分析就声称用例可运行。',
      'verify_case 全 AI 驱动：登录、验证码、改密弹窗等场景由模型自主判断处理；凭据以 __ITEST_USERNAME__ 等占位符注入执行，不会出现在任何输出中。',
      'verify_case 失败时：读取 failure.page.elements，只能用清单中真实存在的选择器修正对应步骤的 locator/动作，禁止臆造；修正走 stage_case_op 暂存后，直接再次调用 verify_case —— 本线程暂存的修改会自动叠加生效（响应 basedOn=staged），验证循环全程不要落库；全部步骤通过后,确认验证通过后再引导用户在右侧暂存区勾选统一保存。',
      'verify_case 会校验 compiled 选择器能真实命中页面（AI 临场绕开坏 locator 不算通过，回放逐字执行 compiled 会失败）:失败原因含"定位校验不通过"时,必须用 failure.page.elements 里的真实选择器替换原 locator(严禁留着坏 locator 只靠 AI 硬跑)。verify_case 还会做用例级终态判定(失败原因含 VisionAssertionFailed):步骤都通过但最终页面不符 expectedOutcome 时,修正步骤行为或调整 expectedOutcome 后再验。',
      '同一用例验证最多重试 3 轮；仍失败则保留用例，如实向用户说明失败步骤与原因，不要无限循环。',
      '环境未配置 login 凭据而验证卡在登录页时，引导用户到项目环境页配置 login 凭据，不要伪造登录步骤。',
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

        // ── 暂存叠加：本线程已暂存的 stage_case_op 虚拟应用到 DB 用例上,验证基于暂存状态继续——
        //    失败→暂存修正→直接重验的循环全程不落库,全部通过后用户在暂存区统一保存 ──
        const stagedOps = await db
          .select({ op: aiStageCaseOps.op, payload: aiStageCaseOps.payload })
          .from(aiStageCaseOps)
          .where(and(eq(aiStageCaseOps.threadId, ctx.threadId), eq(aiStageCaseOps.caseId, caseId)))
          .orderBy(asc(aiStageCaseOps.stagedAt));
        const overlay = computeCaseOverlay(steps, stagedOps);
        if (overlay.deleteStaged) {
          return { ok: false, error: '用例已暂存删除，请先在暂存区取消删除（或落库）后再验证' };
        }
        const effectiveSteps = overlay.steps ?? steps;
        if (effectiveSteps.length === 0) return { ok: false, error: '用例没有可验证的步骤' };
        const effectiveCase =
          overlay.url !== undefined || overlay.defaultEnvId !== undefined
            ? {
                ...caseRow,
                ...(overlay.url !== undefined ? { url: overlay.url } : {}),
                ...(overlay.defaultEnvId !== undefined ? { defaultEnvId: overlay.defaultEnvId } : {}),
              }
            : caseRow;

        // ── LLM 前置检查（全 AI 驱动的硬前提；未配置直接失败，用户去设置页配置）──
        let client: Awaited<ReturnType<typeof resolveLlmClient>>['client'];
        try {
          client = (await resolveLlmClient()).client;
        } catch (e) {
          return { ok: false, error: `LLM 未配置，无法执行 AI 验证: ${(e as Error).message}` };
        }

        // ── 环境解析（case defaultEnv > version link > 项目默认）──
        let envCtx: Awaited<ReturnType<typeof resolveEnv>>;
        try {
          envCtx = await resolveEnv(
            { caseEnvId: effectiveCase.defaultEnvId ?? null, versionId: effectiveCase.versionId ?? ctx.versionId },
            { expectedProjectId: ctx.projectId },
          );
        } catch (e) {
          const errName = e instanceof Error ? e.name : '';
          if (errName === 'EnvMissing') return { ok: false, error: '缺少环境配置，请到项目环境页配置默认环境' };
          if (errName === 'EnvProjectMismatch') return { ok: false, error: '环境所属项目与当前用例不匹配' };
          return { ok: false, error: `环境解析失败: ${(e as Error).message}` };
        }

        // ── 浏览器 + watchdog → 逐步骤 AI 驱动执行（fail-stop）──
        let browser: Browser | undefined;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          if (browser) void browser.close().catch(() => undefined);
        }, VERIFY_TIMEOUT_MS);
        try {
          // resolveCaseUrl 有 db 查询，放进本 try 让 finally 的 envCtx.close 兜底（否则查询抛错会泄漏连接池）
          const resolvedUrl = await resolveCaseUrl(effectiveCase, { envBaseUrl: envCtx.baseUrl });
          const targetUrl = resolvedUrl && /^https?:\/\//.test(resolvedUrl) ? resolvedUrl : undefined;
          browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
          // 命中登录态缓存则注入 context:同环境重试轮/后续用例免登录（过期自愈,见 loginStateCache）
          const loginKey = loginStateKey(envCtx.envId, envCtx.login?.user);
          const cachedState = getLoginState(loginKey);
          const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            viewport: { width: 1280, height: 800 },
            ...(cachedState ? { storageState: cachedState } : {}),
          });
          const page = await context.newPage();

          // 初始导航（与 cdp.ts runStepsInContext 同判定：首条 compiled 为同 URL navigate 则跳过，避免重复加载）
          if (targetUrl) {
            const firstCompiled = effectiveSteps[0]?.compiled;
            const firstAction = (Array.isArray(firstCompiled) && firstCompiled.length > 0
              ? firstCompiled[0]
              : undefined) as { kind?: string; url?: string } | undefined;
            const skipInit = firstAction?.kind === 'navigate' && firstAction.url === targetUrl;
            if (!skipInit) {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
            }
          }

          // 占位符 → 真实值（无凭据时替换为 ''，提示词相应不注入凭据段）
          const cred = envCtx.login;
          let stepSecret: string | undefined;
          const valueSub = (v: string): string => {
            if (v === USER_PH) return cred?.user ?? '';
            if (v === PASSWORD_PH) return cred?.password ?? '';
            if (v === SECRET_PH) return stepSecret ?? '';
            return v;
          };

          const reportId = `verify-${randomUUID()}`;
          const stepResults: AiStepResult[] = [];
          let failedIndex = -1;
          let login: 'logged-in' | 'not-needed' = 'not-needed';
          // SSE 实时进度：验证全程可达数分钟，前端凭这些事件渲染逐步进度卡（spaceEventsStore.verify_progress）。
          // loginCache/loginUser：登录态缓存命中与凭据用户直显对话框，无需翻服务端日志即可确认复用生效。
          ctx.emit({
            type: 'verify_progress', phase: 'start', caseId, total: effectiveSteps.length, targetUrl: targetUrl ?? null,
            loginCache: cachedState ? ('hit' as const) : ('miss' as const),
            loginUser: envCtx.login?.user ?? null,
            stagedOps: overlay.opsApplied,
          });
          for (let i = 0; i < effectiveSteps.length; i++) {
            const s = effectiveSteps[i]!;
            const started = Date.now();

            // 敏感步骤先解密：密文缺失/解密失败直接判该步失败，不让 LLM 乱填
            stepSecret = undefined;
            if (s.sensitive) {
              if (!s.secretCiphertext || !s.secretIv || !s.secretTag) {
                stepResults.push({
                  order: s.order, status: 'failed', durationMs: Date.now() - started,
                  error: 'sensitive 步骤缺少密文（secret-missing）', failureReason: 'SecretMissing',
                });
                ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: 'sensitive 步骤缺少密文' });
                failedIndex = i;
                break;
              }
              try {
                stepSecret = decrypt({
                  ciphertext: Buffer.from(s.secretCiphertext, 'base64'),
                  iv: Buffer.from(s.secretIv, 'base64'),
                  tag: Buffer.from(s.secretTag, 'base64'),
                });
              } catch {
                stepResults.push({
                  order: s.order, status: 'failed', durationMs: Date.now() - started,
                  error: '敏感字段解密失败（secret-decrypt）', failureReason: 'SecretMissing',
                });
                ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: '敏感字段解密失败' });
                failedIndex = i;
                break;
              }
            }

            if (s.delayMs) await page.waitForTimeout(s.delayMs);
            const instruction = buildStepInstruction(
              { order: s.order, instruction: s.instruction, compiled: s.compiled, assertion: s.assertion },
              effectiveSteps.length,
              { hasLogin: !!envCtx.login, hasSecret: stepSecret !== undefined },
            );
            ctx.emit({
              type: 'verify_progress', phase: 'step_start', order: s.order,
              brief: (s.instruction ?? JSON.stringify(s.compiled) ?? '').slice(0, 120),
            });
            // compiled 保真前置校验：click/hover 的目标元素此刻就该在页面上，解析不到直接判失败（不烧 AI 轮次）
            const preErr = await checkCompiledLocators(page, s.compiled, 'pre');
            if (preErr) {
              stepResults.push({
                order: s.order, status: 'failed', durationMs: Date.now() - started,
                error: preErr, failureReason: 'LocatorMismatch',
                screenshot: await writeStepScreenshot(reportId, i + 1, page),
              });
              ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: preErr.slice(0, 120) });
              failedIndex = i;
              break;
            }
            try {
              const summary = await runAiTask(page, instruction, client, false, {
                maxTurns: STEP_MAX_TURNS,
                valueSub,
              });
              const parsed = tryParseJson(summary);
              if (parsed && parsed.status === 'failed') {
                // LLM 自报失败：fail-stop，原因直达反馈
                const reason = typeof parsed.reason === 'string' ? parsed.reason : summary.slice(0, 200);
                stepResults.push({
                  order: s.order, status: 'failed', durationMs: Date.now() - started,
                  error: reason, failureReason: 'StepReportedFailed',
                  screenshot: await writeStepScreenshot(reportId, i + 1, page),
                });
                ctx.emit({
                  type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: reason.slice(0, 120),
                  ...(typeof parsed?.login === 'string' ? { login: parsed.login } : {}),
                });
                failedIndex = i;
                break;
              }
              if (parsed?.login === 'logged-in') login = 'logged-in';
              // compiled 保真后置校验：assert*/fill/check/select/extract 结束时元素理应仍在；
              // AI 可以临场绕开坏 locator，但回放逐字执行 compiled——此刻校验不过，回放必挂
              const postErr = await checkCompiledLocators(page, s.compiled, 'post');
              if (postErr) {
                stepResults.push({
                  order: s.order, status: 'failed', durationMs: Date.now() - started,
                  error: postErr, failureReason: 'LocatorMismatch',
                  screenshot: await writeStepScreenshot(reportId, i + 1, page),
                });
                ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: postErr.slice(0, 120) });
                failedIndex = i;
                break;
              }
              stepResults.push({
                order: s.order, status: 'passed', durationMs: Date.now() - started,
                screenshot: await writeStepScreenshot(reportId, i + 1, page),
                // 契约漂移兜底：summary 非 JSON 也算通过，但原文带出 warning 供人工核查
                ...(parsed ? {} : { warning: summary.slice(0, 200) }),
              });
              ctx.emit({
                type: 'verify_progress', phase: 'step_done', order: s.order, status: 'passed',
                durationMs: Date.now() - started,
                // 逐步登录行为以 LLM 当轮自报为准（含契约漂移,如实展示）
                ...(typeof parsed?.login === 'string' ? { login: parsed.login } : {}),
                ...(parsed ? {} : { reason: summary.slice(0, 120) }),
              });
            } catch (e) {
              // watchdog 强关浏览器会让在途 runAiTask 抛错——此时真实原因是超时而非步骤失败
              if (timedOut) return { ok: false, error: `验证超时（${VERIFY_TIMEOUT_MS / 1000}s）已终止` };
              stepResults.push({
                order: s.order, status: 'failed', durationMs: Date.now() - started,
                error: (e as Error).message.slice(0, 300), failureReason: 'AiTaskAborted',
                screenshot: await writeStepScreenshot(reportId, i + 1, page),
              });
              ctx.emit({ type: 'verify_progress', phase: 'step_done', order: s.order, status: 'failed', durationMs: Date.now() - started, reason: (e as Error).message.slice(0, 120) });
              failedIndex = i;
              break;
            }
          }

          // 用例级终态判定：与正式回放同一 vision 断言（cdp.ts runCaseVisionAssert），
          // 全部步骤通过后再判 expectedOutcome——verify_case 不能只保证"步骤能执行"，还得保证"终态符合预期"。
          let visionFailure: { error?: string | null; humanMessage?: string | null; screenshot?: string | null; failureReason?: string | null } | null = null;
          if (failedIndex < 0 && typeof caseRow.expectedOutcome === 'string' && caseRow.expectedOutcome.trim()) {
            const va = await runCaseVisionAssert({
              page,
              reportId,
              caseTitle: caseRow.title,
              caseUrl: targetUrl ?? null,
              expectedOutcome: caseRow.expectedOutcome,
              vars: {},
              sensitiveVarKeys: [],
              llmClient: client,
            });
            if (va?.failureStep) {
              visionFailure = va.failureStep;
              ctx.emit({
                type: 'verify_progress', phase: 'step_done', order: -1, status: 'failed',
                reason: (va.failureStep.error ?? '终态与用例预期不符').slice(0, 120),
              });
            }
          }

          // 登录态回写：不依赖 LLM 自报的 login 字段（实测存在漏报契约漂移），配了登录就无条件存当前会话——
          // 未登录时存的是匿名会话，下轮注入后 AI 照样识别登录页重新登录并覆盖（自愈）。
          // watchdog 超时路径在循环内提前 return，不会走到这里。
          const savedState = await context.storageState().catch(() => null);
          if (savedState) saveLoginState(loginKey, savedState);

          // ── 失败收尾：失败页元素清单（供 agent 修正 locator）──
          let failurePage: Awaited<ReturnType<typeof extractPageElements>> | null = null;
          if (failedIndex >= 0 || visionFailure) {
            failurePage = await extractPageElements(page).catch(() => null);
          }

          // ── 结果组装（成功精简、失败信息密集）──
          const stepsSummary = stepResults.map((r) => ({
            order: r.order,
            status: r.status,
            durationMs: r.durationMs,
            ...(r.warning ? { warning: r.warning } : {}),
            ...(r.screenshot ? { screenshot: r.screenshot } : {}),
            ...(r.error ? { error: r.error } : {}),
            ...(r.failureReason ? { failureReason: r.failureReason } : {}),
          }));
          if (failedIndex < 0 && !visionFailure) {
            // cacheSaved: 正常收尾均无条件回写（watchdog 超时路径在循环内提前 return,无 end 事件）
            ctx.emit({ type: 'verify_progress', phase: 'end', result: 'passed', cacheSaved: true });
            return {
              ok: true,
              data: JSON.stringify({
                result: 'passed',
                caseId,
                envId: envCtx.envId,
                targetUrl: targetUrl ?? null,
                login,
                basedOn: overlay.opsApplied > 0 ? ('staged' as const) : ('db' as const),
                stagedOpsApplied: overlay.opsApplied,
                steps: stepsSummary,
              }),
            };
          }
          if (visionFailure) {
            ctx.emit({ type: 'verify_progress', phase: 'end', result: 'failed', cacheSaved: true });
            return {
              ok: true,
              data: JSON.stringify({
                result: 'failed',
                caseId,
                envId: envCtx.envId,
                targetUrl: targetUrl ?? null,
                login,
                basedOn: overlay.opsApplied > 0 ? ('staged' as const) : ('db' as const),
                stagedOpsApplied: overlay.opsApplied,
                steps: stepsSummary,
                failure: {
                  stepOrder: -1,
                  action: null,
                  error: visionFailure.error ?? '最终页面与用例预期不符',
                  failureReason: visionFailure.failureReason ?? 'VisionAssertionFailed',
                  humanMessage: visionFailure.humanMessage ?? '最终页面与用例预期不符',
                  screenshot: visionFailure.screenshot ?? null,
                  page: failurePage,
                  note: 'vision 终态判定失败：全部步骤执行通过后，最终页面仍不符合 expectedOutcome。请核对最后几步的实际业务效果，修正步骤或 expectedOutcome 后重验。',
                },
              }),
            };
          }
          const failed = stepResults[failedIndex]!;
          const failedStep = effectiveSteps[failedIndex]!;
          ctx.emit({ type: 'verify_progress', phase: 'end', result: 'failed', cacheSaved: true });
          return {
            ok: true,
            data: JSON.stringify({
              result: 'failed',
              caseId,
              envId: envCtx.envId,
              targetUrl: targetUrl ?? null,
              login,
              basedOn: overlay.opsApplied > 0 ? ('staged' as const) : ('db' as const),
              stagedOpsApplied: overlay.opsApplied,
              steps: stepsSummary,
              failure: {
                stepOrder: failed.order,
                action: failedStep.compiled ?? null,
                error: failed.error ?? null,
                failureReason: failed.failureReason ?? null,
                humanMessage: failed.error ?? null,
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
