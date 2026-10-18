import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { Client } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runPushWithLock } from '../src/db/migrate.js';

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  await container.stop();
});

/** spawn `pnpm exec tsx src/db/migrate.ts`，stdout/stderr 汇总到 logs，返回退出码。 */
function spawnMigrate(): Promise<{ code: number | null; logs: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'src/db/migrate.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', (d: Buffer) => { logs += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { logs += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, logs }));
  });
}

/** 查询某张 schema 表是否存在（drizzle-kit push 建表后应存在）。 */
async function tableExists(name: string): Promise<boolean> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS ok`,
      [name]
    );
    return r.rows[0]!.ok as boolean;
  } finally {
    await client.end();
  }
}

describe('migrate.ts advisory lock push', () => {
  it('锁内 push 幂等：连续两次都成功且 schema 存在', async () => {
    await runPushWithLock();
    await runPushWithLock();
    expect(await tableExists('projects')).toBe(true);
  });

  it('并发拿锁互斥：两个进程同时 push 都 exit 0，且至少一个进程在等待锁', async () => {
    const [a, b] = await Promise.all([spawnMigrate(), spawnMigrate()]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const logs = `${a.logs}\n${b.logs}`;
    // 同一时刻只有一个进程在 push：第二个必然要等锁（pino 输出到 stdout）
    expect(logs).toContain('等待 schema 同步锁');
    // 串行化后推 dirty schema 时不会互相读到半成品：不应出现 DDL 冲突错误
    for (const re of [/already exists/i, /duplicate key/i, /tuple concurrently updated/i, /deadlock/i]) {
      expect(logs).not.toMatch(re);
    }
    // 跑完 schema 完好
    expect(await tableExists('projects')).toBe(true);
  });
});