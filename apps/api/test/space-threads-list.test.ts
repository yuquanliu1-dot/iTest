import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let pool: Pool;
let app: import('express').Express;
let tmpDir: string;

/** Create one kind='version' thread; if sessionFile is given a real file path it passes the fs probe, otherwise it points at a
 *  nonexistent path (non-empty piThreadId passes the SQL where clause but is filtered by the fs probe — matching production threads
 *  whose session file was cleaned up). createdAt uses explicit minute offsets so the (createdAt,id) total order is deterministic;
 *  updatedAt defaults to the same instant and can be bumped forward separately to simulate rename/new-message title landing
 *  (the ordering must not be driven by it). */
async function insertThread(versionId: string, opts: { updatedAt: string; updatedAtLater?: string; title?: string; sessionFile?: string }): Promise<string> {
  const id = randomUUID();
  const sessionFile = opts.sessionFile ?? path.join(tmpDir, 'missing', `${randomUUID()}.jsonl`);
  await pool.query(
    `INSERT INTO ai_threads(id, kind, version_id, title, pi_thread_id, created_at, updated_at)
     VALUES ($1, 'version', $2, $3, $4, $5::timestamp, $6::timestamp)`,
    [id, versionId, opts.title ?? null, sessionFile, opts.updatedAt, opts.updatedAtLater ?? opts.updatedAt],
  );
  return id;
}

const at = (minutesAgo: number): string => {
  const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - minutesAgo * 60_000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

/** Each case gets an isolated version space so data never bleeds between them. */
async function freshVersion(): Promise<string> {
  return (await seedProject(pool)).versionId;
}

/** Bulk-create threads with real session files, returning the id set. */
async function seedRealThreads(versionId: string, count: number, startMinutesAgo: number): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let i = 0; i < count; i++) {
    const file = path.join(tmpDir, `${randomUUID()}.jsonl`);
    await fs.writeFile(file, '');
    ids.add(await insertThread(versionId, { updatedAt: at(startMinutesAgo + i), title: `线程${i}`, sessionFile: file }));
  }
  return ids;
}

const list = (versionId: string, query: string) =>
  request(app).get(`/api/assistant/threads?workspacePath=${versionId}${query}`);

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  await seedOrg(pool);
  const { default: exp } = await import('express');
  const { spaceRoute } = await import('../src/pi/space/router.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { managerUserOf } = await import('./helpers/auth.js');
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  app = exp();
  app.use(exp.json());
  app.use((req, _res, next) => { req.user = managerUserOf(userId, username, orgId, orgPath); next(); });
  app.use('/api/assistant', spaceRoute);
  app.use(errorHandler);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'space-threads-test-'));
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('GET /api/assistant/threads 分页契约(?limit=)', () => {
  it('按 limit 翻页:页间无重叠、hasMore 递减到收口', async () => {
    const versionId = await freshVersion();
    const ids = await seedRealThreads(versionId, 25, 0);
    const seen: string[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    const pageSizes: number[] = [];
    while (hasMore) {
      const res = await list(versionId, `&limit=10${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.threads)).toBe(true);
      pageSizes.push(res.body.threads.length);
      for (const t of res.body.threads) {
        expect(typeof t.id).toBe('string');
        expect(typeof t.title).toBe('string'); // titled threads come out as strings
        seen.push(t.id);
      }
      hasMore = res.body.hasMore;
      cursor = res.body.threads.at(-1)?.id;
    }
    expect(pageSizes).toEqual([10, 10, 5]);
    expect(new Set(seen).size).toBe(25);
    expect(new Set(seen)).toEqual(ids);
  });

  it('无 session 文件的线程被过滤且不占页配额(循环取数)', async () => {
    const versionId = await freshVersion();
    // 5 real + 5 fake + 5 real: limit=10 should skip the fakes to fill 10 reals, with hasMore exactly false (DB exhausted)
    await seedRealThreads(versionId, 5, 100);
    for (let i = 0; i < 5; i++) await insertThread(versionId, { updatedAt: at(50 + i) });
    await seedRealThreads(versionId, 5, 40);
    const res = await list(versionId, '&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.threads).toHaveLength(10);
    expect(res.body.hasMore).toBe(false);
    for (const t of res.body.threads) expect(t.title).toMatch(/^线程/);
  });

  it('同 created_at tie 按 id 决胜,keyset 游标不重不漏(行值子查询)', async () => {
    const versionId = await freshVersion();
    const ties = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const file = path.join(tmpDir, `${randomUUID()}.jsonl`);
      await fs.writeFile(file, '');
      ties.add(await insertThread(versionId, { updatedAt: at(200), title: `线程${i}`, sessionFile: file }));
    }
    // Same-instant ordering is necessarily id desc; pull all three rows page by page (limit=1), no overlap or omission between pages; page 3 hasMore exactly false
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const res = await list(versionId, `&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.body.threads).toHaveLength(1);
      seen.push(res.body.threads[0]!.id as string);
      expect(res.body.hasMore).toBe(page < 2);
      cursor = res.body.threads[0]!.id as string;
    }
    expect(new Set(seen)).toEqual(ties);
  });

  it('排序锚点是创建时间:老线程 updatedAt 被改名/新消息顶新也不上浮', async () => {
    const versionId = await freshVersion();
    // A created earlier (300 min ago) but recently active (updated_at=now); B created later (100 min ago) with no activity
    const fileA = path.join(tmpDir, `${randomUUID()}.jsonl`);
    const fileB = path.join(tmpDir, `${randomUUID()}.jsonl`);
    await fs.writeFile(fileA, '');
    await fs.writeFile(fileB, '');
    const a = await insertThread(versionId, { updatedAt: at(300), updatedAtLater: at(0), title: 'A-老会话新活跃', sessionFile: fileA });
    const b = await insertThread(versionId, { updatedAt: at(100), title: 'B-较新会话', sessionFile: fileB });
    // Both the old contract (bare array, hard cap 20) and the paged contract must put B first: by creation time, B is newer than A
    const legacy = await list(versionId, '');
    expect((legacy.body as { id: string }[]).map((t) => t.id)).toEqual([b, a]);
    const paged = await list(versionId, '&limit=10');
    expect((paged.body.threads as { id: string }[]).map((t) => t.id)).toEqual([b, a]);
  });

  it('limit 超 200 收口;非法 limit 走旧契约(裸数组)', async () => {
    const versionId = await freshVersion();
    await seedRealThreads(versionId, 3, 500);
    const clamped = await list(versionId, '&limit=100000');
    expect(clamped.body.threads.length).toBeLessThanOrEqual(200);
    expect(typeof clamped.body.hasMore).toBe('boolean');

    const legacy = await list(versionId, '');
    expect(Array.isArray(legacy.body)).toBe(true);
    const garbage = await list(versionId, '&limit=abc');
    expect(Array.isArray(garbage.body)).toBe(true);
  });
});
