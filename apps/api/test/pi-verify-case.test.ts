import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// All-AI-driven orchestration test: runAiTask / writeStepScreenshot / extractPageElements are stubbed, focusing on the verify_case orchestration contract.
// Placeholder constants are defined at the execute layer (the verifyCase prompt takes them via aiTask.js); stub those too to isolate real dependencies.
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
  // Mechanical dry-run passes everything by default (step order passed through); failure/wiring details are overridden per-case via mockImplementationOnce
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
  // Template materialization/masking required by runCaseVisionAssert (no dataset variables/sensitive columns in verify scenarios, identity is enough)
  materializeExpectedOutcome: (t: string) => t,
  maskSensitiveValues: (t: string) => t,
  // Landing retry for the init pre-navigation (direct by default; retry semantics are unit-tested against the real implementation in cdp-goto-retry.test.ts)
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
// Wrap liveView with a spy: existing real behavior unchanged (registers into the in-memory table), so ctx.liveView=false cases can assert zero calls
vi.mock('../src/execute/liveView.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/execute/liveView.js')>();
  return { ...actual, registerLiveView: vi.fn(actual.registerLiveView) };
});
// LLM module stub: resolveLlmClient defaults to reading the settings table (the test DB has no provider config and would throw), so inject a fake client first.
vi.mock('../src/agent/llmSettings.js', () => ({
  resolveLlmClient: vi.fn(async () => ({
    config: { provider: 'anthropic', apiKey: 'fake', model: 'fake' },
    client: { provider: 'anthropic' as const, complete: async () => ({ kind: 'text' as const, value: '', provider: 'anthropic' as const, vision: false }) },
  })),
}));
// playwright stub: launch → context.newPage returns a minimal page; gotos records the initial navigation and ctxOpts records newContext args (exposed to tests via __testState).
// locator/getByText/getByTestId/getByRole simulate the count probing of compiled fidelity checks: selectors in zeroLocators always hit 0; multiLocators hit exactly 2 (multi-match); selectors containing :contains throw an invalid pseudo-class error (same as real Playwright).
vi.mock('playwright-core', () => {
  const state = {
    gotos: [] as string[], ctxOpts: [] as unknown[], zeroLocators: [] as string[], multiLocators: [] as string[],
    // SPA mount-lag simulation: sel → count() returns 1 from the Nth call onward (0 before that)
    mountAfter: {} as Record<string, number>, countCalls: {} as Record<string, number>,
    // Keep-alive stub switch: false → browser reports isConnected=false / page isClosed=true (= not keep-alive-able, same shape as a real browser
    // disconnect) → the finally check fails, closing on use; true → reports connected and page not closed → commit at round end.
    browserAlive: false,
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
        // The keep-alive check reads this (finally: browser.isConnected?.() === true)
        isConnected: () => state.browserAlive,
        newContext: vi.fn(async (opts?: unknown) => {
          state.ctxOpts.push(opts);
          return {
            newPage: async () => ({
              url: () => 'http://env.example/page',
              goto: async (u: string) => { state.gotos.push(u); },
              waitForLoadState: async () => {},
              waitForTimeout: async () => {},
              on: () => {}, // consoleCapture subscription (console/pageerror); the stub page needs no collection
              close: async () => {},
              // The keep-alive check reads this (finally: page.isClosed?.() === false)
              isClosed: () => !state.browserAlive,
              screenshot: async () => Buffer.from('fake-png'),
              // pageSettle's pixel fingerprint takes a number; the assertion text check takes the innerText string.
              // Always returns 0: two consecutive identical values → page has settled; in the innerText scenario it is always empty string, judge still decides semantically.
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
// judgeCaseOutcome stub: the LLM judge for vision final-state verdicts (the real implementation needs a vision model; tests inject the verdict).
vi.mock('../src/agent/judgeCaseOutcome.js', () => ({
  judgeCaseOutcome: vi.fn(async () => ({ passed: true, reason: 'ok' })),
}));
// assertionJudge stub: the LLM judge for assertion text vetting (the real implementation sends an LLM request; tests inject the verdict).
// Defaults to real=true (keep the assertion); only dedicated cases override via mockImplementationOnce.
vi.mock('../src/pi/space/tools/assertionJudge.js', () => ({
  judgeAssertionText: vi.fn(async () => ({ real: true, reason: '' })),
}));

let pool: Pool;
let projectId: string;
let groupId: string;
let versionId: string;

beforeAll(async () => {
  const pgDb = await createTestDatabase();
  process.env.DATABASE_URL = pgDb.uri;
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: pgDb.uri });
  await pool.query(SCHEMA_SQL);
  // SCHEMA_SQL does not yet include the staging tables, so this file creates them (aligned with src/db/schema.ts)
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
});

beforeEach(async () => {
  vi.clearAllMocks();
  const { __testState } = (await import('playwright-core')) as unknown as {
    __testState: { gotos: string[]; ctxOpts: unknown[]; zeroLocators: string[]; multiLocators: string[]; mountAfter: Record<string, number>; countCalls: Record<string, number>; browserAlive: boolean };
  };
  __testState.gotos.length = 0;
  __testState.ctxOpts.length = 0;
  __testState.zeroLocators.length = 0;
  __testState.multiLocators.length = 0;
  __testState.mountAfter = {};
  __testState.countCalls = {};
  __testState.browserAlive = false;
  // The keep-alive registry is in-process state: residue across cases would make a later round unexpectedly hit reuse and mask real behavior
  const { resetForTest } = await import('../src/pi/space/tools/browserSessions.js');
  resetForTest();
  await pool.query(`TRUNCATE test_steps, test_cases, test_environments, environment_objects,
    requirements, "groups", projects, project_versions, ai_threads, ai_stage_case_ops, ai_stage_cases
    RESTART IDENTITY CASCADE`);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  groupId = seed.groupId;
  versionId = seed.versionId;
  // Every case requires a resolvable environment (needed by resolveEnv): the default environment has no login credentials
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
  /** Step-level assertion in the same order as steps (for testing the step assertion text vetting) */
  assertions?: unknown[];
  expectedOutcome?: string | null;
  /** Mark only step 1 sensitive and inject ciphertext (plaintext StepSecret!9) */
  sensitiveStep1?: boolean;
  /** sensitive=true but no ciphertext injected (secret-missing scenario) */
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
  // First demote the default environment inserted by beforeEach (the only partial index test_environments_project_default_uq), then insert the new default
  await pool.query(`UPDATE test_environments SET is_default = false WHERE project_id = $1`, [projectId]);
  const env = await pool.query(
    `INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '登录环境', true) RETURNING id`,
    [projectId],
  );
  // Since 0041, login credentials are merged into the default web service object: user/loginUrl/secret embedded in payload
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

/** Vision-mode case: instruction-only steps (compiled NULL) — the target shape for trail collection and keep-alive resume. Returns per-step ids. */
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

/** Reads the initial navigation recorded by the playwright stub */
async function fakeGotos(): Promise<string[]> {
  const { __testState } = (await import('playwright-core')) as unknown as { __testState: { gotos: string[] } };
  return __testState.gotos;
}

/** Current default environment id (part of the loginStateCache key) */
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
    // One runAiTask per step; the instruction contains compiled and the step number
    expect(runAiTask).toHaveBeenCalledTimes(2);
    const call = vi.mocked(runAiTask).mock.calls[0]!;
    expect(String(call[1])).toContain('#missing');
    expect(String(call[1])).toContain('第 1 步 / 共 2 步');
    expect(String(call[1])).not.toContain('__ITEST_USERNAME__'); // No credentials → credential section not injected
    expect(call[4]).toMatchObject({ maxTurns: 5 });
    // Initial navigation is invoked (first step is not a same-URL navigate) — via gotoWithLandedRetry (with landing-validation retry fallback)
    const { gotoWithLandedRetry } = await import('../src/execute/cdp.js');
    expect(vi.mocked(gotoWithLandedRetry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gotoWithLandedRetry).mock.calls[0]![1]).toBe('http://env.example/page');
    // verify_progress SSE event sequence: start → (step_start + step_done)×2 → replay_start → replay_done → end
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

  it('成功路径也回传终态页元素清单(page)：边跑边讨论讨论控件只以实测清单为准', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"完成","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('passed');
      // The success response carries the page element list symmetrically with failure.page (prevents the agent from inventing page controls)
      expect(data.page.elements[0]).toContain('button#del');
    }
  });

  it('ctx.liveView=false：不注册实时画面且 start 无 liveUrl（批量后台链路）；缺省会话行为不变', async () => {
    const { registerLiveView } = await import('../src/execute/liveView.js');
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    // Off path: liveView=false → zero registration, start event without liveUrl
    const caseOff = await seedCase({ steps: [CLICK_COMPILED] });
    const emitOff: unknown[] = [];
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const rOff = await buildVerifyCaseTool({ ...toolCtx(emitOff), liveView: false }).execute({ caseId: caseOff });
    expect(rOff.ok).toBe(true);
    expect(registerLiveView).not.toHaveBeenCalled();
    const startOff = emitOff[0] as { liveUrl?: string };
    expect(startOff.liveUrl).toBeUndefined();
    // Default (undefined): the session chain still registers and carries the stream address
    const caseOn = await seedCase({ steps: [CLICK_COMPILED] });
    const emitOn: unknown[] = [];
    const rOn = await buildVerifyCaseTool(toolCtx(emitOn)).execute({ caseId: caseOn });
    expect(rOn.ok).toBe(true);
    expect(registerLiveView).toHaveBeenCalledTimes(1);
    const startOn = emitOn[0] as { liveUrl?: string };
    expect(startOn.liveUrl).toContain('/live/');
  });

  it('resume 轮后缀步失败 → 响应仍 ok:true（回归：stepResults 局部下标 vs failedIndex 全局下标）', async () => {
    // Exposed by prod228 field testing: after round 1 passes step 1 / fails step 2 (confirmedThrough=1), round 2 resumes the prefix and
    // step 2 fails again — the old code's stepResults[failedIndex] ran past the head of the local array (undefined → reading .order threw).
    const caseId = await seedCase({
      steps: [
        CLICK_COMPILED, // Step 1: count=1 hit, AI phase passes
        [{ kind: 'click', locator: [{ strategy: 'css', value: '.ghost-element' }] }], // Step 2: pre-check hits 0, fails
      ],
    });
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { zeroLocators: string[] } };
    __testState.zeroLocators.push('.ghost-element');
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');

    // Round 1: step 1 passes, step 2 pre-check fails
    const r1 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      const d1 = JSON.parse(r1.data!);
      expect(d1.result).toBe('failed');
      expect(d1.failure.failureReason).toBe('LocatorMismatch');
    }

    // Round 2: resume step 1 (mechanical replay, AI not re-run), step 2 fails again — must return ok:true with a full failure, not throw
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
    // Prefix does not re-run AI: across both rounds, only round 1 step 1 called runAiTask once
    expect(vi.mocked(runAiTask)).toHaveBeenCalledTimes(1);
    // The restore dry-run ctx likewise carries the web origin (resume prefix rebuild also dispatches relative-URL navigate)
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
    // Bare placeholders without @ref still resolve to the same service via the "case web_service_ref → environment default web" chain
    expect(opts.valueSub('__ITEST_USERNAME__')).toBe('qa01');
    expect(opts.valueSub('__ITEST_PASSWORD__')).toBe('Passw0rd!');
    expect(opts.valueSub('普通值')).toBe('普通值');
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.login).toBe('logged-in');
      expect(r.data).not.toContain('Passw0rd!');
    }
    // start event reports the credential user and cache miss; run once more to capture the event (the login state cache has been written back, so this run should be a hit — also covers the hit assertion)
    const emitLog: unknown[] = [];
    const r2 = await buildVerifyCaseTool(toolCtx(emitLog)).execute({ caseId });
    expect(r2.ok).toBe(true);
    const start2 = emitLog[0] as { loginCache: string; loginUser: string | null };
    expect(start2).toMatchObject({ loginCache: 'hit', loginUser: 'qa01' });
    // Prefix confirmation reuse: after round 1 fully passes, round 2's AI phase does not re-run (confirmed steps rebuild DOM state via mechanical replay),
    // runAiTask is still only called once in round 1; the event sequence has no step_*, only start → replay_start → replay_done → end.
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
    expect(runAiTask).toHaveBeenCalledTimes(2); // Stop as soon as step 2 fails; step 3 (none) never runs
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
    // Failure path: the failed step's step_done carries status=failed + reason, and end result=failed
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
      // Steps with compiled still get the locator-repair wording on failure (the agent can repair)
      expect(data.failure.note).toContain('修正 locator');
    }
  });

  it('自然语言步（无 compiled）AI 相失败 → note 分流反馈用户：停止重跑与自诊，不再引导修 locator', async () => {
    // Requirement framing (2026-10-27): in discussion-phase verification, a natural-language step's AI phase failing usually means the step description mismatches the page
    // (or earlier steps led the page astray) — the agent has no way to fix a selector and re-running changes nothing; it should be reported back to the user for adjustment.
    const caseId = await seedCase({ steps: [null] }); // instruction-only vision step (instruction=第一步：点击删除按钮)
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
      expect(data.failure.note).toContain('第一步：点击删除按钮'); // Original step text returned for relaying to the user
      expect(data.failure.note).not.toContain('修正 locator 只能使用'); // The old locator-repair wording must not mislead
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

  it('登录类用例（步骤引用凭据占位符）：缓存里有登录态也不注入——干净会话起跑', async () => {
    const localId = randomUUID();
    await pool.query(
      `INSERT INTO ai_stage_cases(thread_id, local_id, version_id, title, url, steps, staged_at)
       VALUES ('t1', $1, $2, '登录用例', 'http://env.example/login', $3::jsonb, now())`,
      [localId, versionId, JSON.stringify([
        {
          action: '在用户名输入框填入 __ITEST_USERNAME__，密码框填入 __ITEST_PASSWORD__，点击登录按钮',
          compiled: CLICK_COMPILED,
          assertion: null,
        },
      ])],
    );
    // Put a warm login state in the cache: for a normal case it would be injected (pinned by the previous case), but a login case must skip it
    const { saveLoginState } = await import('../src/pi/space/tools/loginStateCache.js');
    saveLoginState(`${await defaultEnvId()}:`, { cookies: [{ name: 'sid', value: 'warm' }], origins: [] } as never);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"logged-in"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId: localId });
    expect(r.ok).toBe(true);
    const { __testState } = (await import('playwright-core')) as unknown as {
      __testState: { ctxOpts: Array<Record<string, unknown> | undefined> };
    };
    expect(__testState.ctxOpts[0]).not.toHaveProperty('storageState');
    // STEP_SECRET is a step-level sensitive value (a business form password field), not a login signal — injection proceeds as usual
    const { isLoginCaseSteps } = await import('../src/pi/space/tools/verifyCase.js');
    expect(isLoginCaseSteps([{ instruction: '填入 __ITEST_STEP_SECRET__' }])).toBe(false);
    expect(isLoginCaseSteps([{ instruction: '普通步' }, { compiled: [{ kind: 'fill', value: '__ITEST_PASSWORD@web__' }] }])).toBe(true);
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
    // The AI sees the overlaid compiled (#real), not the DB's #missing
    const instruction = String(vi.mocked(runAiTask).mock.calls[0]![1]);
    expect(instruction).toContain('#real');
    expect(instruction).not.toContain('#missing');
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.basedOn).toBe('staged');
      expect(data.stagedOpsApplied).toBe(1);
    }
    // start event reports the staging overlay count → the frontend's "based on staging (1 modification)" badge
    const start = emitLog[0] as { stagedOps: number };
    expect(start.stagedOps).toBe(1);
    // Nothing persisted: the DB step's compiled is still #missing
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
    // The LLM sees the draft's compiled (#newBtn); the instruction contains the url fallback (a draft without a group goes through the dual-line beyond env baseUrl) and the step number
    const call = vi.mocked(runAiTask).mock.calls[0]!;
    expect(String(call[1])).toContain('#newBtn');
    expect(String(call[1])).toContain('第 1 步 / 共 2 步');
    // start event carries the draft flag
    const start = emitLog[0] as { caseId: string; stagedOps: number };
    expect(start).toMatchObject({ caseId: localId, stagedOps: 0 });
  });

  it('非 UUID 草稿 localId：跳过 uuid 列查询直查草稿（回归 prod228 invalid input syntax for type uuid）', async () => {
    const localId = 'login-a-positiven';
    await pool.query(
      `INSERT INTO ai_stage_cases(thread_id, local_id, version_id, title, url, steps, staged_at)
       VALUES ('t1', $1, $2, '草稿-短名localId', 'http://env.example/page', $3::jsonb, now())`,
      [localId, versionId, JSON.stringify([{ action: '点击', compiled: CLICK_COMPILED, assertion: null }])],
    );
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId: localId });
    // Before the fix: query testCases.id (uuid column) directly first → invalid input syntax for type uuid, and the draft fallback never got a chance to run
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('passed');
      expect(data.basedOn).toBe('staged');
      expect(data.caseId).toBe(localId);
    }
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
    expect(runAiTask).not.toHaveBeenCalled(); // Blocked upfront, no AI rounds burned
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
      // The AI clearly reported passed, yet the fidelity check still judges failure (replay would see count=0)
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
      // Any candidate hitting counts as pass — only all candidates hitting 0 is a replay failure
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
    // Regression of backtest 8a178d83's root cause: after networkidle the page still had not finished mounting; probing gave up and the element appeared ~2s later.
    // The verify pre-check/post-check window is aligned with replay (12 polling rounds); late-mounting elements should pass rather than be judged LocatorMismatch.
    const caseId = await seedCase({
      steps: [[{ kind: 'assertVisible', locator: [{ strategy: 'css', value: '.late-mount' }] }]],
    });
    const { __testState } = (await import('playwright-core')) as unknown as {
      __testState: { mountAfter: Record<string, number>; countCalls: Record<string, number> };
    };
    __testState.mountAfter['.late-mount'] = 3; // First 2 probes return 0; mounting completes on the 3rd
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
    // Regression motivation: AI-generated bare-tag candidates like '#ruleconfig1 .baseForm input' hit every input in the form,
    // and replay's strict-mode fallback .first() silently fills the first field — a verify that only tests count>0 would let "coincidentally correct" through.
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
    expect(runAiTask).toHaveBeenCalledTimes(1); // fill is a post-check: the AI runs first, and the element should still be there
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
    expect(runAiTask).not.toHaveBeenCalled(); // Blocked upfront, the AI does not run
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
      // Replay probing order = buildCandidates order: css .multi-a hits first (count=2) and is adopted; the unique role candidate never gets used
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
      expect(data.steps[0].status).toBe('passed'); // The step itself is fine; death is at final state
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
    // The assertion original text is returned so the agent can rewrite it into real UI text, instead of sneaking through by weakening the assertion
    expect(data.droppedAssertions).toEqual([{ order: 1, assertion: '登录表单正常展示' }]);
    // The AI-phase instruction carries an "ignored" note, so it no longer tries to verify text that does not exist on the page
    const instr = String(vi.mocked(runAiTask).mock.calls[0]![1]);
    expect(instr).toContain('断言：已忽略');
    expect(instr).toContain('登录表单正常展示');
    // Mechanical replay also skips this assertion (replay dispatches verbatim; running it would only waste one check)
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
    // Source for relative-URL navigate joining (prod228 gap 2: previously the dry-run ctx lacked these two fields and every navigate was invalid-navigate-url)
    expect(ctxArg.caseWebOrigin).toBe('http://env.example');
    expect(ctxArg.caseWebServiceRef).toBeNull();
    // Screenshot directory isolation (-replay suffix) to avoid overwriting the AI phase's same-named step-N.png; final-state verdict does not re-run
    expect(ctxArg.reportId).toMatch(/-replay$/);
    expect(ctxArg.expectedOutcome).toBeUndefined();
    // compiled is passed verbatim to the mechanical replay engine; browser/context reuse verify's own instances (login state carried via cookies)
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
      // Attribution evidence (probeLocatorHits) probes live candidate hits against the dry-run page — the real replay page has a locator, so the stub completes the same shape.
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
        // Simulate the real engine calling back onFailurePage on failure (verify uses this to keep the dry-run page reference)
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
      expect(data.steps[0].status).toBe('passed'); // AI phase fully passed, death at mechanical replay
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
    // The failure-page element list comes from the dry-run page (the divergence scene), not the AI's old page
    const { extractPageElements } = await import('../src/pi/inspectPage.js');
    expect(vi.mocked(extractPageElements).mock.calls.at(-1)?.[0]).toBe(replayPageStub);
    // SSE sequence: AI steps all pass → replay_start → replay_done(failed) → end(failed)
    const phases = emitLog.map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['start', 'step_start', 'step_done', 'replay_start', 'replay_done', 'end']);
    const replayDone = emitLog[4] as { status: string; reason: string };
    expect(replayDone).toMatchObject({ status: 'failed', reason: '所有定位候选均未命中' });
    const end = emitLog.at(-1) as { result: string };
    expect(end.result).toBe('failed');
  });

  it('全视觉用例（无 compiled）跳过机械干跑 → 响应不带 replay 摘要（不报 epoch 假时长）', async () => {
    // Regression point: when the dry run is skipped, replayStartedAt stays 0, and the previously unconditional
    // replay.durationMs = Date.now()-0 was an epoch-scale garbage value (seen 6 times on prod228).
    const caseId = await seedCase({ steps: [null, null] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    expect(executeCaseInBrowser).not.toHaveBeenCalled(); // No compiled to dispatch verbatim → dry run skipped
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
    // Staged/DB step ids map directly to decrypted plaintext (the DB-default secretResolver DB-query chain does not apply in the verify context)
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

    // First 3 rounds fail for the same reason (failure category signature = vision)
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
    // Hardened wording (prod228 2026-10-27: the soft notice was ignored; the agent spent 9~15 minutes reading source self-diagnosing after triggering)
    expect(d.failure.humanMessage).toContain('停止调用一切工具');
    expect(chromium.launch).not.toHaveBeenCalled(); // Short-circuited, browser not launched

    // Counter steps back one level: the next run allows 1 real attempt (another same-cause failure triggers stop again; no permanent deadlock)
    vi.mocked(chromium.launch).mockClear();
    const allowed = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(JSON.parse(allowed!.data!).failure.failureReason).toBe('VisionAssertionFailed');
    expect(chromium.launch).toHaveBeenCalled();
    // Allowed round shows an explicit warning: must report after this round ends, no more self-directed retries
    expect(JSON.parse(allowed!.data!).roundNotes[0]).toContain('护栏放行');
  });

  it('中途通过即清零，不触发强制停止', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED], expectedOutcome: '列表展示数据' });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { judgeCaseOutcome } = await import('../src/agent/judgeCaseOutcome.js');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');

    // First accumulate 2 rounds of same-cause failures (below the limit of 3)
    vi.mocked(judgeCaseOutcome).mockResolvedValue({ passed: false, reason: '不符 A' });
    for (let i = 0; i < 2; i++) {
      await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    }
    // Pass → counter resets to zero
    vi.mocked(judgeCaseOutcome).mockResolvedValue({ passed: true, reason: '通过' });
    expect(JSON.parse((await buildVerifyCaseTool(toolCtx()).execute({ caseId }))!.data!).result).toBe('passed');
    // Counter is indeed reset: 3 more consecutive failures trigger only on the 4th call (not early via "the 2 rounds accumulated before the pass + these 3 rounds")
    vi.mocked(judgeCaseOutcome).mockResolvedValue({ passed: false, reason: '不符 B' });
    for (let i = 0; i < 3; i++) {
      const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
      expect(JSON.parse(r!.data!).failure.failureReason).toBe('VisionAssertionFailed');
    }
    const stopped = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(JSON.parse(stopped!.data!).failure.failureReason).toBe('StagnantRoundLimit');
  });

  it('失败大类归一：LocatorMismatch ↔ AiTaskAborted 振荡也计入同因连续，第 4 次调用强制停止', async () => {
    // prod228 2026-10-26 field regression: in 26 verify rounds / 2h39m / zero output, locator-gate kills and AI-phase
    // aborts alternated (two shapes of the same page obstacle); the old signature `${failureReason}:${stepOrder}` had a max same-signature
    // streak of only 2 rounds → the guard never triggered. After normalizing to failure category, both belong to execution, so oscillation no longer bypasses the guard.
    const caseId = await seedCase({
      steps: [[{ kind: 'click', locator: [{ strategy: 'css', value: '.osc-btn' }] }]],
    });
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { zeroLocators: string[] } };
    const { runAiTask } = await import('../src/execute/aiTask.js');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');

    // Round 1: pre-check hits 0 → LocatorMismatch
    __testState.zeroLocators.push('.osc-btn');
    const r1 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(JSON.parse(r1!.data!).failure.failureReason).toBe('LocatorMismatch');

    // Round 2: locator recovers, AI phase rejects → AiTaskAborted (different reason from round 1, same category)
    __testState.zeroLocators.length = 0;
    vi.mocked(runAiTask).mockRejectedValueOnce(new Error('aiTask 放弃：找不到目标'));
    const r2 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(JSON.parse(r2!.data!).failure.failureReason).toBe('AiTaskAborted');

    // Round 3: LocatorMismatch again — three consecutive rounds in the execution category, the counter should have hit the limit
    __testState.zeroLocators.push('.osc-btn');
    const r3 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(JSON.parse(r3!.data!).failure.failureReason).toBe('LocatorMismatch');

    // 4th call: forced stop, browser not launched again
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
    // Regression motivation (2026-10-17 prod228): the fixed 300s global watchdog cannot fit a 10-step case — each step's AI phase takes ~85-107s,
    // 3 steps already burn 286.8s and step 4 gets killed mid-flight by the 300s budget. The budget must grow with step count for multi-step re-verification to be viable.
    const { computeVerifyTimeoutMs } = await import('../src/pi/space/tools/verifyCase.js');
    expect(computeVerifyTimeoutMs(0)).toBe(300_000); // Fallback (no-steps is blocked earlier, so 0 never happens)
    expect(computeVerifyTimeoutMs(1)).toBe(300_000);
    expect(computeVerifyTimeoutMs(2)).toBe(300_000); // 2×130k=260k < floor → still 300k
    expect(computeVerifyTimeoutMs(3)).toBe(3 * 130_000); // 3×130k=390k crosses the floor, climbing linearly
    expect(computeVerifyTimeoutMs(4)).toBe(4 * 130_000);
    expect(computeVerifyTimeoutMs(10)).toBe(10 * 130_000); // 10 steps ≈ 21.7min
    expect(computeVerifyTimeoutMs(10)).toBeGreaterThan(300_000);
  });
});

