import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// 全 AI 驱动编排测试：runAiTask / writeStepScreenshot / extractPageElements 打桩，聚焦 verify_case 编排契约。
vi.mock('../src/execute/aiTask.js', () => ({ runAiTask: vi.fn() }));
vi.mock('../src/execute/cdp.js', () => ({ writeStepScreenshot: vi.fn(async () => '/screenshots/verify-x/step-1.png') }));
vi.mock('../src/pi/inspectPage.js', () => ({
  extractPageElements: vi.fn(async () => ({
    title: '失败页',
    url: 'http://env.example/page',
    elements: ['- button#del "删除" 选择器: #del'],
    truncated: false,
  })),
}));
// LLM 模块桩：resolveLlmClient 缺省走 settings 表（测试库无 provider 配置会抛），先注入假 client。
vi.mock('../src/agent/llmSettings.js', () => ({
  resolveLlmClient: vi.fn(async () => ({
    config: { provider: 'anthropic', apiKey: 'fake', model: 'fake' },
    client: { provider: 'anthropic' as const, complete: async () => ({ kind: 'text' as const, value: '', provider: 'anthropic' as const, vision: false }) },
  })),
}));
// playwright 桩：launch → context.newPage 返回极简 page；gotos 记录初始导航（经 __testState 暴露给测试）。
vi.mock('playwright-core', () => {
  const state = { gotos: [] as string[] };
  return {
    chromium: {
      launch: vi.fn(async () => ({
        newContext: async () => ({
          newPage: async () => ({
            url: () => 'http://env.example/page',
            goto: async (u: string) => { state.gotos.push(u); },
            waitForLoadState: async () => {},
            waitForTimeout: async () => {},
            close: async () => {},
          }),
          close: async () => {},
        }),
        close: async () => {},
      })),
    },
    __testState: state,
  };
});

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
  const { __testState } = (await import('playwright-core')) as unknown as { __testState: { gotos: string[] } };
  __testState.gotos.length = 0;
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

