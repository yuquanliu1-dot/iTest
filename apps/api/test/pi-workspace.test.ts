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

  it('upsertCase with scenarioId that does not exist throws', async () => {
    const ws = await import('../src/pi/workspace.js');
    await expect(
      ws.upsertCase(requirementId, 'missing-scenario', { id: 'c1', title: 'C', description: null, priority: 'P1', steps: [] }),
    ).rejects.toThrow(/not found; call upsert_scenario first/);
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
});