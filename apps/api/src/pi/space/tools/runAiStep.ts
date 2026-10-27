/**
 * run_ai_step 工具：免暂存直跑 AI 相——用户明确要求「不生成步骤直接跑」时，
 * 跳过 stage_case 草稿环节，直接在真实被测系统浏览器上执行一条自然语言指令
 * （AI 相视觉执行：模型看截图与元素清单自主操作，登录/验证码/弹窗自主处理），
 * 跑完把结果回报给用户、边跑边讨论。
 * 同一线程连续调用复用同一个浏览器会话：页面状态跨调用保留（上一步打开的
 * 对话框/页面下一步直接操作），空闲 10 分钟自动回收。凭据走占位符注入 +
 * 登录态缓存读写（与 verify_case 同一把尺），真实值不进 LLM 上下文/输出。
 */
import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { resolveEnv } from '../../../execute/envContext.js';
import { runAiTask, USER_PH, PASSWORD_PH, credentialPlaceholder, makeCredentialValueSub } from '../../../execute/aiTask.js';
import { buildCredentialSource, renderWebResourceManifest } from '../../../execute/credentialSource.js';
import { gotoWithLandedRetry, writeStepScreenshot } from '../../../execute/cdp.js';
import { resolveLlmClient } from '../../../agent/llmSettings.js';
import { tryParseJson } from '../../../agent/llm-client.js';
import { getLoginState, loginStateKey, saveLoginState } from './loginStateCache.js';
import { registerLiveView, type LiveViewHandle } from '../../../execute/liveView.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

/** 会话空闲回收窗口：讨论间隙超过 10 分钟即回收浏览器（下次调用重新建立）。 */
const AI_STEP_SESSION_TTL_MS = 10 * 60_000;
/** 单条指令墙钟帽子：runAiTask 只按轮数受限，LLM 客户端挂起时轮数计数不到——
 *  与 verify_case 的 STEP_AI_TIMEOUT_MS 同值（240s：慢 SUT 冷启动+登录实测 183.7s，留 ~30% 余量）。 */
const AI_STEP_TIMEOUT_MS = 240_000;

interface AiStepSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  live: LiveViewHandle;
  envId: string;
  loginUser: string | null;
  webRef: string | null;
  /** 会话建立时的登录态缓存 key（envId:user），回写用。 */
  loginKey: string;
  /** 会话建立时是否命中登录态缓存（进度事件回显）。 */
  loginCache: 'hit' | 'miss';
  lastUsed: number;
}
const aiStepSessions = new Map<string, AiStepSession>();

async function closeSession(s: AiStepSession): Promise<void> {
  s.live.close();
  await s.browser.close().catch(() => undefined);
}

// 空闲会话清扫：懒过期之外，线程讨论结束后浏览器进程不留挂（unref 不阻退出）。
const sweeper = setInterval(
  () => {
    const now = Date.now();
    for (const [key, s] of aiStepSessions) {
      if (now - s.lastUsed > AI_STEP_SESSION_TTL_MS) {
        aiStepSessions.delete(key);
        void closeSession(s);
      }
    }
  },
  60_000,
);
sweeper.unref();

/** 指令提示词：用户自然语言指令 + 占位符凭据段（仅配置了 login 时）+ 输出契约。
 *  协议与 verify_case 的 buildStepInstruction 同源（无步骤序号/compiled 参考段）。 */
function buildAiStepInstruction(instruction: string, hasLogin: boolean, webManifest: string): string {
  const lines: string[] = [];
  lines.push('你是网页测试执行器，在当前浏览器页面上完成用户指定的这一步操作，完成后按输出契约结束。');
  lines.push('');
  lines.push('## 本次操作');
  lines.push(instruction);
  if (hasLogin) {
    lines.push('');
    lines.push('## 登录凭据');
    lines.push('若当前页面是登录页（由你根据页面内容自行判断），先用占位符完成登录再执行本步：');
    if (webManifest) {
      lines.push('## 本次可用的 web 服务');
      lines.push(webManifest);
      lines.push(`- 用户名输入框 fill 的 value 用字面量 ${credentialPlaceholder('user', '<服务名>')}`);
      lines.push(`- 密码输入框 fill 的 value 用字面量 ${credentialPlaceholder('password', '<服务名>')}`);
      lines.push('- 「未配置凭据」的服务不要尝试登录（必然失败）；需要跨系统时用对应服务名做归属。');
    } else {
      lines.push(`- 用户名输入框 fill 的 value 用字面量 ${USER_PH}`);
      lines.push(`- 密码输入框 fill 的 value 用字面量 ${PASSWORD_PH}`);
    }
    lines.push('平台会把占位符替换为真实值；你不得猜测、拼接或输出真实凭据。');
    lines.push('登录后若出现强制改密/绑定等弹窗，按页面提示处理（能跳过则跳过）后继续本步。');
  }
  lines.push('');
  lines.push('## 输出契约');
  lines.push('done.summary 必须是该 JSON 对象序列化后的文本：');
  lines.push('{"status":"passed"|"failed","reason":"<一句话中文>","login":"logged-in"|"not-needed"}');
  lines.push('- passed：本步操作（含触发的登录）已按页面实际状态完成；failed 写清原因。');
  lines.push('- login：本轮你实际执行了登录填表并提交 → "logged-in"；确实没有登录任何表单 → "not-needed"。');
  lines.push('中途无法继续时直接输出 {"fail":"原因"}。');
  return lines.join('\n');
}

