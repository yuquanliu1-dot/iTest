/**
 * Acceptance tests for AI assistant session-file persistence (pi JSONL on disk).
 * Must go through the real session factory — the stub factory never touches disk, so it cannot test persistence or restart recovery.
 * Isolation approach:
 *  - Before dynamically importing session.js, point PI_DATA_DIR at an mkdtemp temp dir (repo.ts's DATA_DIR
 *    reads env at module load), so test artifacts never land in the developer's real .data; afterAll removes the whole directory;
 *  - llm_base_url points at a local 400 stub service: 400 does not match pi's retryable error pattern (pi-ai
 *    utils/retry.js's RETRYABLE_PROVIDER_ERROR_PATTERN only recognizes connection-class/429/5xx wording),
 *    so prompt fails immediately; with a dead port, connection errors would trigger the assistant-level retry of 3 attempts with exponential backoff (2s+4s+8s ≈ 14s per message).
 *    The key is fake (sk-test); the stub binds port 0 assigned by the kernel — never leaves the machine and never collides on a port.
 * Assertion approach:
 *  - pi assigns the sessionFile path immediately when persist=true; flushing to disk is delayed behind the _hasConversation() gate;
 *  - the user message is flushed into the JSONL before contacting the model, so the file exists even when the model call fails;
 *  - resetSpaceSessions() only drops the in-memory record; the DB row and the disk file both remain.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedLlmChannel, seedProject } from './helpers/db.js';

let pool: Pool;
/** Isolated .data root: must be set before any dynamic import of session.js (which transitively loads repo.ts's module-level DATA_DIR/SESSIONS_ROOT). */
let tmpDataDir: string;
/** 400 stub service: every request immediately gets HTTP 400, so prompt takes the non-retryable branch and fails fast. */
let stubServer: http.Server;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-spacedata-'));
  process.env.PI_DATA_DIR = tmpDataDir;
  vi.resetModules();
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);

  // Every request gets HTTP 400 (a non-retryable error): pi fails immediately on 400, no backoff retry.
  stubServer = http.createServer((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"itest test stub rejected the request","type":"invalid_request_error"}}');
  });
  await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve));
  const port = (stubServer.address() as AddressInfo).port;
  // The real factory requires a non-empty readLlmConfig. The key is fake (sk-test); baseUrl points at the 400 stub:
  // the synthesized model gets a 400 the moment it contacts the stub (non-retryable, no backoff retry, prompt fails fast).
  // The failure does not affect this file's assertions — the user message is flushed into the JSONL before contacting the provider; "file lands on disk" is exactly the point being pinned.
  // The stub's 400 wording deliberately avoids pi's retry/overflow regex keywords (server/internal/timeout/limit/exceeds…).
  await seedLlmChannel(pool, {
    provider: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    baseUrl: `http://127.0.0.1:${port}/v1`,
  });
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
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

/** Create a version thread row with an empty pi_thread_id (same DB shape as POST /threads). */
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
    // With pi persist=true the sessionFile absolute path is assigned and written back to the DB immediately, but not yet flushed
    const file = await sessionFileOf(threadId);
    expect(file).not.toBe('');
    expect(file.startsWith(SESSIONS_ROOT)).toBe(true);
    await expect(fs.access(file)).rejects.toThrow();

    // The model call will fail immediately when contacting the provider (fake key + 400 stub); swallow it — this case asserts "file lands on disk", not "the model replied"
    await sendSpaceUserMessage(threadId, '你好').catch(() => undefined);
    await expect(fs.access(file)).resolves.toBeUndefined();
    // Not just existence: the user message must really be inside (an empty file or header-only file counts as a failure)
    expect(await fs.readFile(file, 'utf8')).toContain('你好');
  });

  it('重启丢内存 record 后再 ensure,历史从磁盘 JSONL 恢复', async () => {
    const { versionId } = await seedProject(pool);
    const threadId = await insertThread(versionId);
    const { ensureSpaceRecord, sendSpaceUserMessage, snapshotOfThread, resetSpaceSessions } =
      await import('../src/pi/space/session.js');

    await ensureSpaceRecord(threadId);
    await sendSpaceUserMessage(threadId, '你好').catch(() => undefined);
    expect((await snapshotOfThread(threadId))!.metadata.messageCount).toBeGreaterThan(0);
    const file = await sessionFileOf(threadId);

    // Simulate a process restart: only the in-memory record is dropped; the DB row and disk file should both remain
    resetSpaceSessions();
    expect(await snapshotOfThread(threadId)).toBeNull();
    expect(await sessionFileOf(threadId)).toBe(file);
    await expect(fs.access(file)).resolves.toBeUndefined();

    // ensure again → goes through SessionManager.open(piThreadId, ...) to restore history
    await ensureSpaceRecord(threadId);
    expect((await snapshotOfThread(threadId))!.metadata.messageCount).toBeGreaterThan(0);
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

      // One bad file must not take down the list/snapshot APIs: when open throws, the factory degrades to create and only logs a warn
      await expect(ensureSpaceRecord(threadId)).resolves.toBeTruthy();
      // Confirm the degraded branch really ran (rather than a coincidental resolve): the path has moved to a new session file under SESSIONS_ROOT
      const after = await sessionFileOf(threadId);
      expect(after).not.toBe(corrupt);
      expect(after.startsWith(SESSIONS_ROOT)).toBe(true);
      // The bad file is not appended to or rewritten; it stays untouched
      expect(await fs.readFile(corrupt, 'utf8')).toBe('this is not json\n');
    } finally {
      // Even a mid-assertion failure must not leave the bad file on disk
      await fs.rm(corrupt, { force: true }).catch(() => undefined);
    }
  });
});
