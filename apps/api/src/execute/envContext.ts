import { db } from '../db/client.js';
import { testEnvironments, environmentObjects, projectVersions } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { decrypt } from '../lib/secret-crypto.js';
import { resolveDbDialect, defaultDbPort } from '@itest/shared';
import pg from 'pg';
import mysql from 'mysql2/promise';

export class EnvMissing extends Error {
  constructor() { super('no environment configured for case, plan, version, or project'); this.name = 'EnvMissing'; }
}

export class EnvProjectMismatch extends Error {
  constructor() { super('environment belongs to a different project'); this.name = 'EnvProjectMismatch'; }
}

export class DecryptError extends Error {
  constructor(cause: string) { super(`decrypt failed: ${cause}`); this.name = 'DecryptError'; }
}

/** gauss100 bridge unconfigured (GAUSS_BRIDGE_URL unset: local dev has no bridge; production compose injects it). */
export class GaussBridgeMissing extends Error {
  constructor() {
    super('gauss-bridge-missing: gauss100 数据库需经 JDBC 桥访问，但未配置 GAUSS_BRIDGE_URL（生产环境随 compose 注入 http://gauss-bridge:8080；本地 dev 请自建桥并导出该变量）');
    this.name = 'GaussBridgeMissing';
  }
}

export class WebServiceMissing extends Error {
  constructor(message: string) { super(message); this.name = 'WebServiceMissing'; }
}

/** DB dialect: postgres / mysql. The deciding logic lives in @itest/shared (one copy shared by probing and runtime). */
export type DbDialect = import('@itest/shared').DbDialect;

