/** 失败信号采集：落库带线归并/同键去重/INSERT 失败不打断（fire-and-forget 语义）。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let pool: Pool;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_failure_signals`);
});

describe('recordNlAiFailSignal', () => {
  it('落行：productLine 由 project 反查，payload 快照自包含', async () => {
    const { recordNlAiFailSignal } = await import('../src/pi/space/failureSignals.js');
    const { projectId, productLineId } = await seedProject(pool);
    await recordNlAiFailSignal({
      threadId: randomUUID(), projectId, caseId: 'local-1', stepOrder: 4,
      payload: { caseTitle: '事件管理用例', stepInstruction: '点击新增按钮', failureReason: 'AiTaskAborted', targetUrl: 'http://x/a', pageUrl: 'http://x/b' },
    });
    const r = (await pool.query(`SELECT * FROM assistant_failure_signals`)).rows[0]!;
    expect(r.type).toBe('nl_ai_fail');
    expect(r.product_line_id).toBe(productLineId);
    expect(r.case_id).toBe('local-1');
    expect(r.step_order).toBe(4);
    expect(r.payload).toMatchObject({ failureReason: 'AiTaskAborted', stepInstruction: '点击新增按钮' });
  });

  it('同 (thread,case,step) 重复落 → 静默去重（onConflictDoNothing）', async () => {
    const { recordNlAiFailSignal } = await import('../src/pi/space/failureSignals.js');
    const { projectId } = await seedProject(pool);
    const threadId = randomUUID();
    const input = { threadId, projectId, caseId: 'c', stepOrder: 1, payload: { caseTitle: 't', stepInstruction: 'i', failureReason: 'x', targetUrl: null, pageUrl: null } };
    await recordNlAiFailSignal(input);
    await recordNlAiFailSignal(input);
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_failure_signals`)).rows[0]!;
    expect(n.n).toBe(1);
  });

  it('INSERT 失败只 warn 不 throw（verify 主流程不受影响）', async () => {
    const { recordNlAiFailSignal } = await import('../src/pi/space/failureSignals.js');
    await pool.query(`ALTER TABLE assistant_failure_signals RENAME TO assistant_failure_signals_bak`);
    try {
      await expect(recordNlAiFailSignal({
        threadId: randomUUID(), projectId: randomUUID(), caseId: 'c', stepOrder: 1,
        payload: { caseTitle: 't', stepInstruction: 'i', failureReason: 'x', targetUrl: null, pageUrl: null },
      })).resolves.toBeUndefined(); // 不抛
    } finally {
      await pool.query(`ALTER TABLE assistant_failure_signals_bak RENAME TO assistant_failure_signals`);
    }
  });
});