export function buildRunAiStepTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'run_ai_step',
    description:
      '在被测系统真实浏览器上直接执行一条自然语言操作指令（AI 相：模型看截图与元素清单自主操作浏览器，登录/验证码/弹窗自主处理），无需先创建/暂存用例。用于用户明确要求「不生成步骤直接跑 / 先在页面上试一下」的讨论场景：逐条执行用户指令、逐步回报结果，边跑边讨论。同一线程连续调用复用同一个浏览器会话——页面状态跨调用保留（上一步打开的对话框/页面下一步仍在），空闲 10 分钟自动回收；url 缺省时停留在当前页面继续操作，传 url 则导航到该地址（首次调用必须给出目标：传 url，或环境默认 web 服务 origin 兜底）。执行有 live view 视频流；与正式执行一样会产生真实副作用。',
    parameters: Type.Object({
      instruction: Type.String({ minLength: 1, maxLength: 2000 }),
      url: Type.Optional(Type.String({ minLength: 8, maxLength: 2000 })),
      webRef: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    }),
    promptGuidelines: [
      '用户明确要求不生成步骤直接跑（如「不用写用例，直接在页面上试试」「先跑一下看看」）时，用 run_ai_step 逐条执行用户的自然语言指令：每次调用执行一个操作意图，跑完把结果（成功/失败与原因、页面变化）回报给用户再继续讨论——不要先 stage_case 或生成用例草稿。',
      'run_ai_step 同线程复用同一浏览器会话：连续指令不要每条都传 url（页面状态保留，上一步打开的弹窗/页面下一步直接操作即可）；只有需要换页面时才传 url。',
      '跑通的步骤若用户认可、要沉淀为用例，再回到常规流程：stage_case 暂存（步骤=讨论中验证过的自然语言指令）→ verify_case 实测 → solidify_case 固化。',
    ],
    execute: async (input) => {
      const { instruction, url, webRef: webRefInput } = input as { instruction: string; url?: string; webRef?: string };
      const webRef = webRefInput?.trim() || null;
      try {
        // ── 会话复用（懒过期：超时的旧会话就地回收重建）──
        const existing = aiStepSessions.get(ctx.threadId);
        let session = existing && Date.now() - existing.lastUsed <= AI_STEP_SESSION_TTL_MS ? existing : null;
        if (existing && !session) {
          aiStepSessions.delete(ctx.threadId);
          void closeSession(existing);
        }

        // ── 环境每次调用独立解析（不跨调用持有连接池）；会话把凭据口径固定在建立时刻 ──
        const envCtx = await resolveEnv({ versionId: ctx.versionId }, { expectedProjectId: ctx.projectId });
        try {
          const cred = envCtx.resolveLogin(webRef);
          // 首次调用必须有目标地址：url 优先，缺省回落环境默认 web 服务 origin
          let firstUrl: string | null = null;
          if (!session && !url) {
            try {
              const origin = envCtx.resolveWebOrigin(webRef);
              firstUrl = origin || null;
            } catch {
              firstUrl = null;
            }
            if (!firstUrl) {
              return { ok: false, error: '缺少目标地址：首次调用请传 url（目标业务页完整深链），且环境未配置可兜底的默认 web 服务' };
            }
          }
          // LLM 未配置直接失败（不启动浏览器）
          const client = (await resolveLlmClient()).client;
          const notes: string[] = [];
          let targetUrl = url ?? undefined;
          if (!session) {
            targetUrl = url ?? firstUrl!;
            const loginKey = loginStateKey(envCtx.envId, cred?.user);
            const cachedState = getLoginState(loginKey);
            const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
            const context = await browser.newContext({
              ignoreHTTPSErrors: true,
              viewport: { width: 1280, height: 800 },
              ...(cachedState ? { storageState: cachedState } : {}),
            });
            const page = await context.newPage();
            const live = registerLiveView();
            live.setPage(page);
            session = {
              browser,
              context,
              page,
              live,
              envId: envCtx.envId,
              loginUser: cred?.user ?? null,
              webRef,
              loginKey,
              loginCache: cachedState ? 'hit' : 'miss',
              lastUsed: Date.now(),
            };
            aiStepSessions.set(ctx.threadId, session);
            // 初始导航 + 落地校验重试（深链冷启动竞态兜底；落到登录页不告警——AI 相会自助登录）
            const landed = await gotoWithLandedRetry(page, targetUrl);
            if (!landed.landed && !landed.finalUrl.includes('/login')) {
              notes.push(`入口 goto 后未落到目标页（当前 ${landed.finalUrl}，目标 ${targetUrl}）——若后续操作失败，先核对是否入口未达。`);
            }
          } else if (url) {
            // 已有会话显式换页：导航到新地址
            const landed = await gotoWithLandedRetry(session.page, url);
            if (!landed.landed && !landed.finalUrl.includes('/login')) {
              notes.push(`goto 后未落到目标页（当前 ${landed.finalUrl}，目标 ${url}）。`);
            }
          }
          const s = session;
          const manifest = (() => {
            try {
              return renderWebResourceManifest({ envCtx });
            } catch {
              return '';
            }
          })();
          const valueSub = makeCredentialValueSub(buildCredentialSource({ envCtx, caseWebServiceRef: s.webRef }));

          const startedAt = Date.now();
          const startUrl = targetUrl ?? s.page.url();
          ctx.emit({
            type: 'ai_step_progress',
            phase: 'start',
            instruction: instruction.slice(0, 120),
            targetUrl: startUrl,
            loginCache: s.loginCache,
            loginUser: s.loginUser,
            liveUrl: `/api/assistant/threads/${ctx.threadId}/live/${s.live.key}`,
          });

          const reportId = `aistep-${randomUUID()}`;
          let result: 'passed' | 'failed';
          let reason: string | null = null;
          let warning: string | undefined;
          let login: 'logged-in' | 'not-needed' = 'not-needed';
          let runP: Promise<string> | undefined;
          let sessionDropped = false;
          let guardTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            runP = runAiTask(s.page, buildAiStepInstruction(instruction, !!cred, manifest), client, false, {
              valueSub,
              lang: ctx.lang,
              resourceManifest: manifest,
            });
            const guard = new Promise<never>((_, reject) => {
              guardTimer = setTimeout(() => reject(new Error('AI_STEP_TIMEOUT')), AI_STEP_TIMEOUT_MS);
            });
            const summary = await Promise.race([runP, guard]);
            const parsed = tryParseJson(summary);
            if (parsed?.status === 'failed') {
              result = 'failed';
              reason = typeof parsed.reason === 'string' ? parsed.reason : summary.slice(0, 200);
            } else {
              result = 'passed';
              if (!parsed) warning = summary.slice(0, 200); // 契约漂移兜底：非 JSON 也算通过，原文带出供人工核查
              if (parsed?.login === 'logged-in') login = 'logged-in';
            }
          } catch (e) {
            const msg = (e as Error).message ?? '';
            result = 'failed';
            if (msg === 'AI_STEP_TIMEOUT') {
              // 墙钟超时：在途 runAiTask 放弃（browser 关闭后其 page 操作自然 reject），
              // 会话整体回收——下次调用重新建立，避免与在途执行抢同一页面。
              void runP?.catch(() => undefined);
              aiStepSessions.delete(ctx.threadId);
              void closeSession(s);
              sessionDropped = true;
              reason = `执行超过 ${AI_STEP_TIMEOUT_MS / 1000}s 已中止`;
            } else {
              reason = msg.slice(0, 300);
            }
          } finally {
            // 竞速结束即清墙钟定时器（verify_case 同款）：不清会每调用漏一个 240s 挂起定时器。
            if (guardTimer) clearTimeout(guardTimer);
          }

          // 登录态回写（与 verify_case 同语义：无条件存当前会话，未登录时存匿名会话也会被下轮自愈）
          if (!sessionDropped) {
            const st = await s.context.storageState().catch(() => null);
            if (st) saveLoginState(s.loginKey, st);
          }
          const screenshot = sessionDropped
            ? null
            : await writeStepScreenshot(reportId, 1, s.page).catch(() => null);
          s.lastUsed = Date.now();
          // 页面崩溃（page closed）时回收会话：下次调用重建
          if (!sessionDropped && s.page.isClosed()) {
            aiStepSessions.delete(ctx.threadId);
            void closeSession(s);
          }
          ctx.emit({
            type: 'ai_step_progress',
            phase: 'end',
            result,
            ...(reason ? { reason: reason.slice(0, 120) } : {}),
            durationMs: Date.now() - startedAt,
            ...(login === 'logged-in' ? { login } : {}),
          });
          return {
            ok: true,
            data: JSON.stringify({
              result,
              instruction,
              reason,
              ...(warning ? { warning } : {}),
              login,
              durationMs: Date.now() - startedAt,
              screenshot,
              pageUrl: sessionDropped ? null : s.page.url(),
              ...(notes.length > 0 ? { notes } : {}),
            }),
          };
        } finally {
          await envCtx.close().catch(() => undefined);
        }
      } catch (e) {
        return { ok: false, error: `AI 相直跑失败: ${(e as Error).message}` };
      }
    },
  };
}
