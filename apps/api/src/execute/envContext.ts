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

/** 被测系统的登录凭据（environment_objects objectType=login）。 */
export interface LoginCtx {
  user: string;
  password: string;
  /** 登录页地址；null 表示用检测页/当前页直接填表。 */
  loginUrl: string | null;
}

export interface EnvCtx {
  envId: string;
  /** 部署入口 URL：执行期导航兜底用（用例.url → 分组.defaultUrl → 环境.base_url → 项目.defaultUrl） */
  baseUrl: string | null;
  db?: { host: string; port: number; database: string; user: string; password: string };
  /** 已建立好的查询池；缺省表示该环境未配置 DB。close() 时统一 end()。 */
  pool?: QueryPool;
  syslog?: SyslogCtx;
  login?: LoginCtx;
  close(): Promise<void>;
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
interface LoginPayload {
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
  const row = (await db.select({ id: testEnvironments.id }).from(testEnvironments)
    .where(and(eq(testEnvironments.projectId, projectId), eq(testEnvironments.isDefault, true)))
    .limit(1))[0];
  return row?.id ?? null;
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

  let pool: QueryPool | undefined;
  let dbCfg: EnvCtx['db'];
  const dbObj = pick('db');
  if (dbObj) {
    const p = (dbObj.payload ?? {}) as DbPayload;
    if (p.host && p.dbName && p.user) {
      const dialect: DbDialect = p.dbType === 'mysql' ? 'mysql' : 'postgres';
      const port = p.port ?? (dialect === 'mysql' ? 3306 : 5432);
      const password = p.secret?.c && p.secret?.i && p.secret?.t ? safeDecrypt(p.secret) : '';
      dbCfg = { host: p.host, port, database: p.dbName, user: p.user, password };
      pool = createQueryPool({ dialect, host: p.host, port, database: p.dbName, user: p.user, password });
    }
  }

  let syslogCfg: EnvCtx['syslog'];
  const syslogObj = pick('syslog');
  if (syslogObj) {
    const p = (syslogObj.payload ?? {}) as SyslogPayload;
    if (p.host && p.user && p.filePath && p.secret?.c && p.secret?.i && p.secret?.t) {
      const authType: SyslogCtx['authType'] = p.authType === 'password' ? 'password' : 'key';
      const secret = safeDecrypt(p.secret);
      syslogCfg = {
        host: p.host,
        port: p.sshPort ?? 22,
        user: p.user,
        filePath: p.filePath,
        authType,
        ...(authType === 'password' ? { password: secret } : { privateKey: Buffer.from(secret) }),
      };
    }
  }

  let loginCfg: EnvCtx['login'];
  const loginObj = pick('login');
  if (loginObj) {
    const p = (loginObj.payload ?? {}) as LoginPayload;
    if (p.user && p.secret?.c && p.secret?.i && p.secret?.t) {
      loginCfg = { user: p.user, password: safeDecrypt(p.secret), loginUrl: p.loginUrl ?? null };
    }
  }

  return {
    envId,
    baseUrl: env.baseUrl ?? null,
    db: dbCfg,
    pool,
    syslog: syslogCfg,
    login: loginCfg,
    async close() {
      if (pool) await pool.end();
    },
  };
}
