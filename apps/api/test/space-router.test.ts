import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
/** 隔离的 .data 根:fake 会话的落盘文件写这里,不污染开发者真实的 apps/api/.data(须先于任何动态 import 设好)。 */
let tmpDataDir: string;

/** 捕获 prompt 的入参与 options，供图片透传断言用（每个用例在 beforeEach 清空）。 */
const capturedPrompts: { text: string; options?: { streamingBehavior?: string; images?: { data: string; mimeType: string }[] } }[] = [];
/** threadId → fake 会话的落盘路径，供 DELETE 清文件断言用（beforeEach 清空）。 */
const fakeSessionFiles = new Map<string, string>();

/**
 * 模拟 pi 持久化的可观测面：persist=true 时建会话即分配 sessionFile 路径（eager），
 * 但只有首条消息 prompt() 才真正写盘。列表判据=文件存在性，草稿线程=有路径无文件。
 * 不重造 pi 的 JSONL 结构——列表接口只 fs.access，从不解析内容。
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
 * 默认 stub 工厂:复刻真工厂的完整契约——建 fake 会话并把它的 sessionFile 落库
 * (真工厂 createSpaceSessionFactory 末尾 db.update(piThreadId=session.sessionFile) 同一步)。
 * 少了这步,DB 里 pi_thread_id 永远是空串,列表判据(文件存在性)永远进不了列表。
 */
