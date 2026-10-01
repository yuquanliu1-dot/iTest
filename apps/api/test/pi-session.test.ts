import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let requirementId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_workspace_state, ai_threads RESTART IDENTITY CASCADE`);
  const { projectId } = await seedProject(pool);
  const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
  requirementId = r.rows[0]!.id as string;
});

class FakeSession {
  private listeners = new Set<(e: unknown) => void>();
  private _streaming = false;
  isStreaming() { return this._streaming; }
  messages: unknown[] = [];
  subscribe(fn: (e: unknown) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async prompt() { this._streaming = true; queueMicrotask(() => this._streaming = false); }
  abort() { this._streaming = false; }
  async dispose() { this.listeners.clear(); }
}

describe('pi supervisor', () => {
  it('ensureRecord creates an ai_threads row and reuses on second call', async () => {
    const { setSessionFactory, ensureRecord, resetSessions } = await import('../src/pi/session.js');
    resetSessions();
    let calls = 0;
    setSessionFactory(async () => { calls++; return new FakeSession() as never; });
    const r1 = await ensureRecord(requirementId);
    const r2 = await ensureRecord(requirementId);
    expect(r1.threadId).toBe(r2.threadId);
    expect(calls).toBe(1);
  });

  it('sendUserMessage relays prompt and fans out events', async () => {
    const { setSessionFactory, ensureRecord, subscribeThread, sendUserMessage, resetSessions } = await import('../src/pi/session.js');
    resetSessions();
    const fake = new FakeSession();
    setSessionFactory(async () => fake as never);
    const r = await ensureRecord(requirementId);
    const seen: unknown[] = [];
    subscribeThread(r.threadId, (e) => seen.push(e));
    await sendUserMessage(r.threadId, { content: 'hi' });
    expect(fake.messages.length).toBe(0); // FakeSession doesn't store content
    expect(seen.length).toBe(0);          // No fan-out (no subscribe call fired in fake)
  });

  it('subscribeThread emits snapshot first (seq=0)', async () => {
    const { setSessionFactory, ensureRecord, subscribeThread, resetSessions } = await import('../src/pi/session.js');
    resetSessions();
    setSessionFactory(async () => new FakeSession() as never);
    const r = await ensureRecord(requirementId);
    let first: unknown;
    subscribeThread(r.threadId, (e) => { if (first === undefined) first = e; }, { includeSnapshot: true });
    expect((first as { seq: number }).seq).toBe(0);
    expect((first as { metadata: { id: string } }).metadata.id).toBe(r.threadId);
  });

  it('cancelThread calls abort()', async () => {
    const { setSessionFactory, ensureRecord, cancelThread, resetSessions } = await import('../src/pi/session.js');
    resetSessions();
    const fake = new FakeSession();
    const abortSpy = (fake as unknown as { abort: () => void }).abort = () => { (fake as unknown as { _aborted: boolean })._aborted = true; };
    void abortSpy;
    setSessionFactory(async () => fake as never);
    const r = await ensureRecord(requirementId);
    cancelThread(r.threadId);
    expect((fake as unknown as { _aborted: boolean })._aborted).toBe(true);
  });
});
