import { pool } from '../src/db/client.ts';
const r = await pool.query(`SELECT id, name FROM "groups" WHERE project_id='3aae908c-b252-4dcc-b89c-86e0c35cfedc'`);
for (const row of r.rows) console.log(row.id, row.name);
await pool.end();