import { pool } from '../src/db/client.ts';
const r = await pool.query(
  `SELECT key, value FROM settings WHERE key IN ('llm_channels','llm_default_channel','llm_vision_channel')`,
);
for (const row of r.rows) console.log(row.key, '=', typeof row.value === 'string' ? row.value : JSON.stringify(row.value));
await pool.end();
