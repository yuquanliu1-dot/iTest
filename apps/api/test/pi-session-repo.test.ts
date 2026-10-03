import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_workspace_state, ai_scenarios, ai_cases, ai_threads RESTART IDENTITY CASCADE`);
  const { projectId } = await seedProject(pool);
  const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
  requirementId = r.rows[0]!.id as string;
});

// 与 pi-session.test.ts 同款 FakeSession，避免污染 cwd / 拉起真实 LLM。
class FakeSession {
  private listeners = new Set<(e: unknown) => void>();
  private _streaming = false;
  get isStreaming() { return this._streaming; }
  messages: unknown[] = [];
  subscribe(fn: (e: unknown) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async prompt() { this._streaming = true; queueMicrotask(() => this._streaming = false); }
  abort() { this._streaming = false; }
  async dispose() { this.listeners.clear(); }
}

describe('session + repo 集成', () => {
  it('checkoutRepo 抛 no_repo → factory 仍建 session，repoAvailable=false', async () => {
    const session = await import('../src/pi/session.js');
    const repo = await import('../src/pi/repo.js');
    session.resetSessions();
    vi.spyOn(repo, 'checkoutRepo').mockRejectedValue(new repo.RepoUnavailableError('no_repo', 'no repo'));
    const factorySpy = vi.fn(async () => new FakeSession() as never);
    session.setSessionFactory((ctx) => factorySpy(ctx));
    const rec = await session.ensureRecord(requirementId);
    expect(rec.session).toBeTruthy();
    expect(factorySpy).toHaveBeenCalledOnce();
    const arg = factorySpy.mock.calls[0]![0] as { contextMode: string; repoAvailable: boolean; cwd: string | null };
    expect(arg.repoAvailable).toBe(false);
    expect(arg.cwd).toBeNull();
  });

  it('checkoutRepo 成功 → factory 收到 cwd + repoAvailable=true', async () => {
    const session = await import('../src/pi/session.js');
    const repo = await import('../src/pi/repo.js');
    session.resetSessions();
    const fakeCwd = '/tmp/fake-repo-checkout';
    vi.spyOn(repo, 'checkoutRepo').mockResolvedValue(fakeCwd);
    const factorySpy = vi.fn(async () => new FakeSession() as never);
    session.setSessionFactory((ctx) => factorySpy(ctx));
    await session.ensureRecord(requirementId);
    expect(factorySpy).toHaveBeenCalledOnce();
    const arg = factorySpy.mock.calls[0]![0] as { cwd?: string | null; repoAvailable: boolean };
    expect(arg.cwd).toBe(fakeCwd);
    expect(arg.repoAvailable).toBe(true);
  });
});
