import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://itest:itest@localhost:5432/itest' });
// db/client.js reads DATABASE_URL
process.env.DATABASE_URL ??= 'postgres://itest:itest@localhost:5432/itest';

const { ensureRecord, sendUserMessage, resetSessions } = await import('../src/pi/session.js');

const rid = process.argv[2];
if (!rid) { console.error('usage: tsx scripts/debug-pi.ts <requirementId>'); process.exit(1); }

try {
  const rec = await ensureRecord(rid);
  console.log('[debug] threadId:', rec.threadId);
  rec.session.subscribe((e) => console.log('[event]', JSON.stringify(e).slice(0, 300)));
  console.log('[debug] sending prompt…');
  await sendUserMessage(rec.threadId, { content: '回复 ok 两个字母即可' });
  console.log('[debug] prompt resolved');
  await new Promise((r) => setTimeout(r, 30000));
  console.log('[debug] messages count:', (rec.session as unknown as { messages: unknown[] }).messages.length);
  await resetSessions();
} catch (err) {
  console.error('[debug] FAILED:', err);
} finally {
  await pool.end();
  process.exit(0);
}
