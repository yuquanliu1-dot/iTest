/**
 * AI 助手会话文件持久化（pi JSONL 落盘）验收用例。
 * 必须走真实会话工厂——stub 工厂不碰磁盘，测不出持久化与重启恢复。
 * 隔离口径：
 *  - 动态 import session.js 之前先把 PI_DATA_DIR 指到 mkdtemp 临时目录（repo.ts 的 DATA_DIR
 *    在模块加载时读 env），测试产物不落开发者真实的 .data，afterAll 整目录删除；
 *  - llm_base_url 指向本地 400 桩服务：400 不命中 pi 的可重试错误模式（pi-ai
 *    utils/retry.js 的 RETRYABLE_PROVIDER_ERROR_PATTERN 只认连接类/429/5xx 文案），
 *    prompt 立即失败；若用死端口，连接错误会触发助手级重试 3 次指数退避（2s+4s+8s ≈ 14s/条）。
 *    key 是假的（sk-test），桩服务绑端口 0 由内核分配，永不出网也永不撞端口。
 * 断言口径：
 *  - pi 在 persist=true 时立即分配 sessionFile 路径，落盘被 _hasConversation() 门延后；
 *  - 用户消息在联系模型之前就 flush 进 JSONL，所以模型调不通文件也照样在；
 *  - resetSpaceSessions() 只丢内存 record，DB 行与磁盘文件都还在。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
/** 隔离的 .data 根：必须在任何动态 import session.js（连带 repo.ts 的模块级 DATA_DIR/SESSIONS_ROOT）之前设好。 */
let tmpDataDir: string;
/** 400 桩服务：任何请求都立即回 HTTP 400，让 prompt 走不可重试分支快速失败。 */
let stubServer: http.Server;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-spacedata-'));
  process.env.PI_DATA_DIR = tmpDataDir;
  vi.resetModules();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);

  // 任何请求一律回 HTTP 400（非可重试错误）：pi 拿到 400 立即失败，不退避重试。
  stubServer = http.createServer((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"itest test stub rejected the request","type":"invalid_request_error"}}');
  });
  await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve));
  const port = (stubServer.address() as AddressInfo).port;
  // 真实工厂要求 readLlmConfig 非空。key 是假的(sk-test)，baseUrl 指向 400 桩服务：
  // 合成模型联系桩即拿到 400（非可重试错误，无退避重试，prompt 快速失败）。
  // 失败不影响本文件断言——用户消息在联系 provider 之前就已 flush 进 JSONL，"文件落盘"正是要钉的那个点。
  // 桩的 400 文案刻意避开 pi 的重试/溢出正则关键词（server/internal/timeout/limit/exceeds…）。
  await pool.query(`INSERT INTO settings(key, value) VALUES
    ('llm_provider','"openai"'),
    ('llm_api_key','"sk-test"'),
    ('llm_model','"gpt-4o-mini"'),
    ('llm_base_url','"http://127.0.0.1:${port}/v1"')`);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
  await new Promise<void>((resolve, reject) => {
    stubServer.closeAllConnections();
    stubServer.close((err) => (err ? reject(err) : resolve()));
  });
  await fs.rm(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { resetSpaceSessions } = await import('../src/pi/space/session.js');
  resetSpaceSessions();
  await pool.query(`TRUNCATE ai_threads RESTART IDENTITY CASCADE`);
});

/** 建一条 pi_thread_id 为空的 version 线程行（与 POST /threads 落库形状一致）。 */
async function insertThread(versionId: string): Promise<string> {
  const id = randomUUID();
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

    // 模型调不通（假 key + 400 桩）会在联系 provider 时立即失败；吞掉它——本例断言的是"文件落盘"，不是"模型有回话"
    await sendSpaceUserMessage(threadId, '你好').catch(() => undefined);
    await expect(fs.access(file)).resolves.toBeUndefined();
    // 不止要文件存在，还要用户消息真的写进去了（空文件/只有头行都算挂）
    expect(await fs.readFile(file, 'utf8')).toContain('你好');
  });

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
  });

  it('会话文件损坏时 ensureSpaceRecord 不抛,降级重建', async () => {
    const { versionId } = await seedProject(pool);
    const threadId = await insertThread(versionId);
    const { ensureSpaceRecord, SESSIONS_ROOT } = await import('../src/pi/space/session.js');

    const corrupt = path.join(SESSIONS_ROOT, `corrupt-${randomUUID()}.jsonl`);
    try {
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
    } finally {
      // 断言中途挂也不能把坏文件留在磁盘上
      await fs.rm(corrupt, { force: true }).catch(() => undefined);
    }
  });
});
