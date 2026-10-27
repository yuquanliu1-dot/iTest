import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// 全 AI 驱动编排测试：runAiTask / writeStepScreenshot / extractPageElements 打桩，聚焦 verify_case 编排契约。
// 占位符常量随 execute 层定义（verifyCase 提示词经 aiTask.js 取用）,一并打桩隔绝真实依赖。
vi.mock('../src/execute/aiTask.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/execute/aiTask.js')>();
  return {
    ...actual,
    runAiTask: vi.fn(),
    USER_PH: '__ITEST_USERNAME__',
    PASSWORD_PH: '__ITEST_PASSWORD__',
    SECRET_PH: '__ITEST_STEP_SECRET__',
  };
});
vi.mock('../src/execute/cdp.js', () => ({
  writeStepScreenshot: vi.fn(async () => '/screenshots/verify-x/step-1.png'),
  // 机械干跑默认全过（步骤序号透传）；失败/接线细节由用例内 mockImplementationOnce 覆写
  executeCaseInBrowser: vi.fn(
    async (
      _caseId: string,
      steps: Array<{ order: number }>,
      _ctx?: unknown,
      _browser?: unknown,
      _context?: unknown,
      _targetUrl?: string,
      _onPreflight?: unknown,
      _caseWindow?: unknown,
      _onFailurePage?: (page: unknown, failedIndex: number) => Promise<void>,
    ) => steps.map((s) => ({ order: s.order, status: 'passed' as const, durationMs: 10 })),
  ),
  // runCaseVisionAssert 依赖的模板物化/脱敏（验证场景无数据集变量/敏感列，恒等即可）
  materializeExpectedOutcome: (t: string) => t,
  maskSensitiveValues: (t: string) => t,
  // init 预导航的落地重试（默认直达；重试语义由 cdp-goto-retry.test.ts 对真实实现单测）
  gotoWithLandedRetry: vi.fn(async (_page: unknown, targetUrl: string) => ({ landed: true, finalUrl: targetUrl })),
}));
vi.mock('../src/pi/inspectPage.js', () => ({
  extractPageElements: vi.fn(async () => ({
    title: '失败页',
    url: 'http://env.example/page',
    bodyLen: 120,
    elements: ['- button#del "删除" 选择器: #del'],
    truncated: false,
  })),
  extractPageEvidence: vi.fn(async () => ({ overlays: [] })),
}));
// liveView 包一层 spy：既有真实行为不变（登记进内存表），供 ctx.liveView=false 用例断言零调用
vi.mock('../src/execute/liveView.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/execute/liveView.js')>();
  return { ...actual, registerLiveView: vi.fn(actual.registerLiveView) };
});
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
              // pageSettle 的像素指纹取数字；断言文本体检取 innerText 字符串。
              // 恒返回 0：连续两次相同 → 页面已静止；innerText 场景恒为空串，judge 仍按语义判。
              evaluate: async () => 0,
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
// assertionJudge 桩：断言文本体检的 LLM 判官（真实实现要发 LLM 请求，测试注入裁决结果）。
// 缺省判 real=true（保留断言），仅专门的用例用 mockImplementationOnce 覆盖。
vi.mock('../src/pi/space/tools/assertionJudge.js', () => ({
  judgeAssertionText: vi.fn(async () => ({ real: true, reason: '' })),
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
    requirements, "groups", projects, project_versions, ai_threads, ai_stage_case_ops, ai_stage_cases
    RESTART IDENTITY CASCADE`);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  groupId = seed.groupId;
  versionId = seed.versionId;
  // 每个用例都要求环境可解析（resolveEnv 需要）：默认环境无 login 凭据
  const seedEnv = await pool.query(
    `INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认环境', true) RETURNING id`,
    [projectId],
  );
  await pool.query(
    `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES ($1, 'web', '默认', '{"name":"web","scheme":"http","host":"env.example"}', true)`,
    [seedEnv.rows[0]!.id],
  );
});

