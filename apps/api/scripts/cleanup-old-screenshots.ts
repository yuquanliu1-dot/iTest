import { pool } from '../src/db/client.ts';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
const SCREEN_DIR = join(process.cwd(), 'screenshots');
const dirs = await readdir(SCREEN_DIR);
let cleaned = 0;
for (const d of dirs) {
  await rm(join(SCREEN_DIR, d), { recursive: true, force: true }).catch(() => undefined);
  cleaned++;
}
console.log(`removed ${cleaned} report screenshot dirs`);
await pool.end();
