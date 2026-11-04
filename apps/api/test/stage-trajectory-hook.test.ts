import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

// R2 落库钩子：/stage/save 成功落库后投递轨迹蒸馏（fire-and-forget），enqueue 抛错绝不影响主流程。
// mock 机制：vi.resetModules + vi.doMock 拦截钩子里的动态 import('../../scheduler/trajectoryQueue.js')
// ——stageRoute 必须在 doMock 之后重导，动态 import 才会解析到 mock（两种相对路径解析到同一文件）。
let pool: Pool;
let app: import('express').Express;
let seedUserId: string;
const enqueueMock = vi.fn(async () => {});

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  vi.resetModules();
  vi.doMock('../src/scheduler/trajectoryQueue.js', () => ({
    enqueueTrajectoryDistill: enqueueMock,
  }));
  const { default: exp } = await import('express');
  const { spaceRoute } = await import('../src/pi/space/router.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  // 注意：seedOrg 必须用与 seedProject 同一份 helpers 模块（其 seedOrgCache 是模块级
  // WeakMap——resetModules 后动态重导会拿到另一份空缓存,再种一个新 org,项目就落到
  // 请求用户不可见的组织里 → 404 project not found）。
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  seedUserId = userId;
  const { managerUserOf } = await import('./helpers/auth.js');
  app = exp();
  app.use(exp.json());
  app.use((req, _res, next) => { req.user = managerUserOf(userId, username, orgId, orgPath); next(); });
  app.use('/api/assistant', spaceRoute);
  app.use(errorHandler);
  await import('../src/db/client.js');
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_threads, ai_stage_cases, test_steps, test_cases RESTART IDENTITY CASCADE`);
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue(undefined);
});

/** 造一个版本线程 + 一条已编译暂存用例草稿，返回锚点 id。 */
async function seedDraft(): Promise<{ threadId: string; localId: string; groupId: string; versionId: string }> {
  const { versionId, groupId } = await seedProject(pool);
  const threadId = randomUUID();
  await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,'')`, [threadId, versionId]);
  const localId = randomUUID();
  await pool.query(
    `INSERT INTO ai_stage_cases(thread_id, local_id, version_id, title, url, steps) VALUES ($1, $2, $3, '轨迹钩子用例', 'http://env.example/page', $4::jsonb)`,
    [threadId, localId, versionId, JSON.stringify([{ action: '点击登录', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#login' }] }], assertion: null }])],
  );
  return { threadId, localId, groupId, versionId };
}

describe('POST /threads/:id/stage/save — 轨迹蒸馏落库钩子', () => {
  it('落库成功 → enqueueTrajectoryDistill 收到 localId/caseId 成对负载（threadId/versionId/userId 对齐）', async () => {
    const { threadId, localId, groupId, versionId } = await seedDraft();
    const r = await request(app).post(`/api/assistant/threads/${threadId}/stage/save`)
      .send({ cases: [{ localId, groupId }] });
    expect(r.status).toBe(200);
    expect(r.body.savedCases).toBe(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const arg = enqueueMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.kind).toBe('trajectory');
    expect(arg.threadId).toBe(threadId);
    expect(arg.versionId).toBe(versionId);
    expect(arg.userId).toBe(seedUserId);
    const items = arg.items as Array<{ localId: string; caseId: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.localId).toBe(localId);
    expect(items[0]!.caseId).toBe(r.body.caseIdMap[localId]);
    // caseId 必须是真实落库的用例
    const n = (await pool.query(`SELECT count(*)::int n FROM test_cases WHERE id=$1`, [items[0]!.caseId])).rows[0]!;
    expect(n.n).toBe(1);
  });

  it('enqueue 抛错 → save 仍然 200、用例已落库、stage 行已删（fire-and-forget 铁律）', async () => {
    const { threadId, localId, groupId } = await seedDraft();
    enqueueMock.mockRejectedValueOnce(new Error('queue down'));
    const r = await request(app).post(`/api/assistant/threads/${threadId}/stage/save`)
      .send({ cases: [{ localId, groupId }] });
    expect(r.status).toBe(200);
    expect(r.body.savedCases).toBe(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const n = (await pool.query(`SELECT count(*)::int n FROM test_cases`)).rows[0]!;
    expect(n.n).toBe(1);
    const stage = (await pool.query(`SELECT count(*)::int n FROM ai_stage_cases WHERE local_id=$1`, [localId])).rows[0]!;
    expect(stage.n).toBe(0);
  });
});