async function seedCase(opts: {
  platform?: string;
  url?: string | null;
  steps?: unknown[];
  /** 与 steps 同序的 step-level assertion（测试步骤断言文本体检用） */
  assertions?: unknown[];
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
      `INSERT INTO test_steps(case_id, "order", source, compiled, instruction, assertion)
       VALUES ($1, $2, 'ai', $3::jsonb, $4, $5::jsonb)`,
      [
        id,
        i + 1,
        JSON.stringify(opts.steps![i]),
        i === 0 ? '第一步：点击删除按钮' : null,
        opts.assertions?.[i] != null ? JSON.stringify(opts.assertions[i]) : null,
      ],
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
    `INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '登录环境', true) RETURNING id`,
    [projectId],
  );
  // 0041 起登录凭据并入默认 web 服务对象:user/loginUrl/secret 内嵌 payload
  const payload = {
    name: 'web',
    scheme: 'http',
    host: 'env.example',
    user: 'qa01',
    loginUrl: '/login',
    secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') },
  };
  await pool.query(
    `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES ($1, 'web', '默认', $2::jsonb, true)`,
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
    // 初始导航被调（首步非同 URL navigate）——经 gotoWithLandedRetry（含落地校验重试兜底）
    const { gotoWithLandedRetry } = await import('../src/execute/cdp.js');
    expect(vi.mocked(gotoWithLandedRetry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gotoWithLandedRetry).mock.calls[0]![1]).toBe('http://env.example/page');
    // verify_progress SSE 事件序列:start → (step_start + step_done)×2 → replay_start → replay_done → end
    const phases = emitLog.map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['start', 'step_start', 'step_done', 'step_start', 'step_done', 'replay_start', 'replay_done', 'end']);
    const start = emitLog[0] as { type: string; caseId: string; total: number; targetUrl: string | null; loginCache: string; loginUser: string | null };
    expect(start).toMatchObject({ type: 'verify_progress', caseId, total: 2, targetUrl: 'http://env.example/page', loginCache: 'miss', loginUser: null });
    const stepStart = emitLog[1] as { order: number; brief: string };
    expect(stepStart).toMatchObject({ order: 1 });
    expect(stepStart.brief).toContain('点击删除按钮');
    const stepDone = emitLog[2] as { type: string; order: number; status: string; login?: string };
    expect(stepDone).toMatchObject({ type: 'verify_progress', order: 1, status: 'passed', login: 'not-needed' });
    const end = emitLog[7] as { result: string; cacheSaved: boolean };
    expect(end.result).toBe('passed');
    expect(end.cacheSaved).toBe(true);
  });

  it('ctx.liveView=false：不注册实时画面且 start 无 liveUrl（批量后台链路）；缺省会话行为不变', async () => {
    const { registerLiveView } = await import('../src/execute/liveView.js');
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    // 关闭路径：liveView=false → 零注册、start 事件无 liveUrl
    const caseOff = await seedCase({ steps: [CLICK_COMPILED] });
    const emitOff: unknown[] = [];
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const rOff = await buildVerifyCaseTool({ ...toolCtx(emitOff), liveView: false }).execute({ caseId: caseOff });
    expect(rOff.ok).toBe(true);
    expect(registerLiveView).not.toHaveBeenCalled();
    const startOff = emitOff[0] as { liveUrl?: string };
    expect(startOff.liveUrl).toBeUndefined();
    // 缺省（undefined）：会话链路照旧注册并带流地址
    const caseOn = await seedCase({ steps: [CLICK_COMPILED] });
    const emitOn: unknown[] = [];
    const rOn = await buildVerifyCaseTool(toolCtx(emitOn)).execute({ caseId: caseOn });
    expect(rOn.ok).toBe(true);
    expect(registerLiveView).toHaveBeenCalledTimes(1);
    const startOn = emitOn[0] as { liveUrl?: string };
    expect(startOn.liveUrl).toContain('/live/');
  });

  it('resume 轮后缀步失败 → 响应仍 ok:true（回归：stepResults 局部下标 vs failedIndex 全局下标）', async () => {
    // prod228 实测暴露：第 1 轮步 1 过 / 步 2 败(confirmedThrough=1)后,第 2 轮 resume 前缀、
    // 步 2 再次失败时,旧代码 stepResults[failedIndex] 越过局部数组头(undefined→读 .order 抛错)。
    const caseId = await seedCase({
      steps: [
        CLICK_COMPILED, // 步 1:count=1 命中,AI 相通过
        [{ kind: 'click', locator: [{ strategy: 'css', value: '.ghost-element' }] }], // 步 2:pre-check 命中 0 失败
      ],
    });
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { zeroLocators: string[] } };
    __testState.zeroLocators.push('.ghost-element');
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');

    // 第 1 轮：步 1 过、步 2 pre-check 失败
    const r1 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      const d1 = JSON.parse(r1.data!);
      expect(d1.result).toBe('failed');
      expect(d1.failure.failureReason).toBe('LocatorMismatch');
    }

    // 第 2 轮：resume 步 1(机械回放,不重跑 AI),步 2 仍失败——必须 ok:true 带完整 failure,而非抛错
    const r2 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r2.ok, r2.ok ? '' : r2.error).toBe(true);
    if (r2.ok) {
      const d2 = JSON.parse(r2.data!);
      expect(d2.result).toBe('failed');
      expect(d2.resumeFrom).toBe(1);
      expect(d2.steps).toHaveLength(2);
      expect(d2.steps[0].status).toBe('passed');
      expect(d2.steps[1].status).toBe('failed');
      expect(d2.failure.stepOrder).toBe(2);
      expect(d2.failure.failureReason).toBe('LocatorMismatch');
      expect(d2.failure.error).toContain('.ghost-element');
      expect(d2.failure.evidence).toMatchObject({
        probes: [{ strategy: 'css', value: '.ghost-element', hitCount: 0 }],
      });
    }
    // 前缀不重跑 AI：两轮合计只有第 1 轮步 1 调过 runAiTask 一次
    expect(vi.mocked(runAiTask)).toHaveBeenCalledTimes(1);
    // restore 干跑 ctx 同样携带 web origin（resume 前缀重建也会派发相对 URL navigate）
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    const restoreCall = vi.mocked(executeCaseInBrowser).mock.calls[0]! as unknown as [
      string,
      unknown,
      { caseWebOrigin?: string | null },
    ];
    expect(restoreCall[2].caseWebOrigin).toBe('http://env.example');
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
    expect(instruction).toContain('__ITEST_USERNAME@web__');
    expect(instruction).toContain('__ITEST_PASSWORD@web__');
    expect(instruction).not.toContain('Passw0rd!');
    const opts = call[4] as { valueSub: (v: string) => string };
    expect(opts.valueSub('__ITEST_USERNAME@web__')).toBe('qa01');
    expect(opts.valueSub('__ITEST_PASSWORD@web__')).toBe('Passw0rd!');
    // 无 @ref 的裸占位符仍按「用例 web_service_ref → 环境默认 web」链解析到同一服务
    expect(opts.valueSub('__ITEST_USERNAME__')).toBe('qa01');
    expect(opts.valueSub('__ITEST_PASSWORD__')).toBe('Passw0rd!');
    expect(opts.valueSub('普通值')).toBe('普通值');
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.login).toBe('logged-in');
      expect(r.data).not.toContain('Passw0rd!');
    }
    // start 事件上报凭据用户与缓存未命中；重跑一次捕获事件（登录态缓存已回写,本次应为 hit——顺带覆盖 hit 断言）
    const emitLog: unknown[] = [];
    const r2 = await buildVerifyCaseTool(toolCtx(emitLog)).execute({ caseId });
    expect(r2.ok).toBe(true);
    const start2 = emitLog[0] as { loginCache: string; loginUser: string | null };
    expect(start2).toMatchObject({ loginCache: 'hit', loginUser: 'qa01' });
    // 前缀确认复用：round 1 全过后 round 2 的 AI 相不再重跑（已确认步骤以机械回放重建 DOM 状态），
    // runAiTask 仍只有 round 1 那一次调用；事件序列无 step_*，只有 start → replay_start → replay_done → end。
    expect(vi.mocked(runAiTask)).toHaveBeenCalledTimes(1);
    const phases2 = emitLog.map((e) => (e as { phase: string }).phase);
    expect(phases2).toEqual(['start', 'replay_start', 'replay_done', 'end']);
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
      // 有 compiled 的步骤失败仍走 locator 修正文案（agent 可修）
      expect(data.failure.note).toContain('修正 locator');
    }
  });

  it('自然语言步（无 compiled）AI 相失败 → note 分流反馈用户：停止重跑与自诊，不再引导修 locator', async () => {
    // 需求口径（2026-10-27）：讨论期验证里自然语言步的 AI 相失败大概率是步骤描述与页面不符
    // （或前面步骤把页面带偏）——agent 改 selector 无从下手、重跑不改变结果，应反馈用户调整。
    const caseId = await seedCase({ steps: [null] }); // instruction-only 视觉步（instruction=第一步：点击删除按钮）
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockRejectedValue(new Error('aiTask 放弃：页面上没有该目标'));
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      expect(data.failure.failureReason).toBe('AiTaskAborted');
      expect(data.failure.note).toContain('该步是自然语言步骤，由 AI 相');
      expect(data.failure.note).toContain('反馈给用户');
      expect(data.failure.note).toContain('停止重跑');
      expect(data.failure.note).toContain('不要再调用 verify_case');
      expect(data.failure.note).toContain('第一步：点击删除按钮'); // 步骤原文回带，便于转述给用户
      expect(data.failure.note).not.toContain('修正 locator 只能使用'); // 旧 locator 修正文案不得误导
    }
  });

  it('compiled 纯 aiTask 形态（kind 全为 aiTask）同样走反馈用户分流', async () => {
    const caseId = await seedCase({ steps: [[{ kind: 'aiTask', instruction: '关闭可能出现的引导浮层' }]] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValueOnce('{"status":"failed","reason":"找不到浮层","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.failure.failureReason).toBe('StepReportedFailed');
      expect(data.failure.note).toContain('该步是自然语言步骤，由 AI 相');
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

describe('verify_case 断言文本体检', () => {
  const ASSERT_COMPILED = [{ kind: 'click', locator: [{ strategy: 'css', value: '#okBtn' }] }];

  it('判定为描述性短语 → 不进本轮指令、不进机械回放、原样回传给 LLM', async () => {
    const caseId = await seedCase({
      steps: [ASSERT_COMPILED],
      assertions: ['登录表单正常展示'],
    });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { judgeAssertionText } = await import('../src/pi/space/tools/assertionJudge.js');
    vi.mocked(judgeAssertionText).mockResolvedValueOnce({ real: false, reason: '描述状态而非页面文案' });

    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok, r.ok ? '' : JSON.stringify(r)).toBe(true);
    const data = JSON.parse(r!.data!);
    expect(data.result).toBe('passed');
    // 断言原文回传，agent 据此改写成真实 UI 文案，而不是靠弱化断言蒙混
    expect(data.droppedAssertions).toEqual([{ order: 1, assertion: '登录表单正常展示' }]);
    // AI 相指令里带「已忽略」说明，不再让它去核实一个页面上不存在的文案
    const instr = String(vi.mocked(runAiTask).mock.calls[0]![1]);
    expect(instr).toContain('断言：已忽略');
    expect(instr).toContain('登录表单正常展示');
    // 机械回放也跳过该断言（回放逐字派发，跑一遍只会白挂一次）
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    const stepsArg = vi.mocked(executeCaseInBrowser).mock.calls[0]![1] as Array<{ assertion: unknown }>;
    expect(stepsArg[0]!.assertion).toBeNull();
  });

  it('判定为真实 UI 文案 → 断言照常进入指令与回放', async () => {
    const caseId = await seedCase({
      steps: [ASSERT_COMPILED],
      assertions: ['登录'],
    });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { judgeAssertionText } = await import('../src/pi/space/tools/assertionJudge.js');
    vi.mocked(judgeAssertionText).mockResolvedValueOnce({ real: true, reason: '按钮文案' });

    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const data = JSON.parse(r!.data!);
    expect(data.droppedAssertions).toBeUndefined();
    const instr = String(vi.mocked(runAiTask).mock.calls[0]![1]);
    expect(instr).toContain('断言（预期结果，完成后自行核实）');
    expect(instr).not.toContain('断言：已忽略');
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    const stepsArg = vi.mocked(executeCaseInBrowser).mock.calls[0]![1] as Array<{ assertion: unknown }>;
    expect(stepsArg[0]!.assertion).not.toBeNull();
  });
});

describe('verify_case compiled 机械回放干跑', () => {
  it('AI 相全过后干跑：executeCaseInBrowser 调用一次、reportId 隔离、不重复终态判定，通过 → passed + replay 摘要', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const emitLog: unknown[] = [];
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx(emitLog)).execute({ caseId });
    expect(r.ok).toBe(true);
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    expect(executeCaseInBrowser).toHaveBeenCalledTimes(1);
    const call = vi.mocked(executeCaseInBrowser).mock.calls[0]!;
    const [caseIdArg, stepsArg, ctxArg, browserArg, contextArg, targetUrlArg] = call as unknown as [
      string,
      Array<{ compiled: unknown[] }>,
      { reportId: string; expectedOutcome?: string },
      unknown,
      unknown,
      string | undefined,
    ];
    expect(caseIdArg).toBe(caseId);
    expect(targetUrlArg).toBe('http://env.example/page');
    // 相对 URL navigate 的拼接来源（prod228 缺口 2：此前干跑 ctx 缺这两字段一律 invalid-navigate-url）
    expect(ctxArg.caseWebOrigin).toBe('http://env.example');
    expect(ctxArg.caseWebServiceRef).toBeNull();
    // 截图目录隔离（-replay 后缀），避免覆盖 AI 相同名 step-N.png；终态判定不重复跑
    expect(ctxArg.reportId).toMatch(/-replay$/);
    expect(ctxArg.expectedOutcome).toBeUndefined();
    // compiled 逐字透传给机械回放引擎；browser/context 复用 verify 自己的实例（登录态随 cookie 携带）
    expect(stepsArg[0]!.compiled).toEqual(CLICK_COMPILED);
    expect(browserArg).toBeTruthy();
    expect(contextArg).toBeTruthy();
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('passed');
      expect(data.replay.result).toBe('passed');
      expect(typeof data.replay.durationMs).toBe('number');
    }
  });

  it('干跑失败（AI 能过、逐字回放挂）→ ReplayDivergence，failure.page 取干跑自己的 page', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const replayPageStub = {
      url: () => 'http://env.example/page',
      marker: 'replay-page' as const,
      // 归因证据（probeLocatorHits）要对干跑页做候选实时命中探测——真实回放 page 有 locator，桩补全同形。
      locator: (sel: string) => ({ count: async () => (sel.includes('#missing') ? 0 : 1) }),
      getByText: (t: string) => ({ count: async () => 1 }),
      getByRole: () => ({ count: async () => 1 }),
      getByTestId: () => ({ count: async () => 1 }),
    };
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    vi.mocked(executeCaseInBrowser).mockImplementationOnce(
      async (
        _cid: string,
        _steps: Array<{ order: number }>,
        _ctx: unknown,
        _browser: unknown,
        _context: unknown,
        _targetUrl: string | undefined,
        _onPreflight: unknown,
        _caseWindow: unknown,
        _onStep: unknown,
        onFailurePage?: (page: unknown, failedIndex: number) => Promise<void>,
      ) => {
        // 模拟真实引擎失败时回调 onFailurePage（verify 借此留住干跑 page 引用）
        await onFailurePage?.(replayPageStub, 0);
        return [
          { order: 1, status: 'failed' as const, durationMs: 5, error: 'count=0 (role)', failureReason: 'LocatorAllFailed', humanMessage: '所有定位候选均未命中', screenshot: '/screenshots/verify-x-replay/step-1.png' },
        ];
      },
    );
    const emitLog: unknown[] = [];
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx(emitLog)).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      expect(data.steps[0].status).toBe('passed'); // AI 相全过，死在机械回放
      expect(data.replay[0].status).toBe('failed');
      expect(data.failure.stepOrder).toBe(1);
      expect(data.failure.failureReason).toBe('ReplayDivergence');
      expect(data.failure.error).toBe('count=0 (role)');
      expect(data.failure.humanMessage).toBe('所有定位候选均未命中');
      expect(data.failure.screenshot).toContain('-replay');
      expect(data.failure.action).toEqual(CLICK_COMPILED);
      expect(data.failure.page.elements[0]).toContain('button#del');
      expect(typeof data.failure.note).toBe('string');
    }
    // 失败页元素清单取自干跑 page（分叉现场），不是 AI 旧 page
    const { extractPageElements } = await import('../src/pi/inspectPage.js');
    expect(vi.mocked(extractPageElements).mock.calls.at(-1)?.[0]).toBe(replayPageStub);
    // SSE 序列：AI 步全过 → replay_start → replay_done(failed) → end(failed)
    const phases = emitLog.map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['start', 'step_start', 'step_done', 'replay_start', 'replay_done', 'end']);
    const replayDone = emitLog[4] as { status: string; reason: string };
    expect(replayDone).toMatchObject({ status: 'failed', reason: '所有定位候选均未命中' });
    const end = emitLog.at(-1) as { result: string };
    expect(end.result).toBe('failed');
  });

  it('全视觉用例（无 compiled）跳过机械干跑 → 响应不带 replay 摘要（不报 epoch 假时长）', async () => {
    // 回归点：干跑被跳过时 replayStartedAt 恒为 0，此前无条件发出的
    // replay.durationMs = Date.now()-0 是 epoch 级垃圾值（prod228 出现 6 次）。
    const caseId = await seedCase({ steps: [null, null] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    expect(executeCaseInBrowser).not.toHaveBeenCalled(); // 无 compiled 可逐字派发 → 跳过干跑
    const data = JSON.parse((r as { data: string }).data);
    expect(data.result).toBe('passed');
    expect(data.replay).toBeUndefined();
  });

  it('敏感步骤：干跑注入 secretResolver（stepId → 解密明文）；非敏感用例不注入', async () => {
    const sensitiveId = await seedCase({ steps: [CLICK_COMPILED], sensitiveStep1: true });
    const plainId = await seedCase({ steps: [CLICK_COMPILED] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r1 = await buildVerifyCaseTool(toolCtx()).execute({ caseId: sensitiveId });
    expect(r1.ok).toBe(true);
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    const sensitiveCall = vi.mocked(executeCaseInBrowser).mock.calls[0]! as unknown as [
      string,
      Array<{ id: string; sensitive: boolean }>,
      { secretResolver: (stepId: string) => Promise<string | null> },
    ];
    expect(sensitiveCall[1][0]!.sensitive).toBe(true);
    // 暂存/DB step id 直接映射解密明文（DB 默认 secretResolver 查库链路不适用 verify 语境）
    await expect(sensitiveCall[2].secretResolver(sensitiveCall[1][0]!.id)).resolves.toBe('StepSecret!9');
    await expect(sensitiveCall[2].secretResolver('unknown-step')).resolves.toBeNull();
    if (r1.ok) expect(r1.data).not.toContain('StepSecret!9');
    const r2 = await buildVerifyCaseTool(toolCtx()).execute({ caseId: plainId });
    expect(r2.ok).toBe(true);
    const plainCall = vi.mocked(executeCaseInBrowser).mock.calls[1]! as unknown as [
      string,
      unknown,
      { secretResolver?: unknown },
    ];
    expect(plainCall[2].secretResolver).toBeUndefined();
  });
});

describe('verify_case 空转硬上限', () => {
  it('同因连续失败达上限后强制停止（StagnantRoundLimit），且不再启动浏览器', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED], expectedOutcome: '最终状态达成' });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { judgeCaseOutcome } = await import('../src/agent/judgeCaseOutcome.js');
    vi.mocked(judgeCaseOutcome).mockResolvedValue({ passed: false, reason: '最终页面与预期不符' });
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');

    // 前 3 轮同因失败（失败大类签名 = vision）
    for (let i = 0; i < 3; i++) {
      const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
      expect(r.ok).toBe(true);
      const d = JSON.parse(r!.data!);
      expect(d.result).toBe('failed');
      expect(d.failure.failureReason).toBe('VisionAssertionFailed');
    }

    const { chromium } = await import('playwright-core');
    vi.mocked(chromium.launch).mockClear();
    const stopped = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(stopped.ok).toBe(true);
    const d = JSON.parse(stopped!.data!);
    expect(d.failure.failureReason).toBe('StagnantRoundLimit');
    expect(d.failure.humanMessage).toContain('强制停止');
    // 措辞加硬（prod228 2026-10-27：软提示被无视，agent 触发后读源码自诊 9~15 分钟）
    expect(d.failure.humanMessage).toContain('停止调用一切工具');
    expect(chromium.launch).not.toHaveBeenCalled(); // 短路不启动浏览器

    // 计数回退一级：下一次放行 1 次实测（仍同因失败会再次触发停止，不永久死锁）
    vi.mocked(chromium.launch).mockClear();
    const allowed = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(JSON.parse(allowed!.data!).failure.failureReason).toBe('VisionAssertionFailed');
    expect(chromium.launch).toHaveBeenCalled();
    // 放行轮显式警告：本轮结束后必须汇报，不得继续自行重试
    expect(JSON.parse(allowed!.data!).roundNotes[0]).toContain('护栏放行');
  });

  it('中途通过即清零，不触发强制停止', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED], expectedOutcome: '列表展示数据' });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { judgeCaseOutcome } = await import('../src/agent/judgeCaseOutcome.js');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');

    // 先攒 2 轮同因失败（未达上限 3）
    vi.mocked(judgeCaseOutcome).mockResolvedValue({ passed: false, reason: '不符 A' });
    for (let i = 0; i < 2; i++) {
      await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    }
    // 通过 → 计数清零
    vi.mocked(judgeCaseOutcome).mockResolvedValue({ passed: true, reason: '通过' });
    expect(JSON.parse((await buildVerifyCaseTool(toolCtx()).execute({ caseId }))!.data!).result).toBe('passed');
    // 计数确已清零：再连败 3 轮也只在第 4 次调用才触发（而非"通过前攒的 2 轮 + 这 3 轮"提前触发）
    vi.mocked(judgeCaseOutcome).mockResolvedValue({ passed: false, reason: '不符 B' });
    for (let i = 0; i < 3; i++) {
      const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
      expect(JSON.parse(r!.data!).failure.failureReason).toBe('VisionAssertionFailed');
    }
    const stopped = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(JSON.parse(stopped!.data!).failure.failureReason).toBe('StagnantRoundLimit');
  });

  it('失败大类归一：LocatorMismatch ↔ AiTaskAborted 振荡也计入同因连续，第 4 次调用强制停止', async () => {
    // prod228 2026-10-26 实录回归：26 轮 verify / 2h39m / 零产出里，locator 闸门击杀与 AI 相
    // abort 交替出现（同一页面障碍的两种形态），旧签名 `${failureReason}:${stepOrder}` 最长同签名
    // 连续仅 2 轮 → 护栏全程未触发。归一到失败大类后两类同属 execution，振荡不再绕过护栏。
    const caseId = await seedCase({
      steps: [[{ kind: 'click', locator: [{ strategy: 'css', value: '.osc-btn' }] }]],
    });
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { zeroLocators: string[] } };
    const { runAiTask } = await import('../src/execute/aiTask.js');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');

    // 第 1 轮：pre-check 命中 0 → LocatorMismatch
    __testState.zeroLocators.push('.osc-btn');
    const r1 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(JSON.parse(r1!.data!).failure.failureReason).toBe('LocatorMismatch');

    // 第 2 轮：locator 恢复命中，AI 相 reject → AiTaskAborted（与第 1 轮不同 reason、同类）
    __testState.zeroLocators.length = 0;
    vi.mocked(runAiTask).mockRejectedValueOnce(new Error('aiTask 放弃：找不到目标'));
    const r2 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(JSON.parse(r2!.data!).failure.failureReason).toBe('AiTaskAborted');

    // 第 3 轮：再次 LocatorMismatch —— 三轮 execution 大类连续，计数应已到上限
    __testState.zeroLocators.push('.osc-btn');
    const r3 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(JSON.parse(r3!.data!).failure.failureReason).toBe('LocatorMismatch');

    // 第 4 次调用：强制停止，且不再启动浏览器
    const { chromium } = await import('playwright-core');
    vi.mocked(chromium.launch).mockClear();
    const stopped = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(JSON.parse(stopped!.data!).failure.failureReason).toBe('StagnantRoundLimit');
    expect(JSON.parse(stopped!.data!).failure.humanMessage).toContain('execution');
    expect(chromium.launch).not.toHaveBeenCalled();
  });
});

