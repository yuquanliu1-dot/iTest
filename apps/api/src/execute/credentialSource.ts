/**
 * The single construction point for runtime credential sources: mechanical replay (cdp.resolveEnvCredential),
 * AI replay fallback (cdp.aiCredentialSub), and the pi layer's verify/solidify/login tools all use it.
 *
 * Three-level default chain: explicit @ref → the case's bound web_service_ref → the environment's default web service.
 * One chain covers both "different cases test different webs" (level 2) and "one case across webs" (level 1).
 */
import { credentialPlaceholder, type CredentialSource } from './aiTask.js';
import type { EnvCtx } from './envContext.js';

/** Which web service a ref-less placeholder resolves onto (the level-2/3 chain result; null = no usable web in the environment). */
export function defaultWebRef(ctx: { envCtx?: EnvCtx; caseWebServiceRef?: string | null }): string | null {
  const explicit = ctx.caseWebServiceRef;
  if (explicit) return explicit;
  const webs = ctx.envCtx?.webServices ?? [];
  const def = webs.find((w) => w.isDefault) ?? webs.find((w) => w.name);
  return def?.name ?? null;
}

/** Assembles a CredentialSource. secret is the step-level sensitive ciphertext (web-independent, passed through as-is). */
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
    // An explicit @ref naming a wrong service hard-fails (strictRef): silently using the default service's credentials would log the test into another system.
    byRef: (ref) => env?.resolveLogin(ref) ?? null,
    strictRef: true,
    envName: env?.envName ?? null,
    defaultRef: defRef,
  };
}

/** Resource manifest for the AI prompt (only name / origin / whether credentials exist; never real values).
 *  Each line directly gives that service's credential placeholder form — the model copies it verbatim, no need to assemble @name itself. */
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
