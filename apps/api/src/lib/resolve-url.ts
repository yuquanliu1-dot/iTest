import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { environmentObjects, groups, testEnvironments } from '../db/schema.js';
import { WebServiceMissing, type WebServiceEntry } from '../execute/envContext.js';

/** URL 解析链（2026-10 相对化改造）：
 *  case.url 绝对 → 直通；相对（/开头）→ 环境 web 服务 origin + path；空 → 默认服务 origin。
 *  执行链传 envCtx（已解析环境）；录制/展示链 defaultEnvFallback=true，用 case.defaultEnv → 项目默认环境。
 *  分组 defaultUrl 与环境 baseUrl 已删（迁移 0040）。 */

export interface ResolveUrlEnv {
  envName: string;
  webServices: WebServiceEntry[];
  resolveWebOrigin(ref?: string | null): string | null;
}

function webEntriesOf(rows: Array<{ label: string; isDefault: boolean; payload: unknown }>): WebServiceEntry[] {
  return rows
    .map((o) => {
      const p = (o.payload ?? {}) as { name?: unknown; scheme?: unknown; host?: unknown; port?: unknown };
      if (typeof p.host !== 'string' || p.host.length === 0) return null;
      const scheme = p.scheme === 'https' ? 'https' : 'http';
      const port = typeof p.port === 'number' ? p.port : (scheme === 'https' ? 443 : 80);
      const defaultPort = (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443);
      return {
        name: typeof p.name === 'string' && p.name.length > 0 ? p.name : null,
        label: o.label,
        origin: `${scheme}://${p.host}${defaultPort ? '' : `:${port}`}`,
        isDefault: o.isDefault,
      };
    })
    .filter((w): w is WebServiceEntry => w !== null);
}

function resolverOf(entries: WebServiceEntry[], envName: string) {
  return (ref?: string | null): string | null => {
    if (entries.length === 0) return null;
    if (ref) {
      const hit = entries.find((w) => w.name === ref);
      if (!hit) {
        const list = entries.filter((w) => w.name).map((w) => w.name).join('、') || '(无命名服务)';
        throw new WebServiceMissing(`环境「${envName}」不存在 web 服务 ${ref}，可用：${list}`);
      }
      return hit.origin;
    }
    return (entries.find((w) => w.isDefault) ?? entries[0]!).origin;
  };
}

/** 展示/录制链：case.defaultEnv → 项目默认环境，构建 ResolveUrlEnv。 */
export async function displayWebEnv(caseRow: { defaultEnvId?: string | null; groupId: string }): Promise<ResolveUrlEnv | null> {
  const g = (await db.select().from(groups).where(eq(groups.id, caseRow.groupId)))[0];
  if (!g) return null;
  let env = caseRow.defaultEnvId
    ? (await db.select().from(testEnvironments).where(eq(testEnvironments.id, caseRow.defaultEnvId)))[0]
    : undefined;
  if (!env) {
    env = (await db.select().from(testEnvironments)
      .where(and(eq(testEnvironments.projectId, g.projectId), eq(testEnvironments.isDefault, true))))[0];
  }
  if (!env) return null;
  const objs = await db.select().from(environmentObjects).where(eq(environmentObjects.environmentId, env.id));
  const entries = webEntriesOf(objs.filter((o) => o.objectType === 'web'));
  return { envName: env.name, webServices: entries, resolveWebOrigin: resolverOf(entries, env.name) };
}

/** 项目全部 web 服务 origin → ref 名映射（录制回填相对化用）。 */
export async function projectWebOrigins(projectId: string): Promise<Map<string, string>> {
  const envs = await db.select({ id: testEnvironments.id }).from(testEnvironments).where(eq(testEnvironments.projectId, projectId));
  const map = new Map<string, string>();
  if (envs.length === 0) return map;
  const objs = await db.select().from(environmentObjects)
    .where(inArray(environmentObjects.environmentId, envs.map((e) => e.id)));
  for (const o of objs) {
    if (o.objectType !== 'web') continue;
    const w = webEntriesOf([o])[0];
    if (w && !map.has(w.origin)) map.set(w.origin, w.name ?? 'web');
  }
  return map;
}

/** 绝对 URL → { path, ref } 命中项目任一 web origin；未命中返回 null（保留绝对）。 */
export function relativizeUrl(absolute: string, origins: Map<string, string>): { path: string; ref: string } | null {
  if (!/^https?:\/\//.test(absolute)) return null;
  try {
    const u = new URL(absolute);
    if (!origins.has(u.origin)) return null;
    return { path: `${u.pathname}${u.search}${u.hash}`, ref: origins.get(u.origin)! };
  } catch {
    return null;
  }
}

export async function resolveCaseUrl(
  caseRow: { url: string | null; webServiceRef?: string | null; groupId: string; defaultEnvId?: string | null },
  o: { envCtx?: ResolveUrlEnv; defaultEnvFallback?: boolean } = {},
): Promise<string | null> {
  if (caseRow.url && /^https?:\/\//.test(caseRow.url)) return caseRow.url;
  const env = o.envCtx ?? (o.defaultEnvFallback ? await displayWebEnv(caseRow) : undefined);
  if (!env) return null;
  const origin = env.resolveWebOrigin(caseRow.webServiceRef ?? null);
  if (!origin) {
    if (caseRow.url) throw new WebServiceMissing(`环境「${env.envName}」未配置 web 服务，请到项目环境页添加`);
    return null; // 空 url + 无服务：维持 about:blank 开始的现状
  }
  return caseRow.url ? `${origin}${caseRow.url}` : origin;
}
