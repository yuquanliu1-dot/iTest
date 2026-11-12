import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let pool: Pool;
let app: import('express').Express;
/** Isolated .data root: the fake session's disk files are written here, never touching the developer's real apps/api/.data (must be set before any dynamic import). */
let tmpDataDir: string;

/** Captures prompt inputs and options for image-passthrough assertions (cleared in beforeEach for every case). */
const capturedPrompts: { text: string; options?: { streamingBehavior?: string; images?: { data: string; mimeType: string }[] } }[] = [];
/** threadId → the fake session's disk path, for DELETE file-cleanup assertions (cleared in beforeEach). */
const fakeSessionFiles = new Map<string, string>();

/**
 * Simulates pi's persistence observable surface: with persist=true, creating a session assigns the sessionFile path immediately (eager),
 * but only the first message's prompt() actually writes to disk. List criterion = file existence; a draft thread = path without a file.
 * Does not re-create pi's JSONL structure — the list API only fs.access, it never parses content.
 */
function makeFakeSession(threadId?: string) {
  const listeners = new Set<(e: unknown) => void>();
  const sessionFile = path.join(tmpDataDir, 'pi-sessions', `${crypto.randomUUID()}.jsonl`);
  if (threadId) fakeSessionFiles.set(threadId, sessionFile);
  return {
    sessionFile,
    messages: [] as unknown[],
    listeners,
    subscribe(fn: (e: unknown) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    async prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp'; images?: { data: string; mimeType: string }[] }) {
      capturedPrompts.push({ text, options });
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });
      await fs.appendFile(sessionFile, JSON.stringify({ role: 'user' }) + '\n');
      this.messages.push({ role: 'user' });
    },
    abort() {},
    async dispose() {},
    get isStreaming() { return false; },
  };
}

/**
 * Default stub factory: replicates the real factory's full contract — create the fake session and persist its sessionFile
 * (the same step as the real factory's createSpaceSessionFactory ending with db.update(piThreadId=session.sessionFile)).
 * Without this step, pi_thread_id in the DB stays an empty string forever and the list criterion (file existence) never admits anything into the list.
 */