/** Dialect-normalized query pool: shared by sql steps and connection tests, papering over the pg / mysql2 result-shape differences. */
export interface QueryPool {
  dialect: DbDialect;
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export function createQueryPool(cfg: {
  dialect: DbDialect;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}): QueryPool {
  if (cfg.dialect === 'gauss100') {
    // GaussDB 100 = Huawei's private wire protocol, no Node driver → SQL is forwarded over HTTP to the JDBC bridge (infra/docker/gauss-bridge).
    // Lazy failure: creation must always succeed (test-db builds the pool outside the try; throwing at creation would become a 500); a missing URL is only reported on the first query() call.
    return {
      dialect: 'gauss100',
      async query(sql, params) {
        const base = process.env.GAUSS_BRIDGE_URL; // re-read each call: env changes by tests or ops take effect immediately
        if (!base) throw new GaussBridgeMissing();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const token = process.env.GAUSS_BRIDGE_TOKEN;
        if (token) headers['x-bridge-token'] = token;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 30_000);
        let res: Response;
        try {
          res = await fetch(`${base.replace(/\/+$/, '')}/query`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              host: cfg.host, port: cfg.port, user: cfg.user,
              password: cfg.password, schema: cfg.database, sql, params,
            }),
            signal: ac.signal,
          });
        } catch (e) {
          throw new Error(`gauss bridge: 无法连接 SQL 桥（${base}）: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          clearTimeout(timer);
        }
        const text = await res.text();
        if (!res.ok) {
          const msg = (() => { try { return String(JSON.parse(text).error ?? text); } catch { return text; } })();
          throw new Error(`gauss bridge: HTTP ${res.status}: ${msg}`);
        }
        try {
          return { rows: JSON.parse(text).rows as Record<string, unknown>[] };
        } catch {
          throw new Error(`gauss bridge: 响应不是合法 JSON: ${text.slice(0, 200)}`);
        }
      },
      end: async () => undefined, // the bridge is stateless (each request gets its own JDBC connection), nothing to release
    };
  }
  if (cfg.dialect === 'mysql') {
    const pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      connectionLimit: 2,
      connectTimeout: 5000,
    });
    return {
      dialect: 'mysql',
      async query(sql, params) {
        const [rows] = await pool.query(sql, params);
        return { rows: rows as unknown as Record<string, unknown>[] };
      },
      end: () => pool.end(),
    };
  }
  const pool = new pg.Pool({ host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password: cfg.password, max: 2, connectionTimeoutMillis: 5000 });
  return {
    dialect: 'postgres',
    async query(sql, params) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    end: () => pool.end(),
  };
}

export interface SyslogCtx {
  host: string;
  port: number;
  user: string;
  filePath: string;
  authType: 'key' | 'password';
  privateKey?: Buffer;
  password?: string;
}

/** A fully configured syslog object (the label is the runtime ref; `(envId,'syslog',label)` uniqueness is already guaranteed at the service layer). */
export interface SyslogEntry {
  label: string;
  ctx: SyslogCtx;
  isDefault: boolean;
}

/** The SUT's login credentials (derived from the default web service object's payload since 0041). */
export interface LoginCtx {
  user: string;
  password: string;
  /** Login page address; null means filling the form directly on the detection page / current page. */
  loginUrl: string | null;
}

/** Each named web service with credentials configured, within the environment: name → credentials. Resolution source for the runtime placeholder `__ITEST_USERNAME@name__`. */
export type WebLogins = Map<string, LoginCtx>;

export interface WebServiceEntry {
  /** payload.name; null = unnamed (default service only, not referable by cases) */
  name: string | null;
  label: string;
  origin: string;
  isDefault: boolean;
}

export interface EnvCtx {
  envId: string;
  /** Environment display name (user-visible messages like WebServiceMissing carry it; aligned with resolve-url's ResolveUrlEnv). */
  envName: string;
  /** All web service objects (objectType='web'). */
  webServices: WebServiceEntry[];
  /** Non-empty ref matches by name exactly (WebServiceMissing on miss); empty ref takes isDefault → earliest.
   *  Returns null when the environment has no web objects at all. */
  resolveWebOrigin(ref?: string | null): string | null;
  /** Derived: the default web service's origin (legacy consumer compatibility). */
  readonly baseUrl: string | null;
  /** Derived: the default db's connection config (legacy consumer compatibility). undefined when no db is configured. */
  db?: { host: string; port: number; database: string; user: string; password: string };
  /** Derived: the default db's connection pool (legacy consumer compatibility). Lazily built and cached; undefined when no db is configured. */
  pool?: QueryPool;
  /** All fully configured db objects (the label is the ref). */
  dbs: DbEntry[];
  /** db by ref; empty ref → the complete default entry (default missing or incomplete → null, never falling back to another db); miss → null. */
  resolveDb(ref?: string | null): DbEntry | null;
  /** Lazily built + cached connection pool; miss → EnvDbMissing (the message names the ref). Same-name calls return the same pool. */
  resolveDbPool(ref?: string | null): Promise<QueryPool>;
  /** All fully configured syslog objects (the label is the ref). */
  syslogs: SyslogEntry[];
  /** By ref; empty ref → the complete default entry (default missing or incomplete → null); miss → null (never silently falling back to the default). */
  resolveSyslog(ref?: string | null): SyslogCtx | null;
  syslog?: SyslogCtx;
  login?: LoginCtx;
  /** Each named web service's own login credentials (only those with user+secret configured); unnamed objects never enter this map. */
  logins: WebLogins;
  /** Web credentials by ref; empty ref → the default web; no credentials for that ref → null (never silently falling back to the default). */
  resolveLogin(ref?: string | null): LoginCtx | null;
  /** Whether a web service has credentials configured (for AI resource-manifest rendering; never returns any value). */
  hasCredentials(ref: string): boolean;
  close(): Promise<void>;
}

/** A fully configured db object (the label is the runtime ref; `(envId,'db',label)` uniqueness is already guaranteed at the service layer). */
export interface DbEntry {
  label: string;
  dialect: DbDialect;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  isDefault: boolean;
}

/** payload shape (environment_objects.payload). secret is the AES-256-GCM triple (base64). */
interface DbPayload {
  host?: string | null;
  port?: number | null;
  dbName?: string | null;
  /** Defaults to postgres (legacy-data compatibility). */
  dbType?: DbDialect;
  user?: string | null;
  secret?: { c?: string | null; i?: string | null; t?: string | null } | null;
}
interface SyslogPayload {
  host?: string | null;
  user?: string | null;
  sshPort?: number | null;
  filePath?: string | null;
  /** Defaults to key (PEM private key) (legacy-data compatibility). */
  authType?: 'key' | 'password';
  secret?: { c?: string | null; i?: string | null; t?: string | null } | null;
}
/** Web service payload (embeds the application login credentials since 0041: user / loginUrl / secret). secret is the AES-256-GCM triple. */
interface WebPayload {
  name?: string | null;
  scheme?: string | null;
  host?: string | null;
  port?: number | null;
  user?: string | null;
  loginUrl?: string | null;
  secret?: { c?: string | null; i?: string | null; t?: string | null } | null;
}

export function safeDecrypt(secret: { c?: string | null; i?: string | null; t?: string | null }): string {
  try {
    return decrypt({
      ciphertext: Buffer.from(secret.c ?? '', 'base64'),
      iv: Buffer.from(secret.i ?? '', 'base64'),
      tag: Buffer.from(secret.t ?? '', 'base64'),
    });
  } catch (e) {
    throw new DecryptError(e instanceof Error ? e.message : String(e));
  }
}

async function projectDefaultEnvId(projectId: string): Promise<string | null> {
  // Mode A: when the project has no explicit default environment, automatically fall back to the project's "sole environment".
  // Avoids EnvMissing merely because the "set as default" button was never clicked.
  // Priority: the is_default=true one → otherwise any entry (earliest by createdAt).
  const row = (await db.select({ id: testEnvironments.id }).from(testEnvironments)
    .where(and(eq(testEnvironments.projectId, projectId), eq(testEnvironments.isDefault, true)))
    .limit(1))[0];
  if (row) return row.id;
  const fallback = (await db.select({ id: testEnvironments.id }).from(testEnvironments)
    .where(eq(testEnvironments.projectId, projectId))
    .orderBy(testEnvironments.createdAt)
    .limit(1))[0];
  return fallback?.id ?? null;
}

async function versionEnvironmentId(versionId: string): Promise<string | null> {
  const row = (await db.select({ environmentId: projectVersions.environmentId }).from(projectVersions)
    .where(eq(projectVersions.id, versionId)).limit(1))[0];
  return row?.environmentId ?? null;
}

/**
 * Environment resolution chain: planEnvId (group-level environment, runPlan passes group.environmentId) → case.defaultEnvId → version.environmentId → project default environment.
 * After hitting an environment, the is_default object of each (environmentId, object_type) (earliest entry when no default) builds the connection context.
 *
 * guard.expectedProjectId is "the case's own project" and handles two mutually independent things, hence split into switches rather than turned off together:
 * 1. Fallback lookup of the project's default environment — cases shared in across product lines should still use their own project's default environment; must stay in effect;
 * 2. Ownership re-check of the hit environment — the plan environment hangs under the plan's own project, so cross-project cases getting it is normal,
 *    exempted by allowCrossProjectEnv; otherwise every cross-project case would fail with EnvProjectMismatch.
 */
export async function resolveEnv(
  opts: { planEnvId?: string | null; caseEnvId?: string | null; versionId?: string | null },
  guard?: { expectedProjectId?: string; allowCrossProjectEnv?: boolean },
): Promise<EnvCtx> {
  let envId = opts.planEnvId ?? opts.caseEnvId ?? null;
  if (!envId && opts.versionId) envId = await versionEnvironmentId(opts.versionId);
  if (!envId && guard?.expectedProjectId) envId = await projectDefaultEnvId(guard.expectedProjectId);
  if (!envId) throw new EnvMissing();

  const env = (await db.select().from(testEnvironments).where(eq(testEnvironments.id, envId)).limit(1))[0];
  if (!env) throw new EnvMissing();
  if (guard?.expectedProjectId && !guard.allowCrossProjectEnv && env.projectId !== guard.expectedProjectId) {
    throw new EnvProjectMismatch();
  }

  const objects = await db.select().from(environmentObjects).where(eq(environmentObjects.environmentId, envId));
  const pick = (type: string) =>
    objects.find((o) => o.objectType === type && o.isDefault) ?? objects.find((o) => o.objectType === type);

  // db objects: list every fully configured entry with the label as ref. Connection pools are lazily built (eagerly building all would waste connections in multi-db setups),
  // pools cache into pools, close() ends them all. EnvCtx.db / EnvCtx.pool are "derived getters of the default db".
  const dbs: DbEntry[] = [];
  // Default selection only checks whether "the selected entry" is complete: first select by isDefault, then validate completeness,
  // incomplete is judged dead (null), never silently falling back to another complete db — connecting to the wrong db is far harder to troubleshoot than an error.
  // (An early implementation filtered completeness before selection, so an incomplete default db got skipped → silently connected elsewhere.)
  const defaultDbLabel: string | null = (() => {
    const obj = pick('db');
    if (!obj) return null;
    const p = (obj.payload ?? {}) as DbPayload;
    if (!p.host || !p.dbName || !p.user) return null;
    return obj.label;
  })();
  for (const o of objects.filter((x) => x.objectType === 'db')) {
    const p = (o.payload ?? {}) as DbPayload;
    if (!p.host || !p.dbName || !p.user) continue;
    // When dbType is missing, infer from the url's jdbc prefix (legacy data where the AI wrote jdbc:mysql:// but omitted dbType)
    const dialect: DbDialect = resolveDbDialect(p);
    dbs.push({
      label: o.label,
      dialect,
      host: p.host,
      port: p.port ?? defaultDbPort(dialect),
      database: p.dbName,
      user: p.user,
      password: p.secret?.c && p.secret?.i && p.secret?.t ? safeDecrypt(p.secret) : '',
      isDefault: o.isDefault,
    });
  }
  const resolveDb = (ref?: string | null): DbEntry | null => {
    if (ref) return dbs.find((d) => d.label === ref) ?? null;
    // Empty ref: only "the complete default entry" counts. Default missing or incomplete → null (judged dead, no fallback).
    if (defaultDbLabel === null) return null;
    return dbs.find((d) => d.label === defaultDbLabel) ?? null;
  };
  const pools = new Map<string, QueryPool>();
  const poolFor = (entry: DbEntry): QueryPool => {
    const hit = pools.get(entry.label);
    if (hit) return hit;
    const created = createQueryPool({
      dialect: entry.dialect, host: entry.host, port: entry.port,
      database: entry.database, user: entry.user, password: entry.password,
    });
    pools.set(entry.label, created);
    return created;
  };
  const resolveDbPool = async (ref?: string | null): Promise<QueryPool> => {
    const entry = resolveDb(ref);
    if (!entry) {
      // Empty ref and the default entry exists but is incomplete → report "default db incompletely configured" and name it,
      // never saying "no database objects configured" — that list clearly names a db; self-contradictory.
      const defaultIncomplete = !ref && defaultDbLabel === null && pick('db') !== null;
      const e = new Error(defaultIncomplete
        ? `env-db-missing: 环境「${env.name}」默认数据库对象「${pick('db')!.label}」配置不完整（需 host/dbName/user），可用:${dbs.map((d) => d.label).join('、') || '(无)'}`
        : `env-db-missing: 环境「${env.name}」${ref ? `不存在名为 ${ref} 的数据库对象` : '未配置任何数据库对象'}，可用:${dbs.map((d) => d.label).join('、') || '(无)'}`);
      e.name = 'EnvDbMissing';
      (e as Error & { resource?: string | null }).resource = ref ?? null;
      throw e;
    }
    return poolFor(entry);
  };

  // syslog objects: collect every fully configured entry with the label as ref; the default entry additionally hangs on the legacy field syslog.
  const syslogs: SyslogEntry[] = [];
  // Same as db: default selection selects first then validates completeness; incomplete is judged dead (no fallback).
  const defaultSyslogLabel: string | null = (() => {
    const obj = pick('syslog');
    if (!obj) return null;
    const p = (obj.payload ?? {}) as SyslogPayload;
    if (!p.host || !p.user || !p.filePath || !p.secret?.c || !p.secret?.i || !p.secret?.t) return null;
    return obj.label;
  })();
  for (const o of objects.filter((x) => x.objectType === 'syslog')) {
    const p = (o.payload ?? {}) as SyslogPayload;
    if (!p.host || !p.user || !p.filePath || !p.secret?.c || !p.secret?.i || !p.secret?.t) continue;
    const authType: SyslogCtx['authType'] = p.authType === 'password' ? 'password' : 'key';
    const secret = safeDecrypt(p.secret);
    syslogs.push({
      label: o.label,
      isDefault: o.isDefault,
      ctx: {
        host: p.host,
        port: p.sshPort ?? 22,
        user: p.user,
        filePath: p.filePath,
        authType,
        ...(authType === 'password' ? { password: secret } : { privateKey: Buffer.from(secret) }),
      },
    });
  }
  const resolveSyslogEntry = (ref?: string | null): SyslogEntry | null => {
    if (ref) return syslogs.find((s) => s.label === ref) ?? null;
    if (defaultSyslogLabel === null) return null;
    return syslogs.find((s) => s.label === defaultSyslogLabel) ?? null;
  };
  const syslogCfg = resolveSyslogEntry()?.ctx;

  // Collect each named web's own embedded credentials (payload.user + secret); unnamed objects don't enter the map (not referable).
  const logins: WebLogins = new Map();
  for (const o of objects.filter((x) => x.objectType === 'web')) {
    const p = (o.payload ?? {}) as WebPayload;
    if (!p.secret?.c || !p.secret?.i || !p.secret?.t || !p.user) continue;
    const name = typeof p.name === 'string' && p.name.length > 0 ? p.name : null;
    if (!name) continue;
    logins.set(name, { user: p.user, password: safeDecrypt(p.secret), loginUrl: p.loginUrl ?? null });
  }
  // Legacy field compatibility: login = the default web's credentials (pick('web') uses the same selection logic as resolveWebOrigin() with an empty ref).
  let loginCfg: EnvCtx['login'];
  const webObj = pick('web');
  if (webObj) {
    const p = (webObj.payload ?? {}) as WebPayload;
    if (p.user && p.secret?.c && p.secret?.i && p.secret?.t) {
      loginCfg = { user: p.user, password: safeDecrypt(p.secret), loginUrl: p.loginUrl ?? null };
    }
  }

  const webServices: WebServiceEntry[] = objects
    .filter((o) => o.objectType === 'web')
    .map((o) => {
      const p = (o.payload ?? {}) as WebPayload;
      if (!p.host) return null;
      const scheme = p.scheme === 'https' ? 'https' : 'http';
      const port = p.port ?? (scheme === 'https' ? 443 : 80);
      const defaultPort = (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443);
      return {
        name: typeof p.name === 'string' && p.name.length > 0 ? p.name : null,
        label: o.label,
        origin: `${scheme}://${p.host}${defaultPort ? '' : `:${port}`}`,
        isDefault: o.isDefault,
      };
    })
    .filter((w): w is WebServiceEntry => w !== null);
  const namedList = () => webServices.filter((w) => w.name).map((w) => w.name).join('、') || '(无命名服务)';
  const resolveWebOrigin = (ref?: string | null): string | null => {
    if (webServices.length === 0) return null;
    if (ref) {
      const hit = webServices.find((w) => w.name === ref);
      if (!hit) throw new WebServiceMissing(`环境「${env.name}」不存在 web 服务 ${ref},可用:${namedList()}`);
      return hit.origin;
    }
    return (webServices.find((w) => w.isDefault) ?? webServices[0]!).origin;
  };

  return {
    envId,
    envName: env.name,
    webServices,
    resolveWebOrigin,
    get baseUrl() { return resolveWebOrigin(); },
    dbs,
    resolveDb,
    resolveDbPool,
    get db() {
      // Derived getter: the default db's connection config. No db configured → undefined (the judged-dead branch).
      const d = resolveDb();
      if (!d) return undefined;
      const { label: _l, isDefault: _def, dialect: _dia, ...rest } = d;
      return rest;
    },
    get pool() {
      // Derived getter: the default db's connection pool. Lazily built and cached (the call site needs it immediately anyway).
      const d = resolveDb();
      if (!d) return undefined;
      return poolFor(d);
    },
    syslog: syslogCfg,
    syslogs,
    resolveSyslog: (ref?: string | null) => resolveSyslogEntry(ref)?.ctx ?? null,
    login: loginCfg,
    logins,
    resolveLogin: (ref?: string | null) => {
      if (ref) return logins.get(ref) ?? null;
      const def = webServices.find((w) => w.isDefault) ?? webServices.find((w) => w.name);
      return (def?.name ? logins.get(def.name) : undefined) ?? null;
    },
    hasCredentials: (ref: string) => logins.has(ref),
    async close() {
      await Promise.all(Array.from(pools.values()).map((p) => p.end().catch(() => undefined)));
      pools.clear();
    },
  } satisfies EnvCtx;
}
