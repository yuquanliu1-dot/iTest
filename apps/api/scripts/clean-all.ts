import { pool } from '../src/db/client.ts';
const r = await pool.query("DELETE FROM test_cases WHERE requirement_id='4f88438b-acdb-4c76-93b6-f27dc4159dba'");
console.log('deleted', r.rowCount, 'cases');
await pool.end();