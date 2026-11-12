import { Type } from '@earendil-works/pi-ai';
import { chromium } from 'playwright-core';
import { resolveEnv } from '../../../execute/envContext.js';
import { runAiTask, credentialPlaceholder, makeCredentialValueSub } from '../../../execute/aiTask.js';
import { buildCredentialSource, renderWebResourceManifest } from '../../../execute/credentialSource.js';
import { registerLiveView } from '../../../execute/liveView.js';
import { resolveLlmClient } from '../../../agent/llmSettings.js';
import { tryParseJson } from '../../../agent/llm-client.js';
import { loginStateKey, saveLoginState } from './loginStateCache.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

/** Login instruction: target navigation, placeholder credentials, captcha recognition (the system prompt's existing OCR rules); success is self-judged by the model from the page state.
 *  When webRef names a target web service, the placeholders carry @ref ownership; the manifest tells the model which other services are available. */
function buildLoginInstruction(targetUrl: string, webRef: string | null, manifest: string): string {
  const phUser = credentialPlaceholder('user', webRef);
  const phPassword = credentialPlaceholder('password', webRef);
  const manifestSection = manifest ? `\n## 可选 web 服务\n${manifest}\n` : '';
  // With a service manifest, additionally give the @name-suffixed literal forms: to log into another system the model copies that line.
  const refHint = manifest
    ? `\n   （要登清单里的其它服务时，改用该服务名对应的占位符，如 ${credentialPlaceholder('user', '<服务名>')} / ${credentialPlaceholder('password', '<服务名>')}）`
    : '';
  return `你需要在浏览器里完成网站登录，成功后停留在登录后的页面。
${manifestSection}
## 目标
1. 若当前不在登录页，先用 navigate 动作导航到 ${targetUrl}。
2. 判断当前页面是否登录页（由你根据页面内容自行判断）；不是（已有登录态）则直接 done。
3. 登录页：找到用户名/密码输入框，fill 的 value 一律用字面量 ${phUser} / ${phPassword}
   （平台会替换为真实值；你不得猜测、拼接或输出真实凭据）。${refHint}
4. 验证码：先 screenshot 放大验证码图片逐字符辨认（字母+数字，绝不出现 0 O o 1 l I），fill 进验证码输入框。
5. 点击登录/提交按钮（按页面实际元素为准）；登录后若出现强制改密/绑定等弹窗，能跳过则跳过。
6. 确认已登录（页面不再含登录表单）后按输出契约 done。

## 输出契约
done.summary 必须是该 JSON 对象序列化后的文本：{"status":"passed"|"failed","reason":"<一句话中文>"}
无法完成时直接输出 {"fail":"原因"}。`;
}

