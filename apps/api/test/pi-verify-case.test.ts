import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// executeCaseInBrowser / loginInContext 打桩：工具测试聚焦编排与结果组装。
vi.mock('../src/execute/cdp.js', () => ({ executeCaseInBrowser: vi.fn() }));
vi.mock('../src/pi/autoLogin.js', () => ({ loginInContext: vi.fn() }));
// LLM 模块桩：resolveLlmClient 缺省走 settings 表（测试库无 provider 配置会抛），先注入假 client。
vi.mock('../src/agent/llmSettings.js', () => ({
  resolveLlmClient: vi.fn(async () => ({
    config: { provider: 'anthropic', apiKey: 'fake', model: 'fake' },
    client: { provider: 'anthropic' as const, complete: async () => ({ kind: 'text' as const, value: '', provider: 'anthropic' as const, vision: false }) },
  })),
}));
vi.mock('playwright-core', () => ({
  chromium: {
    launch: async () => ({
      newContext: async () => ({ __fake: 'context' }),
      close: async () => {},
    }),
  },
}));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let projectId: string;
let groupId: string;
let versionId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
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
  vi.clearAllMocks();
  await pool.query(`TRUNCATE test_steps, test_cases, test_environments, environment_objects,
    requirements, "groups", projects, project_versions, ai_threads, ai_workspace_state
    RESTART IDENTITY CASCADE`);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  groupId = seed.groupId;
  versionId = seed.versionId;
  // 每个用例都要求环境可解析（resolveEnv 需要）：默认环境无 login 凭据
  await pool.query(
    `INSERT INTO test_environments(project_id, name, is_default, base_url) VALUES ($1, '默认环境', true, 'http://env.example')`,
    [projectId],
  );
});

