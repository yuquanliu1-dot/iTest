/** R3.6 会话信号采集器：窗口/消费幂等/rca 排除/候选与选样上限/文件护栏（testcontainers + 临时目录 fixture）。 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_SQL } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let sessionsRoot: string;
/** 固定「现在」，窗口/age 计算全以此为基准。 */
const NOW = new Date('2026-11-01T12:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  sessionsRoot = await mkdtemp(join(tmpdir(), 'pi-sess-'));
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_threads, assistant_failure_signals, ai_assistant_feedback`);
});

// ── JSONL 造行（行带 ISO timestamp——R3.6 起解析层透传）──
const userLine = (text: string, ts: string) =>
  JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } });
const toolCallLine = (id: string, name: string, args: unknown, ts: string) =>
  JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] } });
const toolResultLine = (id: string, name: string, ts: string, isError = false) =>
  JSON.stringify({ type: 'message', timestamp: ts, message: { role: 'toolResult', content: [{ type: 'text', text: 'r' }], toolCallId: id, toolName: name, isError } });

/** 可疑会话 fixture：verify 死循环 3 连（同参）+ 30min 时长 → 嫌疑分 3+2+2=7。 */
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

/** 静默会话 fixture：1 轮无 timestamp → 嫌疑分 0（仍产信号，仅用于灌数量）。 */
const quietJsonl = () => userLine('安静会话', new Date(Date.parse('2026-11-01T09:00:00Z')).toISOString());

/** 插线程（piThreadId=绝对 .jsonl 路径直探；jsonl 缺省=指向不存在文件）。
 *  updated_at 以 UTC 墙钟字符串写入（drizzle mapToDriverValue=toISOString 同款语义；
 *  原生 Date 参数会被 pg 序列化成本地偏移串，与 drizzle 读路径（按 UTC 解析）差时区）。 */
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
    expect(second.signals).toHaveLength(0); // 同 epoch 抑制
    const newUpdatedAt = new Date(t.updatedAt.getTime() + 5 * MIN);
    await pool.query(`UPDATE ai_threads SET updated_at=$1 WHERE id=$2`, [newUpdatedAt.toISOString().slice(0, 19).replace('T', ' '), t.id]);
    const third = await collect(new Set([refId]));
    expect(third.signals).toHaveLength(1); // 新 epoch 重喂
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
    await seedThread({}); // 缺文件
    await seedThread({ jsonl: `${userLine('首条需求：超大会话', NOW.toISOString())}\n${'x'.repeat(9 * 1024 * 1024)}` });
    const { signals, notes } = await collect();
    expect(signals).toHaveLength(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('8MB');
  });

  it('>30 条候选截断：最老的 5 条可疑线程（高嫌疑分）被 limit 30 排除，不进 top12', async () => {
    // 30 条静默线程（updatedAt 最新，嫌疑分 0）
    for (let i = 0; i < 30; i++) await seedThread({ ageMs: i * MIN, jsonl: quietJsonl() });
    // 5 条最老的可疑线程（6 天前，嫌疑分 7）——若候选 cap 失效它们会霸占 top12
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