async function seedCase(opts: {
  platform?: string;
  url?: string | null;
  steps?: unknown[];
  /** 仅对第 1 步标记 sensitive 并注入密文（明文 StepSecret!9） */
  sensitiveStep1?: boolean;
  /** sensitive=true 但不注入密文（secret-missing 场景） */
  sensitiveNoSecret?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO test_cases(id, group_id, version_id, title, url, platform) VALUES ($1, $2, $3, '验证用例', $4, $5)`,
    [id, groupId, versionId, opts.url ?? 'http://env.example/page', opts.platform ?? 'web'],
  );
  for (let i = 0; i < (opts.steps ?? []).length; i++) {
    await pool.query(
      `INSERT INTO test_steps(case_id, "order", source, compiled, instruction) VALUES ($1, $2, 'ai', $3::jsonb, $4)`,
      [id, i + 1, JSON.stringify(opts.steps![i]), i === 0 ? '第一步：点击删除按钮' : null],
    );
  }
  if (opts.sensitiveStep1 || opts.sensitiveNoSecret) {
    if (opts.sensitiveStep1) {
      const { encrypt } = await import('../src/lib/secret-crypto.js');
      const enc = encrypt('StepSecret!9');
      await pool.query(
        `UPDATE test_steps SET sensitive = true, secret_ciphertext = $2, secret_iv = $3, secret_tag = $4
         WHERE case_id = $1 AND "order" = 1`,
        [id, enc.ciphertext.toString('base64'), enc.iv.toString('base64'), enc.tag.toString('base64')],
      );
    } else {
      await pool.query(`UPDATE test_steps SET sensitive = true WHERE case_id = $1 AND "order" = 1`, [id]);
    }
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

function toolCtx(emitLog?: unknown[]) {
  return {
    threadId: 't1',
    versionId,
    projectId,
    repo: { cwd: null, issue: null, noRepo: false },
    emit: (e: unknown) => emitLog?.push(e),
  };
}

const CLICK_COMPILED = [{ kind: 'click', locator: [{ strategy: 'css', value: '#missing' }] }];

/** 读取 playwright 桩记录的初始导航 */
async function fakeGotos(): Promise<string[]> {
  const { __testState } = (await import('playwright-core')) as unknown as { __testState: { gotos: string[] } };
  return __testState.gotos;
}

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

  it('LLM 未配置 → ok:false，不启动浏览器', async () => {
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    vi.mocked(resolveLlmClient).mockRejectedValueOnce(new Error('未配置 provider'));
    const caseId = await seedCase({ steps: CLICK_COMPILED });
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('LLM 未配置');
    const { chromium } = await import('playwright-core');
    expect(chromium.launch).not.toHaveBeenCalled();
  });
});

describe('verify_case 逐步 AI 执行编排', () => {
  it('无 login 凭据：每步一次 runAiTask（maxTurns=5、初始 goto）全通过 → result passed', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED, CLICK_COMPILED] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"完成","login":"not-needed"}');
    const emitLog: unknown[] = [];
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx(emitLog)).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('passed');
      expect(data.login).toBe('not-needed');
      expect(data.steps).toHaveLength(2);
      expect(data.steps[0].screenshot).toContain('/screenshots/verify-');
    }
    // 每步一次 runAiTask；instruction 含 compiled 与步骤序号
    expect(runAiTask).toHaveBeenCalledTimes(2);
    const call = vi.mocked(runAiTask).mock.calls[0]!;
    expect(String(call[1])).toContain('#missing');
    expect(String(call[1])).toContain('第 1 步 / 共 2 步');
    expect(String(call[1])).not.toContain('__ITEST_USERNAME__'); // 无凭据不注入凭据段
    expect(call[4]).toMatchObject({ maxTurns: 5 });
    // 初始导航被调（首步非同 URL navigate）
    expect(await fakeGotos()).toEqual(['http://env.example/page']);
    // verify_progress SSE 事件序列:start → (step_start + step_done)×2 → end
    const phases = emitLog.map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['start', 'step_start', 'step_done', 'step_start', 'step_done', 'end']);
    const start = emitLog[0] as { type: string; caseId: string; total: number; targetUrl: string | null };
    expect(start).toMatchObject({ type: 'verify_progress', caseId, total: 2, targetUrl: 'http://env.example/page' });
    const stepStart = emitLog[1] as { order: number; brief: string };
    expect(stepStart).toMatchObject({ order: 1 });
    expect(stepStart.brief).toContain('点击删除按钮');
    const stepDone = emitLog[2] as { type: string; order: number; status: string };
    expect(stepDone).toMatchObject({ type: 'verify_progress', order: 1, status: 'passed' });
    const end = emitLog[5] as { result: string };
    expect(end.result).toBe('passed');
  });

  it('配置 login 凭据：instruction 含占位符不含明文，valueSub 还原真实值 → login logged-in', async () => {
    await seedLoginObject();
    const caseId = await seedCase({ steps: [CLICK_COMPILED] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"已登录并完成点击","login":"logged-in"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const call = vi.mocked(runAiTask).mock.calls[0]!;
    const instruction = String(call[1]);
    expect(instruction).toContain('__ITEST_USERNAME__');
    expect(instruction).toContain('__ITEST_PASSWORD__');
    expect(instruction).not.toContain('Passw0rd!');
    const opts = call[4] as { valueSub: (v: string) => string };
    expect(opts.valueSub('__ITEST_USERNAME__')).toBe('qa01');
    expect(opts.valueSub('__ITEST_PASSWORD__')).toBe('Passw0rd!');
    expect(opts.valueSub('普通值')).toBe('普通值');
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.login).toBe('logged-in');
      expect(r.data).not.toContain('Passw0rd!');
    }
  });

  it('敏感步骤：instruction 含 __ITEST_STEP_SECRET__，valueSub 还原明文，返回无明文', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED], sensitiveStep1: true });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const instruction = String(vi.mocked(runAiTask).mock.calls[0]![1]);
    expect(instruction).toContain('__ITEST_STEP_SECRET__');
    expect(instruction).toContain('敏感字段');
    expect(instruction).not.toContain('StepSecret!9');
    const opts = vi.mocked(runAiTask).mock.calls[0]![4] as { valueSub: (v: string) => string };
    expect(opts.valueSub('__ITEST_STEP_SECRET__')).toBe('StepSecret!9');
    if (r.ok) expect(r.data).not.toContain('StepSecret!9');
  });

  it('sensitive=true 但密文缺失 → 该步 failed SecretMissing，不调 runAiTask', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED], sensitiveNoSecret: true });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    expect(runAiTask).not.toHaveBeenCalled();
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      expect(data.failure.failureReason).toBe('SecretMissing');
      expect(data.failure.error).toContain('secret-missing');
    }
  });

  it('summary failed → fail-stop：runAiTask 调用次数=失败步序号，failure 结构完整', async () => {
    const caseId = await seedCase({
      steps: [CLICK_COMPILED, [{ kind: 'assertText', locator: [{ strategy: 'css', value: '.msg' }], value: '成功' }]],
    });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask)
      .mockResolvedValueOnce('{"status":"passed","reason":"ok","login":"not-needed"}')
      .mockResolvedValueOnce('{"status":"failed","reason":"元素未找到","login":"not-needed"}');
    const emitLog: unknown[] = [];
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx(emitLog)).execute({ caseId });
    expect(r.ok).toBe(true);
    expect(runAiTask).toHaveBeenCalledTimes(2); // 第 2 步失败即停，第 3 步（无）不再执行
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      expect(data.steps[0].status).toBe('passed');
      expect(data.steps[1].status).toBe('failed');
      expect(data.failure.stepOrder).toBe(2);
      expect(data.failure.action).toEqual([
        { kind: 'assertText', locator: [{ strategy: 'css', value: '.msg' }], value: '成功' },
      ]);
      expect(data.failure.error).toBe('元素未找到');
      expect(data.failure.failureReason).toBe('StepReportedFailed');
      expect(data.failure.humanMessage).toBe('元素未找到');
      expect(data.failure.page.elements[0]).toContain('button#del');
      expect(typeof data.failure.note).toBe('string');
    }
    // 失败路径:失败步 step_done 带 status=failed + reason,end result=failed
    const stepDoneFailed = emitLog.find(
      (e) => (e as { phase?: string }).phase === 'step_done' && (e as { order?: number }).order === 2,
    ) as { status: string; reason: string };
    expect(stepDoneFailed).toMatchObject({ status: 'failed', reason: '元素未找到' });
    const end = emitLog.at(-1) as { result: string };
    expect(end.result).toBe('failed');
  });

  it('runAiTask reject → failureReason AiTaskAborted + 失败页元素清单', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockRejectedValue(new Error('aiTask 放弃：找不到登录按钮'));
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      expect(data.failure.stepOrder).toBe(1);
      expect(data.failure.failureReason).toBe('AiTaskAborted');
      expect(data.failure.error).toContain('aiTask 放弃');
      expect(data.failure.page.elements[0]).toContain('button#del');
    }
  });

  it('summary 非 JSON → passed + warning 契约漂移兜底', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('已手动完成点击操作');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('passed');
      expect(data.steps[0].warning).toBe('已手动完成点击操作');
    }
  });
});

describe('verify_case 注册', () => {
  it('buildSpaceTools 包含 verify_case', async () => {
    const { buildSpaceTools } = await import('../src/pi/space/tools/index.js');
    const names = buildSpaceTools(toolCtx()).map((t) => t.name);
    expect(names).toContain('verify_case');
  });
});
