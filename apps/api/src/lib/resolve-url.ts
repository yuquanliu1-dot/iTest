import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { environmentObjects, groups, testEnvironments } from '../db/schema.js';
import { WebServiceMissing, type WebServiceEntry } from '../execute/envContext.js';

/** URL resolution chain (2026-10 relativization rework):
 *  absolute case.url → pass through; relative (starting with /) → environment web service origin + path; empty → default service origin.
 *  The execution chain passes envCtx (already-resolved environment); the recording/display chain uses defaultEnvFallback=true with case.defaultEnv → project default environment.
 *  Group defaultUrl and environment baseUrl are gone (migration 0040). */

export interface ResolveUrlEnv {
  envName: string;
  webServices: WebServiceEntry[];
  resolveWebOrigin(ref?: string | null): string | null;
}

export function webEntriesOf(rows: Array<{ label: string; isDefault: boolean; payload: unknown }>): WebServiceEntry[] {
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
        throw new WebServiceMissing(`环境「${envName}」不存在 web 服务 ${ref},可用:${list}`);
      }
      return hit.origin;
    }
    return (entries.find((w) => w.isDefault) ?? entries[0]!).origin;
  };
}

/** Display/recording chain: case.defaultEnv → project default environment, building a ResolveUrlEnv. */
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

/** All project web service origins → ref-name mapping (used by the recorder to backfill relativized urls).
 *  value=service name; the unnamed default service maps to null (a relative URL with no ref hits the default); unnamed non-default services cannot be referenced and are skipped. */
export async function projectWebOrigins(projectId: string): Promise<Map<string, string | null>> {
  const envs = await db.select({ id: testEnvironments.id }).from(testEnvironments).where(eq(testEnvironments.projectId, projectId));
  const map = new Map<string, string | null>();
  if (envs.length === 0) return map;
  const objs = await db.select().from(environmentObjects)
    .where(inArray(environmentObjects.environmentId, envs.map((e) => e.id)));
  for (const o of objs) {
    if (o.objectType !== 'web') continue;
    const w = webEntriesOf([o])[0];
    if (!w || map.has(w.origin)) continue;
    if (w.name) map.set(w.origin, w.name);
    else if (w.isDefault) map.set(w.origin, null);
  }
  return map;
}

/** Absolute URL → { path, ref } when it hits any project web origin; returns null on a miss (keeps absolute). A null ref means
 *  it hit the unnamed default service, so no web_service_ref is filled after relativization. */
export function relativizeUrl(absolute: string, origins: Map<string, string | null>): { path: string; ref: string | null } | null {
  if (!/^https?:\/\//.test(absolute)) return null;
  try {
    const u = new URL(absolute);
    const ref = origins.get(u.origin);
    if (ref === undefined) return null;
    return { path: `${u.pathname}${u.search}${u.hash}`, ref };
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
    if (caseRow.url) throw new WebServiceMissing(`环境「${env.envName}」未配置 web 服务,请到项目环境页添加`);
    return null; // empty url + no service: keep the status quo of starting at about:blank
  }
  if (!caseRow.url) return origin;
  // Only join the origin onto relative urls starting with /; urls that are neither absolute, nor empty, nor /-prefixed are always
  // rejected (avoids concatenating things like http://origin/about:blank; the two legal shapes are absolute http(s) or /-prefixed).
  if (!caseRow.url.startsWith('/')) {
    throw new WebServiceMissing(`环境「${env.envName}」:用例 url 需为绝对 http(s) 地址或以 / 开头`);
  }
  return `${origin}${caseRow.url}`;
}
