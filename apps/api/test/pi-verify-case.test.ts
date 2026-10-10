import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// 全 AI 驱动编排测试：runAiTask / writeStepScreenshot / extractPageElements 打桩，聚焦 verify_case 编排契约。
vi.mock('../src/execute/aiTask.js', () => ({ runAiTask: vi.fn() }));
vi.mock('../src/execute/cdp.js', () => ({
  writeStepScreenshot: vi.fn(async () => '/screenshots/verify-x/step-1.png'),
  // runCaseVisionAssert 依赖的模板物化/脱敏（验证场景无数据集变量/敏感列，恒等即可）
  materializeExpectedOutcome: (t: string) => t,
  maskSensitiveValues: (t: string) => t,
}));
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
// playwright 桩：launch → context.newPage 返回极简 page；gotos 记录初始导航、ctxOpts 记录 newContext 入参（经 __testState 暴露给测试）。
// locator/getByText/getByTestId/getByRole 模拟 compiled 保真校验的 count 探测：zeroLocators 里的选择器永远命中 0；multiLocators 精确命中 2（多匹配）；含 :contains 的选择器抛非法伪类错误（与真实 Playwright 一致）。
vi.mock('playwright-core', () => {
  const state = {
    gotos: [] as string[], ctxOpts: [] as unknown[], zeroLocators: [] as string[], multiLocators: [] as string[],
    // SPA 挂载滞后模拟：sel → 第 N 次 count() 起返回 1（之前返回 0）
    mountAfter: {} as Record<string, number>, countCalls: {} as Record<string, number>,
  };
  const makeLoc = (sel: string) => ({
    count: async () => {
      if (sel.includes(':contains')) throw new Error(`Unknown pseudo-class "${sel.match(/:contains/)?.[0]}"`);
      if (state.zeroLocators.some((z) => sel.includes(z))) return 0;
      if (state.multiLocators.some((m) => sel === m)) return 2;
      const need = state.mountAfter[sel];
      if (need != null) {
        const c = (state.countCalls[sel] ?? 0) + 1;
        state.countCalls[sel] = c;
        return c >= need ? 1 : 0;
      }
      return 1;
    },
  });
  return {
    chromium: {
      launch: vi.fn(async () => ({
        newContext: vi.fn(async (opts?: unknown) => {
          state.ctxOpts.push(opts);
          return {
            newPage: async () => ({
              url: () => 'http://env.example/page',
              goto: async (u: string) => { state.gotos.push(u); },
              waitForLoadState: async () => {},
              waitForTimeout: async () => {},
              close: async () => {},
              screenshot: async () => Buffer.from('fake-png'),
              locator: (sel: string) => makeLoc(sel),
              getByText: (t: string) => makeLoc(`text=${t}`),
              getByTestId: (t: string) => makeLoc(`testid=${t}`),
              getByRole: (r: string, opts?: { name?: string }) => makeLoc(`role=${r}:${opts?.name ?? ''}`),
            }),
            storageState: async () => ({ cookies: [{ name: 'sid', value: 'cached' }], origins: [] }),
            close: async () => {},
          };
        }),
        close: async () => {},
      })),
    },
    __testState: state,
  };
});
// judgeCaseOutcome 桩：vision 终态判定的 LLM 判官（真实实现要走视觉模型，测试注入裁决结果）。
vi.mock('../src/agent/judgeCaseOutcome.js', () => ({
  judgeCaseOutcome: vi.fn(async () => ({ passed: true, reason: 'ok' })),
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
  // SCHEMA_SQL 尚未收录暂存表,本文件自建(与 src/db/schema.ts 对齐)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_stage_cases (
      thread_id text NOT NULL,
      local_id text NOT NULL,
      version_id uuid NOT NULL,
      title varchar(200) NOT NULL,
      description text,
      priority varchar(20),
      url text,
      steps jsonb NOT NULL DEFAULT '[]',
      default_env_id uuid,
      expected_outcome text,
      dataset_local_id text,
      staged_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT ai_stage_cases_pk PRIMARY KEY(thread_id, local_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_stage_case_ops (
      thread_id text NOT NULL,
      local_id text NOT NULL,
      version_id uuid NOT NULL,
      case_id uuid NOT NULL,
      op varchar(30) NOT NULL,
      payload jsonb NOT NULL,
      summary text NOT NULL,
      diff text,
      staged_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT ai_stage_case_ops_pk PRIMARY KEY(thread_id, local_id)
    )`);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  const { __testState } = (await import('playwright-core')) as unknown as {
    __testState: { gotos: string[]; ctxOpts: unknown[]; zeroLocators: string[]; multiLocators: string[]; mountAfter: Record<string, number>; countCalls: Record<string, number> };
  };
  __testState.gotos.length = 0;
  __testState.ctxOpts.length = 0;
  __testState.zeroLocators.length = 0;
  __testState.multiLocators.length = 0;
  __testState.mountAfter = {};
  __testState.countCalls = {};
  await pool.query(`TRUNCATE test_steps, test_cases, test_environments, environment_objects,
    requirements, "groups", projects, project_versions, ai_threads, ai_workspace_state, ai_stage_case_ops, ai_stage_cases
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
  expectedOutcome?: string | null;
  /** 仅对第 1 步标记 sensitive 并注入密文（明文 StepSecret!9） */
  sensitiveStep1?: boolean;
  /** sensitive=true 但不注入密文（secret-missing 场景） */
  sensitiveNoSecret?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO test_cases(id, group_id, version_id, title, url, platform, expected_outcome) VALUES ($1, $2, $3, '验证用例', $4, $5, $6)`,
    [id, groupId, versionId, opts.url ?? 'http://env.example/page', opts.platform ?? 'web', opts.expectedOutcome ?? null],
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

/** 当前默认环境 id（loginStateCache 的 key 组成部分） */
async function defaultEnvId(): Promise<string> {
  const r = await pool.query(`SELECT id FROM test_environments WHERE project_id = $1 AND is_default = true`, [projectId]);
  return r.rows[0]!.id as string;
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
    const start = emitLog[0] as { type: string; caseId: string; total: number; targetUrl: string | null; loginCache: string; loginUser: string | null };
    expect(start).toMatchObject({ type: 'verify_progress', caseId, total: 2, targetUrl: 'http://env.example/page', loginCache: 'miss', loginUser: null });
    const stepStart = emitLog[1] as { order: number; brief: string };
    expect(stepStart).toMatchObject({ order: 1 });
    expect(stepStart.brief).toContain('点击删除按钮');
    const stepDone = emitLog[2] as { type: string; order: number; status: string; login?: string };
    expect(stepDone).toMatchObject({ type: 'verify_progress', order: 1, status: 'passed', login: 'not-needed' });
    const end = emitLog[5] as { result: string; cacheSaved: boolean };
    expect(end.result).toBe('passed');
    expect(end.cacheSaved).toBe(true);
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
    // start 事件上报凭据用户与缓存未命中；step_done 上报当轮登录行为
    const emitLog: unknown[] = [];
    // 重跑一次以捕获事件（缓存已回写,本次应为 hit——顺带覆盖 hit 断言）
    const r2 = await buildVerifyCaseTool(toolCtx(emitLog)).execute({ caseId });
    expect(r2.ok).toBe(true);
    const start2 = emitLog[0] as { loginCache: string; loginUser: string | null };
    expect(start2).toMatchObject({ loginCache: 'hit', loginUser: 'qa01' });
    const stepDone2 = emitLog[2] as { login?: string };
    expect(stepDone2.login).toBe('logged-in');
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

  it('登录态缓存命中：newContext 注入 storageState（免登录直接跑步骤）', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED] });
    const { saveLoginState } = await import('../src/pi/space/tools/loginStateCache.js');
    const fakeState = { cookies: [{ name: 'sid', value: 'warm' }], origins: [] };
    saveLoginState(`${await defaultEnvId()}:`, fakeState as never);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const { __testState } = (await import('playwright-core')) as unknown as {
      __testState: { ctxOpts: Array<Record<string, unknown> | undefined> };
    };
    expect(__testState.ctxOpts[0]).toMatchObject({ storageState: fakeState });
  });

  it('login logged-in：验证后回写 storageState 缓存（key 为 envId:user）', async () => {
    await seedLoginObject();
    const caseId = await seedCase({ steps: [CLICK_COMPILED] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"已登录并完成点击","login":"logged-in"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const { getLoginState } = await import('../src/pi/space/tools/loginStateCache.js');
    expect(getLoginState(`${await defaultEnvId()}:qa01`)).toEqual({
      cookies: [{ name: 'sid', value: 'cached' }],
      origins: [],
    });
  });

  it('LLM 漏报 login（not-needed）仍回写缓存——回归：契约漂移不阻断暖缓存', async () => {
    await seedLoginObject();
    const caseId = await seedCase({ steps: [CLICK_COMPILED] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"完成","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const { getLoginState } = await import('../src/pi/space/tools/loginStateCache.js');
    expect(getLoginState(`${await defaultEnvId()}:qa01`)).toEqual({
      cookies: [{ name: 'sid', value: 'cached' }],
      origins: [],
    });
  });

  it('stage_case_op 暂存的 update_step 自动叠加：验证基于暂存步骤继续，全程不落库', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED] });
    const stepRows = await pool.query(`SELECT id FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId]);
    const stepId = stepRows.rows[0]!.id as string;
    const fixed = [{ kind: 'click', locator: [{ strategy: 'css', value: '#real' }] }];
    await pool.query(
      `INSERT INTO ai_stage_case_ops(thread_id, local_id, version_id, case_id, op, payload, summary, staged_at)
       VALUES ('t1', $1, $2, $3, 'update_step', $4::jsonb, '修正 locator', now())`,
      [randomUUID(), versionId, caseId, JSON.stringify({ action: 'update_step', caseId, stepId, compiled: fixed })],
    );
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const emitLog: unknown[] = [];
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx(emitLog)).execute({ caseId });
    expect(r.ok).toBe(true);
    // AI 看到的是叠加后的 compiled（#real），不是 DB 里的 #missing
    const instruction = String(vi.mocked(runAiTask).mock.calls[0]![1]);
    expect(instruction).toContain('#real');
    expect(instruction).not.toContain('#missing');
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.basedOn).toBe('staged');
      expect(data.stagedOpsApplied).toBe(1);
    }
    // start 事件上报暂存叠加数 → 前端"基于暂存（1 项修改）"徽标
    const start = emitLog[0] as { stagedOps: number };
    expect(start.stagedOps).toBe(1);
    // 全程不落库：DB 步骤 compiled 仍是 #missing
    const after = await pool.query(`SELECT compiled FROM test_steps WHERE id = $1`, [stepId]);
    expect(JSON.stringify(after.rows[0]!.compiled)).toContain('#missing');
  });

  it('纯草稿用例（stage_case localId，未落库）：verify_case 直接以 localId 验证 → passed，全程不落库', async () => {
    const localId = randomUUID();
    const draftSteps = [
      { action: '点击新建按钮', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#newBtn' }] }], assertion: null },
      { action: '填写表单', compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#name' }], value: '测试' }], assertion: null },
    ];
    await pool.query(
      `INSERT INTO ai_stage_cases(thread_id, local_id, version_id, title, url, steps, expected_outcome, staged_at)
       VALUES ('t1', $1, $2, '草稿用例', 'http://env.example/page', $3::jsonb, '表单保存成功', now())`,
      [localId, versionId, JSON.stringify(draftSteps)],
    );
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const emitLog: unknown[] = [];
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx(emitLog)).execute({ caseId: localId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('passed');
      expect(data.basedOn).toBe('staged');
      expect(data.steps).toHaveLength(2);
      expect(data.caseId).toBe(localId);
    }
    // LLM 看到的是草稿的 compiled（#newBtn），指令含 url 兜底（草稿无分组走 env baseUrl 之外的双线）与步骤序号
    const call = vi.mocked(runAiTask).mock.calls[0]!;
    expect(String(call[1])).toContain('#newBtn');
    expect(String(call[1])).toContain('第 1 步 / 共 2 步');
    // start 事件携带草稿标记
    const start = emitLog[0] as { caseId: string; stagedOps: number };
    expect(start).toMatchObject({ caseId: localId, stagedOps: 0 });
  });

  it('纯草稿用例未落库：verify_case 通过后 DB 仍无 test_cases 行（验证全程不落库）', async () => {
    const localId = randomUUID();
    await pool.query(
      `INSERT INTO ai_stage_cases(thread_id, local_id, version_id, title, steps, staged_at)
       VALUES ('t1', $1, $2, '草稿', $3::jsonb, now())`,
      [localId, versionId, JSON.stringify([{ action: '点击', compiled: CLICK_COMPILED, assertion: null }])],
    );
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId: localId });
    expect(r.ok).toBe(true);
    const rows = await pool.query(`SELECT id FROM test_cases WHERE title = '草稿'`);
    expect(rows.rows).toHaveLength(0);
  });

  it('stage_case_op 暂存 delete_case → ok:false（用例待删除，不应再验证）', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED] });
    await pool.query(
      `INSERT INTO ai_stage_case_ops(thread_id, local_id, version_id, case_id, op, payload, summary, staged_at)
       VALUES ('t1', $1, $2, $3, 'delete_case', $4::jsonb, '删除用例', now())`,
      [randomUUID(), versionId, caseId, JSON.stringify({ action: 'delete_case', caseId })],
    );
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('已暂存删除');
  });

  it('compiled 保真前置校验：click 用非法 :contains 选择器 → LocatorMismatch，不调 runAiTask', async () => {
    const caseId = await seedCase({
      steps: [[{ kind: 'click', locator: [{ strategy: 'css', value: "button.el-button--primary>span:contains('新建')" }] }]],
    });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    expect(runAiTask).not.toHaveBeenCalled(); // 前置拦截，不烧 AI 轮次
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      expect(data.steps[0].failureReason).toBe('LocatorMismatch');
      expect(data.steps[0].error).toContain(':contains');
      expect(data.failure.failureReason).toBe('LocatorMismatch');
    }
  });

  it('compiled 保真后置校验：AI 报 passed 但 assertVisible locator 命中 0 → LocatorMismatch', async () => {
    const caseId = await seedCase({
      steps: [[{ kind: 'assertVisible', locator: [{ strategy: 'css', value: '.ghost-element' }] }]],
    });
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { zeroLocators: string[] } };
    __testState.zeroLocators.push('.ghost-element');
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"看到了","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      // AI 明明报了 passed，保真校验仍判失败（回放将 count=0）
      expect(data.steps[0].status).toBe('failed');
      expect(data.steps[0].failureReason).toBe('LocatorMismatch');
      expect(data.steps[0].error).toContain('.ghost-element');
    }
  });

  it('compiled 保真后置校验：多候选首候选命中 0、次候选命中 → 通过（或关系，与回放一致）', async () => {
    const caseId = await seedCase({
      steps: [[{
        kind: 'assertVisible',
        locator: [
          { strategy: 'css', value: '.ghost-element' },
          { strategy: 'text', value: '删除' },
        ],
      }]],
    });
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { zeroLocators: string[] } };
    __testState.zeroLocators.push('.ghost-element');
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"看到了","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      // 任一候选命中即通过——全部候选命中 0 才是回放失败
      expect(data.result).toBe('passed');
      expect(data.steps[0].status).toBe('passed');
    }
  });

  it('compiled 保真后置校验：多候选全部命中 0 → LocatorMismatch 且失败信息列出全部候选', async () => {
    const caseId = await seedCase({
      steps: [[{
        kind: 'assertVisible',
        locator: [
          { strategy: 'css', value: '.ghost-a' },
          { strategy: 'css', value: '.ghost-b' },
        ],
      }]],
    });
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { zeroLocators: string[] } };
    __testState.zeroLocators.push('.ghost-a', '.ghost-b');
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"看到了","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      expect(data.steps[0].status).toBe('failed');
      expect(data.steps[0].failureReason).toBe('LocatorMismatch');
      expect(data.steps[0].error).toContain('全部 2 个候选');
      expect(data.steps[0].error).toContain('.ghost-a');
      expect(data.steps[0].error).toContain('.ghost-b');
    }
  });

  it('compiled 保真后置校验：SPA 挂载滞后（前两轮 count=0 后命中）→ 轮询窗口内通过', async () => {
    // 回测 8a178d83 根因回归：networkidle 后页面仍未挂载完，探测放弃约 2s 后元素才出现。
    // verify 预检/后置校验窗口与回放对齐（12 轮轮询），迟挂载元素应判通过而非 LocatorMismatch。
    const caseId = await seedCase({
      steps: [[{ kind: 'assertVisible', locator: [{ strategy: 'css', value: '.late-mount' }] }]],
    });
    const { __testState } = (await import('playwright-core')) as unknown as {
      __testState: { mountAfter: Record<string, number>; countCalls: Record<string, number> };
    };
    __testState.mountAfter['.late-mount'] = 3; // 前 2 次探测 0，第 3 次挂载完成
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"看到了","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('passed');
      expect(data.steps[0].status).toBe('passed');
      expect(__testState.countCalls['.late-mount']).toBe(3);
    }
  });

  it('compiled 保真后置校验：fill 首候选命中多个元素（count>1）→ AmbiguousLocator', async () => {
    // 回归动机：AI 生成 '#ruleconfig1 .baseForm input' 这类裸标签候选命中表单全部 input，
    // 回放 strict-mode 兜底 .first() 静默填第一个字段——verify 只测 count>0 会放行"碰巧对"。
    const caseId = await seedCase({
      steps: [[{ kind: 'fill', locator: [{ strategy: 'css', value: '#ruleconfig1 .baseForm input' }], value: '规则名' }]],
    });
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { multiLocators: string[] } };
    __testState.multiLocators.push('#ruleconfig1 .baseForm input');
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    expect(runAiTask).toHaveBeenCalledTimes(1); // fill 是后置校验：AI 先执行，元素理应仍在
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      expect(data.steps[0].status).toBe('failed');
      expect(data.steps[0].failureReason).toBe('AmbiguousLocator');
      expect(data.steps[0].error).toContain('#ruleconfig1 .baseForm input');
      expect(data.steps[0].error).toContain('命中 2 个元素');
      expect(data.failure.failureReason).toBe('AmbiguousLocator');
    }
  });

  it('compiled 保真前置校验：click 首候选命中多个 → AmbiguousLocator，不烧 AI 轮次', async () => {
    const caseId = await seedCase({
      steps: [[{ kind: 'click', locator: [{ strategy: 'css', value: '#Datarules .header button.el-button--primary' }] }]],
    });
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { multiLocators: string[] } };
    __testState.multiLocators.push('#Datarules .header button.el-button--primary');
    const { runAiTask } = await import('../src/execute/aiTask.js');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    expect(runAiTask).not.toHaveBeenCalled(); // 前置拦截，AI 不跑
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      expect(data.steps[0].failureReason).toBe('AmbiguousLocator');
    }
  });

  it('多匹配判定与回放同序：首候选多匹配、次候选唯一 → 仍判 AmbiguousLocator（回放按序采用首候选）', async () => {
    const caseId = await seedCase({
      steps: [[{
        kind: 'fill',
        locator: [
          { strategy: 'css', value: '.multi-a' },
          { strategy: 'role', value: 'textbox[name="规则名称"]' },
        ],
        value: 'x',
      }]],
    });
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { multiLocators: string[] } };
    __testState.multiLocators.push('.multi-a');
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      // 回放探测顺序 = buildCandidates 顺序：css .multi-a 先命中（count=2）即被采用，轮不到唯一的 role 候选
      expect(data.steps[0].failureReason).toBe('AmbiguousLocator');
      expect(data.steps[0].error).toContain('.multi-a');
    }
  });

  it('用例级终态判定：步骤全过后 vision 判不符 expectedOutcome → failed VisionAssertionFailed', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED], expectedOutcome: '字段以只读形式展示' });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { judgeCaseOutcome } = await import('../src/agent/judgeCaseOutcome.js');
    vi.mocked(judgeCaseOutcome).mockResolvedValue({ passed: false, reason: '输入框未置灰，仍可编辑' });
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      expect(data.steps[0].status).toBe('passed'); // 步骤本身没问题，死在终态
      expect(data.failure.stepOrder).toBe(-1);
      expect(data.failure.failureReason).toBe('VisionAssertionFailed');
      expect(data.failure.error).toContain('输入框未置灰');
      expect(data.failure.humanMessage).toBe('最终页面与用例预期不符');
    }
  });

  it('用例级终态判定通过：vision 判 passed → 整体 passed（judge 被真实调用一次）', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED], expectedOutcome: '列表展示解析规则' });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { judgeCaseOutcome } = await import('../src/agent/judgeCaseOutcome.js');
    vi.mocked(judgeCaseOutcome).mockResolvedValue({ passed: true, reason: '列表已展示规则' });
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('passed');
    }
    expect(vi.mocked(judgeCaseOutcome)).toHaveBeenCalledTimes(1);
  });
});

describe('verify_case 注册', () => {
  it('buildSpaceTools 包含 verify_case', async () => {
    const { buildSpaceTools } = await import('../src/pi/space/tools/index.js');
    const names = buildSpaceTools(toolCtx()).map((t) => t.name);
    expect(names).toContain('verify_case');
  });
});
