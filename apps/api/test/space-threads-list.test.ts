import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let tmpDir: string;

/** 造一条 kind='version' 线程;sessionFile 给真实文件路径则过 fs 探测,不给则指向不存在
 *  的路径(非空 piThreadId 过 SQL where、被 fs 探测滤掉——对应生产上 session 文件被清的线程)。
 *  createdAt 用显式分钟差保证 (createdAt,id) 全序确定;updatedAt 缺省同刻,可单独后拨
 *  模拟改名/新消息落题(排序不应被它带跑)。 */
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

/** 每个用例独立版本空间,互不串数据。 */
async function freshVersion(): Promise<string> {
  return (await seedProject(pool)).versionId;
}

/** 批量造带真实 session 文件的线程,返回 id 集合。 */
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
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
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
  await container.stop();
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
        expect(typeof t.title).toBe('string'); // 有题线程出字符串
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
    // 5 真 + 5 假 + 5 真:limit=10 应跳过假的凑满 10 真,hasMore 精确为 false(库里已耗尽)
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
    // 同刻排序必为 id desc;逐页(limit=1)拉完三行,页间不重不漏;第 3 页 hasMore 精确 false
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
    // A 先建(300 分钟前)但最近活跃(updated_at=now);B 后建(100 分钟前)无活跃
    const fileA = path.join(tmpDir, `${randomUUID()}.jsonl`);
    const fileB = path.join(tmpDir, `${randomUUID()}.jsonl`);
    await fs.writeFile(fileA, '');
    await fs.writeFile(fileB, '');
    const a = await insertThread(versionId, { updatedAt: at(300), updatedAtLater: at(0), title: 'A-老会话新活跃', sessionFile: fileA });
    const b = await insertThread(versionId, { updatedAt: at(100), title: 'B-较新会话', sessionFile: fileB });
    // 旧契约(裸数组,20 硬顶)与分页契约都必须 B 在前:按创建时间,B 比 A 新
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
