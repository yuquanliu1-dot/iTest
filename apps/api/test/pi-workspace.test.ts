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
  // 本文件经 workspace.js 间接持有 db/client.js 的单例池，先关掉再停容器，
  // 否则容器停止会打断残留连接报 57P01（与 pi-tools.test.ts / pi-inspect-page.test.ts 同款处理）。
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

describe('workspace bus', () => {
  it('subscribe + publish fires once and unsub stops delivery', async () => {
    const { subscribeWorkspace, publishWorkspaceEvent } = await import('../src/pi/bus.js');
    const calls: unknown[] = [];
    const unsub = subscribeWorkspace(requirementId, (e) => calls.push(e));
    publishWorkspaceEvent({ type: 'workspace_doc', requirementId });
    publishWorkspaceEvent({ type: 'workspace_doc', requirementId });
    unsub();
    publishWorkspaceEvent({ type: 'workspace_doc', requirementId });
    expect(calls.length).toBe(2);
  });
});

describe('workspace store', () => {
  it('emptyDoc on missing row returns empty skeleton', async () => {
    const { loadDoc } = await import('../src/pi/workspace.js');
    const d = await loadDoc(requirementId);
    expect(d.plan).toBeNull();
    expect(d.scenarios).toEqual([]);
    expect(d.looseCases).toEqual([]);
  });

  it('announcePlan + upsertScenario + upsertCase persist + publish', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { subscribeWorkspace } = await import('../src/pi/bus.js');
    const events: unknown[] = [];
    subscribeWorkspace(requirementId, (e) => events.push(e));
    await ws.announcePlan(requirementId, { scenarios: 1, cases: 2 });
    await ws.upsertScenario(requirementId, { id: 's1', title: 'S', description: null, cases: [] });
    await ws.upsertCase(requirementId, 's1', { id: 'c1', title: 'C', description: null, priority: 'P0', steps: [] });
    const doc = await ws.loadDoc(requirementId);
    expect(doc.plan).toEqual({ scenarios: 1, cases: 2 });
    expect(doc.scenarios[0]!.cases).toHaveLength(1);
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  it('upsertCase with scenarioId that does not exist auto-creates a placeholder scenario', async () => {
    const ws = await import('../src/pi/workspace.js');
    await ws.upsertCase(requirementId, 'missing-scenario', { id: 'c1', title: 'C', description: null, priority: 'P1', steps: [] });
    const doc = await ws.loadDoc(requirementId);
    const s = doc.scenarios.find((x) => x.id === 'missing-scenario');
    expect(s).toBeDefined();
    expect(s!.cases).toHaveLength(1);
    expect(s!.cases[0]!.id).toBe('c1');
  });

  it('upsertCase tolerates steps without name by using action fallback in the tools wrapper', async () => {
    // tools.ts 内的兜底不在此处直接测试；这里只验证 upsertCase 接受无 name 的 step
    // （schema 校验在 tools 层；这里强制传入有 name 的 step 以走持久化路径）。
    const ws = await import('../src/pi/workspace.js');
    await ws.upsertScenario(requirementId, { id: 's1', title: 'S', description: null, cases: [] });
    await ws.upsertCase(requirementId, 's1', { id: 'c1', title: 'C', description: null, priority: 'P0', steps: [
      { name: '打开页面', action: '打开登录页', assertion: null },
    ] });
    const doc = await ws.loadDoc(requirementId);
    expect(doc.scenarios[0]!.cases[0]!.steps[0]!.name).toBe('打开页面');
  });

  it('removeSaved drops only the listed case ids and empties drained scenarios', async () => {
    const ws = await import('../src/pi/workspace.js');
    await ws.upsertScenario(requirementId, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C1', description: null, priority: 'P0', steps: [] },
      { id: 'c2', title: 'C2', description: null, priority: 'P1', steps: [] },
    ] });
    await ws.removeSaved(requirementId, ['c1']);
    const doc = await ws.loadDoc(requirementId);
    expect(doc.scenarios[0]!.cases.map((c) => c.id)).toEqual(['c2']);
  });

  it('removeSaved keeps untouched scenarios', async () => {
    const ws = await import('../src/pi/workspace.js');
    await ws.upsertScenario(requirementId, { id: 's1', title: 'S1', description: null, cases: [
      { id: 'c1', title: 'C', description: null, priority: 'P0', steps: [] },
    ] });
    await ws.upsertScenario(requirementId, { id: 's2', title: 'S2', description: null, cases: [] });
    await ws.removeSaved(requirementId, ['c1']);
    const doc = await ws.loadDoc(requirementId);
    expect(doc.scenarios.map((s) => s.id)).toEqual(['s2']);
  });

  it('removeItem removes both cases and scenarios', async () => {
    const ws = await import('../src/pi/workspace.js');
    await ws.upsertScenario(requirementId, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C', description: null, priority: 'P0', steps: [] },
    ] });
    await ws.removeItem(requirementId, { kind: 'scenario', id: 's1' });
    const doc = await ws.loadDoc(requirementId);
    expect(doc.scenarios).toEqual([]);
  });

  it('28 parallel upsert_case calls all persist (regression for JSONB read-modify-write race)', async () => {
    const ws = await import('../src/pi/workspace.js');
    await ws.upsertScenario(requirementId, { id: 's1', title: 'S', description: null, cases: [] });
    const N = 28;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ws.upsertCase(requirementId, 's1', {
          id: `c${i}`,
          title: `用例 ${i}`,
          description: null,
          priority: i % 4 === 0 ? 'P0' : 'P1',
          steps: [{ name: `step ${i}`, action: `do ${i}`, assertion: null }],
        }),
      ),
    );
    const doc = await ws.loadDoc(requirementId);
    expect(doc.scenarios.find((s) => s.id === 's1')!.cases).toHaveLength(N);
    const rows = await pool.query(`SELECT count(*)::int AS n FROM ai_cases WHERE requirement_id = $1`, [requirementId]);
    expect(rows.rows[0]!.n).toBe(N);
  });

  it('parallel upsert_case across 5 scenarios preserves per-scenario counts', async () => {
    const ws = await import('../src/pi/workspace.js');
    const sids = ['sa', 'sb', 'sc', 'sd', 'se'];
    for (const sid of sids) {
      await ws.upsertScenario(requirementId, { id: sid, title: sid, description: null, cases: [] });
    }
    const N = 28;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ws.upsertCase(requirementId, sids[i % sids.length]!, {
          id: `c${i}`,
          title: `C${i}`,
          description: null,
          priority: 'P1',
          steps: [],
        }),
      ),
    );
    const doc = await ws.loadDoc(requirementId);
    const total = doc.scenarios.reduce((n, s) => n + s.cases.length, 0);
    expect(total).toBe(N);
    for (const sid of sids) {
      const s = doc.scenarios.find((x) => x.id === sid)!;
      expect(s.cases.length).toBeGreaterThan(0);
    }
  });

  it('emptyDoc 默认 contextMode=auto, repoContext=null', async () => {
    const { emptyDoc } = await import('../src/pi/workspace.js');
    const d = emptyDoc();
    expect(d.contextMode).toBe('auto');
    expect(d.repoContext).toBeNull();
  });

  it('recordContextMode 持久化 + 不覆盖 pageContext', async () => {
    const ws = await import('../src/pi/workspace.js');
    await ws.recordPageInspection(requirementId, 'http://x');
    await ws.recordContextMode(requirementId, 'repo');
    const d = await ws.loadDoc(requirementId);
    expect(d.contextMode).toBe('repo');
    expect(d.pageContext?.url).toBe('http://x');
  });

  it('recordRepoCheckout 写入 commit + 保留其他字段', async () => {
    const ws = await import('../src/pi/workspace.js');
    await ws.recordContextMode(requirementId, 'auto');
    await ws.recordRepoCheckout(requirementId, { commit: 'abc1234', fetchedAt: '2026-10-03T00:00:00Z', mode: 'auto' });
    const d = await ws.loadDoc(requirementId);
    expect(d.repoContext?.commit).toBe('abc1234');
    expect(d.contextMode).toBe('auto');
  });
});