describe('verify_case 轨迹收集（solidify 零执行复用的数据源）', () => {
  it('整轮全过：视觉步轨迹入册（动作原样），traceSaved=true', async () => {
    const { caseId, stepIds } = await seedVisualCase(2);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask)
      .mockImplementationOnce(async (_p, _i, _c, _m, opts) => {
        opts?.onAction?.({ type: 'click', selector: '#btn-1' }, true);
        opts?.onAction?.({ type: 'screenshot', selector: 'body' }, true); // Observational actions are also collected; the mapping side skips them
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
        opts?.onAction?.({ type: 'click', selector: '#gone' }, false); // Failed actions do not enter the trail
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
    // Round 1: step 1 passes (collects click), step 2 fails (confirmCache records confirmedThrough=1, trail enters the ledger with confirmation)
    vi.mocked(runAiTask)
      .mockImplementationOnce(async (_p, _i, _c, _m, opts) => {
        opts?.onAction?.({ type: 'click', selector: '#btn-1' }, true);
        return '{"status":"passed","reason":"完成","login":"not-needed"}';
      })
      .mockResolvedValueOnce('{"status":"failed","reason":"超时","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    // Round 2: prefix recovered mechanically (AI not re-run), step 2 passes and collects fill
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
    // Prefix step: trail comes from round 1 carry-over (this round's mechanical recovery has no AI actions)
    expect((entry!.trace.get(stepIds[0]!)![0] as { selector: string }).selector).toBe('#btn-1');
    // Changed step: newly collected by this round's AI phase
    expect((entry!.trace.get(stepIds[1]!)![0] as { value: string }).value).toBe('v2');
  });

  it('resume restore 吃确认轨迹：纯 NL 前缀步收到映射后的机械 compiled（不再 compile-missing 打断重跑）', async () => {
    // Gap regression: mapForReplay carried no instruction, so pure-NL prefix steps hit compile-missing in restore,
    // and resume degenerated into "re-run the AI phase wholesale from the first NL step". After wiring confirmedTraces → mapAiActionsToCompiled,
    // the restore slice receives mechanical actions and rebuilds prefix state with zero LLM / zero screenshots.
    const { caseId } = await seedVisualCase(2);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask)
      .mockImplementationOnce(async (_p, _i, _c, _m, opts) => {
        opts?.onAction?.({ type: 'click', selector: '#btn-1' }, true);
        return '{"status":"passed","reason":"完成","login":"not-needed"}';
      })
      .mockResolvedValueOnce('{"status":"failed","reason":"失败","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    await buildVerifyCaseTool(toolCtx()).execute({ caseId }); // Round 1: step 1 passes, step 2 fails
    // Round 2: restore (prefix step 1) → AI phase runs only step 2
    vi.mocked(runAiTask).mockResolvedValueOnce('{"status":"passed","reason":"完成","login":"not-needed"}');
    const r2 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r2.ok).toBe(true);
    const data2 = JSON.parse((r2 as { data: string }).data);
    expect(data2.resumeFrom).toBe(1);
    expect(data2.result).toBe('passed');
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    // Round 1's failure makes no cdp call; all-vision cases skip the ending dry run → the only cdp call in round 2 is the restore
    expect(executeCaseInBrowser).toHaveBeenCalledTimes(1);
    const restoreSteps = vi.mocked(executeCaseInBrowser).mock.calls[0]![1] as Array<{ compiled: unknown }>;
    expect(restoreSteps[0]!.compiled).toEqual([
      { kind: 'click', locator: [{ strategy: 'css', value: '#btn-1' }] },
    ]);
    // AI phase runs only step 2: 3 calls across both rounds (round 1 ×2 + round 2 ×1); prefix steps do not re-burn recognition
    expect(runAiTask).toHaveBeenCalledTimes(3);
  });

  it('确认轨迹映射失败（坐标动作未解析回 selector）→ 该前缀步不可机械恢复 → 跳过注定断链的回放', async () => {
    const { caseId } = await seedVisualCase(2);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask)
      .mockImplementationOnce(async (_p, _i, _c, _m, opts) => {
        opts?.onAction?.({ type: 'click', x: 500, y: 400 }, true); // Coordinate action, no selector
        return '{"status":"passed","reason":"完成","login":"not-needed"}';
      })
      .mockResolvedValueOnce('{"status":"failed","reason":"失败","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"完成","login":"not-needed"}');
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    const r2 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    const data2 = JSON.parse((r2 as { data: string }).data);
    // Coordinate actions have no way to be dispatched by mechanical replay → the prefix step cannot be recovered → do not feed it into the replay slice (otherwise it is guaranteed
    // to break the chain at compile-missing and waste a replay destined to fail while also knocking the recovery convergence point back to that step): the AI phase takes over from step 1.
    expect(executeCaseInBrowser).not.toHaveBeenCalled();
    expect(data2.resumeFrom).toBe(0);
  });

  it('混合前缀：编译过的 UI 步保留原 compiled 不吃轨迹；视觉步吃轨迹——结尾干跑只喂纯机械步（无纯机械步则整段跳过）', async () => {
    const caseId = await seedCase({ steps: [null, CLICK_COMPILED, null] }); // NL / compiled UI step / NL
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask)
      .mockImplementationOnce(async (_p, _i, _c, _m, opts) => {
        opts?.onAction?.({ type: 'click', selector: '#btn-1' }, true);
        return '{"status":"passed","reason":"完成","login":"not-needed"}';
      })
      // Step 2 (mechanical step, AI phase passes as usual with compiled as reference, no trail)
      .mockResolvedValueOnce('{"status":"passed","reason":"完成","login":"not-needed"}')
      .mockResolvedValueOnce('{"status":"failed","reason":"失败","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    await buildVerifyCaseTool(toolCtx()).execute({ caseId }); // Round 1: steps 1-2 pass, step 3 fails
    vi.mocked(runAiTask).mockResolvedValueOnce('{"status":"passed","reason":"完成","login":"not-needed"}');
    const r2 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r2.ok).toBe(true);
    const data2 = JSON.parse((r2 as { data: string }).data);
    expect(data2.resumeFrom).toBe(2);
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    // Round 2: only restore (prefix 2 steps) — the ending dry run only feeds "pure mechanical steps"; this example's only compiled is a click
    // (a compiled UI step that cannot be replayed alone without the NL precondition state) → the whole dry-run segment is skipped, no longer misreporting divergence via NL-step compile-missing
    expect(executeCaseInBrowser).toHaveBeenCalledTimes(1);
    const restoreSteps = vi.mocked(executeCaseInBrowser).mock.calls[0]![1] as Array<{ compiled: unknown }>;
    expect(restoreSteps[0]!.compiled).toEqual([
      { kind: 'click', locator: [{ strategy: 'css', value: '#btn-1' }] },
    ]);
    expect(restoreSteps[1]!.compiled).toEqual(CLICK_COMPILED); // Compiled UI step kept as-is, not overwritten by the trail
    expect(data2.result).toBe('passed');
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
    expect(entry!.trace.has(stepIds[0]!)).toBe(false); // Sensitive step not in the ledger
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
    expect(call[2].expectedOutcome).toBeUndefined(); // The dry-run ctx carries no final-state verdict (verify judges itself)
    // The dry-run ctx carries the web service origin (for relative-URL navigate joining) and the case-bound service name
    expect(call[2].caseWebOrigin).toBe('http://env.example');
    expect(call[2].caseWebServiceRef).toBeNull();
    expect(typeof call[2].onPageReady).toBe('function'); // Mechanical mode uses it to obtain the final-state page
    expect(call[1][0]!.compiled).toEqual(CLICK_COMPILED);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('passed');
      expect(data.mode).toBe('mechanical');
      expect(data.steps).toEqual([]); // No AI-phase step results
      expect(data.replay.result).toBe('passed');
      expect(data.login).toBeUndefined(); // No AI self-report
      expect(data.traceSaved).toBeUndefined(); // Mechanical rounds produce no trail
    }
    // SSE: start → replay_start → replay_done → end (no step events)
    const phases = emitLog.map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['start', 'replay_start', 'replay_done', 'end']);
    expect(emitLog[0]).toMatchObject({ type: 'verify_progress', caseId, total: 2, mode: 'mechanical', resumeFrom: 0 });
    // Initial goto skipped (the dry-run engine navigates itself; without an AI phase the page has no use)
    expect(await fakeGotos()).toEqual([]);
    // Mechanical rounds leave the trail cache untouched (neither saved nor cleared)
    const { getVerifiedTrace } = await import('../src/pi/space/tools/verifyTrace.js');
    expect(getVerifiedTrace(`t1::${caseId}`)).toBeNull();
  });

  it('allVisual 用例 → ok:false 拒绝并引导 full，不启动浏览器', async () => {
    const caseId = await seedCase({ steps: [null, null] }); // Pure instruction vision steps (compiled null)
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId, mode: 'mechanical' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('mechanical');
    const { chromium } = await import('playwright-core');
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it('全 aiTask 固化结果 → mechanical 放行并干跑（aiTask 是可派发动作，不强迫重跑 full）', async () => {
    // Regression motivation: 2026-10-28 prod228 field report — solidify solidifies steps that cannot be mapped mechanically into aiTask execution steps,
    // but all-aiTask cases were shut out by the old rule (isAllVisualSteps), forcing the agent to run the explicitly forbidden full again.
    const AI_TASK_COMPILED = [{ kind: 'aiTask', instruction: '点击删除按钮' }];
    const caseId = await seedCase({ steps: [AI_TASK_COMPILED, AI_TASK_COMPILED] });
    const emitLog: unknown[] = [];
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx(emitLog)).execute({ caseId, mode: 'mechanical' });
    expect(r.ok).toBe(true);
    // verify itself does not run the AI phase; in the dry run, aiTask is dispatched by the execution engine (this test mocks the engine and only verifies the gate and arguments)
    const { runAiTask } = await import('../src/execute/aiTask.js');
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    expect(runAiTask).not.toHaveBeenCalled();
    expect(executeCaseInBrowser).toHaveBeenCalledTimes(1);
    const call = vi.mocked(executeCaseInBrowser).mock.calls[0]! as unknown as [
      string,
      Array<{ compiled: unknown[] }>,
    ];
    expect(call[1][0]!.compiled).toEqual(AI_TASK_COMPILED);
    expect(call[1][1]!.compiled).toEqual(AI_TASK_COMPILED);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('passed');
      expect(data.mode).toBe('mechanical');
      expect(data.replay.result).toBe('passed');
    }
    const phases = emitLog.map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['start', 'replay_start', 'replay_done', 'end']);
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
      expect(data.failure.page.elements[0]).toContain('button#del'); // The divergence scene page
      expect(data.failure.note).toContain('mode=full'); // Upgrade hint
      expect(data.failure.note).toContain('登录态');
    }
    const phases = emitLog.map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['start', 'replay_start', 'replay_done', 'end']);
  });

  it('干跑全过后终态判定在干跑页上跑：vision 不符 → VisionAssertionFailed', async () => {
    const caseId = await seedCase({ steps: [CLICK_COMPILED], expectedOutcome: '最终状态达成' });
    // onPageReady hands back the dry-run final-state page → vision evidence collection must land on it (not the initial about:blank page)
    const replayPageStub = {
      url: () => 'http://env.example/page',
      evaluate: async () => 0,
      screenshot: async () => Buffer.from('fake-png'),
      // pageSettle's visual-stability verdict needs two consecutive frames (evaluate fingerprints) + an interval wait; neither can be missing
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
    // The vision failure page = the dry-run final-state page (the one handed back by onPageReady)
    const { extractPageElements } = await import('../src/pi/inspectPage.js');
    expect(vi.mocked(extractPageElements).mock.calls.at(-1)?.[0]).toBe(replayPageStub);
    // Final-state verdict event: step_done with order=-1 (frontend progress card rendering)
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

    // Round 1 full: the assertion is vetted as a descriptive phrase → dropped is recorded into the prefix confirmation cache
    const r1 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(JSON.parse(r1.data!).droppedAssertions).toHaveLength(1);

    // Round 2 mechanical (steps unchanged): reuses dropped → that step's assertion in replay is null (no longer judged literally)
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
      expect(d2.droppedAssertions).toHaveLength(1); // Returned as-is for rewriting
    }

    // Round 3 mechanical (step changed via staging): hash mismatch → no reuse, the new assertion goes into replay literally
    // Note: the update_step staging op only carries instruction/compiled (assertions are not among the editable fields),
    // so "changing the instruction" is used to create the step-hash change — exactly the real scenario of "this step's content changed".
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
    // This step's content changed → the previous round's dropped verdict is not reused → the assertion enters replay literally
    expect(call3[1][0]!.assertion).toBe('登录表单正常展示');
    // Zero AI rounds throughout (round 1 full happens to be 1)
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
    // prod228 2026-10-26 field report: the case url was the portal home page → the agent wrote the "enter XX page" menu click into steps,
    // and 26 verify rounds burned 64-76% of execution time on navigation steps; on 10-27 the user supplied a business-page deep link and one goto landed directly, navigation overhead ≈ 0.
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

describe('verify_case 机械执行步（不经浏览器）', () => {
  const SQL_COMPILED = [
    { kind: 'sql', sql: 'select asset_name from t where host_ip = ?', params: ['{{ip}}'], assertion: { match: 'contains', expected: 'x' } },
  ];

  beforeEach(async () => {
    // Reset the dry-run stub to default all-pass: clearAllMocks only clears call records, not implementations;
    // a mockImplementation left by the previous case (the failing one) would leak here and pollute results.
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    vi.mocked(executeCaseInBrowser).mockImplementation(
      async (_cid: string, steps: Array<{ order: number }>) =>
        steps.map((s) => ({ order: s.order, status: 'passed' as const, durationMs: 10 })),
    );
  });

  it('纯 sql 步：AI 相不执行该步（浏览器无 DB 通道），由结尾干跑裁决', async () => {
    // Regression point: prod228 2026-10-28 field report — the AI phase was asked to execute SQL and repeatedly tried over 5 rounds without success
    // (the agent noted "the AI phase is a browser executor and cannot execute SQL queries against the database"). Mechanical steps should not enter the AI phase.
    const caseId = await seedCase({ steps: [SQL_COMPILED] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const emitLog: unknown[] = [];
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx(emitLog)).execute({ caseId });
    expect(r.ok).toBe(true);
    // The AI phase was never called (that step is skipped, and no other steps exist)
    expect(vi.mocked(runAiTask)).not.toHaveBeenCalled();
    // Dry run still runs (the verdict belongs to it)
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    expect(executeCaseInBrowser).toHaveBeenCalledTimes(1);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.result).toBe('passed');
    // The step is recorded as passed in steps, noting that the dry run decides it
    expect(data.steps[0].status).toBe('passed');
    expect(String(data.steps[0].warning)).toContain('机械执行步');
  });

  it('混合步（click + sql）：AI 相只做浏览器那半，指令里明说机械部分别碰', async () => {
    const caseId = await seedCase({
      steps: [[{ kind: 'click', locator: [{ strategy: 'css', value: '#ok' }] }, ...SQL_COMPILED]],
    });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    expect(vi.mocked(runAiTask)).toHaveBeenCalledTimes(1);
    const instruction = vi.mocked(runAiTask).mock.calls[0]![1] as string;
    expect(instruction).toContain('只负责浏览器里的那部分动作');
  });

  it('干跑查库结果随响应带出：replay.steps[].sql 含 dbRef/rowCount/rows（agent 据此认真值）', async () => {
    // Regression point: prod228 2026-10-28 — the agent could not see the DB query's returned rows and had to build 15 PROBE probe cases in a row to feel out the table structure.
    const caseId = await seedCase({ steps: [SQL_COMPILED] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    vi.mocked(executeCaseInBrowser).mockImplementationOnce(
      async (_cid: string, steps: Array<{ order: number }>) =>
        steps.map((s) => ({
          order: s.order,
          status: 'passed' as const,
          durationMs: 7,
          sql: {
            dbRef: 'SIEM数据库',
            rowCount: 1,
            durationMs: 11,
            rows: [{ asset_name: 'paas-es-test-02' }],
            assertion: { matched: true, expected: 'x', match: 'contains' as const },
          },
        })),
    );
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.replay.steps[0].sql.dbRef).toBe('SIEM数据库');
    expect(data.replay.steps[0].sql.rowCount).toBe(1);
    expect(data.replay.steps[0].sql.rows).toEqual([{ asset_name: 'paas-es-test-02' }]);
  });

  it('干跑查库断言失败：failure.sql 带出实际行（断言未命中时 rows 仍在）', async () => {
    const caseId = await seedCase({ steps: [SQL_COMPILED] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    vi.mocked(executeCaseInBrowser).mockImplementationOnce(
      async (_cid: string, steps: Array<{ order: number }>) =>
        steps.map((s) => ({
          order: s.order,
          status: 'failed' as const,
          durationMs: 9,
          error: 'sql assertion failed',
          failureReason: 'SqlAssertionFailed' as const,
          humanMessage: 'SQL 结果断言未命中',
          sql: {
            dbRef: 'SIEM数据库',
            rowCount: 0,
            durationMs: 5,
            rows: [],
            assertion: { matched: false, expected: 'x', match: 'contains' as const },
          },
        })),
    );
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.result).toBe('failed');
    expect(data.failure.failureReason).toBe('ReplayDivergence');
    expect(data.failure.sql.dbRef).toBe('SIEM数据库');
    expect(data.failure.sql.assertion.matched).toBe(false);
  });

  it('混合用例（自然语言步 + sql 步）：AI 相跳 sql 步，结尾干跑只喂 sql 步（不再误报 ReplayDivergence）', async () => {
    // Regression point: after discussion-phase DB/API steps got compiled, the "all compiled" check became false → the dry run started →
    // dispatching natural-language steps verbatim is guaranteed compile-missing → the whole case was misjudged ReplayDivergence (mixed cases always failed falsely under the old rule).
    // New rule: full + mixed → the dry run only feeds pure mechanical steps (DB/API steps do not depend on browser page state and can be genuinely adjudicated).
    const caseId = await seedCase({ steps: [null, SQL_COMPILED] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    // The AI phase only runs natural-language steps; the sql step is skipped (never goes through the browser)
    expect(vi.mocked(runAiTask)).toHaveBeenCalledTimes(1);
    expect(data.steps[1].status).toBe('passed');
    expect(String(data.steps[1].warning)).toContain('机械执行步');
    // The ending dry run only receives the sql step — natural-language steps do not enter the dry run (verbatim dispatch is guaranteed compile-missing)
    expect(executeCaseInBrowser).toHaveBeenCalledTimes(1);
    const dryRunSteps = vi.mocked(executeCaseInBrowser).mock.calls[0]![1] as Array<{ compiled: unknown }>;
    expect(dryRunSteps).toHaveLength(1);
    expect(dryRunSteps[0]!.compiled).toEqual(SQL_COMPILED);
    // Whole case passes (no longer falsely failed as divergence)
    expect(data.result).toBe('passed');
    expect(data.replay.steps).toHaveLength(1);
  });

  it('混合用例里 sql 断言不成立：按 ReplayDivergence 报出且 failure.sql 带实际行', async () => {
    const caseId = await seedCase({ steps: [null, SQL_COMPILED] });
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"ok","login":"not-needed"}');
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    vi.mocked(executeCaseInBrowser).mockImplementationOnce(
      async (_cid: string, steps: Array<{ order: number }>) =>
        steps.map((s) => ({
          order: s.order,
          status: 'failed' as const,
          durationMs: 9,
          error: 'sql assertion failed',
          failureReason: 'SqlAssertionFailed' as const,
          humanMessage: 'SQL 结果断言未命中',
          sql: {
            dbRef: 'SIEM数据库',
            rowCount: 1,
            durationMs: 5,
            rows: [{ asset_name: 'paas-es-test-02' }],
            assertion: { matched: false, expected: 'x', match: 'contains' as const },
          },
        })),
    );
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.result).toBe('failed');
    expect(data.failure.failureReason).toBe('ReplayDivergence');
    expect(data.failure.stepOrder).toBe(2);
    expect(data.failure.sql.rows).toEqual([{ asset_name: 'paas-es-test-02' }]);
    expect(data.failure.sql.assertion.matched).toBe(false);
  });

  it('工具文案声明机械步由干跑裁决 + 查库结果随响应带出（agent 依赖文案选路）', async () => {
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const guidelines = buildVerifyCaseTool(toolCtx()).promptGuidelines.join('\n');
    expect(guidelines).toContain('replay.steps[].sql');
    expect(guidelines).toContain('不要建探针用例');
  });
});

describe('verify_case 跨轮保活（浏览器注册表接线）', () => {
  /** Make the playwright stub's browser report "connected and page not closed" → the finally check holds, commit at round end */
  async function alive(): Promise<void> {
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { browserAlive: boolean } };
    __testState.browserAlive = true;
  }
  /** The keep-alive session for a case in the registry (key = threadId::caseId, same convention as verifyCase) */
  async function session(caseId: string): Promise<{ appliedHashes: string[] } | null> {
    const { peekSession } = await import('../src/pi/space/tools/browserSessions.js');
    return peekSession(`t1::${caseId}`);
  }

  it('失败轮也保活：浏览器留在失败现场，下轮从失败步续跑（前缀零重演）', async () => {
    const { caseId } = await seedVisualCase(2);
    await alive();
    const { runAiTask } = await import('../src/execute/aiTask.js');
    // Round 1: step 1 passes (collects click trail), step 2 fails → a failing round must still keep the browser on the scene
    vi.mocked(runAiTask)
      .mockImplementationOnce(async (_p, _i, _c, _m, opts) => {
        opts?.onAction?.({ type: 'click', selector: '#btn-1' }, true);
        return '{"status":"passed","reason":"完成","login":"not-needed"}';
      })
      .mockResolvedValueOnce('{"status":"failed","reason":"失败","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r1 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(JSON.parse((r1 as { data: string }).data).result).toBe('failed');
    // Failing round = clean breakpoint: browser registered, effective prefix = number of steps before the failed step
    const s1 = await session(caseId);
    expect(s1).not.toBeNull();
    expect(s1!.appliedHashes.length).toBe(1);

    // Round 2: keep-alive hit → no new browser, no prefix replay, AI phase runs only the failed step
    vi.mocked(runAiTask).mockResolvedValueOnce('{"status":"passed","reason":"完成","login":"not-needed"}');
    const { chromium } = await import('playwright-core');
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    const r2 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    const data2 = JSON.parse((r2 as { data: string }).data);
    expect(data2.result).toBe('passed');
    expect(data2.browserReused).toBe(true);
    expect(data2.resumeFrom).toBe(1); // AI phase resumes from the failed step
    expect(runAiTask).toHaveBeenCalledTimes(3); // Round1×2 + Round2×1 (prefix steps do not re-burn)
    expect(executeCaseInBrowser).not.toHaveBeenCalled(); // Keep-alive hit → zero replay
    expect(chromium.launch).toHaveBeenCalledTimes(1); // Reuses the same browser
  });

  it('保活未命中（浏览器断开）→ 降级既有 fresh+restore 路径，行为不变', async () => {
    const { caseId } = await seedVisualCase(2);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask)
      .mockImplementationOnce(async (_p, _i, _c, _m, opts) => {
        opts?.onAction?.({ type: 'click', selector: '#btn-1' }, true);
        return '{"status":"passed","reason":"完成","login":"not-needed"}';
      })
      .mockResolvedValueOnce('{"status":"failed","reason":"失败","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    // Browser not keep-alive-able (default stub state) → not registered
    expect(await session(caseId)).toBeNull();
  });

  it('混合前缀：可恢复段照常回放，其后的不可恢复步交 AI 相（回放切片截到可恢复前缀）', async () => {
    const { caseId } = await seedVisualCase(3);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    // Round 1: step 1's trail is mappable (selector); step 2's trail is not (coordinates); step 3 fails
    vi.mocked(runAiTask)
      .mockImplementationOnce(async (_p, _i, _c, _m, opts) => {
        opts?.onAction?.({ type: 'click', selector: '#btn-1' }, true);
        return '{"status":"passed","reason":"完成","login":"not-needed"}';
      })
      .mockImplementationOnce(async (_p, _i, _c, _m, opts) => {
        opts?.onAction?.({ type: 'click', x: 500, y: 400 }, true);
        return '{"status":"passed","reason":"完成","login":"not-needed"}';
      })
      .mockResolvedValueOnce('{"status":"failed","reason":"失败","login":"not-needed"}');
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    // Round 2: replay slice = the longest recoverable prefix (1 step) → AI phase takes over from step 2
    vi.mocked(runAiTask).mockResolvedValue('{"status":"passed","reason":"完成","login":"not-needed"}');
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    const r2 = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    const data2 = JSON.parse((r2 as { data: string }).data);
    expect(data2.result).toBe('passed');
    expect(data2.resumeFrom).toBe(1);
    const restoreSteps = vi.mocked(executeCaseInBrowser).mock.calls[0]![1] as Array<{ order: number; compiled: unknown }>;
    expect(restoreSteps.length).toBe(1); // The unrecoverable step 2 does not enter the replay slice
    expect(restoreSteps[0]!.compiled).toEqual([
      { kind: 'click', locator: [{ strategy: 'css', value: '#btn-1' }] },
    ]);
  });
});
