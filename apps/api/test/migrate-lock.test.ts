import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { Client } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { runPushWithLock } from '../src/db/migrate.js';


beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
}, 120_000);

afterAll(async () => {
});

/** Spawns `pnpm exec tsx src/db/migrate.ts`, collecting stdout/stderr into logs; returns the exit code. */
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

/** Checks whether a schema table exists (should exist after drizzle-kit push creates it). */
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
    // Only one process can be pushing at a time: the second necessarily waits for the lock (pino logs to stdout)
    expect(logs).toContain('等待 schema 同步锁');
    // After serialization, pushing a dirty schema never exposes a half-done state to the other process: no DDL-conflict errors
    for (const re of [/already exists/i, /duplicate key/i, /tuple concurrently updated/i, /deadlock/i]) {
      expect(logs).not.toMatch(re);
    }
    // Schema intact after the run
    expect(await tableExists('projects')).toBe(true);
  });
});