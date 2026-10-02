import { pool } from '../src/db/client.ts';
const r = await pool.query("SELECT id, username, must_change_password FROM users WHERE username='admin'");
console.log(r.rows);
await pool.end();
