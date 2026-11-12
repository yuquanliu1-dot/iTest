/** R3.6 session signal collector: window/consumption idempotency/rca exclusion/candidate and sampling caps/file guards (testcontainers + temp-dir fixtures). */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_SQL } from './helpers/db.js';

let pool: Pool;
let sessionsRoot: string;
/** Pin "now": all window/age calculations are anchored to this. */
const NOW = new Date('2026-11-01T12:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  sessionsRoot = await mkdtemp(join(tmpdir(), 'pi-sess-'));
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_threads, assistant_failure_signals, ai_assistant_feedback`);
});

// ── JSONL line builders (lines carry ISO timestamps — parsed transparently since R3.6) ──
const userLine = (text: string, ts: string) =>
  JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } });
const toolCallLine = (id: string, name: string, args: unknown, ts: string) =>
  JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] } });
const toolResultLine = (id: string, name: string, ts: string, isError = false) =>
  JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'toolResult', content: [{ type: 'text', text: 'r' }], toolCallId: id, toolName: name, isError } });

/** Suspicious session fixture: 3 consecutive verify loops (same args) + 30min duration → suspicion score 3+2+2=7. */
function suspiciousJsonl(firstUserText = '首条需求：核查SOC事件列表'): string {
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const at = (min: number) => new Date(t0 + min * MIN).toISOString();
  const lines = [userLine(firstUserText, at(0))];
  for (let i = 1; i <= 3; i++) {
    lines.push(toolCallLine(`c${i}`, 'verify_case', { caseId: 'loc-1' }, at(i * 10)));
    lines.push(toolResultLine(`c${i}`, 'verify_case', at(i * 10 + 1), false));
  }
  return lines.join('\n');
}

/** Quiet session fixture: 1 turn without a timestamp → suspicion score 0 (still yields a signal; only for padding the count). */
const quietJsonl = () => userLine('安静会话', new Date(Date.parse('2026-11-01T09:00:00Z')).toISOString());

/** Insert a thread (piThreadId=absolute .jsonl path probed directly; jsonl omitted = points at a nonexistent file).
 *  updated_at is written as a UTC wall-clock string (same semantics as drizzle mapToDriverValue=toISOString;
 *  a native Date parameter gets serialized by pg into a local-offset string, which differs in timezone from the drizzle read path (parsed as UTC)). */
async function seedThread(opts: { ageMs?: number; purpose?: string; jsonl?: string }): Promise<{ id: string; updatedAt: Date; piThreadId: string }> {
  const updatedAt = new Date(NOW.getTime() - (opts.ageMs ?? 0));
  const piThreadId = opts.jsonl !== undefined ? join(sessionsRoot, `sess_${randomUUID()}.jsonl`) : `missing-${randomUUID()}`;
  if (opts.jsonl !== undefined) await writeFile(piThreadId, opts.jsonl);
  const wall = updatedAt.toISOString().slice(0, 19).replace('T', ' ');
  const r = await pool.query(
    `INSERT INTO ai_threads (pi_thread_id, purpose, updated_at, created_at) VALUES ($1, $2, $3, $3) RETURNING id`,
    [piThreadId, opts.purpose ?? 'chat', wall],
  );
  return { id: r.rows[0]!.id as string, updatedAt, piThreadId };
}

async function collect(consumed: ReadonlySet<string> = new Set()) {
  const { collectSessionSignals } = await import('../src/pi/space/sessionSignals.js');
  return collectSessionSignals({ consumedRefIds: consumed, sessionsRoot, now: NOW });
}

describe('collectSessionSignals', () => {
  it('窗口内 chat → 1 信号：refId=key 格式 session#<uuid>#<epoch>，excerpt 含指标头与首条用户消息，time=updatedAt', async () => {
    const t = await seedThread({ jsonl: suspiciousJsonl() });
    const { signals, notes } = await collect();
    expect(notes).toEqual([]);
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.refId).toBe(`session#${t.id}#${t.updatedAt.getTime()}`);
    expect(s.key).toBe(s.refId);
    expect(s.time).toBe(t.updatedAt.toISOString());
    expect(s.title).toContain('会话 7 轮/31min');
    expect(s.title).toContain('verify 3 次');
    expect(s.excerpt).toContain('嫌疑分=7');
    expect(s.excerpt).toContain('轮数=7');
    expect(s.excerpt).toContain('首条需求：核查SOC事件列表');
  });

  it('消费幂等：refId 已消费 → 不再产出；UPDATE updated_at（新 epoch）→ 重喂', async () => {
    const t = await seedThread({ jsonl: suspiciousJsonl() });
    const first = await collect();
    expect(first.signals).toHaveLength(1);
    const refId = first.signals[0]!.refId;
    const second = await collect(new Set([refId]));
    expect(second.signals).toHaveLength(0); // same epoch suppression
    const newUpdatedAt = new Date(t.updatedAt.getTime() + 5 * MIN);
    await pool.query(`UPDATE ai_threads SET updated_at=$1 WHERE id=$2`, [newUpdatedAt.toISOString().slice(0, 19).replace('T', ' '), t.id]);
    const third = await collect(new Set([refId]));
    expect(third.signals).toHaveLength(1); // new epoch refeed
    expect(third.signals[0]!.refId).toBe(`session#${t.id}#${newUpdatedAt.getTime()}`);
  });

  it('rca 线程排除；8 天前排除；piThreadId 为空串排除', async () => {
    await seedThread({ purpose: 'rca', jsonl: suspiciousJsonl() });
    await seedThread({ ageMs: 8 * DAY, jsonl: suspiciousJsonl() });
    await pool.query(`INSERT INTO ai_threads (pi_thread_id, purpose, updated_at) VALUES ('', 'chat', $1)`, [NOW]);
    const { signals } = await collect();
    expect(signals).toHaveLength(0);
  });

  it('坏文件（非 JSONL）跳过不炸批；缺文件静默；>8MB 跳过记 note', async () => {
    await seedThread({ jsonl: 'not json at all\n{broken' });
    await seedThread({}); // file missing
    await seedThread({ jsonl: `${userLine('首条需求：超大会话', NOW.toISOString())}\n${'x'.repeat(9 * 1024 * 1024)}` });
    const { signals, notes } = await collect();
    expect(signals).toHaveLength(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('8MB');
  });

  it('>30 条候选截断：最老的 5 条可疑线程（高嫌疑分）被 limit 30 排除，不进 top12', async () => {
    // 30 quiet threads (newest updatedAt, suspicion score 0)
    for (let i = 0; i < 30; i++) await seedThread({ ageMs: i * MIN, jsonl: quietJsonl() });
    // 5 oldest suspicious threads (6 days ago, suspicion score 7) — if the candidate cap failed they would monopolize the top12
    for (let i = 0; i < 5; i++) {
      await seedThread({ ageMs: 6 * DAY + i * MIN, jsonl: suspiciousJsonl(`CAPMARK-marker-${i}`) });
    }
    const { signals } = await collect();
    expect(signals).toHaveLength(12);
    expect(signals.every((s) => !s.excerpt.includes('CAPMARK-marker'))).toBe(true);
    expect(signals.every((s) => s.excerpt.includes('嫌疑分=0'))).toBe(true);
  });

  it('top-12 选样：15 条可疑线程 → 只出 12 条', async () => {
    for (let i = 0; i < 15; i++) await seedThread({ ageMs: i * MIN, jsonl: suspiciousJsonl() });
    const { signals } = await collect();
    expect(signals).toHaveLength(12);
  });
});
