/** SCHEMA_SQL usability of the three new R3 tables: version-chain partial unique idempotency, batch/proposal cascade. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL } from './helpers/db.js';

let pool: Pool;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
}, 60_000);

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_solidify_proposals, assistant_solidify_batches, assistant_prompt_module_versions`);
});

describe('R3 schema：三张新表', () => {
  it('assistant_prompt_module_versions：source_ref 命中 partial unique → 冲突不落行', async () => {
    const ref = crypto.randomUUID();
    const r1 = await pool.query(
      `INSERT INTO assistant_prompt_module_versions (module_key, value, source, source_ref)
       VALUES ('space.style.zh', 'a', 'solidify_apply', $1) RETURNING seq`, [ref]);
    const r2 = await pool.query(
      `INSERT INTO assistant_prompt_module_versions (module_key, value, source, source_ref)
       VALUES ('space.style.zh', 'b', 'solidify_apply', $1) ON CONFLICT DO NOTHING RETURNING seq`, [ref]);
    expect(r1.rows.length).toBe(1);
    expect(r2.rows.length).toBe(0);
  });

  it('source_ref 为 NULL 的行不受唯一约束（多次手工编辑合法）', async () => {
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', 'x', 'manual_edit')`);
    await pool.query(`INSERT INTO assistant_prompt_module_versions (module_key, value, source) VALUES ('space.style.zh', 'y', 'manual_edit')`);
    const n = await pool.query(`SELECT count(*)::int n FROM assistant_prompt_module_versions WHERE module_key = 'space.style.zh'`);
    expect(n.rows[0].n).toBe(2);
  });

  it('batches/proposals：删批次级联删提案', async () => {
    const b = await pool.query(`INSERT INTO assistant_solidify_batches (status) VALUES ('done') RETURNING id`);
    await pool.query(
      `INSERT INTO assistant_solidify_proposals (batch_id, kind, target, title, body, rationale, sources, distill_model)
       VALUES ($1, 'prompt_amendment', 'space.style.zh', 't', 'b', 'r', '[]', 'm')`, [b.rows[0].id]);
    await pool.query(`DELETE FROM assistant_solidify_batches WHERE id = $1`, [b.rows[0].id]);
    const n = await pool.query(`SELECT count(*)::int n FROM assistant_solidify_proposals`);
    expect(n.rows[0].n).toBe(0);
  });
});
