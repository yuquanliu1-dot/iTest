import { db } from '../db/client.js';
import { testEnvironments, environmentObjects, projectVersions } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { decrypt } from '../lib/secret-crypto.js';
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

export class WebServiceMissing extends Error {
  constructor(message: string) { super(message); this.name = 'WebServiceMissing'; }
}

export type DbDialect = 'postgres' | 'mysql';

/** 方言归一的查询池：queryDb 步骤与连接测试共用，屏蔽 pg / mysql2 的结果形状差异。 */
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

/** 一个配置完整的 syslog 对象（label 即执行期的 ref；`(envId,'syslog',label)` 已在 service 层保证唯一）。 */
export interface SyslogEntry {
  label: string;
  ctx: SyslogCtx;
  isDefault: boolean;
}

/** 被测系统的登录凭据(0041 起由默认 web 服务对象 payload 派生)。 */
export interface LoginCtx {
  user: string;
  password: string;
  /** 登录页地址；null 表示用检测页/当前页直接填表。 */
  loginUrl: string | null;
}

/** 环境内每个"已配凭据"的命名 web 服务：name → 凭据。执行期占位符 `__ITEST_USERNAME@name__` 的解析源。 */
export type WebLogins = Map<string, LoginCtx>;

export interface WebServiceEntry {
  /** payload.name;null=未命名(仅默认服务,不可被用例引用) */
  name: string | null;
  label: string;
  origin: string;
  isDefault: boolean;
}

export interface EnvCtx {
  envId: string;
  /** 环境显示名（WebServiceMissing 等用户可见消息带名;与 resolve-url 的 ResolveUrlEnv 对齐）。 */
  envName: string;
  /** 全部 web 服务对象(objectType='web')。 */
  webServices: WebServiceEntry[];
  /** ref 非空按 name 精确匹配(找不到抛 WebServiceMissing);空取 isDefault→最早。
   *  环境无任何 web 对象返回 null。 */
  resolveWebOrigin(ref?: string | null): string | null;
  /** 派生:默认 web 服务 origin(兼容旧消费点)。 */
  readonly baseUrl: string | null;
  /** 派生:默认 db 的连接配置(兼容旧消费点)。未配置 db 时 undefined。 */
  db?: { host: string; port: number; database: string; user: string; password: string };
  /** 派生:默认 db 的连接池(兼容旧消费点)。惰建且缓存；未配置 db 时 undefined。 */
  pool?: QueryPool;
  /** 全部配置完整的 db 对象(label 即 ref)。 */
  dbs: DbEntry[];
  /** 按 ref 取 db；ref 空 → isDefault → 最早；未命中 → null。 */
  resolveDb(ref?: string | null): DbEntry | null;
  /** 惰建 + 缓存连接池；未命中 → EnvDbMissing(消息点名 ref)。同名调用返回同一个池。 */
  resolveDbPool(ref?: string | null): Promise<QueryPool>;
  /** 全部配置完整的 syslog 对象（label 即 ref）。 */
  syslogs: SyslogEntry[];
  /** 按 ref 取；ref 空 → isDefault → 最早；未命中 → null（绝不静默回落默认）。 */
  resolveSyslog(ref?: string | null): SyslogCtx | null;
  syslog?: SyslogCtx;
  login?: LoginCtx;
  /** 每个命名 web 服务各自的登录凭据（仅已配 user+secret 的）；无名对象不进此表。 */
  logins: WebLogins;
  /** 按 ref 取 web 凭据；ref 空 → 默认 web；该 ref 无凭据 → null（绝不静默回落默认）。 */
  resolveLogin(ref?: string | null): LoginCtx | null;
  /** 某 web 服务是否配了凭据（AI 资源清单渲染用，不返回任何值）。 */
  hasCredentials(ref: string): boolean;
  close(): Promise<void>;
}

/** 一个配置完整的 db 对象（label 即执行期的 ref；`(envId,'db',label)` 已在 service 层保证唯一）。 */
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

/** payload 形状（environment_objects.payload）。secret 为 AES-256-GCM 三元组（base64）。 */
interface DbPayload {
  host?: string | null;
  port?: number | null;
  dbName?: string | null;
  /** 缺省按 postgres 处理（老数据兼容）。 */
  dbType?: 'postgres' | 'mysql';
  user?: string | null;
  secret?: { c?: string | null; i?: string | null; t?: string | null } | null;
}
interface SyslogPayload {
  host?: string | null;
  user?: string | null;
  sshPort?: number | null;
  filePath?: string | null;
  /** 缺省按 key（PEM 私钥）处理（老数据兼容）。 */
  authType?: 'key' | 'password';
  secret?: { c?: string | null; i?: string | null; t?: string | null } | null;
}
/** web 服务 payload(0041 起内嵌应用登录凭据:user / loginUrl / secret)。secret 为 AES-256-GCM 三元组。 */
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
  // Mode A：项目内没有显式默认环境时，自动取该项目的「唯一环境」作兜底。
  // 避免因没点"设为默认"按钮导致 EnvMissing。
  // 优先级：is_default=true 的 → 任意一条（按 createdAt 最早的）。
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
 * 环境解析链：plan.environmentId → case.defaultEnvId → version.environmentId → 项目默认环境。
 * 命中环境后取 (environmentId, object_type) 的 is_default 对象（缺默认取最早一条）构建连接上下文。
 */
