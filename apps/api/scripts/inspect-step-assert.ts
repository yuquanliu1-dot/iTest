import { pool } from '../src/db/client.ts';
const r = await pool.query(
  `SELECT tc.title, s."order", s.name, s.action->>'assertion' as assertion, s.action->'expectedResult' as expected FROM test_steps s JOIN test_cases tc ON tc.id = s.case_id WHERE tc.id='6c54e3c0-2929-4112-ba7b-20cc4c9cff33' ORDER BY s."order"`,
);
for (const row of r.rows) {
  console.log(`${row.order}. ${row.name}  assertion=${row.assertion}`);
}
await pool.end();
