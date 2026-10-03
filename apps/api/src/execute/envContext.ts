import { db } from '../db/client.js';
import { testEnvironments } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../lib/secret-crypto.js';
import pg from 'pg';

export class EnvMissing extends Error {
  constructor() { super('no environment configured for case or plan'); this.name = 'EnvMissing'; }
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

interface EnvRow {
  id: string;
  projectId: string;
  dbHost: string | null;
  dbPort: number | null;
  dbName: string | null;
  dbUser: string | null;
  dbPasswordCiphertext: string | null;
  dbPasswordIv: string | null;
  dbPasswordTag: string | null;
  syslogHost: string | null;
  syslogUser: string | null;
  syslogSshPort: number | null;
  syslogKeyCiphertext: string | null;
  syslogKeyIv: string | null;
  syslogKeyTag: string | null;
  syslogFilePath: string | null;
}

function safeDecrypt(ciphertext: string, iv: string, tag: string): string {
  try {
    return decrypt({ ciphertext: Buffer.from(ciphertext, 'base64'), iv: Buffer.from(iv, 'base64'), tag: Buffer.from(tag, 'base64') });
  } catch (e) {
    throw new DecryptError(e instanceof Error ? e.message : String(e));
  }
}

export async function resolveEnv(
  opts: { planEnvId?: string | null; caseEnvId?: string | null },
  guard?: { expectedProjectId?: string },
): Promise<EnvCtx> {
  const envId = opts.planEnvId ?? opts.caseEnvId;
  if (!envId) throw new EnvMissing();

  const row = (await db.select().from(testEnvironments).where(eq(testEnvironments.id, envId)).limit(1))[0] as EnvRow | undefined;
  if (!row) throw new EnvMissing();

  if (guard?.expectedProjectId && row.projectId !== guard.expectedProjectId) {
    throw new EnvProjectMismatch();
  }

  let pool: pg.Pool | undefined;
  let dbCfg: EnvCtx['db'];
  if (row.dbHost && row.dbPort && row.dbName && row.dbUser) {
    let password = '';
    if (row.dbPasswordCiphertext && row.dbPasswordIv && row.dbPasswordTag) {
      password = safeDecrypt(row.dbPasswordCiphertext, row.dbPasswordIv, row.dbPasswordTag);
    }
    dbCfg = { host: row.dbHost, port: row.dbPort, database: row.dbName, user: row.dbUser, password };
    pool = new pg.Pool({ host: row.dbHost, port: row.dbPort, database: row.dbName, user: row.dbUser, password, max: 2 });
  }

  let syslogCfg: EnvCtx['syslog'];
  if (row.syslogHost && row.syslogUser && row.syslogKeyCiphertext && row.syslogKeyIv && row.syslogKeyTag && row.syslogFilePath) {
    const privateKey = decrypt({
      ciphertext: Buffer.from(row.syslogKeyCiphertext, 'base64'),
      iv: Buffer.from(row.syslogKeyIv, 'base64'),
      tag: Buffer.from(row.syslogKeyTag, 'base64'),
    });
    syslogCfg = {
      host: row.syslogHost,
      port: row.syslogSshPort ?? 22,
      user: row.syslogUser,
      privateKey: Buffer.from(privateKey),
      filePath: row.syslogFilePath,
    };
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