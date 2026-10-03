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
  // 否则容器停止会打断残留连接报 57P01（与 pi-inspect-page.test.ts 同款处理）。
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

describe('workspace tools wrapper (upsert_case)', () => {
  it('steps.name 缺省时回退到 action 首句', async () => {
    const { buildWorkspaceTools } = await import('../src/pi/tools.js');
    const tools = buildWorkspaceTools(requirementId);
    const upsert = tools.find((t) => t.name === 'upsert_case')!;
    // 第一步 name 缺省，第二步有 name（验证向后兼容）
    const r = await upsert.execute({
      id: 'c1', title: '用例1', description: null, priority: 'P0', scenarioId: null,
      steps: [
        { action: '打开登录页面, 等待 2 秒', assertion: null },
        { name: '提交', action: '点击登录按钮', assertion: '欢迎' },
      ],
    });
    expect(r.ok).toBe(true);
    const { loadDoc } = await import('../src/pi/workspace.js');
    const doc = await loadDoc(requirementId);
    expect(doc.looseCases[0]!.steps[0]!.name).toBe('打开登录页面');
    expect(doc.looseCases[0]!.steps[1]!.name).toBe('提交');
  });

  it('scenarioId 指向未声明场景时自动建占位场景，不再抛错', async () => {
    const { buildWorkspaceTools } = await import('../src/pi/tools.js');
    const tools = buildWorkspaceTools(requirementId);
    const upsert = tools.find((t) => t.name === 'upsert_case')!;
    const r = await upsert.execute({
      id: 'c1', title: '用例', description: null, priority: 'P1', scenarioId: 'phantom',
      steps: [{ name: 'n', action: 'a', assertion: null }],
    });
    expect(r.ok).toBe(true);
    const { loadDoc } = await import('../src/pi/workspace.js');
    const doc = await loadDoc(requirementId);
    const s = doc.scenarios.find((x) => x.id === 'phantom');
    expect(s).toBeDefined();
    expect(s!.cases).toHaveLength(1);
  });

  it('upsert_case 可省略 description/priority/scenarioId/assertion，执行器兜底默认值（A：消除整批验证拒绝）', async () => {
    const { buildWorkspaceTools } = await import('../src/pi/tools.js');
    const tools = buildWorkspaceTools(requirementId);
    const upsert = tools.find((t) => t.name === 'upsert_case')!;

    // 2026-10-02 实测 LLM 首轮只传 id/title/steps：schema 必填把整批调用拒掉，
    // 迫使模型重试多耗一轮（15.8s）。这些字段必须不在 TypeBox required 里。
    const schema = upsert.parameters as { required?: string[]; properties: Record<string, { items?: { required?: string[] } } > };
    expect(schema.required).not.toContain('description');
    expect(schema.required).not.toContain('priority');
    expect(schema.required).not.toContain('scenarioId');
    expect(schema.properties.steps!.items!.required).not.toContain('assertion');

    // 执行器兜底：priority→P2、description→null、scenarioId→null（散用例）、assertion→null
    const r = await upsert.execute({
      id: 'c-loose', title: '散用例', steps: [{ action: '打开页面' }],
    });
    expect(r.ok).toBe(true);
    const { loadDoc } = await import('../src/pi/workspace.js');
    const doc = await loadDoc(requirementId);
    const c = doc.looseCases[0]!;
    expect(c.priority).toBe('P2');
    expect(c.description).toBeNull();
    expect(c.steps[0]!.assertion).toBeNull();
  });

  // 2026-10-02 第二轮实测：LLM 把"放弃"写成空数组 [] 会被回放视作"什么都不做"，
  // 隐藏失败；必须归一化为 null（短路不再重试）。同样兜底 locator 形状异常：
  // LLM 偶尔写成 {item:{strategy,value}} 单对象外壳或直接给单元素对象。
  // 2026-10-02 第三轮实测：LLM 进一步把每个候选多包一层数组（[[{...}]]），
  // 应剥到只剩 [{...},{...}]。
  it('upsert_case 防御性归一化：空数组→null、{item:{...}}→[{...}]、{strategy,value}→[{strategy,value}]、[[{...}]]→[{...}]', async () => {
    const { buildWorkspaceTools } = await import('../src/pi/tools.js');
    const tools = buildWorkspaceTools(requirementId);
    const upsert = tools.find((t) => t.name === 'upsert_case')!;
    await upsert.execute({
      id: 'c-shape', title: '形状测试', priority: 'P1',
      steps: [
        // 1. 空数组 → null
        { name: '空数组放弃', action: '看不太清的验证码', compiled: [] },
        // 2. {item:{...}} → [{...}]
        { name: 'item外壳', action: '点击登录',
          compiled: [{ kind: 'click', locator: { item: { strategy: 'css', value: "button[type='submit']" } } }] },
        // 3. {strategy,value} → [{strategy,value}]
        { name: '单对象locator', action: '填用户名',
          compiled: [{ kind: 'fill', value: 'admin', locator: { strategy: 'css', value: "input[name='username']" } }] },
        // 4. 双层嵌套 [[{...},{...}]] → [{...},{...}]
        { name: '双层嵌套', action: '填密码',
          compiled: [{ kind: 'fill', value: 'admin123',
            locator: [[{ strategy: 'css', value: "input[name='password']" }, { strategy: 'css', value: "input[type='password']" }]] }] },
        // 5. 正常数组（对照）
        { name: '正常数组', action: '访问登录页',
          compiled: [{ kind: 'navigate', url: 'http://192.168.30.228:8088/static/login.html' }] },
        // 6. 显式 null 透传
        { name: '显式null', action: '模糊指令', compiled: null },
      ],
    });
    const { loadDoc } = await import('../src/pi/workspace.js');
    const doc = await loadDoc(requirementId);
    const steps = doc.looseCases[0]!.steps;
    expect(steps[0]!.compiled).toBeNull();                      // 空数组 → null
    expect(steps[1]!.compiled).toEqual([                          // {item:{...}} → [{...}]
      { kind: 'click', locator: [{ strategy: 'css', value: "button[type='submit']" }] },
    ]);
    expect(steps[2]!.compiled).toEqual([                          // {strategy,value} → [{...}]
      { kind: 'fill', value: 'admin', locator: [{ strategy: 'css', value: "input[name='username']" }] },
    ]);
    expect(steps[3]!.compiled).toEqual([                          // [[{...}]] → [{...},{...}]
      { kind: 'fill', value: 'admin123',
        locator: [{ strategy: 'css', value: "input[name='password']" }, { strategy: 'css', value: "input[type='password']" }] },
    ]);
    expect(steps[4]!.compiled).toEqual([                          // 正常数组保持
      { kind: 'navigate', url: 'http://192.168.30.228:8088/static/login.html' },
    ]);
    expect(steps[5]!.compiled).toBeNull();                       // 显式 null 透传
  });
});
