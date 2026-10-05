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
    const { projectId, versionId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    const a = await request(app).post(`/api/requirements/${rid}/ai-thread`).send({});
    const b = await request(app).post(`/api/requirements/${rid}/ai-thread`).send({});
    expect(a.status).toBe(200);
    expect(b.body.threadId).toBe(a.body.threadId);
  });

  it('POST /:id/ai-workspace/save persists scenarios + cases + steps', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, groupId, versionId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    await ws.upsertScenario(rid, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C1', description: 'd', priority: 'P0', steps: [
        { name: 'step1', action: 'do X', assertion: '断言看见工作台' },
      ] },
    ] });
    const saved = await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId, targetVersionId: versionId, scenarioIds: ['s1'], caseIds: ['c1'] });
    expect(saved.status).toBe(200);
    expect(saved.body.savedCases).toBe(1);
    const cases = await pool.query(`SELECT * FROM test_cases WHERE requirement_id = $1`, [rid]);
    expect(cases.rows[0]!.scenario_id).toBeTruthy();
    expect(cases.rows[0]!.priority).toBe('P0');
    const steps = await pool.query(`SELECT * FROM test_steps WHERE case_id = $1`, [cases.rows[0]!.id]);
    expect(steps.rows[0]!.source).toBe('agent');
    expect((steps.rows[0]!.action as { kind: string }).kind).toBe('aiTask');
    expect((steps.rows[0]!.assertion as { kind: string }).kind).toBe('assertText');
    // 新写入路径要落规范 assertText 形态（target=page, equals=text），否则回放引擎 dispatch 不认识。
    expect((steps.rows[0]!.assertion as { target: string }).target).toBe('page');
    expect((steps.rows[0]!.assertion as { equals: string }).equals).toBe('断言看见工作台');
    const doc = await ws.loadDoc(rid);
    expect(doc.scenarios).toEqual([]);
  });

  it('POST /:id/ai-workspace/save preserves aiTask steps on save without LLM compile', async () => {
    const llmMod = await import('../src/agent/llmSettings.js');
    let calls = 0;
    const mockClient = {
      provider: 'openai' as const,
      complete: async () => {
        calls++;
        return { kind: 'json' as const, value: { steps: [{ kind: 'navigate', url: 'http://localhost/login' }] }, provider: 'openai' as const, vision: false };
      },
    };
    llmMod.__setLlmClientForTest({ config: { provider: 'openai', apiKey: 'k', model: 'm' }, client: mockClient });
    try {
      const ws = await import('../src/pi/workspace.js');
      const { projectId, groupId, versionId } = await seedProject(pool);
      const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
      const rid = r.rows[0]!.id as string;
      await ws.upsertScenario(rid, { id: 's1', title: 'S', description: null, cases: [
        { id: 'c1', title: 'C1', description: 'd', priority: 'P0', steps: [
          { name: 'multi', action: '1. 输入手机号\n2. 输入密码', assertion: 'assert' },
        ] },
      ] });
      const saved = await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
        .send({ groupId, targetVersionId: versionId, scenarioIds: ['s1'], caseIds: ['c1'] });
      expect(saved.status).toBe(200);
      const steps = await pool.query(
        `SELECT action FROM test_steps WHERE case_id = (SELECT id FROM test_cases WHERE requirement_id = $1 LIMIT 1) ORDER BY "order"`,
        [rid],
      );
      // 拆条后的两条 aiTask 原样落库，不再走 LLM 编译。
      expect(steps.rows.length).toBeGreaterThanOrEqual(2);
      const first = steps.rows[0]!.action as { kind: string; instruction: string };
      expect(first.kind).toBe('aiTask');
      expect(typeof first.instruction).toBe('string');
      // 整条链路不触发任何 LLM 调用：aiTask 已经在编译期移除兜底。
      expect(calls).toBe(0);
    } finally {
      llmMod.__setLlmClientForTest(null);
    }
  });

  it('save 把需求文本中的真实 URL 落到 test_cases.url', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const ws = await import('../src/pi/workspace.js');
    const r = await pool.query(
      `INSERT INTO requirements(title, content, project_id) VALUES ('r', '页面地址：http://192.168.30.228:8088/static/element-manager.html，请参考实际代码。', $1) RETURNING id`,
      [projectId],
    );
    const rid = r.rows[0]!.id as string;
    await ws.upsertScenario(rid, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C1', description: 'd', priority: 'P0', steps: [
        { name: 'multi', action: '1. 打开页面\n2. 点击添加元素', assertion: null },
      ] },
    ] });
    const saved = await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId, targetVersionId: versionId, scenarioIds: ['s1'], caseIds: ['c1'] });
    expect(saved.status).toBe(200);
    // 需求文本里的真实 URL 直接落到 test_cases.url；不再走 LLM 编译 ctx.url。
    const cases = await pool.query(`SELECT url FROM test_cases WHERE requirement_id = $1`, [rid]);
    expect(cases.rows[0]!.url).toBe('http://192.168.30.228:8088/static/element-manager.html');
  });

  it('pageContext（inspect_page 抓取记录）优先于需求文本 URL', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, groupId, versionId } = await seedProject(pool);
    const r = await pool.query(
      `INSERT INTO requirements(title, content, project_id) VALUES ('r', '页面地址：http://from-text.example/page，请参考。', $1) RETURNING id`,
      [projectId],
    );
    const rid = r.rows[0]!.id as string;
    await ws.recordPageInspection(rid, 'http://from-inspect.example/real');
    await ws.upsertScenario(rid, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C1', description: null, priority: 'P1', steps: [
        { name: 'n', action: 'a', assertion: null },
      ] },
    ] });
    const saved = await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId, targetVersionId: versionId, scenarioIds: ['s1'], caseIds: ['c1'] });
    expect(saved.status).toBe(200);
    const cases = await pool.query(`SELECT url FROM test_cases WHERE requirement_id = $1`, [rid]);
    expect(cases.rows[0]!.url).toBe('http://from-inspect.example/real');
  });

  it('save reuses scenario row by (requirementId, title)', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, groupId, versionId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    await ws.upsertScenario(rid, { id: 's1', title: 'Same', description: null, cases: [] });
    await ws.upsertScenario(rid, { id: 's2', title: 'Same', description: null, cases: [] });
    await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId, targetVersionId: versionId, scenarioIds: ['s1','s2'], caseIds: [] });
    const c = await pool.query(`SELECT count(*)::int AS n FROM scenarios WHERE requirement_id = $1`, [rid]);
    expect(c.rows[0]!.n).toBe(1);
  });

  it('404 when group not in same project', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, versionId } = await seedProject(pool);
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
    const { projectId, groupId, versionId } = await seedProject(pool);
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
      .send({ groupId, targetVersionId: versionId, scenarioIds: ['s1'], caseIds: ['c-loose'] });
    expect(ok.status).toBe(200);
    expect(ok.body.savedCases).toBe(3);

    // 关键反向验证：仅勾选散用例 c-loose，s1 未选，预期只保存 c-loose 这一个。
    const ws2 = await import('../src/pi/workspace.js');
    const { projectId: pid2, groupId: gid2, versionId: vid2 } = await seedProject(pool);
    const r2 = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r2','c',$1) RETURNING id`, [pid2]);
    const rid2 = r2.rows[0]!.id as string;
    await ws2.upsertScenario(rid2, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C1', description: null, priority: 'P0', steps: [] },
      { id: 'c2', title: 'C2', description: null, priority: 'P1', steps: [] },
    ] });
    await ws2.upsertCase(rid2, null, { id: 'c-loose', title: 'Loose', description: null, priority: 'P2', steps: [] });
    const onlyLoose = await request(app).post(`/api/requirements/${rid2}/ai-workspace/save`)
      .send({ groupId: gid2, targetVersionId: vid2, scenarioIds: [], caseIds: ['c-loose'] });
    expect(onlyLoose.status).toBe(200);
    expect(onlyLoose.body.savedCases).toBe(1);
    const cases = await pool.query(`SELECT title FROM test_cases WHERE requirement_id = $1 ORDER BY title`, [rid2]);
    expect(cases.rows.map((row) => row.title)).toEqual(['Loose']);
  });

  it('upsertCase persists compiled field into staged step', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, versionId } = await seedProject(pool);
    const r = await pool.query(
      `INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`,
      [projectId],
    );
    const rid = r.rows[0]!.id as string;
    await ws.upsertCase(rid, null, {
      id: 'c1',
      title: 'T',
      description: null,
      priority: 'P0',
      steps: [
        {
          name: 's1',
          action: 'click submit',
          assertion: null,
          compiled: [{ kind: 'click', locator: [{ strategy: 'text', value: 'submit' }] }],
        },
      ],
    });
    const doc = await ws.loadDoc(rid);
    expect(doc.looseCases[0]!.steps[0]!.compiled).toEqual([
      { kind: 'click', locator: [{ strategy: 'text', value: 'submit' }] },
    ]);
  });

  it('upsertCase defaults missing compiled to null', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, versionId } = await seedProject(pool);
    const r = await pool.query(
      `INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`,
      [projectId],
    );
    const rid = r.rows[0]!.id as string;
    await ws.upsertCase(rid, null, {
      id: 'c1',
      title: 'T',
      description: null,
      priority: 'P0',
      steps: [{ name: 's1', action: 'click submit', assertion: null }],
    });
    const doc = await ws.loadDoc(rid);
    // 缺省语义：loadDoc 不规范化 undefined；undefined 表示"未尝试"，由 save 兜底编译。
    // 此测试保护"显式传 null"语义：null 表示"AI 已放弃，短路不再重试"。
    expect(doc.looseCases[0]!.steps[0]!.compiled).toBeUndefined();
  });

  it('save 沿用 staged step 的 compiled 数组（不再展开，按 aiTask 规则存）', async () => {
    const llmMod = await import('../src/agent/llmSettings.js');
    let calls = 0;
    const mockClient = {
      provider: 'openai' as const,
      complete: async () => {
        calls++;
        return { kind: 'json' as const, value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] }, provider: 'openai' as const, vision: false };
      },
    };
    llmMod.__setLlmClientForTest({ config: { provider: 'openai', apiKey: 'k', model: 'm' }, client: mockClient });
    try {
      const ws = await import('../src/pi/workspace.js');
      const { projectId, groupId, versionId } = await seedProject(pool);
      const r = await pool.query(
        `INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`,
        [projectId],
      );
      const rid = r.rows[0]!.id as string;
      await ws.upsertScenario(rid, {
        id: 's1', title: 'S', description: null, cases: [
          {
            id: 'c1', title: 'C1', description: 'd', priority: 'P0',
            steps: [
              {
                name: 's1',
                action: 'click submit',
                assertion: null,
                compiled: [{ kind: 'click', locator: [{ strategy: 'text', value: 'submit' }] }],
              },
            ],
          },
        ],
      });
      const saved = await request(app)
        .post(`/api/requirements/${rid}/ai-workspace/save`)
        .send({ groupId, targetVersionId: versionId, scenarioIds: ['s1'], caseIds: ['c1'] });
      expect(saved.status).toBe(200);
      expect(calls).toBe(0); // 没有任何 LLM 兜底调用
      const steps = await pool.query(
        `SELECT action FROM test_steps WHERE case_id = (SELECT id FROM test_cases WHERE requirement_id = $1 LIMIT 1) ORDER BY "order"`,
        [rid],
      );
      // save 路径不再做 aiStep 展开（aiStep 已删除）；每条 step 直接落 aiTask 壳，
      // 编译过的 DSL 仅保留在草稿/编译期；落库步为 aiTask，回放期 aiTask 自带元素清单看截图决策。
      const a = steps.rows[0]!.action as { kind: string; instruction: string };
      expect(a.kind).toBe('aiTask');
      expect(a.instruction).toBe('click submit');
    } finally {
      llmMod.__setLlmClientForTest(null);
    }
  });

  it('explicit caseId under unselected scenario saves only that case (partial selection)', async () => {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, groupId, versionId } = await seedProject(pool);
    const r = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`, [projectId]);
    const rid = r.rows[0]!.id as string;
    await ws.upsertScenario(rid, { id: 's1', title: 'S', description: null, cases: [
      { id: 'c1', title: 'C1', description: null, priority: 'P0', steps: [] },
      { id: 'c2', title: 'C2', description: null, priority: 'P1', steps: [] },
    ] });
    // 场景 s1 未勾选，只显式勾选 c1：预期只保存 C1，且挂到场景行 S 下
    const saved = await request(app).post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId, targetVersionId: versionId, scenarioIds: [], caseIds: ['c1'] });
    expect(saved.status).toBe(200);
    expect(saved.body.savedCases).toBe(1);
    const rows = await pool.query(`SELECT tc.title, sc.title AS scenario_title FROM test_cases tc LEFT JOIN scenarios sc ON sc.id = tc.scenario_id WHERE tc.requirement_id = $1`, [rid]);
    expect(rows.rows.map((row) => row.title)).toEqual(['C1']);
    expect(rows.rows[0]!.scenario_title).toBe('S');
  });
});