describe('verify_case 超时预算', () => {
  it('全局预算随步数缩放：1-3 步保底 300s，4 步起线性增至 130s/步', async () => {
    // 回归动机（2026-10-17 prod228）：固定 300s 全局看门狗装不下 10 步用例——每步 AI 相 ~85-107s，
    // 3 步就烧 286.8s，第 4 步中途被 300s 预算强杀。预算必须随步数增长才谈得上多步用例可重复验证。
    const { computeVerifyTimeoutMs } = await import('../src/pi/space/tools/verifyCase.js');
    expect(computeVerifyTimeoutMs(0)).toBe(300_000); // 兜底（无步骤前置已拦截，绝不至于 0）
    expect(computeVerifyTimeoutMs(1)).toBe(300_000);
    expect(computeVerifyTimeoutMs(2)).toBe(300_000); // 2×130k=260k < 保底 → 仍 300k
    expect(computeVerifyTimeoutMs(3)).toBe(3 * 130_000); // 3×130k=390k 起越保底，线性爬升
    expect(computeVerifyTimeoutMs(4)).toBe(4 * 130_000);
    expect(computeVerifyTimeoutMs(10)).toBe(10 * 130_000); // 10 步 ≈ 21.7min
    expect(computeVerifyTimeoutMs(10)).toBeGreaterThan(300_000);
  });
});