async function seedCase(opts: { platform?: string; url?: string | null; steps?: unknown[] }): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO test_cases(id, group_id, version_id, title, url, platform) VALUES ($1, $2, $3, '验证用例', $4, $5)`,
    [id, groupId, versionId, opts.url ?? 'http://env.example/page', opts.platform ?? 'web'],
  );
  for (let i = 0; i < (opts.steps ?? []).length; i++) {
    await pool.query(
      `INSERT INTO test_steps(case_id, "order", source, compiled) VALUES ($1, $2, 'ai', $3::jsonb)`,
      [id, i + 1, JSON.stringify(opts.steps![i])],
    );
  }
  return id;
}

async function seedLoginObject(): Promise<void> {
  const { encrypt } = await import('../src/lib/secret-crypto.js');
  const enc = encrypt('Passw0rd!');
  // 先降级 beforeEach 插入的默认环境（唯一部分索引 test_environments_project_default_uq），再插新默认
  await pool.query(`UPDATE test_environments SET is_default = false WHERE project_id = $1`, [projectId]);
  const env = await pool.query(
    `INSERT INTO test_environments(project_id, name, is_default, base_url) VALUES ($1, '登录环境', true, 'http://env.example') RETURNING id`,
    [projectId],
  );
  const payload = {
    user: 'qa01',
    loginUrl: 'http://env.example/login',
    secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') },
  };
  await pool.query(
    `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES ($1, 'login', '默认', $2::jsonb, true)`,
    [env.rows[0]!.id, JSON.stringify(payload)],
  );
}

function toolCtx() {
  return { threadId: 't1', versionId, projectId, repo: { cwd: null, issue: null, noRepo: false }, emit: () => {} };
}

const CLICK_COMPILED = [{ kind: 'click', locator: [{ strategy: 'css', value: '#missing' }] }];

describe('verify_case 前置校验', () => {
  it('用例不存在 → ok:false', async () => {
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId: randomUUID() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('用例不存在');
  });

  it('移动端用例 → ok:false', async () => {
    const caseId = await seedCase({ platform: 'mobile', steps: CLICK_COMPILED });
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('移动端');
  });

  it('无步骤 → ok:false', async () => {
    const caseId = await seedCase({ steps: [] });
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('没有可验证的步骤');
  });
});

describe('verify_case 执行编排', () => {
  it('无 login 凭据：跳过登录直跑，全部通过 → result passed', async () => {
    const caseId = await seedCase({ steps: CLICK_COMPILED });
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    const { loginInContext } = await import('../src/pi/autoLogin.js');
    vi.mocked(executeCaseInBrowser).mockResolvedValue([
      { order: 1, status: 'passed', durationMs: 12, hitLocator: { kind: 'css', value: '#missing' } },
    ] as never);
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('passed');
      expect(data.login).toBe('not-needed');
      expect(data.steps).toHaveLength(1);
    }
    expect(loginInContext).not.toHaveBeenCalled();
    // 编排契约：verify- 前缀 reportId、expectedOutcome null、第 9 参为失败钩子
    const call = vi.mocked(executeCaseInBrowser).mock.calls[0]!;
    expect(call[2].reportId).toMatch(/^verify-/);
    expect(call[2].expectedOutcome).toBeNull();
    expect(call[5]).toBe('http://env.example/page');
    expect(call[8]).toBeTypeOf('function');
  });

  it('失败即停：failure 结构含失败动作/归因/失败页元素清单', async () => {
    const caseId = await seedCase({
      steps: [CLICK_COMPILED, [{ kind: 'assertText', locator: [{ strategy: 'css', value: '.msg' }], value: '成功' }]],
    });
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    vi.mocked(executeCaseInBrowser).mockImplementation(async (...args: unknown[]) => {
      // 模拟引擎：先触发失败钩子（携带失败页），再返回失败结果
      const onFailurePage = args[8] as (p: unknown, i: number) => Promise<void>;
      await onFailurePage(
        {
          url: () => 'http://env.example/list',
          evaluate: async () => ({ title: '列表页', elements: ['- button#del "删除" 选择器: #del'], truncated: false }),
        },
        1,
      );
      return [
        { order: 1, status: 'passed', durationMs: 10 },
        { order: 2, status: 'failed', durationMs: 5000, error: '元素未找到: .msg', failureReason: 'ElementNotFound', humanMessage: '未找到待断言元素', screenshot: '/screenshots/verify-x/step-2.png' },
      ] as never;
    });
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      expect(data.failure.stepOrder).toBe(2);
      expect(data.failure.action).toEqual([{ kind: 'assertText', locator: [{ strategy: 'css', value: '.msg' }], value: '成功' }]);
      expect(data.failure.failureReason).toBe('ElementNotFound');
      expect(data.failure.page.url).toBe('http://env.example/list');
      expect(data.failure.page.elements[0]).toContain('button#del');
      expect(typeof data.failure.note).toBe('string');
    }
  });

  it('配置 login 凭据：loginInContext 被调用(明文密码不出现在返回中) → logged-in', async () => {
    await seedLoginObject();
    const caseId = await seedCase({ steps: CLICK_COMPILED });
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    const { loginInContext } = await import('../src/pi/autoLogin.js');
    vi.mocked(loginInContext).mockResolvedValue('logged-in');
    vi.mocked(executeCaseInBrowser).mockResolvedValue([{ order: 1, status: 'passed', durationMs: 5 }] as never);
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const call = vi.mocked(loginInContext).mock.calls[0]!;
    expect(call[1]).toMatchObject({ user: 'qa01', password: 'Passw0rd!', loginUrl: 'http://env.example/login' });
    expect(call[2]).toBe('http://env.example/login');
    if (r.ok) expect(JSON.parse(r.data!).login).toBe('logged-in');
    if (r.ok) expect(r.data).not.toContain('Passw0rd!');
  });

  it('loginInContext 抛错 → ok:false 登录失败', async () => {
    await seedLoginObject();
    const caseId = await seedCase({ steps: CLICK_COMPILED });
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    const { loginInContext } = await import('../src/pi/autoLogin.js');
    vi.mocked(loginInContext).mockRejectedValue(new Error('自动填表登录失败（未找到用户名/密码输入框或提交后仍在登录页）'));
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('登录失败');
    expect(executeCaseInBrowser).not.toHaveBeenCalled();
  });
});

describe('verify_case 注册', () => {
  it('buildSpaceTools 包含 verify_case', async () => {
    const { buildSpaceTools } = await import('../src/pi/space/tools/index.js');
    const names = buildSpaceTools(toolCtx()).map((t) => t.name);
    expect(names).toContain('verify_case');
  });
});
