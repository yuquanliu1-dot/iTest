import { pool } from '../src/db/client.ts';
const r = await pool.query(
  `SELECT key, value FROM settings WHERE key IN ('llm_provider','llm_api_key','llm_model','llm_base_url')`,
);
for (const row of r.rows) console.log(row.key, '=', typeof row.value === 'string' ? row.value : JSON.stringify(row.value));
await pool.end();