async function stubFactory(ctx: { threadId: string }) {
  const s = makeFakeSession(ctx.threadId);
  await pool.query(`UPDATE ai_threads SET pi_thread_id=$2 WHERE id=$1`, [ctx.threadId, s.sessionFile]);
  return s;
}

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-spacedata-'));
  process.env.PI_DATA_DIR = tmpDataDir;
  vi.resetModules();
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  // DELETE /threads staging cleanup touches all 6 ai_stage_* tables; SCHEMA_SQL only creates ai_stage_cases,
  // so the other 5 are topped up here (IF NOT EXISTS, column definitions per src/db/schema.ts).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_stage_case_ops (thread_id text NOT NULL, local_id text NOT NULL, version_id uuid NOT NULL, case_id uuid NOT NULL, op varchar(30) NOT NULL, payload jsonb NOT NULL DEFAULT '{}', summary text NOT NULL, diff text, staged_at timestamp NOT NULL DEFAULT now(), CONSTRAINT ai_stage_case_ops_pk PRIMARY KEY(thread_id, local_id));
    CREATE TABLE IF NOT EXISTS ai_stage_scenarios (thread_id text NOT NULL, local_id text NOT NULL, version_id uuid NOT NULL, requirement_id uuid NOT NULL, title varchar(200) NOT NULL, description text, case_local_ids text[] NOT NULL DEFAULT '{}', staged_at timestamp NOT NULL DEFAULT now(), CONSTRAINT ai_stage_scenarios_pk PRIMARY KEY(thread_id, local_id));
    CREATE TABLE IF NOT EXISTS ai_stage_environments (thread_id text NOT NULL, local_id text NOT NULL, version_id uuid NOT NULL, name varchar(120) NOT NULL, base_url text, objects jsonb NOT NULL DEFAULT '[]', staged_at timestamp NOT NULL DEFAULT now(), CONSTRAINT ai_stage_environments_pk PRIMARY KEY(thread_id, local_id));
    CREATE TABLE IF NOT EXISTS ai_stage_plans (thread_id text NOT NULL, local_id text NOT NULL, version_id uuid NOT NULL, name varchar(200) NOT NULL, environment_id uuid, case_local_ids text[] NOT NULL DEFAULT '{}', staged_at timestamp NOT NULL DEFAULT now(), CONSTRAINT ai_stage_plans_pk PRIMARY KEY(thread_id, local_id));
    CREATE TABLE IF NOT EXISTS ai_stage_datasets (thread_id text NOT NULL, local_id text NOT NULL, version_id uuid NOT NULL, name varchar(120) NOT NULL, description text, columns jsonb NOT NULL DEFAULT '[]', rows jsonb NOT NULL DEFAULT '[]', staged_at timestamp NOT NULL DEFAULT now(), CONSTRAINT ai_stage_datasets_pk PRIMARY KEY(thread_id, local_id));
  `);
  const { default: exp } = await import('express');
  app = exp();
  app.use(exp.json());
  const { spaceRoute } = await import('../src/pi/space/router.js');
  const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
  setSpaceSessionFactory(stubFactory as never);
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use((req, _res, next) => { req.user = managerUserOf(userId, username, orgId, orgPath); next(); });
  app.use('/api/assistant', spaceRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await fs.rm(tmpDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { resetSpaceSessions } = await import('../src/pi/space/session.js');
  resetSpaceSessions();
  capturedPrompts.length = 0;
  fakeSessionFiles.clear();
  await pool.query(`TRUNCATE ai_threads RESTART IDENTITY CASCADE`);
});

describe('space wire contract', () => {
  it('POST /threads 建版本线程并返回快照;每次调用新建一线程(多线程)', async () => {
    const { versionId } = await seedProject(pool);
    const a = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const b = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    expect(a.status).toBe(200);
    expect(a.body.metadata.id).toBeTruthy();
    expect(Array.isArray(a.body.messages)).toBe(true);
    expect(b.body.metadata.id).not.toBe(a.body.metadata.id);
  });

  it('POST /threads 缺 versionId 400;未知 version 404', async () => {
    expect((await request(app).post('/api/assistant/threads').send({})).status).toBe(400);
    const r = await request(app).post('/api/assistant/threads').send({ metadata: { versionId: '00000000-0000-0000-0000-000000000000' } });
    expect(r.status).toBe(404);
  });

  it('POST /threads:LLM 未配置 → 502 llm_not_configured,线程行不残留', async () => {
    const { versionId } = await seedProject(pool);
    const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
    const { HttpError } = await import('../src/middleware/errorHandler.js');
    setSpaceSessionFactory(async () => {
      throw new HttpError(502, 'llm_not_configured', 'LLM 未配置:请先到设置页配置模型');
    });
    const r = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('llm_not_configured');
    expect(r.body.message).toContain('LLM 未配置');
    // A thread row whose initialization failed must be cleaned up, never entering the list
    const rows = await pool.query(`SELECT count(*)::int AS n FROM ai_threads WHERE kind='version'`);
    expect(rows.rows[0]!.n).toBe(0);
    // Other initialization errors → 500 session_init_failed
    setSpaceSessionFactory(async () => { throw new Error('boom'); });
    const r2 = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    expect(r2.status).toBe(500);
    expect(r2.body.error).toBe('session_init_failed');
    setSpaceSessionFactory(stubFactory as never);
  });

  it('POST /threads:无 repo issue 时响应不带 lastError 字段污染', async () => {
    const { versionId } = await seedProject(pool);
    const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
    setSpaceSessionFactory(stubFactory as never);
    const r = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    expect(r.status).toBe(200);
    expect(r.body.lastError).toBeUndefined();
  });

  it('GET /threads?versionId= 返回该版本的线程列表(带标题/状态)', async () => {
    const { versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    await request(app).post(`/api/assistant/threads/${t.body.metadata.id}/messages`).send({ input: { content: '查一下环境' } });
    // Background ensure+prompt sets the title asynchronously; poll and wait to avoid fixed sleeps flaking on slow machines
    let list!: request.Response;
    for (let i = 0; i < 10; i++) {
      list = await request(app).get(`/api/assistant/threads?versionId=${versionId}`);
      if (list.body.some((x: { title: string | null }) => x.title === '查一下环境')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(list.status).toBe(200);
    const row = list.body.find((x: { id: string }) => x.id === t.body.metadata.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe('idle');
    expect(row.title).toBe('查一下环境');
  });

  it('GET /threads 无 versionId 返回空列表(react-pi 运行时机制不带参调用,不 400)', async () => {
    const r = await request(app).get('/api/assistant/threads');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it('GET /threads?versionId= 会话文件不存在的线程不进列表(草稿/未落盘)', async () => {
    const { versionId } = await seedProject(pool);
    // The fake session assigns the sessionFile path at creation (pi's same eager semantics), but with no prompt yet → no file on disk
    const draft = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    // Legacy row with an empty-string pi_thread_id: filtered out first by the SQL push-down condition
    await pool.query(
      `INSERT INTO ai_threads(id, kind, version_id, pi_thread_id, title) VALUES ($1,'version',$2,'','旧会话')`,
      [crypto.randomUUID(), versionId],
    );
    // A path exists but the file doesn't (the real shape of a draft thread) — the criterion must be file existence, not a non-empty path
    await pool.query(
      `INSERT INTO ai_threads(id, kind, version_id, pi_thread_id, title) VALUES ($1,'version',$2,$3,'路径已分配')`,
      [crypto.randomUUID(), versionId, path.join(tmpDataDir, 'pi-sessions', 'never-flushed.jsonl')],
    );
    const list = await request(app).get(`/api/assistant/threads?versionId=${versionId}`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
    expect(draft.body.metadata.id).toBeTruthy(); // the draft thread itself was created fine; it just doesn't enter the list
  });

  it('GET /threads/:id 返回快照;requirement 线程 404(本契约只管 version 线程)', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const g = await request(app).get(`/api/assistant/threads/${t.body.metadata.id}`);
    expect(g.status).toBe(200);
    expect(g.body.metadata.id).toBe(t.body.metadata.id);

    const req = (await pool.query(`INSERT INTO requirements(project_id, title, content) VALUES ($1,'r','c') RETURNING id`, [projectId])).rows[0]!.id as string;
    const rid = crypto.randomUUID();
    await pool.query(`INSERT INTO ai_threads(id, kind, requirement_id, pi_thread_id) VALUES ($1,'requirement',$2,'')`, [rid, req]);
    expect((await request(app).get(`/api/assistant/threads/${rid}`)).status).toBe(404);
  });

  it('GET /threads/:id 冷线程(内存无 record)也回历史快照:ensure 重建会话,不等第二次点击', async () => {
    const { versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const threadId = t.body.metadata.id as string;
    // Cold-memory detection uses "zero messages": after a release restart, the session rebuilt by ensure should naturally be empty;
    // the key point is that it got built (record is no longer null) — before the fix, GET didn't ensure, so record stayed null forever.
    const { resetSpaceSessions, snapshotOfThread } = await import('../src/pi/space/session.js');
    resetSpaceSessions();
    expect(await snapshotOfThread(threadId)).toBeNull();

    const g = await request(app).get(`/api/assistant/threads/${threadId}`);
    expect(g.status).toBe(200);
    expect(g.body.metadata.messageCount).toBe(0);
    // The fix's core assertion: after GET the record has been built (the next GET hits memory, no longer relying on SSE to build it incidentally)
    expect(await snapshotOfThread(threadId)).not.toBeNull();
  });

  it('GET /threads/:id 冷线程但会话构建失败:仍 200 + 兜底空快照(不 500)', async () => {
    const { versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const threadId = t.body.metadata.id as string;
    const { resetSpaceSessions, setSpaceSessionFactory } = await import('../src/pi/space/session.js');
    resetSpaceSessions();
    setSpaceSessionFactory(async () => { throw new Error('boom'); });
    const g = await request(app).get(`/api/assistant/threads/${threadId}`);
    expect(g.status).toBe(200);
    expect(g.body.messages).toEqual([]);
    setSpaceSessionFactory(stubFactory as never);
  });

  it('POST /threads/:id/confirm 未知 confirmId 404;有效 confirmId 落地 resolve', async () => {
    const { versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const threadId = t.body.metadata.id as string;
    expect((await request(app).post(`/api/assistant/threads/${threadId}/confirm`).send({ confirmId: 'bogus', approved: true })).status).toBe(404);

    const { requestConfirmation } = await import('../src/pi/space/confirm.js');
    let confirmId = '';
    const p = requestConfirmation(
      { threadId, toolName: 'manage_cases', action: 'delete', summary: 's', risk: 'delete' },
      (e) => { confirmId = (e as { confirmId: string }).confirmId; },
    );
    const r = await request(app).post(`/api/assistant/threads/${threadId}/confirm`).send({ confirmId, approved: true });
    expect(r.status).toBe(204);
    await expect(p).resolves.toBe(true);
  });

  it('POST /threads/:id/cancel 调 session.abort;无 session 记录时静默 204', async () => {
    const { versionId } = await seedProject(pool);
    const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
    let aborted = 0;
    setSpaceSessionFactory(async () => {
      const s = makeFakeSession() as unknown as { abort: () => void };
      s.abort = () => { aborted += 1; };
      return s as never;
    });
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const threadId = t.body.metadata.id as string;
    const ok = await request(app).post(`/api/assistant/threads/${threadId}/cancel`);
    expect(ok.status).toBe(204);
    expect(aborted).toBe(1);
    // A fully unknown id: route visibility check 404 (no DB row means no silent channel)
    expect((await request(app).post(`/api/assistant/threads/${crypto.randomUUID()}/cancel`)).status).toBe(404);
    // Orphan thread with no session record (row persisted but session creation failed, e.g. LLM unconfigured) also 204 (silent no-op)
    const orphanId = crypto.randomUUID();
    await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,'')`, [orphanId, versionId]);
    expect((await request(app).post(`/api/assistant/threads/${orphanId}/cancel`)).status).toBe(204);
    expect(aborted).toBe(1);
    // Restore the default stub
    setSpaceSessionFactory(stubFactory as never);
  });

  it('GET /threads/:id/events 是 SSE:先 snapshot,confirm_request 可扇出', async () => {
    const { versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const threadId = t.body.metadata.id as string;
    await request(app).get(`/api/assistant/threads/${threadId}`); // make sure the record exists (the factory stub is injected)

    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/assistant/threads/${threadId}/events`);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(Buffer.from(first.value!).toString('utf8')).toContain('snapshot');

      const { emitThreadEvent } = await import('../src/pi/space/session.js');
      emitThreadEvent(threadId, { type: 'confirm_request', confirmId: 'c1' });
      const second = await reader.read();
      expect(Buffer.from(second.value!).toString('utf8')).toContain('confirm_request');
      await reader.cancel();
    } finally {
      // SSE connections are long-lived; closeAllConnections ensures server.close() doesn't hang
      server.close();
      server.closeAllConnections();
    }
  });

  it('events 对无 record 的持久化线程先 ensure:后续自定义事件可达(修复早订阅竞态)', async () => {
    const { versionId } = await seedProject(pool);
    const id = crypto.randomUUID();
    // Direct SQL row insert: after resetSpaceSessions the record doesn't exist — the old implementation subscribed to a noop and emit was lost
    await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,'')`, [id, versionId]);

    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/assistant/threads/${id}/events`);
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      expect(Buffer.from((await reader.read()).value!).toString('utf8')).toContain('snapshot');
      const { emitThreadEvent } = await import('../src/pi/space/session.js');
      emitThreadEvent(id, { type: 'stage', kind: 'case', id: 'c1', action: 'create' });
      const second = await reader.read();
      expect(Buffer.from(second.value!).toString('utf8')).toContain('stage');
      await reader.cancel();
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  it('GET /models 未配置时返回 []', async () => {
    expect((await request(app).get('/api/assistant/models')).body).toEqual([]);
  });
});

describe('线程列表作用域与改名/删除(react-pi ThreadList 契约)', () => {
  /** Create a thread and send one message (to get it into the list — the list filters on messageCount>0). */
  async function activeThread(versionId: string): Promise<string> {
    const created = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const id = created.body.metadata.id as string;
    await request(app).post(`/api/assistant/threads/${id}/messages`).send({ input: { content: 'hi' } });
    for (let i = 0; i < 40; i++) {
      const list = await request(app).get(`/api/assistant/threads?versionId=${versionId}`);
      if (list.body.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return id;
  }

  it('POST /threads 接受 react-pi 的 {workspacePath} 形状(versionId ≡ workspacePath)', async () => {
    const { versionId } = await seedProject(pool);
    const r = await request(app).post('/api/assistant/threads').send({ workspacePath: versionId });
    expect(r.status).toBe(200);
    const row = await pool.query(`SELECT version_id FROM ai_threads WHERE id=$1`, [r.body.metadata.id]);
    expect(row.rows[0]!.version_id).toBe(versionId);
  });

  it('GET /threads?workspacePath= 与 ?versionId= 等价', async () => {
    const { versionId } = await seedProject(pool);
    await activeThread(versionId);
    const a = await request(app).get(`/api/assistant/threads?workspacePath=${versionId}`);
    expect(a.status).toBe(200);
    expect(a.body).toHaveLength(1);
    expect(a.body[0]!.status).toBe('idle');
    // Pi contract: status must be a non-empty string; list entries carry no archived
    expect(typeof a.body[0]!.status).toBe('string');
    expect(a.body[0]!.archived).toBeUndefined();
  });

  it('PATCH /threads/:id 改名;非字符串 title 400;未知线程 404', async () => {
    const { versionId } = await seedProject(pool);
    const id = await activeThread(versionId);
    const r = await request(app).patch(`/api/assistant/threads/${id}`).send({ title: '  新标题  ' });
    expect(r.status).toBe(204);
    const row = await pool.query(`SELECT title FROM ai_threads WHERE id=$1`, [id]);
    expect(row.rows[0]!.title).toBe('新标题');
    expect((await request(app).patch(`/api/assistant/threads/${id}`).send({ title: 42 })).status).toBe(400);
    expect((await request(app).patch(`/api/assistant/threads/${crypto.randomUUID()}`).send({ title: 'x' })).status).toBe(404);
  });

  it('PATCH 改名后首条消息不再覆盖标题(sendSpaceUserMessage 只在无标题时落题)', async () => {
    const { versionId } = await seedProject(pool);
    const created = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const id = created.body.metadata.id as string;
    await request(app).patch(`/api/assistant/threads/${id}`).send({ title: '手动标题' });
    await request(app).post(`/api/assistant/threads/${id}/messages`).send({ input: { content: '第一问' } });
    for (let i = 0; i < 20; i++) {
      const row = await pool.query(`SELECT title FROM ai_threads WHERE id=$1`, [id]);
      if (row.rows[0]!.title) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const row = await pool.query(`SELECT title FROM ai_threads WHERE id=$1`, [id]);
    expect(row.rows[0]!.title).toBe('手动标题');
  });

  it('列表含 title=null 线程时,title 缺省而非 null(react-pi isOptionalString 拒 null,整列表会挂)', async () => {
    const { versionId } = await seedProject(pool);
    const id = await activeThread(versionId);
    // Real race: the first message's flush to disk lands before the background title write → the list reads a null title
    await pool.query(`UPDATE ai_threads SET title=NULL WHERE id=$1`, [id]);
    const list = await request(app).get(`/api/assistant/threads?versionId=${versionId}`);
    expect(list.status).toBe(200);
    const row = list.body.find((x: { id: string }) => x.id === id);
    expect(row).toBeTruthy();
    expect(row.title).toBeUndefined();
  });

  it('DELETE /threads/:id 删线程行并清六张暂存表;内存 record 释放', async () => {
    const { versionId } = await seedProject(pool);
    const id = await activeThread(versionId);
    await pool.query(`INSERT INTO ai_stage_cases(thread_id, local_id, version_id, title) VALUES ($1,'c1',$2,'t')`, [id, versionId]);
    await pool.query(`INSERT INTO ai_stage_case_ops(thread_id, local_id, version_id, case_id, op, payload, summary) VALUES ($1,'o1',$2,$3,'update_case','{}','s')`, [id, versionId, crypto.randomUUID()]);
    await pool.query(`INSERT INTO ai_stage_scenarios(thread_id, local_id, version_id, requirement_id, title) VALUES ($1,'s1',$2,$3,'t')`, [id, versionId, crypto.randomUUID()]);
    await pool.query(`INSERT INTO ai_stage_environments(thread_id, local_id, version_id, name) VALUES ($1,'e1',$2,'n')`, [id, versionId]);
    await pool.query(`INSERT INTO ai_stage_plans(thread_id, local_id, version_id, name) VALUES ($1,'p1',$2,'n')`, [id, versionId]);
    await pool.query(`INSERT INTO ai_stage_datasets(thread_id, local_id, version_id, name) VALUES ($1,'d1',$2,'n')`, [id, versionId]);

    const del = await request(app).delete(`/api/assistant/threads/${id}`);
    expect(del.status).toBe(204);
    // The persisted session file is deleted too (Task 5 behavior; activeThread sent a message → the fake already flushed the file)
    const file = fakeSessionFiles.get(id);
    expect(file).toBeTruthy();
    await expect(fs.access(file!)).rejects.toThrow();
    expect((await pool.query(`SELECT count(*)::int AS n FROM ai_threads WHERE id=$1`, [id])).rows[0]!.n).toBe(0);
    for (const t of ['ai_stage_cases', 'ai_stage_case_ops', 'ai_stage_scenarios', 'ai_stage_environments', 'ai_stage_plans', 'ai_stage_datasets']) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE thread_id=$1`, [id])).rows[0]!.n).toBe(0);
    }
    // In-memory record already dropped: the snapshot API 404s (row gone), and the old session is no longer hit by status queries
    expect((await request(app).get(`/api/assistant/threads/${id}`)).status).toBe(404);
    const { snapshotOfThread } = await import('../src/pi/space/session.js');
    expect(await snapshotOfThread(id)).toBeNull();
    // Delete again: row doesn't exist → 404 (the visibility check intercepts first; the client's deleteThread tolerates 404 the same way)
    expect((await request(app).delete(`/api/assistant/threads/${id}`)).status).toBe(404);
  });
});

