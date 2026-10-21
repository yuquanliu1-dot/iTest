/**
 * 执行期凭据来源的唯一构造点：机械回放（cdp.resolveEnvCredential）、AI 回放降级
 * （cdp.aiCredentialSub）、pi 层 verify/solidify/login 三个工具都用它。
 *
 * 默认链三级：显式 @ref → 用例绑定的 web_service_ref → 环境的默认 web 服务。
 * 一条链同时覆盖"不同用例测不同 web"（第二级）与"同一用例跨 web"（第一级）。
 */
import { credentialPlaceholder, type CredentialSource } from './aiTask.js';
import type { EnvCtx } from './envContext.js';

/** 无 ref 占位符该落到哪个 web 服务上（第二/三级链的结果；null = 环境无可用 web）。 */
export function defaultWebRef(ctx: { envCtx?: EnvCtx; caseWebServiceRef?: string | null }): string | null {
  const explicit = ctx.caseWebServiceRef;
  if (explicit) return explicit;
  const webs = ctx.envCtx?.webServices ?? [];
  const def = webs.find((w) => w.isDefault) ?? webs.find((w) => w.name);
  return def?.name ?? null;
}

/** 组装 CredentialSource。secret 为步骤级敏感密文（与 web 无关，原样透传）。 */
export function buildCredentialSource(
  ctx: { envCtx?: EnvCtx; caseWebServiceRef?: string | null },
  secret?: string | undefined,
): CredentialSource {
  const env = ctx.envCtx;
  const defRef = defaultWebRef(ctx);
  const def = env?.resolveLogin(defRef) ?? null;
  return {
    user: def?.user ?? null,
    password: def?.password ?? null,
    secret: secret ?? null,
    // 显式 @ref 写错服务名时判死（strictRef）：静默用默认服务的凭据会把测试登到另一个系统上。
    byRef: (ref) => env?.resolveLogin(ref) ?? null,
    strictRef: true,
    envName: env?.envName ?? null,
    defaultRef: defRef,
  };
}

/** AI 提示词的资源清单（只含 name / origin / 有无凭据，绝不出现真实值）。
 *  每行直接给出该服务对应的凭据占位符形态——模型照抄即可，不必自己拼 @name。 */
export function renderWebResourceManifest(ctx: { envCtx?: EnvCtx }): string {
  const env = ctx.envCtx;
  const webs = env?.webServices ?? [];
  if (webs.length === 0) return '';
  const lines = webs.map((w) => {
    if (!w.name) return '';
    const has = env?.hasCredentials(w.name) ?? false;
    const ph = has
      ? `（用户名填 ${credentialPlaceholder('user', w.name)}，密码填 ${credentialPlaceholder('password', w.name)}）`
      : '（未配置凭据，不要尝试登录）';
    return `- ${w.name}（${w.isDefault ? '默认' : w.label}） ${w.origin} ${has ? '已配置凭据' : '未配置凭据'}${ph}`;
  }).filter(Boolean);
  if (lines.length === 0) return '';
  return `可用 web 服务（凭据归属用 @name 指定；不写 @name 时用标注「默认」的那个）：\n${lines.join('\n')}`;
}
