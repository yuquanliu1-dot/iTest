import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { logger } from '../logger.js';
import { seedAssistantGuides } from './seed.js';
import { backfillPlanCaseGroups } from './backfillPlanCaseGroups.js';

const LOCK_ID = 0x4954455354; // 'ITEST'
const LOCK_TIMEOUT_MS = 600_000; // 10min

/** Holds an advisory lock while running drizzle-kit push, serializing schema sync across concurrent container startups.
 *  pg is async; connection/lock use await, the child process blocks via spawnSync. */
export async function runPushWithLock(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let locked = false;
  while (Date.now() < deadline) {
    const r = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (r.rows[0]?.ok) { locked = true; break; }
    logger.warn('等待 schema 同步锁（另一容器正在 push）');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!locked) {
    await client.end();
    throw new Error('schema sync lock timeout (600s)');
  }
  try {
    // Group backfill must run before push: only after group_id is backfilled can push safely set it NOT NULL.
    logger.info('advisory lock 获取成功，执行分组回迁（push 前）');
    await backfillPlanCaseGroups(client);
    logger.info('advisory lock 获取成功，执行 drizzle-kit push');
    const r = spawnSync('pnpm', ['exec', 'drizzle-kit', 'push', '--force'], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    if (r.error) throw r.error;
    if (r.status !== 0) process.exit(r.status ?? 1);
    // seed: S1 resident guides (REQ_DESIGN_METHOD / CASE_AUTHORING_FLOW). Idempotent (ON CONFLICT DO NOTHING).
    await seedAssistantGuides(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    await client.end();
  }
}

// Top-level entry (ESM): run this file directly via node dist/db/migrate.js
if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runPushWithLock().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}