export async function resolveEnv(
  opts: { planEnvId?: string | null; caseEnvId?: string | null; versionId?: string | null },
  guard?: { expectedProjectId?: string },
): Promise<EnvCtx> {
  let envId = opts.planEnvId ?? opts.caseEnvId ?? null;
  if (!envId && opts.versionId) envId = await versionEnvironmentId(opts.versionId);
  if (!envId && guard?.expectedProjectId) envId = await projectDefaultEnvId(guard.expectedProjectId);
  if (!envId) throw new EnvMissing();

  const env = (await db.select().from(testEnvironments).where(eq(testEnvironments.id, envId)).limit(1))[0];
  if (!env) throw new EnvMissing();
  if (guard?.expectedProjectId && env.projectId !== guard.expectedProjectId) {
    throw new EnvProjectMismatch();
  }

  const objects = await db.select().from(environmentObjects).where(eq(environmentObjects.environmentId, envId));
  const pick = (type: string) =>
    objects.find((o) => o.objectType === type && o.isDefault) ?? objects.find((o) => o.objectType === type);

  // db 对象：以 label 为 ref 列出全部配置完整的条目。连接池惰建（多 db 场景下急切建全部会浪费连接），
  // 池缓存进 pools，close() 统一 end()。EnvCtx.db / EnvCtx.pool 是「默认 db 的派生 getter」。
  const dbs: DbEntry[] = [];
  for (const o of objects.filter((x) => x.objectType === 'db')) {
    const p = (o.payload ?? {}) as DbPayload;
    if (!p.host || !p.dbName || !p.user) continue;
    const dialect: DbDialect = p.dbType === 'mysql' ? 'mysql' : 'postgres';
    dbs.push({
      label: o.label,
      dialect,
      host: p.host,
      port: p.port ?? (dialect === 'mysql' ? 3306 : 5432),
      database: p.dbName,
      user: p.user,
      password: p.secret?.c && p.secret?.i && p.secret?.t ? safeDecrypt(p.secret) : '',
      isDefault: o.isDefault,
    });
  }
  const resolveDb = (ref?: string | null): DbEntry | null => {
    if (ref) return dbs.find((d) => d.label === ref) ?? null;
    return dbs.find((d) => d.isDefault) ?? dbs[0] ?? null;
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
      const e = new Error(`env-db-missing: 环境「${env.name}」${ref ? `不存在名为 ${ref} 的数据库对象` : '未配置任何数据库对象'}，可用:${dbs.map((d) => d.label).join('、') || '(无)'}`);
      e.name = 'EnvDbMissing';
      (e as Error & { resource?: string | null }).resource = ref ?? null;
      throw e;
    }
    return poolFor(entry);
  };

  // syslog 对象：以 label 为 ref 收集全部配置完整的条目；默认项额外挂到兼容字段 syslog。
  const syslogs: SyslogEntry[] = [];
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
    return syslogs.find((s) => s.isDefault) ?? syslogs[0] ?? null;
  };
  const syslogCfg = resolveSyslogEntry()?.ctx;

  // 逐个命名 web 收集各自的内嵌凭据（payload.user + secret）；无名对象不进表（不可被引用）。
  const logins: WebLogins = new Map();
  for (const o of objects.filter((x) => x.objectType === 'web')) {
    const p = (o.payload ?? {}) as WebPayload;
    if (!p.secret?.c || !p.secret?.i || !p.secret?.t || !p.user) continue;
    const name = typeof p.name === 'string' && p.name.length > 0 ? p.name : null;
    if (!name) continue;
    logins.set(name, { user: p.user, password: safeDecrypt(p.secret), loginUrl: p.loginUrl ?? null });
  }
  // 兼容旧字段 login = 默认 web 的凭据（pick('web') 与 resolveWebOrigin() 空 ref 同选择逻辑）。
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
      // 派生 getter：默认 db 的连接配置。未配置 db → undefined（queryDb 既有判死分支零改动）。
      const d = resolveDb();
      if (!d) return undefined;
      const { label: _l, isDefault: _def, dialect: _dia, ...rest } = d;
      return rest;
    },
    get pool() {
      // 派生 getter：默认 db 的连接池。惰建并缓存（该调用点本来就要立即用它）。
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
