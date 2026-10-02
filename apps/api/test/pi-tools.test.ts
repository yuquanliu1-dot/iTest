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
});
