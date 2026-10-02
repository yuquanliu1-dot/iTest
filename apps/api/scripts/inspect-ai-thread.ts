import { pool } from '../src/db/client.ts';
const r = await pool.query("SELECT id, requirement_id, created_at FROM ai_threads ORDER BY created_at DESC LIMIT 10");
for (const row of r.rows) console.log(row.id, row.requirement_id, row.created_at.toISOString());
await pool.end();