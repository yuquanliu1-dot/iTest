import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// checkoutRepoForVersion 可注入桩;impl 为 undefined 时走真实实现(既有 no_repo 用例不受影响)
const mockCheckout = { impl: undefined as undefined | ((versionId: string) => Promise<string>) };

vi.mock('../src/pi/repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pi/repo.js')>();
  return {
    ...actual,
    checkoutRepoForVersion: (versionId: string) =>
      mockCheckout.impl ? mockCheckout.impl(versionId) : actual.checkoutRepoForVersion(versionId),
  };
});

let container: StartedPostgreSqlContainer;
let pool: Pool;

interface Captured { ctx: unknown; prompts: string[]; }
const captured: Captured[] = [];

function makeFakeSession() {
  const listeners = new Set<(e: unknown) => void>();
  return {
    listeners,
    messages: [] as unknown[],
    prompts: [] as string[],
    subscribe(fn: (e: unknown) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    async prompt(text: string) { this.prompts.push(text); this.messages.push({ role: 'user', content: text }); },
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
  await import('../src/db/client.js');
  const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
  setSpaceSessionFactory(async (ctx) => {
    const s = makeFakeSession();
    captured.push({ ctx, prompts: s.prompts });
    return s as never;
  });
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  captured.length = 0;
  const { resetSpaceSessions } = await import('../src/pi/space/session.js');
  resetSpaceSessions();
  await pool.query(`TRUNCATE ai_threads RESTART IDENTITY CASCADE`);
});

async function insertSpaceThread(versionId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,'')`, [id, versionId]);
  return id;
}

describe('space session supervisor', () => {
  it('ensureSpaceRecord 绑定版本上下文;no_repo 静默降级;首条消息注入摘要+落标题', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const threadId = await insertSpaceThread(versionId);
    const { ensureSpaceRecord, sendSpaceUserMessage } = await import('../src/pi/space/session.js');

    const rec = await ensureSpaceRecord(threadId);
    expect(rec.versionId).toBe(versionId);
    // 项目未配 repoUrl → RepoUnavailableError('no_repo') 被吞,工厂收到 repoAvailable=false
    expect(captured[0]!.ctx).toMatchObject({ threadId, versionId, projectId, repoAvailable: false, cwd: null });

    await sendSpaceUserMessage(threadId, '帮我建三个登录用例');
    const first = captured[0]!.prompts[0]!;
    expect(first).toContain('【版本空间上下文】');
    expect(first).toContain('帮我建三个登录用例');
    const row = (await pool.query(`SELECT title FROM ai_threads WHERE id=$1`, [threadId])).rows[0] as { title: string | null };
    expect(row.title).toBe('帮我建三个登录用例');

    // 第二条消息不再注入摘要
    await sendSpaceUserMessage(threadId, '再建一个');
    expect(captured[0]!.prompts[1]!).not.toContain('【版本空间上下文】');
  }, 30_000);

  it('requirement 线程不能走空间 supervisor', async () => {
    const { projectId } = await seedProject(pool);
    const req = (await pool.query(`INSERT INTO requirements(project_id, title, content) VALUES ($1,'r','c') RETURNING id`, [projectId])).rows[0]!.id as string;
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO ai_threads(id, kind, requirement_id, pi_thread_id) VALUES ($1,'requirement',$2,'')`, [id, req]);
    const { ensureSpaceRecord } = await import('../src/pi/space/session.js');
    await expect(ensureSpaceRecord(id)).rejects.toThrow();
  }, 30_000);

  it('emitThreadEvent 向订阅者广播并带 threadId+seq', async () => {
    const { versionId } = await seedProject(pool);
    const threadId = await insertSpaceThread(versionId);
    const { ensureSpaceRecord, emitThreadEvent, subscribeThread } = await import('../src/pi/space/session.js');
    await ensureSpaceRecord(threadId);
    const events: Record<string, unknown>[] = [];
    const unsub = subscribeThread(threadId, (e) => events.push(e as Record<string, unknown>), { includeSnapshot: true });
    expect(events[0]!.type).toBe('snapshot');
    emitThreadEvent(threadId, { type: 'confirm_request', confirmId: 'c1' });
    expect(events[1]).toMatchObject({ type: 'confirm_request', confirmId: 'c1', threadId });
    expect(typeof events[1]!.seq).toBe('number');
    unsub();
  }, 30_000);

  it('并发 ensureSpaceRecord 单飞:工厂只调一次,双方拿到同一 record', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const threadId = await insertSpaceThread(versionId);
    const { ensureSpaceRecord } = await import('../src/pi/space/session.js');
    const [a, b] = await Promise.all([ensureSpaceRecord(threadId), ensureSpaceRecord(threadId)]);
    expect(a).toBe(b);
    expect(captured).toHaveLength(1);
  }, 30_000);

  it('checkout 失败(非 no_repo):session 照常建立但记录 repoIssue;no_repo 仍完全静默', async () => {
    const { versionId } = await seedProject(pool);
    const threadId = await insertSpaceThread(versionId);
    const { ensureSpaceRecord, spaceRepoIssue } = await import('../src/pi/space/session.js');
    const { RepoUnavailableError } = await import('../src/pi/repo.js');
    mockCheckout.impl = async () => { throw new RepoUnavailableError('auth_failed', 'PAT 无效'); };
    try {
      const rec = await ensureSpaceRecord(threadId);
      expect(rec.versionId).toBe(versionId);
      expect(spaceRepoIssue(threadId)).toContain('auth_failed');
    } finally {
      mockCheckout.impl = undefined;
    }
  }, 30_000);
});
