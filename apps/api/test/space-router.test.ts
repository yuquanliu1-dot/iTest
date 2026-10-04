import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

function makeFakeSession() {
  const listeners = new Set<(e: unknown) => void>();
  return {
    messages: [] as unknown[],
    listeners,
    subscribe(fn: (e: unknown) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    async prompt() { this.messages.push({ role: 'user' }); },
    abort() {},
    async dispose() {},
    get isStreaming() { return false; },
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: exp } = await import('express');
  app = exp();
  app.use(exp.json());
  const { spaceRoute } = await import('../src/pi/space/router.js');
  const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
  setSpaceSessionFactory(async () => makeFakeSession() as never);
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
});

beforeEach(async () => {
  const { resetSpaceSessions } = await import('../src/pi/space/session.js');
  resetSpaceSessions();
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

  it('GET /threads?versionId= 返回该版本的线程列表(带标题/状态)', async () => {
    const { versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    await request(app).post(`/api/assistant/threads/${t.body.metadata.id}/messages`).send({ input: { content: '查一下环境' } });
    await new Promise((r) => setTimeout(r, 50)); // 等后台 ensure+prompt(stub factory 立即完成)
    const list = await request(app).get(`/api/assistant/threads?versionId=${versionId}`);
    expect(list.status).toBe(200);
    const row = list.body.find((x: { id: string }) => x.id === t.body.metadata.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe('idle');
    expect(row.title).toBe('查一下环境');
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

  it('GET /models 未配置时返回 []', async () => {
    expect((await request(app).get('/api/assistant/models')).body).toEqual([]);
  });
});
