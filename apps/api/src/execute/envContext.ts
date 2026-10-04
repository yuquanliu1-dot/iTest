import { db } from '../db/client.js';
import { testEnvironments, environmentObjects, projectVersions } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { decrypt } from '../lib/secret-crypto.js';
import pg from 'pg';

export class EnvMissing extends Error {
  constructor() { super('no environment configured for case, plan, version, or project'); this.name = 'EnvMissing'; }
}

export class EnvProjectMismatch extends Error {
  constructor() { super('environment belongs to a different project'); this.name = 'EnvProjectMismatch'; }
}

export class DecryptError extends Error {
  constructor(cause: string) { super(`decrypt failed: ${cause}`); this.name = 'DecryptError'; }
}

export interface EnvCtx {
  envId: string;
  db?: { host: string; port: number; database: string; user: string; password: string };
  /** 已建立好的 pg 连接池；缺省表示该环境未配置 DB。close() 时统一 end()。 */
  pool?: pg.Pool;
  syslog?: { host: string; port: number; user: string; privateKey: Buffer; filePath: string };
  close(): Promise<void>;
}

/** payload 形状（environment_objects.payload）。secret 为 AES-256-GCM 三元组（base64）。 */
interface DbPayload {
  host?: string | null;
  port?: number | null;
  dbName?: string | null;
  user?: string | null;
  secret?: { c?: string | null; i?: string | null; t?: string | null } | null;
}
interface SyslogPayload {
  host?: string | null;
  user?: string | null;
  sshPort?: number | null;
  filePath?: string | null;
  secret?: { c?: string | null; i?: string | null; t?: string | null } | null;
}

function safeDecrypt(secret: { c?: string | null; i?: string | null; t?: string | null }): string {
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

  let pool: pg.Pool | undefined;
  let dbCfg: EnvCtx['db'];
  const dbObj = pick('db');
  if (dbObj) {
    const p = (dbObj.payload ?? {}) as DbPayload;
    if (p.host && p.dbName && p.user) {
      const port = p.port ?? 5432;
      const password = p.secret?.c && p.secret?.i && p.secret?.t ? safeDecrypt(p.secret) : '';
      dbCfg = { host: p.host, port, database: p.dbName, user: p.user, password };
      pool = new pg.Pool({ host: p.host, port, database: p.dbName, user: p.user, password, max: 2 });
    }
  }

  let syslogCfg: EnvCtx['syslog'];
  const syslogObj = pick('syslog');
  if (syslogObj) {
    const p = (syslogObj.payload ?? {}) as SyslogPayload;
    if (p.host && p.user && p.filePath && p.secret?.c && p.secret?.i && p.secret?.t) {
      const privateKey = safeDecrypt(p.secret);
      syslogCfg = {
        host: p.host,
        port: p.sshPort ?? 22,
        user: p.user,
        privateKey: Buffer.from(privateKey),
        filePath: p.filePath,
      };
    }
  }

  return {
    envId,
    db: dbCfg,
    pool,
    syslog: syslogCfg,
    async close() {
      if (pool) await pool.end();
    },
  };
}