describe('verify_case 轨迹收集（solidify 零执行复用的数据源）', () => {
  /** 视觉模式用例：instruction-only 步骤（compiled NULL）——轨迹收集的目标形态。返回逐步 step id。 */
  async function seedVisualCase(stepCount: number, opts?: { sensitiveFirst?: boolean }): Promise<{ caseId: string; stepIds: string[] }> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO test_cases(id, group_id, version_id, title, url, platform) VALUES ($1, $2, $3, '视觉用例', 'http://env.example/page', 'web')`,
      [id, groupId, versionId],
    );
    for (let i = 0; i < stepCount; i++) {
      await pool.query(
        `INSERT INTO test_steps(case_id, "order", source, instruction) VALUES ($1, $2, 'ai', $3)`,
        [id, i + 1, `第${i + 1}步：完成操作${i + 1}`],
      );
    }
    if (opts?.sensitiveFirst) {
      const { encrypt } = await import('../src/lib/secret-crypto.js');
      const enc = encrypt('StepSecret!9');
      await pool.query(
        `UPDATE test_steps SET sensitive = true, secret_ciphertext = $2, secret_iv = $3, secret_tag = $4
         WHERE case_id = $1 AND "order" = 1`,
        [id, enc.ciphertext.toString('base64'), enc.iv.toString('base64'), enc.tag.toString('base64')],
      );
    }
    const r = await pool.query(`SELECT id FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [id]);
    return { caseId: id, stepIds: r.rows.map((row) => row.id as string) };
  }

  it('整轮全过：视觉步轨迹入册（动作原样），traceSaved=true', async () => {
    const { caseId, stepIds } = await seedVisualCase(2);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask)
      .mockImplementationOnce(async (_p, _i, _c, _m, opts) => {
        opts?.onAction?.({ type: 'click', selector: '#btn-1' }, true);
        opts?.onAction?.({ type: 'screenshot', selector: 'body' }, true); // 观察性动作也收集，映射端跳过
        return '{"status":"passed","reason":"完成","login":"not-needed"}';
      })
      .mockImplementationOnce(async (_p, _i, _c, _m, opts) => {
        opts?.onAction?.({ type: 'fill', selector: '#name', value: '任务A' }, true);
        return '{"status":"passed","reason":"完成","login":"not-needed"}';
      });
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.result).toBe('passed');
    expect(data.traceSaved).toBe(true);
    const { getVerifiedTrace, traceKey } = await import('../src/pi/space/tools/verifyTrace.js');
    const entry = getVerifiedTrace(traceKey('t1', caseId));
    expect(entry).not.toBeNull();
    const t1 = entry!.trace.get(stepIds[0]!)!;
    expect(t1.map((a) => a.type)).toEqual(['click', 'screenshot']);
    expect((t1[0] as { selector: string }).selector).toBe('#btn-1');
    expect(entry!.trace.get(stepIds[1]!)!.length).toBe(1);
  });

  it('动作 ok=false 不收集；步骤失败 → 清缓存 + traceSaved 缺席', async () => {
    const { caseId } = await seedVisualCase(2);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask)
      .mockImplementationOnce(async (_p, _i, _c, _m, opts) => {
        opts?.onAction?.({ type: 'click', selector: '#ok' }, true);
        opts?.onAction?.({ type: 'click', selector: '#gone' }, false); // 失败动作不入轨迹
        return '{"status":"passed","reason":"完成","login":"not-needed"}';
      })
      .mockResolvedValueOnce('{"status":"failed","reason":"按钮不存在","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    const data = JSON.parse((r as { data: string }).data);
    expect(data.result).toBe('failed');
    expect(data.traceSaved).toBeUndefined();
    const { getVerifiedTrace, traceKey } = await import('../src/pi/space/tools/verifyTrace.js');
    expect(getVerifiedTrace(traceKey('t1', caseId))).toBeNull();
  });

  it('resume 轮全过：前缀轨迹携带 + 本轮 AI 相补齐 → 合并保存 traceSaved=true', async () => {
    const { caseId, stepIds } = await seedVisualCase(2);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    // 第 1 轮：步 1 过（收集 click），步 2 失败（confirmCache 记 confirmedThrough=1，轨迹随确认入册）
    vi.mocked(runAiTask)
      .mockImplementationOnce(async (_p, _i, _c, _m, opts) => {
        opts?.onAction?.({ type: 'click', selector: '#btn-1' }, true);
        return '{"status":"passed","reason":"完成","login":"not-needed"}';
      })
      .mockResolvedValueOnce('{"status":"failed","reason":"超时","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    // 第 2 轮：前缀机械恢复（不重跑 AI），步 2 通过并收集 fill
    vi.mocked(runAiTask).mockImplementationOnce(async (_p, _i, _c, _m, opts) => {
      opts?.onAction?.({ type: 'fill', selector: '#name', value: 'v2' }, true);
      return '{"status":"passed","reason":"完成","login":"not-needed"}';
    });
    const r2 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    const data2 = JSON.parse((r2 as { data: string }).data);
    expect(data2.result).toBe('passed');
    expect(data2.resumeFrom).toBe(1);
    expect(data2.traceSaved).toBe(true);
    const { getVerifiedTrace, traceKey } = await import('../src/pi/space/tools/verifyTrace.js');
    const entry = getVerifiedTrace(traceKey('t1', caseId));
    expect(entry).not.toBeNull();
    // 前缀步：轨迹来自第 1 轮携带（本轮机械恢复无 AI 动作）
    expect((entry!.trace.get(stepIds[0]!)![0] as { selector: string }).selector).toBe('#btn-1');
    // 改动步：本轮 AI 相新收集
    expect((entry!.trace.get(stepIds[1]!)![0] as { value: string }).value).toBe('v2');
  });

  it('敏感步骤不入轨迹（凭据属于环境）', async () => {
    const { caseId, stepIds } = await seedVisualCase(2, { sensitiveFirst: true });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"完成","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(JSON.parse((r as { data: string }).data).result).toBe('passed');
    const { getVerifiedTrace, traceKey } = await import('../src/pi/space/tools/verifyTrace.js');
    const entry = getVerifiedTrace(traceKey('t1', caseId));
    expect(entry).not.toBeNull();
    expect(entry!.trace.has(stepIds[0]!)).toBe(false); // 敏感步不在册
    expect(entry!.trace.has(stepIds[1]!)).toBe(true);
  });
});

