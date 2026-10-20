/**
 * AI 助手会话文件持久化（pi JSONL 落盘）验收用例。
 * 必须走真实会话工厂——stub 工厂不碰磁盘，测不出持久化与重启恢复。
 * 断言口径：
 *  - pi 在 persist=true 时立即分配 sessionFile 路径，落盘被 _hasConversation() 门延后；
 *  - 用户消息在联系模型之前就 flush 进 JSONL，所以模型调不通文件也照样在；
 *  - resetSpaceSessions() 只丢内存 record，DB 行与磁盘文件都还在。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  // 真实工厂要求 readLlmConfig 非空。key 是假的(sk-test)，baseUrl 指向死端口 127.0.0.1:1：
  // 合成模型走该地址必然连不上，prompt 快速失败（否则会按 retry 策略反复打真实 provider，
  // 单条消息拖 ~56s，还把测试变成出网依赖）。失败不影响本文件断言——用户消息在联系
  // provider 之前就已 flush 进 JSONL，"文件落盘"正是要钉的那个点。
  await pool.query(`INSERT INTO settings(key, value) VALUES
    ('llm_provider','"openai"'),
    ('llm_api_key','"sk-test"'),
    ('llm_model','"gpt-4o-mini"'),
    ('llm_base_url','"http://127.0.0.1:1/v1"')`);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  const { resetSpaceSessions } = await import('../src/pi/space/session.js');
  resetSpaceSessions();
  await pool.query(`TRUNCATE ai_threads RESTART IDENTITY CASCADE`);
});

/** 建一条 pi_thread_id 为空的 version 线程行（与 POST /threads 落库形状一致）。 */
async function insertThread(versionId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,'')`, [id, versionId]);
  return id;
}

async function sessionFileOf(threadId: string): Promise<string> {
  const row = (await pool.query(`SELECT pi_thread_id FROM ai_threads WHERE id=$1`, [threadId])).rows[0] as { pi_thread_id: string };
  return row.pi_thread_id;
}

describe('会话文件持久化(真实工厂,JSONL 落盘)', () => {
  it('路径在建会话时就分配,文件等第一条消息才落盘', async () => {
    const { versionId } = await seedProject(pool);
    const threadId = await insertThread(versionId);
    const { ensureSpaceRecord, sendSpaceUserMessage, SESSIONS_ROOT } = await import('../src/pi/space/session.js');

    await ensureSpaceRecord(threadId);
    // pi persist=true 时立即分配 sessionFile 绝对路径并回写 DB，但还没写盘
    const file = await sessionFileOf(threadId);
    expect(file).not.toBe('');
    expect(file.startsWith(SESSIONS_ROOT)).toBe(true);
    await expect(fs.access(file)).rejects.toThrow();

    // 模型调不通（假 key + 死端口）会在联系 provider 时失败；吞掉它——本例断言的是"文件落盘"，不是"模型有回话"
    await sendSpaceUserMessage(threadId, '你好').catch(() => undefined);
    await expect(fs.access(file)).resolves.toBeUndefined();
  }, 60_000);

  it('重启丢内存 record 后再 ensure,历史从磁盘 JSONL 恢复', async () => {
    const { versionId } = await seedProject(pool);
    const threadId = await insertThread(versionId);
    const { ensureSpaceRecord, sendSpaceUserMessage, snapshotOfThread, resetSpaceSessions } =
      await import('../src/pi/space/session.js');

    await ensureSpaceRecord(threadId);
    await sendSpaceUserMessage(threadId, '你好').catch(() => undefined);
    expect(snapshotOfThread(threadId)!.metadata.messageCount).toBeGreaterThan(0);
    const file = await sessionFileOf(threadId);

    // 模拟进程重启：只丢内存 record，DB 行与磁盘文件都该还在
    resetSpaceSessions();
    expect(snapshotOfThread(threadId)).toBeNull();
    expect(await sessionFileOf(threadId)).toBe(file);
    await expect(fs.access(file)).resolves.toBeUndefined();

    // 重新 ensure → 走 SessionManager.open(piThreadId, ...) 恢复历史
    await ensureSpaceRecord(threadId);
    expect(snapshotOfThread(threadId)!.metadata.messageCount).toBeGreaterThan(0);
  }, 60_000);

  it('会话文件损坏时 ensureSpaceRecord 不抛,降级重建', async () => {
    const { versionId } = await seedProject(pool);
    const threadId = await insertThread(versionId);
    const { ensureSpaceRecord, SESSIONS_ROOT } = await import('../src/pi/space/session.js');

    const corrupt = path.join(SESSIONS_ROOT, `corrupt-${crypto.randomUUID()}.jsonl`);
    await fs.mkdir(path.dirname(corrupt), { recursive: true });
    await fs.writeFile(corrupt, 'this is not json\n');
    await pool.query(`UPDATE ai_threads SET pi_thread_id=$2 WHERE id=$1`, [threadId, corrupt]);

    // 一条坏文件不能把列表/快照接口带崩：open 抛错时工厂降级 create，只记 warn
    await expect(ensureSpaceRecord(threadId)).resolves.toBeTruthy();
    // 确认确实走了降级分支（而非碰巧 resolve）：路径已换到 SESSIONS_ROOT 下的新会话文件
    const after = await sessionFileOf(threadId);
    expect(after).not.toBe(corrupt);
    expect(after.startsWith(SESSIONS_ROOT)).toBe(true);
    // 坏文件不补写、不改写，保持原样
    expect(await fs.readFile(corrupt, 'utf8')).toBe('this is not json\n');

    await fs.rm(corrupt, { force: true }).catch(() => undefined);
  }, 60_000);
});