export function buildLoginTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'get_login_credentials',
      description:
        '返回当前版本/项目默认环境的登录凭据概要（用户名、登录页地址、是否已配置密码、环境 ID、可选 web 服务名清单）。不会暴露密码本身；若需要登录态，可接着调用 perform_login。',
      parameters: Type.Object({}),
      execute: async () => {
        let envCtx: Awaited<ReturnType<typeof resolveEnv>> | undefined;
        try {
          envCtx = await resolveEnv({ versionId: ctx.versionId }, { expectedProjectId: ctx.projectId });
          const def = envCtx.resolveLogin(null);
          if (!def) {
            return { ok: false, error: '当前默认环境未配置登录凭据(默认 web 服务未填用户名/密码)' };
          }
          return {
            ok: true,
            data: JSON.stringify({
              user: def.user,
              loginUrl: def.loginUrl,
              hasPassword: true,
              environmentId: envCtx.envId,
              // Lets the model know which services are available when calling perform_login(webRef=…)
              webServices: [...envCtx.logins.keys()],
            }),
          };
        } catch (e) {
          return { ok: false, error: `读取环境失败:${(e as Error).message}` };
        } finally {
          if (envCtx) await envCtx.close().catch(() => {});
        }
      },
    },
    {
      name: 'perform_login',
      description:
        '使用当前版本/项目默认环境的应用登录凭据在被测系统执行登录（AI 驱动浏览器：登录页判断、验证码识别、弹窗处理均由模型自主完成），返回 storageState（JSON 字符串）。**登录全程有实时画面**（右栏 LiveViewRail 显示 MJPEG 流，用户能看到填表与提交）——别把「登录成功」的判断只建立在返回的 storageState 上。webRef 可指定用哪个命名 web 服务的凭据（缺省=默认 web 服务）。后续可将 storageState 传给 inspect_page 以抓取登录态页面；凭据在服务端以占位符注入，不会出现在输出中。',
      parameters: Type.Object({
        url: Type.Optional(Type.String({ minLength: 8, maxLength: 2000 })),
        webRef: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      }),
      promptGuidelines: [
        'perform_login 登录全程有实时画面（用户能在右栏看到填表与提交）——登录成功后不要再抓页面确认登录态,storageState 即登录态凭证。',
        '需要确认登录态或抓登录后的页面时,自主用 inspect_page 验证（把 perform_login 返回的 storageState 传进去）——登录态属于可自查的事实,不必请示用户。',
        '要登某个具名 web 服务时，perform_login 传 webRef=<服务名>（可用服务名见 get_login_credentials 返回的 webServices）。',
      ],
      execute: async (input) => {
        const { url, webRef: webRefInput } = input as { url?: string; webRef?: string };
        const webRef = webRefInput?.trim() || null;
        let envCtx: Awaited<ReturnType<typeof resolveEnv>> | undefined;
        try {
          envCtx = await resolveEnv({ versionId: ctx.versionId }, { expectedProjectId: ctx.projectId });
          // A miss on an explicit webRef is an error — silently falling back to the default service would log the test into another system.
          const cred = envCtx.resolveLogin(webRef);
          if (!cred) {
            return {
              ok: false,
              error: webRef
                ? `环境未配置 web 服务 ${webRef} 的登录凭据（可用：${[...envCtx.logins.keys()].join('、') || '无'}）`
                : '当前默认环境未配置登录凭据(默认 web 服务未填用户名/密码)',
            };
          }
          const targetUrl = url || (cred.loginUrl?.startsWith('/') ? `${envCtx.baseUrl ?? ''}${cred.loginUrl}` : cred.loginUrl ?? '') || envCtx.baseUrl || '';
          if (!targetUrl) {
            return { ok: false, error: '缺少登录目标 URL（未传 url，且环境未配置 loginUrl/baseUrl）' };
          }
          // LLM unconfigured fails immediately (the user goes configure it in settings), without launching a browser
          const client = (await resolveLlmClient()).client;
          const browser = await chromium.launch({
            headless: true,
            executablePath: process.env.CHROMIUM_PATH || undefined,
          });
          // Live view: the login process is visible to the user (form-filling/captcha/submit all appear in the stream).
          // Same contract as verify_case/solidify_case — registerLiveView gets a random key,
          // the start event hands the stream URL to the frontend LiveViewRail, and on end close() tears the stream down (the recording stays for replay).
          // ctx.liveView === false is the batch background link: no view source registered, saving the 0.5fps screenshot-polling overhead.
          let live: ReturnType<typeof registerLiveView> | undefined;
          try {
            const context = await browser.newContext({ ignoreHTTPSErrors: true });
            const page = await context.newPage();
            if (ctx.liveView !== false) {
              live = registerLiveView();
              live.setPage(page);
            }
            ctx.emit({
              type: 'login_progress', phase: 'start',
              user: cred?.user ?? null,
              targetUrl,
              liveUrl: live ? `/api/assistant/threads/${ctx.threadId}/live/${live.key}` : undefined,
            });
            // Credential substitution reuses the execution layer's single implementation (the same ruler as verify_case/solidify_case/mechanical replay):
            // explicit webRef takes priority; the default walks the "case web_service_ref → environment default web" chain.
            const summary = await runAiTask(
              page,
              buildLoginInstruction(targetUrl, webRef, renderWebResourceManifest({ envCtx })),
              client,
              false,
              {
                maxTurns: 10,
                lang: ctx.lang,
                valueSub: makeCredentialValueSub(buildCredentialSource({ envCtx, caseWebServiceRef: webRef })),
              },
            );
            const parsed = tryParseJson(summary);
            if (parsed?.status === 'failed') {
              const reason = typeof parsed.reason === 'string' ? parsed.reason : summary.slice(0, 200);
              ctx.emit({ type: 'login_progress', phase: 'end', result: 'failed', reason });
              return { ok: false, error: `登录失败: ${reason}` };
            }
            const storageState = await context.storageState();
            // Warm the cache: verify_case and subsequent perform_login on the same environment+account reuse it directly (expiry self-heals)
            saveLoginState(loginStateKey(envCtx.envId, cred?.user), storageState);
            ctx.emit({ type: 'login_progress', phase: 'end', result: 'passed' });
            return {
              ok: true,
              data: JSON.stringify({ storageState, message: '登录成功' }),
            };
          } finally {
            live?.close();
            await browser.close().catch(() => {});
          }
        } catch (e) {
          return { ok: false, error: `登录失败:${(e as Error).message}` };
        } finally {
          if (envCtx) await envCtx.close().catch(() => {});
        }
      },
    },
  ];
}