describe('verify_case mechanical 机械验收模式', () => {
  it('通过路径：跳过 AI 相（runAiTask 零调用、初始 goto 不跑），只干跑 + 无终态预期直接 passed', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED, CLICK_COMPILED] });
    const emitLog: unknown[] = [];
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx(emitLog)).execute({ caseId, mode: 'mechanical' });
    expect(r.ok).toBe(true);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    expect(runAiTask).not.toHaveBeenCalled();
    expect(executeCaseInBrowser).toHaveBeenCalledTimes(1);
    const call = vi.mocked(executeCaseInBrowser).mock.calls[0]! as unknown as [
      string,
      Array<{ compiled: unknown[]; assertion: unknown }>,
      { reportId: string; expectedOutcome?: string; onPageReady?: unknown },
      unknown,
      unknown,
      string | undefined,
    ];
    expect(call[0]).toBe(caseId);
    expect(call[5]).toBe('http://env.example/page');
    expect(call[2].reportId).toMatch(/-replay$/);
    expect(call[2].expectedOutcome).toBeUndefined(); // 干跑 ctx 不带终态判定（verify 自己判）
    // 干跑 ctx 携带 web 服务 origin（相对 URL navigate 拼接用）与用例绑定服务名
    expect(call[2].caseWebOrigin).toBe('http://env.example');
    expect(call[2].caseWebServiceRef).toBeNull();
    expect(typeof call[2].onPageReady).toBe('function'); // 机械模式靠它拿终态页
    expect(call[1][0]!.compiled).toEqual(CLICK_COMPILED);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('passed');
      expect(data.mode).toBe('mechanical');
      expect(data.steps).toEqual([]); // 无 AI 相步骤结果
      expect(data.replay.result).toBe('passed');
      expect(data.login).toBeUndefined(); // 无 AI 自报
      expect(data.traceSaved).toBeUndefined(); // 机械轮不产轨迹
    }
    // SSE：start → replay_start → replay_done → end（无 step 事件）
    const phases = emitLog.map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['start', 'replay_start', 'replay_done', 'end']);
    expect(emitLog[0]).toMatchObject({ type: 'verify_progress', caseId, total: 2, mode: 'mechanical', resumeFrom: 0 });
    // 初始 goto 跳过（干跑引擎自带导航；无 AI 相页面无用途）
    expect(await fakeGotos()).toEqual([]);
    // 机械轮不动轨迹缓存（既不存也不清）
    const { getVerifiedTrace } = await import('../src/pi/space/tools/verifyTrace.js');
    expect(getVerifiedTrace(`t1::${caseId}`)).toBeNull();
  });

  it('allVisual 用例 → ok:false 拒绝并引导 full，不启动浏览器', async () => {
    const caseId = await seedCase({ steps: [null, null] }); // 纯 instruction 视觉步骤（compiled null）
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId, mode: 'mechanical' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('mechanical');
    const { chromium } = await import('playwright-core');
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it('干跑失败 → ReplayDivergence + note 提示 full 复核/登录态', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED] });
    const replayPageStub = {
      url: () => 'http://env.example/page',
      locator: (sel: string) => ({ count: async () => (sel.includes('#missing') ? 0 : 1) }),
      getByText: (t: string) => ({ count: async () => 1 }),
      getByRole: () => ({ count: async () => 1 }),
      getByTestId: () => ({ count: async () => 1 }),
    };
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    vi.mocked(executeCaseInBrowser).mockImplementationOnce(
      async (
        _cid: string,
        _steps: Array<{ order: number }>,
        _ctx: unknown,
        _browser: unknown,
        _context: unknown,
        _targetUrl: string | undefined,
        _onPreflight: unknown,
        _caseWindow: unknown,
        _onStep: unknown,
        onFailurePage?: (page: unknown, failedIndex: number) => Promise<void>,
      ) => {
        await onFailurePage?.(replayPageStub, 0);
        return [
          { order: 1, status: 'failed' as const, durationMs: 5, error: 'count=0 (role)', failureReason: 'LocatorAllFailed', humanMessage: '所有定位候选均未命中' },
        ];
      },
    );
    const emitLog: unknown[] = [];
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx(emitLog)).execute({ caseId, mode: 'mechanical' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      expect(data.mode).toBe('mechanical');
      expect(data.failure.failureReason).toBe('ReplayDivergence');
      expect(data.failure.stepOrder).toBe(1);
      expect(data.failure.page.elements[0]).toContain('button#del'); // 分叉现场页
      expect(data.failure.note).toContain('mode=full'); // 升级提示
      expect(data.failure.note).toContain('登录态');
    }
    const phases = emitLog.map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['start', 'replay_start', 'replay_done', 'end']);
  });

  it('干跑全过后终态判定在干跑页上跑：vision 不符 → VisionAssertionFailed', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED], expectedOutcome: '最终状态达成' });
    // onPageReady 交还干跑终态页 → vision 证据采集必须落在它上面（不是初始 about:blank page）
    const replayPageStub = {
      url: () => 'http://env.example/page',
      evaluate: async () => 0,
      screenshot: async () => Buffer.from('fake-png'),
      // pageSettle 视觉稳定判定要连拍两帧（evaluate 指纹）+ 间隔等待，缺一不可
      waitForTimeout: async () => {},
      waitForLoadState: async () => {},
      locator: (sel: string) => ({ count: async () => 1 }),
      getByText: (t: string) => ({ count: async () => 1 }),
      getByRole: () => ({ count: async () => 1 }),
      getByTestId: () => ({ count: async () => 1 }),
    };
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    vi.mocked(executeCaseInBrowser).mockImplementationOnce(
      async (
        _cid: string,
        steps: Array<{ order: number }>,
        ctx: { onPageReady?: (p: unknown) => void },
      ) => {
        ctx.onPageReady?.(replayPageStub);
        return steps.map((s) => ({ order: s.order, status: 'passed' as const, durationMs: 10 }));
      },
    );
    const { judgeCaseOutcome } = await import('../src/agent/judgeCaseOutcome.js');
    vi.mocked(judgeCaseOutcome).mockResolvedValue({ passed: false, reason: '最终页面与预期不符' });
    const emitLog: unknown[] = [];
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx(emitLog)).execute({ caseId, mode: 'mechanical' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      expect(data.mode).toBe('mechanical');
      expect(data.failure.failureReason).toBe('VisionAssertionFailed');
      expect(data.failure.note).toContain('机械验收模式');
      expect(data.failure.note).toContain('mode=full');
    }
    // vision 失败页 = 干跑终态页（onPageReady 交还的那个）
    const { extractPageElements } = await import('../src/pi/inspectPage.js');
    expect(vi.mocked(extractPageElements).mock.calls.at(-1)?.[0]).toBe(replayPageStub);
    // 终态判定事件：order=-1 的 step_done（前端进度卡渲染）
    const visionEvent = emitLog.find((e) => (e as { order?: number }).order === -1) as { status: string } | undefined;
    expect(visionEvent).toMatchObject({ status: 'failed' });
  });

  it('dropped 断言：环境与步骤哈希都一致才复用上一轮判定；步骤变更后不复用（字面进回放）', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED], assertions: ['登录表单正常展示'] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { judgeAssertionText } = await import('../src/pi/space/tools/assertionJudge.js');
    vi.mocked(judgeAssertionText).mockResolvedValue({ real: false, reason: '描述性短语' });
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');

    // 第 1 轮 full：断言被体检判为描述性短语 → dropped 记入前缀确认缓存
    const r1 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(JSON.parse(r1.data!).droppedAssertions).toHaveLength(1);

    // 第 2 轮 mechanical（步骤未变）：复用 dropped → 回放里该步 assertion 为 null（不再字面判定）
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    const r2 = await buildVerifyCaseTool(toolCtx()).execute({ caseId, mode: 'mechanical' });
    expect(r2.ok).toBe(true);
    const call2 = vi.mocked(executeCaseInBrowser).mock.calls.at(-1)! as unknown as [
      string,
      Array<{ assertion: unknown }>,
      unknown,
    ];
    expect(call2[1][0]!.assertion).toBeNull();
    if (r2.ok) {
      const d2 = JSON.parse(r2.data!);
      expect(d2.droppedAssertions).toHaveLength(1); // 原样回传供改写
    }

    // 第 3 轮 mechanical（步骤已暂存变更）：哈希不一致 → 不复用，新断言字面进回放
    // 注意 update_step 暂存 op 只承载 instruction/compiled（断言不在可改字段内），
    // 因此用「改 instruction」制造步骤哈希变化——这正是"该步内容变了"的真实场景。
    const stepRows = await pool.query(`SELECT id FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId]);
    const stepId = stepRows.rows[0]!.id as string;
    await pool.query(
      `INSERT INTO ai_stage_case_ops(thread_id, local_id, version_id, case_id, op, payload, summary, staged_at)
       VALUES ('t1', $1, $2, $3, 'update_step', $4::jsonb, '改指令', now())`,
      [randomUUID(), versionId, caseId, JSON.stringify({ action: 'update_step', caseId, stepId, instruction: '点击列表里的删除' })],
    );
    await buildVerifyCaseTool(toolCtx()).execute({ caseId, mode: 'mechanical' });
    const call3 = vi.mocked(executeCaseInBrowser).mock.calls.at(-1)! as unknown as [
      string,
      Array<{ assertion: unknown }>,
      unknown,
    ];
    // 该步内容变了 → 上一轮 dropped 判定不复用 → 断言按字面进回放
    expect(call3[1][0]!.assertion).toBe('登录表单正常展示');
    // 全程无 AI 轮次（第 1 轮 full 恰好 1 次）
    expect(runAiTask).toHaveBeenCalledTimes(1);
  });

  it('stagnant 守卫适用：mechanical 同因连续失败达上限 → 强制停止且不启动浏览器', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED] });
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    vi.mocked(executeCaseInBrowser).mockImplementation(
      async (_cid: string, steps: Array<{ order: number }>) =>
        steps.map((s) => ({ order: s.order, status: 'failed' as const, durationMs: 5, error: 'count=0', failureReason: 'LocatorAllFailed' })),
    );
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    for (let i = 0; i < 3; i++) {
      const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId, mode: 'mechanical' });
      expect(r.ok).toBe(true);
      const d = JSON.parse(r!.data!);
      expect(d.failure.failureReason).toBe('ReplayDivergence');
    }
    const { chromium } = await import('playwright-core');
    vi.mocked(chromium.launch).mockClear();
    const stopped = await buildVerifyCaseTool(toolCtx()).execute({ caseId, mode: 'mechanical' });
    expect(stopped.ok).toBe(true);
    const d = JSON.parse(stopped!.data!);
    expect(d.failure.failureReason).toBe('StagnantRoundLimit');
    expect(chromium.launch).not.toHaveBeenCalled();
  });
});

describe('verify_case 注册', () => {
  it('buildSpaceTools 包含 verify_case', async () => {
    const { buildSpaceTools } = await import('../src/pi/space/tools/index.js');
    const names = buildSpaceTools(toolCtx()).map((t) => t.name);
    expect(names).toContain('verify_case');
  });

  it('工具文案声明 mechanical 模式与 traceReused 轨迹复用（agent 依赖文案选路）', async () => {
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const tool = buildVerifyCaseTool(toolCtx());
    expect(tool.description).toContain('mode="mechanical"');
    expect(tool.description).toContain('轨迹');
    expect(tool.promptGuidelines.join('\n')).toContain('mode="mechanical"');
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const st = buildSolidifyCaseTool(toolCtx());
    expect(st.description).toContain('零执行');
    expect(st.promptGuidelines.join('\n')).toContain('mode="mechanical"');
  });

  it('工具文案声明 url 深链直达人 + 不写导航步（agent 依赖文案选路）', async () => {
    // prod228 2026-10-26 实录：用例 url 是门户首页 → agent 把「进入 XX 页面」菜单点击写进步骤，
    // 26 轮 verify 导航步烧掉 64-76% 执行时间；10-27 用户给出业务页深链后 goto 一步直达，导航开销≈0。
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const tool = buildVerifyCaseTool(toolCtx());
    expect(tool.description).toContain('深链');
    const guidelines = tool.promptGuidelines.join('\n');
    expect(guidelines).toContain('完整深链');
    expect(guidelines).toContain('不要写「打开/进入 XX 页面」');
    expect(guidelines).toContain('StagnantRoundLimit');
  });

  it('工具文案声明自然语言步 AI 相失败分流（agent 依赖文案选路：反馈用户而非重跑）', async () => {
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const guidelines = buildVerifyCaseTool(toolCtx()).promptGuidelines.join('\n');
    expect(guidelines).toContain('自然语言步骤的 AI 相失败分流');
    expect(guidelines).toContain('用户明确答复前不再调用 verify_case');
  });
});
