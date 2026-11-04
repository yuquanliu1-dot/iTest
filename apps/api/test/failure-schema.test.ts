/** R3.5 建表：部分唯一去重 / 默认值 / base_seq 可空。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL } from './helpers/db.js';

let pool: Pool;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe('assistant_failure_signals', () => {
  it('同 (thread,case,step) 且 type=nl_ai_fail 去重；不同 type 不受限', async () => {
    const t = randomUUID();
    const ins = () => pool.query(
      `INSERT INTO assistant_failure_signals (type, thread_id, case_id, step_order, payload) VALUES ('nl_ai_fail', $1, 'c1', 3, '{}')`, [t]);
    await ins();
    await expect(ins()).rejects.toThrow(); // 部分唯一索引拒绝
    // 其他类型同键不冲突
    await pool.query(
      `INSERT INTO assistant_failure_signals (type, thread_id, case_id, step_order, payload) VALUES ('other', $1, 'c1', 3, '{}')`, [t]);
  });

  it('product_line_id 可空；payload jsonb 自包含', async () => {
    const r = await pool.query(
      `INSERT INTO assistant_failure_signals (type, thread_id, case_id, step_order, payload) VALUES ('nl_ai_fail', $1, 'c2', 1, $2::jsonb) RETURNING product_line_id, payload`,
      [randomUUID(), JSON.stringify({ caseTitle: 't', failureReason: 'AiTaskAborted' })]);
    expect(r.rows[0]!.product_line_id).toBeNull();
    expect(r.rows[0]!.payload).toMatchObject({ failureReason: 'AiTaskAborted' });
  });
});

describe('assistant_failure_lessons', () => {
  it('status 默认 active；attribution/title/signals 必填', async () => {
    const r = await pool.query(
      `INSERT INTO assistant_failure_lessons (attribution, title, lesson, signals, distill_model) VALUES ('prompt', 't', 'l', $1::jsonb, 'm') RETURNING status`,
      [JSON.stringify([{ type: 'rollback', refId: '2', excerpt: 'e' }])]);
    expect(r.rows[0]!.status).toBe('active');
    await expect(pool.query(
      `INSERT INTO assistant_failure_lessons (title, lesson, signals, distill_model) VALUES ('t', 'l', '[]', 'm')`,
    )).rejects.toThrow(); // attribution NOT NULL
  });
});

describe('assistant_solidify_proposals.base_seq', () => {
  it('新列可空，老批次语义不变', async () => {
    const b = (await pool.query(`INSERT INTO assistant_solidify_batches (status) VALUES ('done') RETURNING id`)).rows[0]!.id as string;
    const p = await pool.query(
      `INSERT INTO assistant_solidify_proposals (batch_id, kind, target, title, body, rationale, sources, distill_model)
       VALUES ($1, 'prompt_amendment', 'k', 't', 'b', 'r', '[]', 'm') RETURNING base_seq`, [b]);
    expect(p.rows[0]!.base_seq).toBeNull();
  });
});