describe('推荐追问(suggestions)', () => {
  it('未知线程 404(可见性校验);孤儿线程(有行无会话)404 session not found', async () => {
    expect((await request(app).post(`/api/assistant/threads/${crypto.randomUUID()}/suggestions`)).status).toBe(404);
    const { versionId } = await seedProject(pool);
    const orphanId = crypto.randomUUID();
    await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,'')`, [orphanId, versionId]);
    const r = await request(app).post(`/api/assistant/threads/${orphanId}/suggestions`);
    expect(r.status).toBe(404);
  });

  it('活跃线程但转写为空(没发过消息)→ 200 [](不调 LLM、不报错)', async () => {
    const { versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const r = await request(app).post(`/api/assistant/threads/${t.body.metadata.id}/suggestions`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it('冷线程(piThreadId 有值、内存 record 无)→ 先 ensure 重建再生成,不再 404(跨副本轮询落他副本时同款)', async () => {
    const { versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const id = t.body.metadata.id;
    const { resetSpaceSessions, snapshotOfThread } = await import('../src/pi/space/session.js');
    resetSpaceSessions(); // equivalent of a release restart: piThreadId persisted but the in-memory record is cold
    expect(await snapshotOfThread(id)).toBeNull();
    const r = await request(app).post(`/api/assistant/threads/${id}/suggestions`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
    expect(await snapshotOfThread(id)).not.toBeNull(); // ensure rebuilt the session via the "has piThreadId" path
  });

  it('有转写但 LLM 未配置 → 502 llm_not_configured', async () => {
    const { versionId } = await seedProject(pool);
    const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
    setSpaceSessionFactory(async () => {
      const s = makeFakeSession();
      s.messages.push({ role: 'user', content: [{ type: 'text', text: '查一下环境' }] });
      s.messages.push({ role: 'assistant', content: [{ type: 'text', text: '共有 2 个环境' }] });
      return s as never;
    });
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const r = await request(app).post(`/api/assistant/threads/${t.body.metadata.id}/suggestions`);
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('llm_not_configured');
  });
});

describe('suggestions 纯函数', () => {
  it('buildTranscript:取 user/assistant 文本、跳过工具与空消息、末轮 assistant 收尾', async () => {
    const { buildTranscript } = await import('../src/pi/space/suggestions.js');
    const out = buildTranscript([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: [{ type: 'toolCall' }, { type: 'text', text: '中途' }] },
      { role: 'toolResult', content: '忽略' },
      { role: 'user', content: [] },
      { role: 'assistant', content: [{ type: 'text', text: '最终答' }] },
    ]);
    // The assistant section takes only the last turn's body (mid-conversation thinking is overwritten by the last turn); empty user messages are skipped
    expect(out).toBe('用户: 第一问\n助手: 最终答');
  });

  it('buildTranscript:超预算时从最旧整行丢弃,保留最新行', async () => {
    const { buildTranscript } = await import('../src/pi/space/suggestions.js');
    const big = 'x'.repeat(6_000); // single line over budget (TRANSCRIPT_CHAR_BUDGET=6000)
    const msgs = [
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: '最后一问' },
    ];
    const out = buildTranscript(msgs);
    expect(out).toBe('用户: 最后一问');
  });

  it('parseSuggestionLines:去序号/项目符/引号,取前 3 条', async () => {
    const { parseSuggestionLines } = await import('../src/pi/space/suggestions.js');
    expect(parseSuggestionLines('1. 查环境\n- 「建三条用例」\n\n2) 跑一遍\n第四行不要\n第五行也不要')).toEqual([
      '查环境',
      '建三条用例',
      '跑一遍',
    ]);
  });
});

describe('图片附件透传', () => {
  /** Create a thread and send one message, returning the threadId; prompt is fire-and-forget, so poll here until it lands. */
  async function sendWithAttachments(input: Record<string, unknown>): Promise<void> {
    const { versionId } = await seedProject(pool);
    const created = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const id = created.body.metadata.id as string;
    await request(app).post(`/api/assistant/threads/${id}/messages`).send({ input });
    // The route is 204 with background dispatch; wait until prompt gets called (up to ~2s)
    for (let i = 0; i < 40 && capturedPrompts.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('合法 image 附件原样透进 prompt.images,文本不受影响', async () => {
    await sendWithAttachments({
      content: '看这张图',
      attachments: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
    });
    expect(capturedPrompts[0]!.text).toBe('看这张图');
    expect(capturedPrompts[0]!.options?.images).toEqual([{ data: 'aGVsbG8=', mimeType: 'image/png' }]);
  });

  it('无附件时不下发 images 字段(不给 SDK 传空数组)', async () => {
    await sendWithAttachments({ content: '纯文本' });
    expect(capturedPrompts[0]!.options?.images).toBeUndefined();
  });

  it('非 image 的 mimeType / 非 base64 的 data 一律丢弃,但消息照发', async () => {
    await sendWithAttachments({
      content: '混合附件',
      attachments: [
        { type: 'image', mimeType: 'application/pdf', data: 'aGVsbG8=' },
        { type: 'image', mimeType: 'image/png', data: 'not base64!!' },
        null,
        'garbage',
        { type: 'image', mimeType: 'image/jpeg', data: 'd29ybGQ=' },
      ],
    });
    expect(capturedPrompts[0]!.text).toBe('混合附件');
    expect(capturedPrompts[0]!.options?.images).toEqual([{ data: 'd29ybGQ=', mimeType: 'image/jpeg' }]);
  });

  it('张数超上限时截断(取前 4 张),不报错', async () => {
    await sendWithAttachments({
      content: '很多图',
      attachments: Array.from({ length: 6 }, (_v, i) => ({
        type: 'image', mimeType: 'image/png', data: Buffer.from(`img${i}`).toString('base64'),
      })),
    });
    expect(capturedPrompts[0]!.options?.images).toHaveLength(4);
  });
});

describe('快照合并压缩前缀(preCompactionMessagesOf + snapshotOf)', () => {
  it('真 SessionManager.inMemory:压缩 → 前缀=firstKept 之前;无压缩 → 空;firstKeptEntryId=null → 全摘', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const { preCompactionMessagesOf } = await import('../src/pi/space/session.js');
    const mk = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });

    const sm1 = SessionManager.inMemory();
    sm1.appendMessage(mk('旧问题一'));
    sm1.appendMessage(mk('旧问题二'));
    const keptId = sm1.appendMessage(mk('新问题'));
    sm1.appendCompaction('摘要', keptId, 12000);
    const pre1 = preCompactionMessagesOf(sm1);
    expect(pre1).toHaveLength(2);
    expect(pre1[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: '旧问题一' }] });
    expect(pre1[1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: '旧问题二' }] });

    const sm2 = SessionManager.inMemory();
    sm2.appendMessage(mk('唯一问题'));
    expect(preCompactionMessagesOf(sm2)).toEqual([]);

    const sm3 = SessionManager.inMemory();
    sm3.appendMessage(mk('全部被摘出上下文'));
    sm3.appendCompaction('摘要', null, 100);
    // firstKeptEntryId=null → buildContextEntries' kept section is empty, everything pre-compaction was evicted from context,
    // i.e. prefix = all old messages (none lost when merged for display)
    const pre3 = preCompactionMessagesOf(sm3);
    expect(pre3).toHaveLength(1);
    expect(pre3[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: '全部被摘出上下文' }] });
  });

  it('GET /threads/:id 快照把前缀拼在头部,messageCount 合并', async () => {
    const { versionId } = await seedProject(pool);
    const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
    const preUser = { role: 'user', content: [{ type: 'text', text: '压缩前旧问题' }] };
    const preAssistant = { role: 'assistant', content: [{ type: 'text', text: '压缩前旧回答' }] };
    setSpaceSessionFactory(async (ctx: { threadId: string }) => {
      const s = makeFakeSession(ctx.threadId) as Record<string, unknown>;
      s.messages = [
        { role: 'compactionSummary', summary: 'kept 摘要', tokensBefore: 1000 },
        { role: 'user', content: [{ type: 'text', text: '压缩后新问题' }] },
      ];
      s.preCompactionMessages = () => [preUser, preAssistant];
      return s as never;
    });
    try {
      const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
      const threadId = t.body.metadata.id as string;
      const r = await request(app).get(`/api/assistant/threads/${threadId}`);
      expect(r.status).toBe(200);
      expect(r.body.messages).toHaveLength(4);
      expect(r.body.messages[0]).toEqual(preUser);
      expect(r.body.messages[1]).toEqual(preAssistant);
      expect(r.body.messages[2]).toMatchObject({ role: 'compactionSummary' });
      expect(r.body.messages[3]).toMatchObject({ role: 'user' });
      expect(r.body.metadata.messageCount).toBe(4);
    } finally {
      setSpaceSessionFactory(stubFactory as never);
    }
  });
});

describe('持久产物（skill 生成文档等）', () => {
  it('列表接口按线程过滤（新→旧）+ 下载 Content-Type 按记录 mime 出', async () => {
    const { versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const threadId = t.body.metadata.id as string;
    // Artifacts registered via a module sourced identically to the router (same module registry, so we get the very instance the route uses)
    const { registerPersistentArtifact } = await import('../src/pi/space/artifacts.js');
    await registerPersistentArtifact(Buffer.from('older'), { name: '旧报告.docx' }, { threadId, versionId, projectId: crypto.randomUUID() });
    await new Promise((r) => setTimeout(r, 10));
    const token = await registerPersistentArtifact(Buffer.from('newer'), { name: '新报告.docx', count: 5 }, { threadId, versionId, projectId: crypto.randomUUID() });

    const list = await request(app).get(`/api/assistant/threads/${threadId}/artifacts`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    expect(list.body[0]).toMatchObject({ name: '新报告.docx', token, size: 5, count: 5 });
    expect(list.body[0].mime).toContain('wordprocessingml');
    expect(list.body[1].name).toBe('旧报告.docx'); // newest → oldest

    // responseType('blob'): supertest auto-parses unknown binary mime types on its own; force the body to stay a raw buffer
    const dl = await request(app).get(`/api/assistant/threads/${threadId}/artifacts/${token}`).responseType('blob');
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('wordprocessingml'); // no longer hardcoded application/zip
    expect(dl.headers['content-disposition']).toContain("filename*=UTF-8''"); // RFC 5987 non-ASCII filename
    expect(dl.body.toString()).toBe('newer');
  });

  it('未知 token / 他线程 token → 410；未知线程 → 404；无产物线程 → 空数组', async () => {
    const { versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const threadId = t.body.metadata.id as string;
    const other = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const otherId = other.body.metadata.id as string;

    const { registerPersistentArtifact } = await import('../src/pi/space/artifacts.js');
    const token = await registerPersistentArtifact(Buffer.from('x'), { name: 'a.docx' }, { threadId, versionId, projectId: crypto.randomUUID() });

    expect((await request(app).get(`/api/assistant/threads/${threadId}/artifacts/00000000-0000-4000-8000-000000000000`)).status).toBe(410);
    // The token belongs to threadId; accessing it from otherId's URL → 410 (no cross-thread leak)
    expect((await request(app).get(`/api/assistant/threads/${otherId}/artifacts/${token}`)).status).toBe(410);
    expect((await request(app).get(`/api/assistant/threads/${threadId}/artifacts`)).body).toHaveLength(1);
    expect((await request(app).get(`/api/assistant/threads/${otherId}/artifacts`)).body).toHaveLength(0);
    expect((await request(app).get(`/api/assistant/threads/00000000-0000-4000-8000-000000000000/artifacts`)).status).toBe(404);
  });
});
