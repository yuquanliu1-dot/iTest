import { Type } from '@earendil-works/pi-ai';
import { chromium } from 'playwright-core';
import { resolveEnv } from '../../../execute/envContext.js';
import { runAiTask } from '../../../execute/aiTask.js';
import { resolveLlmClient } from '../../../agent/llmSettings.js';
import { tryParseJson } from '../../../agent/llm-client.js';
import { loginStateKey, saveLoginState } from './loginStateCache.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

/** 凭据占位符：提示词里只有字面量，valueSub 在动作执行时刻替换为真实值。 */
const USER_PH = '__ITEST_USERNAME__';
const PASSWORD_PH = '__ITEST_PASSWORD__';

/** 登录指令：目标导航、占位符凭据、验证码识别（system prompt 既有 OCR 规则）、成功由模型按页面状态自判。 */
function buildLoginInstruction(targetUrl: string): string {
  return `你需要在浏览器里完成网站登录，成功后停留在登录后的页面。

## 目标
1. 若当前不在登录页，先用 navigate 动作导航到 ${targetUrl}。
2. 判断当前页面是否登录页（由你根据页面内容自行判断）；不是（已有登录态）则直接 done。
3. 登录页：找到用户名/密码输入框，fill 的 value 一律用字面量 ${USER_PH} / ${PASSWORD_PH}
   （平台会替换为真实值；你不得猜测、拼接或输出真实凭据）。
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
        '返回当前版本/项目默认环境的登录凭据概要（用户名、登录页地址、是否已配置密码、环境 ID）。不会暴露密码本身；若需要登录态，可接着调用 perform_login。',
      parameters: Type.Object({}),
      execute: async () => {
        let envCtx: Awaited<ReturnType<typeof resolveEnv>> | undefined;
        try {
          envCtx = await resolveEnv({ versionId: ctx.versionId }, { expectedProjectId: ctx.projectId });
          if (!envCtx.login) {
            return { ok: false, error: '当前默认环境未配置 login 凭据' };
          }
          return {
            ok: true,
            data: JSON.stringify({
              user: envCtx.login.user,
              loginUrl: envCtx.login.loginUrl,
              hasPassword: true,
              environmentId: envCtx.envId,
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
        '使用当前版本/项目默认环境的 login 凭据在被测系统执行登录（AI 驱动浏览器：登录页判断、验证码识别、弹窗处理均由模型自主完成），返回 storageState（JSON 字符串）。后续可将 storageState 传给 inspect_page 以抓取登录态页面；凭据在服务端以占位符注入，不会出现在输出中。',
      parameters: Type.Object({
        url: Type.Optional(Type.String({ minLength: 8, maxLength: 2000 })),
      }),
      promptGuidelines: [
        '若 inspect_page 返回登录页，先调用 get_login_credentials 确认凭据已配置，再调用 perform_login 获取 storageState，最后将 storageState 传入 inspect_page。',
      ],
      execute: async (input) => {
        const { url } = input as { url?: string };
        let envCtx: Awaited<ReturnType<typeof resolveEnv>> | undefined;
        try {
          envCtx = await resolveEnv({ versionId: ctx.versionId }, { expectedProjectId: ctx.projectId });
          if (!envCtx.login) {
            return { ok: false, error: '当前默认环境未配置 login 凭据' };
          }
          const targetUrl = url || (envCtx.login?.loginUrl?.startsWith('/') ? `${envCtx.baseUrl ?? ''}${envCtx.login.loginUrl}` : envCtx.login?.loginUrl ?? '') || envCtx.baseUrl || '';
          if (!targetUrl) {
            return { ok: false, error: '缺少登录目标 URL（未传 url，且环境未配置 loginUrl/baseUrl）' };
          }
          // LLM 未配置直接失败（用户去设置页配置），不启动浏览器
          const client = (await resolveLlmClient()).client;
          const browser = await chromium.launch({
            headless: true,
            executablePath: process.env.CHROMIUM_PATH || undefined,
          });
          try {
            const context = await browser.newContext({ ignoreHTTPSErrors: true });
            const page = await context.newPage();
            const cred = envCtx.login;
            const summary = await runAiTask(page, buildLoginInstruction(targetUrl), client, false, {
              maxTurns: 10,
              lang: ctx.lang,
              valueSub: (v) =>
                v === USER_PH ? cred?.user ?? '' : v === PASSWORD_PH ? cred?.password ?? '' : v,
            });
            const parsed = tryParseJson(summary);
            if (parsed?.status === 'failed') {
              const reason = typeof parsed.reason === 'string' ? parsed.reason : summary.slice(0, 200);
              return { ok: false, error: `登录失败: ${reason}` };
            }
            const storageState = await context.storageState();
            // 暖缓存：verify_case 及后续 perform_login 同环境同账号直接复用（过期自愈）
            saveLoginState(loginStateKey(envCtx.envId, cred?.user), storageState);
            return {
              ok: true,
              data: JSON.stringify({ storageState, message: '登录成功' }),
            };
          } finally {
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