async function stubFactory(ctx: { threadId: string }) {
  const s = makeFakeSession(ctx.threadId);
  await pool.query(`UPDATE ai_threads SET pi_thread_id=$2 WHERE id=$1`, [ctx.threadId, s.sessionFile]);
  return s;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-spacedata-'));
  process.env.PI_DATA_DIR = tmpDataDir;
  vi.resetModules();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  // DELETE /threads 清暂存会触及全部 6 张 ai_stage_* 表;SCHEMA_SQL 只建了 ai_stage_cases,
  // 其余 5 张在此补齐(IF NOT EXISTS,列定义照 src/db/schema.ts)。
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
  await container.stop();
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
    // 初始化失败的线程行必须清掉,不进列表
    const rows = await pool.query(`SELECT count(*)::int AS n FROM ai_threads WHERE kind='version'`);
    expect(rows.rows[0]!.n).toBe(0);
    // 其它初始化错误 → 500 session_init_failed
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
    // 后台 ensure+prompt 异步落标题;轮询等待,避免固定 sleep 在慢机上 flake
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
    // fake 会话建会话即分配 sessionFile 路径(pi 同款 eager 语义),但没 prompt 过 → 磁盘无文件
    const draft = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    // pi_thread_id 为空串的老行:被 SQL 下推条件先挡掉
    await pool.query(
      `INSERT INTO ai_threads(id, kind, version_id, pi_thread_id, title) VALUES ($1,'version',$2,'','旧会话')`,
      [crypto.randomUUID(), versionId],
    );
    // 有路径但文件不存在(草稿线程的真实形态)——判据必须是文件存在性,不能是路径非空
    await pool.query(
      `INSERT INTO ai_threads(id, kind, version_id, pi_thread_id, title) VALUES ($1,'version',$2,$3,'路径已分配')`,
      [crypto.randomUUID(), versionId, path.join(tmpDataDir, 'pi-sessions', 'never-flushed.jsonl')],
    );
    const list = await request(app).get(`/api/assistant/threads?versionId=${versionId}`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
    expect(draft.body.metadata.id).toBeTruthy(); // 草稿线程本身创建成功,只是不进列表
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
    // 冷内存判定用「零消息」:发版重启后 ensure 重建出来的会话本来就该是空的,
    // 关键在于它被建起来了(record 不再是 null)——修复前 GET 不 ensure,record 永远 null。
    const { resetSpaceSessions, snapshotOfThread } = await import('../src/pi/space/session.js');
    resetSpaceSessions();
    expect(snapshotOfThread(threadId)).toBeNull();

    const g = await request(app).get(`/api/assistant/threads/${threadId}`);
    expect(g.status).toBe(200);
    expect(g.body.metadata.messageCount).toBe(0);
    // 修复的核心断言:GET 之后 record 已建成(下一次 GET 命中内存,不再依赖 SSE 顺带建)
    expect(snapshotOfThread(threadId)).not.toBeNull();
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
    // 完全未知的 id:路由可见性校验 404(不入 DB 不存在静默通道)
    expect((await request(app).post(`/api/assistant/threads/${crypto.randomUUID()}/cancel`)).status).toBe(404);
    // 无 session 记录的孤儿线程(已落库但建 session 失败,如 LLM 未配置)同样 204(静默 no-op)
    const orphanId = crypto.randomUUID();
    await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,'')`, [orphanId, versionId]);
    expect((await request(app).post(`/api/assistant/threads/${orphanId}/cancel`)).status).toBe(204);
    expect(aborted).toBe(1);
    // 恢复默认 stub
    setSpaceSessionFactory(stubFactory as never);
  });

  it('GET /threads/:id/events 是 SSE:先 snapshot,confirm_request 可扇出', async () => {
    const { versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const threadId = t.body.metadata.id as string;
    await request(app).get(`/api/assistant/threads/${threadId}`); // 确保记录存在(工厂 stub 已注入)

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
      // SSE 连接是长连接,closeAllConnections 确保 server.close() 不挂起
      server.close();
      server.closeAllConnections();
    }
  });

  it('events 对无 record 的持久化线程先 ensure:后续自定义事件可达(修复早订阅竞态)', async () => {
    const { versionId } = await seedProject(pool);
    const id = crypto.randomUUID();
    // 直接 SQL 落行:resetSpaceSessions 后 record 不存在 —— 旧实现订阅到 noop 上,emit 会丢
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
  /** 建线程并发一条消息(让它进列表——列表过滤 messageCount>0)。 */
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
    // Pi 契约:status 必须是非空字符串;列表条目不带 archived
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
    // 真实竞态:首条消息 flush 落盘先于后台落题 → 列表读到 null 标题
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
    // 落盘的会话文件一并删除(Task 5 行为;activeThread 发过消息 → fake 已 flush 文件)
    const file = fakeSessionFiles.get(id);
    expect(file).toBeTruthy();
    await expect(fs.access(file!)).rejects.toThrow();
    expect((await pool.query(`SELECT count(*)::int AS n FROM ai_threads WHERE id=$1`, [id])).rows[0]!.n).toBe(0);
    for (const t of ['ai_stage_cases', 'ai_stage_case_ops', 'ai_stage_scenarios', 'ai_stage_environments', 'ai_stage_plans', 'ai_stage_datasets']) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE thread_id=$1`, [id])).rows[0]!.n).toBe(0);
    }
    // 内存 record 已 drop:快照接口 404(行没了),且旧会话不再被 status 查询命中
    expect((await request(app).get(`/api/assistant/threads/${id}`)).status).toBe(404);
    const { snapshotOfThread } = await import('../src/pi/space/session.js');
    expect(snapshotOfThread(id)).toBeNull();
    // 再删一次:行不存在 → 404(可见性校验先拦截;客户端 deleteThread 对 404 同样容忍)
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
    // assistant 段只取最后一轮的正文(中途思考被末轮覆盖),空 user 被跳过
    expect(out).toBe('用户: 第一问\n助手: 最终答');
  });

  it('buildTranscript:超预算时从最旧整行丢弃,保留最新行', async () => {
    const { buildTranscript } = await import('../src/pi/space/suggestions.js');
    const big = 'x'.repeat(6_000); // 单行超预算(TRANSCRIPT_CHAR_BUDGET=6000)
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
  /** 建线程并发一条消息,返回 threadId;prompt 是 fire-and-forget,这里轮询等它落地。 */
  async function sendWithAttachments(input: Record<string, unknown>): Promise<void> {
    const { versionId } = await seedProject(pool);
    const created = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const id = created.body.metadata.id as string;
    await request(app).post(`/api/assistant/threads/${id}/messages`).send({ input });
    // 路由是 204 后台派发,等 prompt 被调到为止(最多 ~2s)
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
