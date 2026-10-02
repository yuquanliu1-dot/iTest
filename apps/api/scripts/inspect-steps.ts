import { pool } from '../src/db/client.ts';

const CASE_ID = '13f530b7-42c1-491c-ba4e-3c17bb7a8c9b';
const r = await pool.query(
  `SELECT tc.id AS case_id, tc.title AS case_title, s."order", s.name, s.action->>'instruction' AS instr, CASE WHEN jsonb_typeof(s.action->'compiled') = 'array' THEN jsonb_array_length(s.action->'compiled') ELSE NULL END AS compiled_len, s.action->'compiled' AS compiled FROM test_steps s JOIN test_cases tc ON tc.id = s.case_id WHERE tc.requirement_id=$1 ORDER BY tc.created_at, s."order"`,
  ['4f88438b-acdb-4c76-93b6-f27dc4159dba'],
);
let lastCase = '';
for (const row of r.rows) {
  if (row.case_id !== lastCase) {
    console.log(`\n========== ${row.case_id} ${row.case_title} ==========`);
    lastCase = row.case_id;
  }
  console.log(`--- ${row.order} ${row.name} compiled_len=${row.compiled_len}`);
  console.log(`  instr: ${(row.instr ?? '').slice(0, 100)}`);
  console.log(`  compiled: ${JSON.stringify(row.compiled)}`);
}
await pool.end();