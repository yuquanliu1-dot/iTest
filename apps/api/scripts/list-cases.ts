import { pool } from '../src/db/client.ts';
const r = await pool.query(
  "SELECT id, title FROM test_cases WHERE requirement_id='4f88438b-acdb-4c76-93b6-f27dc4159dba' ORDER BY created_at",
);
for (const row of r.rows) console.log(row.id, row.title);
await pool.end();