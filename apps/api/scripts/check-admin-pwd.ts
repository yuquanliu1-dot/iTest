import { pool } from '../src/db/client.ts';
const r = await pool.query("SELECT password_hash FROM users WHERE username='admin'");
console.log('hash:', r.rows[0]?.password_hash);
await pool.end();
