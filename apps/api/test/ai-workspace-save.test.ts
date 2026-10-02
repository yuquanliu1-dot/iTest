import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: exp } = await import('express');
  app = exp();
  app.use(exp.json());
  const { requirementsRoute } = await import('../src/routes/requirements.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use((req, _res, next) => { req.user = managerUserOf(userId, username, orgId, orgPath); next(); });
  app.use('/api/requirements', requirementsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_workspace_state, ai_scenarios, ai_cases, ai_threads, scenarios, test_cases, test_steps, requirements, "groups", projects RESTART IDENTITY CASCADE`);
});

describe('ai-thread + ai-workspace + save', () => {
  it('POST /:id/ai-thread is idempotent', async () => {
    const { projectId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    const a = await request(app).post(`/api/requirements/${rid}/ai-thread`).send({});
    const b = await request(app).post(`/api/requirements/${rid}/ai-thread`).send({});
    expect(a.status).toBe(200);
    expect(b.body.threadId).toBe(a.body.threadId);
  });

  it('POST /:id/ai-workspace/save persists scenarios + cases + steps', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, groupId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    await ws.upsertScenario(rid, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C1', description: 'd', priority: 'P0', steps: [
        { name: 'step1', action: 'do X', assertion: 'check Y' },
      ] },
    ] });
    const saved = await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId, scenarioIds: ['s1'], caseIds: ['c1'] });
    expect(saved.status).toBe(200);
    expect(saved.body.savedCases).toBe(1);
    const cases = await pool.query(`SELECT * FROM test_cases WHERE requirement_id = $1`, [rid]);
    expect(cases.rows[0]!.scenario_id).toBeTruthy();
    expect(cases.rows[0]!.priority).toBe('P0');
    const steps = await pool.query(`SELECT * FROM test_steps WHERE case_id = $1`, [cases.rows[0]!.id]);
    expect(steps.rows[0]!.source).toBe('agent');
    expect((steps.rows[0]!.action as { kind: string }).kind).toBe('aiStep');
    expect((steps.rows[0]!.assertion as { kind: string }).kind).toBe('assertText');
    const doc = await ws.loadDoc(rid);
    expect(doc.scenarios).toEqual([]);
  });

  it('POST /:id/ai-workspace/save expands multi-step instructions and compiles aiStep when LLM mock provided', async () => {
    const llmMod = await import('../src/agent/llmSettings.js');
    const mockClient = {
      provider: 'openai' as const,
      complete: async () => ({ kind: 'json' as const, value: { steps: [{ kind: 'navigate', url: 'http://localhost/login' }] }, provider: 'openai' as const, vision: false }),
    };
    llmMod.__setLlmClientForTest({ config: { provider: 'openai', apiKey: 'k', model: 'm' }, client: mockClient });
    try {
      const ws = await import('../src/pi/workspace.js');
      const { projectId, groupId } = await seedProject(pool);
      const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
      const rid = r.rows[0]!.id as string;
      // instruction 用编号列表触发 splitAiStepsInPlace；同时会经过 compileAiStep -> mock 返回 navigate。
      await ws.upsertScenario(rid, { id: 's1', title: 'S', description: null, cases: [
        { id: 'c1', title: 'C1', description: 'd', priority: 'P0', steps: [
          { name: 'multi', action: '1. 打开登录页\n2. 输入手机号', assertion: 'assert' },
        ] },
      ] });
      const saved = await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
        .send({ groupId, scenarioIds: ['s1'], caseIds: ['c1'] });
      expect(saved.status).toBe(200);
      const steps = await pool.query(
        `SELECT action FROM test_steps WHERE case_id = (SELECT id FROM test_cases WHERE requirement_id = $1 LIMIT 1) ORDER BY "order"`,
        [rid],
      );
      // 拆条 + 编译后应该至少 2 条；第一条 instruction 应是拆条后的子串，compiled 应被 mock 写入。
      expect(steps.rows.length).toBeGreaterThanOrEqual(2);
      const first = steps.rows[0]!.action as { kind: string; instruction: string; compiled: unknown };
      expect(first.kind).toBe('aiStep');
      expect(first.compiled).toEqual([{ kind: 'navigate', url: 'http://localhost/login' }]);
    } finally {
      llmMod.__setLlmClientForTest(null);
    }
  });

  it('save reuses scenario row by (requirementId, title)', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, groupId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    await ws.upsertScenario(rid, { id: 's1', title: 'Same', description: null, cases: [] });
    await ws.upsertScenario(rid, { id: 's2', title: 'Same', description: null, cases: [] });
    await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId, scenarioIds: ['s1','s2'], caseIds: [] });
    const c = await pool.query(`SELECT count(*)::int AS n FROM scenarios WHERE requirement_id = $1`, [rid]);
    expect(c.rows[0]!.n).toBe(1);
  });

  it('404 when group not in same project', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId } = await seedProject(pool);
    const other = await pool.query(`INSERT INTO projects(organization_id, name) SELECT organization_id, 'P2' FROM projects WHERE id = $1 RETURNING id`, [projectId]);
    const og = await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, 'G2') RETURNING id`, [other.rows[0]!.id]);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    await ws.upsertScenario(rid, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C', description: null, priority: 'P1', steps: [] },
    ] });
    const r2 = await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId: og.rows[0]!.id, scenarioIds: ['s1'], caseIds: ['c1'] });
    expect(r2.status).toBe(404);
  });

  it('loose caseIds do NOT pull in unselected-scenario cases (regression)', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, groupId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    // 一个场景 s1 含两个用例 c1, c2；再添一个散用例 c-loose。
    await ws.upsertScenario(rid, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C1', description: null, priority: 'P0', steps: [] },
      { id: 'c2', title: 'C2', description: null, priority: 'P1', steps: [] },
    ] });
    await ws.upsertCase(rid, null, { id: 'c-loose', title: 'Loose', description: null, priority: 'P2', steps: [] });
    // 只勾选 s1 + 显式勾选 c-loose。预期：c1, c2, c-loose 都被保存（场景全选 + 显式 loose）。
    const ok = await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId, scenarioIds: ['s1'], caseIds: ['c-loose'] });
    expect(ok.status).toBe(200);
    expect(ok.body.savedCases).toBe(3);

    // 关键反向验证：仅勾选散用例 c-loose，s1 未选，预期只保存 c-loose 这一个。
    const ws2 = await import('../src/pi/workspace.js');
    const { projectId: pid2, groupId: gid2 } = await seedProject(pool);
    const r2 = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r2','c',$1) RETURNING id`, [pid2]);
    const rid2 = r2.rows[0]!.id as string;
    await ws2.upsertScenario(rid2, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C1', description: null, priority: 'P0', steps: [] },
      { id: 'c2', title: 'C2', description: null, priority: 'P1', steps: [] },
    ] });
    await ws2.upsertCase(rid2, null, { id: 'c-loose', title: 'Loose', description: null, priority: 'P2', steps: [] });
    const onlyLoose = await request(app).post(`/api/requirements/${rid2}/ai-workspace/save`)
      .send({ groupId: gid2, scenarioIds: [], caseIds: ['c-loose'] });
    expect(onlyLoose.status).toBe(200);
    expect(onlyLoose.body.savedCases).toBe(1);
    const cases = await pool.query(`SELECT title FROM test_cases WHERE requirement_id = $1 ORDER BY title`, [rid2]);
    expect(cases.rows.map((row) => row.title)).toEqual(['Loose']);
  });

  it('explicit caseId under unselected scenario saves only that case (partial selection)', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, groupId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    await ws.upsertScenario(rid, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C1', description: null, priority: 'P0', steps: [] },
      { id: 'c2', title: 'C2', description: null, priority: 'P1', steps: [] },
    ] });
    // 场景 s1 未勾选，只显式勾选 c1：预期只保存 C1，且挂到场景行 S 下
    const saved = await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId, scenarioIds: [], caseIds: ['c1'] });
    expect(saved.status).toBe(200);
    expect(saved.body.savedCases).toBe(1);
    const rows = await pool.query(`SELECT tc.title, sc.title AS scenario_title FROM test_cases tc LEFT JOIN scenarios sc ON sc.id = tc.scenario_id WHERE tc.requirement_id = $1`, [rid]);
    expect(rows.rows.map((row) => row.title)).toEqual(['C1']);
    expect(rows.rows[0]!.scenario_title).toBe('S');
  });
});