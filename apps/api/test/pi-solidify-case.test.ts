import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from './helpers/pg.js';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// Solidification orchestration test: runAiTask is stubbed, with opts.onAction used to simulate AI action collection (under module-level mocks the collection hook
// is driven manually by the test); writeStepScreenshot / extractPageElements are stubbed, focusing on the solidify_case orchestration contract.
// aiActionMap (mapping function) takes placeholder constants via aiTask.js, also stubbed to isolate real dependencies
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
// Wrap liveView with a spy: existing real behavior unchanged (registers into the in-memory table), so ctx.liveView=false cases can assert zero calls
vi.mock('../src/execute/liveView.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/execute/liveView.js')>();
  return { ...actual, registerLiveView: vi.fn(actual.registerLiveView) };
});
vi.mock('../src/execute/cdp.js', () => ({
  writeStepScreenshot: vi.fn(async () => '/screenshots/solidify-x/step-1.png'),
  // Transitive dependencies of verifyCase.js (solidifyCase reuses its buildStepInstruction/placeholders) and visionAssert
  executeCaseInBrowser: vi.fn(),
  materializeExpectedOutcome: (t: string) => t,
  maskSensitiveValues: (t: string) => t,
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
vi.mock('../src/agent/llmSettings.js', () => ({
  resolveLlmClient: vi.fn(async () => ({
    config: { provider: 'anthropic', apiKey: 'fake', model: 'fake' },
    client: { provider: 'anthropic' as const, complete: async () => ({ kind: 'text' as const, value: '', provider: 'anthropic' as const, vision: false }) },
  })),
}));
// judgeCaseOutcome is only transitively loaded via verifyCase→visionAssert and never called in the solidification chain; stubbed to isolate real dependencies
vi.mock('../src/agent/judgeCaseOutcome.js', () => ({
  judgeCaseOutcome: vi.fn(async () => ({ passed: true, reason: 'ok' })),
}));
vi.mock('playwright-core', () => {
  const state = { gotos: [] as string[], ctxOpts: [] as unknown[] };
  const makeLoc = (sel: string) => ({ count: async () => (sel.includes(':contains') ? Promise.reject(new Error('bad pseudo')) : 1) });
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
              // The solidification chain attaches console/pageerror collection (createConsoleCapture) — a mock missing `on` would break the whole chain
              on: vi.fn(),
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

/** Per-step runAiTask behavior script: consumed in call order (under step fail-stop semantics, remaining queue items are "not executed"). */
interface StepSpec {
  /** (action, success) sequence — successful actions are collected */
  actions?: Array<[Record<string, unknown>, boolean]>;
  summary?: string;
  reject?: Error;
}
let stepQueue: StepSpec[] = [];
/** Snapshot of valueSub(SECRET_PH) at each call time (after the loop ends stepSecret has been reset, so sampling must happen in place). */
let secretProbes: string[] = [];

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
  stepQueue = [];
  secretProbes = [];
  const { __testState } = (await import('playwright-core')) as unknown as { __testState: { gotos: string[]; ctxOpts: unknown[] } };
  __testState.gotos.length = 0;
  __testState.ctxOpts.length = 0;
  const { runAiTask } = await import('../src/execute/aiTask.js');
  vi.mocked(runAiTask).mockImplementation(async (...args: unknown[]) => {
    const opts = args[4] as {
      onAction?: (a: Record<string, unknown>, ok: boolean) => void;
      valueSub?: (v: string) => string;
    };
    // The probe is only meaningful when a sensitive step has a value: the shared valueSub throws SecretMissing for steps without ciphertext
    // (missing credentials are fatal, never silently filled with empty string) — the probe swallows this exception, sampling '' to mean "no ciphertext in this step".
    try {
      secretProbes.push(opts?.valueSub?.('__ITEST_STEP_SECRET__') ?? '');
    } catch {
      secretProbes.push('');
    }
    const step = stepQueue.shift() ?? {};
    for (const [a, ok] of step.actions ?? []) opts?.onAction?.(a, ok);
    if (step.reject) throw step.reject;
    return step.summary ?? '{"status":"passed","reason":"ok","login":"not-needed"}';
  });
  await pool.query(`TRUNCATE test_steps, test_cases, test_environments, environment_objects,
    requirements, "groups", projects, project_versions, ai_threads, ai_stage_case_ops, ai_stage_cases
    RESTART IDENTITY CASCADE`);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  groupId = seed.groupId;
  versionId = seed.versionId;
  const seedEnv = await pool.query(
    `INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认环境', true) RETURNING id`,
    [projectId],
  );
  await pool.query(
    `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES ($1, 'web', '默认', '{"name":"web","scheme":"http","host":"env.example"}', true)`,
    [seedEnv.rows[0]!.id],
  );
});

interface SeedStep {
  instruction?: string | null;
  compiled?: unknown[] | null;
  sensitive?: boolean;
  secret?: string;
}

async function seedCase(opts: {
  platform?: string;
  url?: string | null;
  steps?: SeedStep[];
}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO test_cases(id, group_id, version_id, title, url, platform) VALUES ($1, $2, $3, '固化用例', $4, $5)`,
    [id, groupId, versionId, opts.url ?? 'http://env.example/page', opts.platform ?? 'web'],
  );
  for (let i = 0; i < (opts.steps ?? []).length; i++) {
    const s = opts.steps![i]!;
    await pool.query(
      `INSERT INTO test_steps(case_id, "order", source, compiled, instruction) VALUES ($1, $2, 'ai', $3::jsonb, $4)`,
      [id, i + 1, s.compiled ? JSON.stringify(s.compiled) : null, s.instruction ?? null],
    );
    if (s.sensitive) {
      const { encrypt } = await import('../src/lib/secret-crypto.js');
      const enc = encrypt(s.secret ?? 'StepSecret!9');
      await pool.query(
        `UPDATE test_steps SET sensitive = true, secret_ciphertext = $2, secret_iv = $3, secret_tag = $4
         WHERE case_id = $1 AND "order" = $5`,
        [id, enc.ciphertext.toString('base64'), enc.iv.toString('base64'), enc.tag.toString('base64'), i + 1],
      );
    }
  }
  return id;
}

async function stageOps(): Promise<Array<{ local_id: string; op: string; payload: unknown; case_id: string }>> {
  // ORDER BY staged_at: without sorting, PG's return order is nondeterministic (occasionally reversed after TRUNCATE), which would make step-order assertions flaky
  const r = await pool.query(`SELECT local_id, op, payload, case_id FROM ai_stage_case_ops WHERE thread_id = 't1' ORDER BY staged_at, local_id`);
  return r.rows as Array<{ local_id: string; op: string; payload: unknown; case_id: string }>;
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

describe('mapAiActionsToCompiled 纯函数', () => {
  it('click/fill/navigate 机械映射，screenshot 观察性跳过', async () => {
    const { mapAiActionsToCompiled } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = mapAiActionsToCompiled([
      { type: 'click', selector: '#btn' },
      { type: 'fill', selector: 'input[name="title"]', value: '规则A' },
      { type: 'navigate', url: 'http://env.example/page2' },
      { type: 'screenshot', selector: 'body' },
    ]);
    expect(r).toEqual({
      ok: true,
      skippedCount: 1,
      compiled: [
        { kind: 'click', locator: [{ strategy: 'css', value: '#btn' }] },
        { kind: 'fill', locator: [{ strategy: 'css', value: 'input[name="title"]' }], value: '规则A' },
        { kind: 'navigate', url: 'http://env.example/page2' },
      ],
    });
  });

  it('text= 前缀选择器 → strategy text', async () => {
    const { mapAiActionsToCompiled } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = mapAiActionsToCompiled([{ type: 'click', selector: 'text=删除' }]);
    expect(r).toEqual({ ok: true, skippedCount: 0, compiled: [{ kind: 'click', locator: [{ strategy: 'text', value: '删除' }] }] });
  });

  it('press 无 DSL 对应 → 整步阻断；wait 映射为固定时长 waitFor', async () => {
    const { mapAiActionsToCompiled } = await import('../src/pi/space/tools/solidifyCase.js');
    const press = mapAiActionsToCompiled([{ type: 'click', selector: '#a' }, { type: 'press', key: 'Enter' }]);
    expect(press.ok).toBe(false);
    if (!press.ok) expect(press.reason).toContain('press');
    const wait = mapAiActionsToCompiled([{ type: 'click', selector: '#a' }, { type: 'wait', ms: 1500 }]);
    expect(wait).toEqual({
      ok: true,
      skippedCount: 0,
      compiled: [
        { kind: 'click', locator: [{ strategy: 'css', value: '#a' }] },
        { kind: 'waitFor', locator: [], timeoutMs: 1500 },
      ],
    });
  });

  it('纯等待 / 纯截图序列 → 无可映射动作（盲等 waitFor 不再独苗「固化」，prod228 缺口 3）', async () => {
    const { mapAiActionsToCompiled } = await import('../src/pi/space/tools/solidifyCase.js');
    const onlyWait = mapAiActionsToCompiled([{ type: 'wait', ms: 1000 }, { type: 'wait', ms: 500 }]);
    expect(onlyWait.ok).toBe(false);
    if (!onlyWait.ok) expect(onlyWait.reason).toContain('无可映射动作');
    const waitAndShot = mapAiActionsToCompiled([{ type: 'wait', ms: 1000 }, { type: 'screenshot', selector: 'body' }]);
    expect(waitAndShot.ok).toBe(false);
    // Control: wait interleaved between real interactions still maps normally (click+wait mixing is existing fix #1, must not regress)
    const mixed = mapAiActionsToCompiled([{ type: 'click', selector: '#a' }, { type: 'wait', ms: 1500 }]);
    expect(mixed.ok).toBe(true);
  });

  it('Playwright 专有语法（>> / :has-text）→ 不可映射阻断', async () => {
    const { mapAiActionsToCompiled } = await import('../src/pi/space/tools/solidifyCase.js');
    const chord = mapAiActionsToCompiled([{ type: 'click', selector: '.row >> text=删除' }]);
    expect(chord.ok).toBe(false);
    if (!chord.ok) expect(chord.reason).toContain('Playwright 专有语法');
    const hasText = mapAiActionsToCompiled([{ type: 'fill', selector: 'div:has-text("x") input', value: 'v' }]);
    expect(hasText.ok).toBe(false);
  });

  it('fill 值为凭据占位符 → 阻断（凭据归环境登录，不进用例）', async () => {
    const { mapAiActionsToCompiled } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = mapAiActionsToCompiled([{ type: 'fill', selector: '#user', value: '__ITEST_USERNAME__' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('占位符');
  });

  it('空序列 / 全观察性动作 → 无可映射动作', async () => {
    const { mapAiActionsToCompiled } = await import('../src/pi/space/tools/solidifyCase.js');
    const empty = mapAiActionsToCompiled([]);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toContain('无可映射动作');
    const onlyShots = mapAiActionsToCompiled([{ type: 'screenshot', selector: 'body' }]);
    expect(onlyShots.ok).toBe(false);
  });
});

describe('solidify_case 前置校验', () => {
  it('用例不存在 → ok:false', async () => {
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId: randomUUID() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('用例不存在');
  });

  it('移动端用例 → ok:false', async () => {
    const caseId = await seedCase({ platform: 'mobile', steps: [{ instruction: '点击' }] });
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('移动端');
  });

  it('无视觉模式步骤（全 compiled）→ ok:false 指引 update_step 回退', async () => {
    const caseId = await seedCase({
      steps: [{ compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }] }],
    });
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('没有待固化的视觉模式步骤');
  });

  it('LLM 未配置 → ok:false，不启动浏览器', async () => {
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    vi.mocked(resolveLlmClient).mockRejectedValueOnce(new Error('未配置 provider'));
    const caseId = await seedCase({ steps: [{ instruction: '点击删除' }] });
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('LLM 未配置');
    const { chromium } = await import('playwright-core');
    expect(chromium.launch).not.toHaveBeenCalled();
  });
});

describe('solidify_case 编排', () => {
  it('全视觉 DB 用例：动作收集 → 机械映射 → 逐步 update_step 暂存（幂等 localId），DB 不落库', async () => {
    const caseId = await seedCase({ steps: [{ instruction: '点击删除按钮' }, { instruction: '填写规则名称' }] });
    const stepRows = await pool.query(`SELECT id FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId]);
    const [stepId1, stepId2] = stepRows.rows.map((r) => r.id as string);
    stepQueue = [
      { actions: [[{ type: 'click', selector: '#del' }, true], [{ type: 'screenshot', selector: 'body' }, true]] },
      { actions: [[{ type: 'fill', selector: 'input[name="ruleName"]', value: '规则A' }, true], [{ type: 'click', selector: 'button[type="submit"]' }, true]] },
    ];
    const emitLog: unknown[] = [];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx(emitLog)).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('solidified');
      expect(data.basedOn).toBe('db');
      expect(data.steps).toHaveLength(2);
      expect(data.steps[0]).toMatchObject({ order: 1, status: 'solidified' });
      expect(data.steps[1]).toMatchObject({ order: 2, status: 'solidified' });
      expect(data.steps[0].warning).toContain('跳过 1 个观察性截图动作');
      expect(data.note).toContain('verify_case');
    }
    // Staged update_step: deterministic localId (solidify-<stepId>) + mapped compiled payload
    const ops = await stageOps();
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ op: 'update_step', case_id: caseId, local_id: `solidify-${stepId1}` });
    expect(ops[0].payload).toEqual({
      action: 'update_step', caseId, stepId: stepId1,
      compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }],
    });
    expect(ops[1].payload).toEqual({
      action: 'update_step', caseId, stepId: stepId2,
      compiled: [
        { kind: 'fill', locator: [{ strategy: 'css', value: 'input[name="ruleName"]' }], value: '规则A' },
        { kind: 'click', locator: [{ strategy: 'css', value: 'button[type="submit"]' }] },
      ],
    });
    // emitStage broadcasts kind=case_op (frontend staging preview)
    const stageEvents = emitLog.filter((e) => (e as { type?: string }).type === 'stage');
    expect(stageEvents).toHaveLength(2);
    expect(stageEvents[0]).toMatchObject({ kind: 'case_op', id: `solidify-${stepId1}`, action: 'stage' });
    // solidify_progress SSE sequence: start → end (the minimal phase indicator chosen by the user)
    const sse = emitLog.filter((e) => (e as { type?: string }).type === 'solidify_progress');
    expect(sse.map((e) => (e as { phase: string }).phase)).toEqual(['start', 'end']);
    expect(sse[0]).toMatchObject({ caseId, total: 2, solidifiable: 2, targetUrl: 'http://env.example/page', loginCache: 'miss' });
    expect(sse[1]).toMatchObject({ result: 'solidified', solidified: 2, kept: 0 });
    // Solidification does not persist: DB step compiled stays NULL (waiting for verify_case acceptance + user-selected save)
    const after = await pool.query(`SELECT compiled FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId]);
    expect(after.rows[0]!.compiled).toBeNull();
    expect(after.rows[1]!.compiled).toBeNull();
  });

  it('runAiTask 编排：每步一次（maxTurns=5、占位符 valueSub）、初始 goto、提示词含步骤序号', async () => {
    const caseId = await seedCase({ steps: [{ instruction: '点击删除按钮' }] });
    stepQueue = [{ actions: [[{ type: 'click', selector: '#del' }, true]] }];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    expect(runAiTask).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runAiTask).mock.calls[0]!;
    expect(String(call[1])).toContain('点击删除按钮');
    expect(String(call[1])).toContain('第 1 步 / 共 1 步');
    const opts = call[4] as { maxTurns: number; valueSub: (v: string) => string };
    expect(opts.maxTurns).toBe(5);
    expect(opts.valueSub('普通值')).toBe('普通值'); // No credentials environment: placeholders replaced with empty, literals kept as-is
    expect(typeof opts.onAction).toBe('function');
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { gotos: string[] } };
    expect(__testState.gotos).toEqual(['http://env.example/page']);
  });

  it('混合步骤：已编译步骤执行但不固化，敏感步骤保持原样，仅视觉非敏感步骤产生暂存', async () => {
    const caseId = await seedCase({
      steps: [
        { instruction: '输入访问口令', sensitive: true, secret: 'StepSecret!9' },
        { compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#tab' }] }] },
        { instruction: '点击删除按钮' },
      ],
    });
    stepQueue = [
      {}, // Sensitive step still runs via AI (placeholder protocol), but actions are not collected
      {}, // Compiled step executes (compiled as reference), not a solidification candidate
      { actions: [[{ type: 'click', selector: '#del' }, true]] },
    ];
    const emitLog: unknown[] = [];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx(emitLog)).execute({ caseId });
    expect(r.ok).toBe(true);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    expect(runAiTask).toHaveBeenCalledTimes(3); // All steps really execute (side effects match execution)
    // Sensitive step instruction injects the __ITEST_STEP_SECRET__ section (same protocol as verify_case)
    const sensitiveInstruction = String(vi.mocked(runAiTask).mock.calls[0]![1]);
    expect(sensitiveInstruction).toContain('__ITEST_STEP_SECRET__');
    expect(secretProbes[0]).toBe('StepSecret!9'); // Snapshot at call time (stepSecret is reset after the loop ends)
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('solidified');
      expect(data.steps).toHaveLength(3);
      expect(data.steps[0]).toMatchObject({ order: 1, status: 'skipped-compiled' });
      expect(String(data.steps[0].reason)).toContain('敏感');
      expect(data.steps[1]).toMatchObject({ order: 2, status: 'skipped-compiled' });
      expect(data.steps[2]).toMatchObject({ order: 3, status: 'solidified' });
    }
    const ops = await stageOps();
    expect(ops).toHaveLength(1); // Only step 3
    const start = emitLog.find((e) => (e as { phase?: string }).phase === 'start') as { solidifiable: number; total: number };
    expect(start).toMatchObject({ solidifiable: 1, total: 3 });
  });

  it('任一步骤失败 → 原子语义：不暂存任何修改，failure 带失败页元素清单', async () => {
    const caseId = await seedCase({ steps: [{ instruction: '点击删除按钮' }, { instruction: '填写名称' }] });
    stepQueue = [
      { actions: [[{ type: 'click', selector: '#del' }, true]] },
      { summary: '{"status":"failed","reason":"保存按钮不可点击","login":"not-needed"}' },
    ];
    const emitLog: unknown[] = [];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx(emitLog)).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      expect(data.failure.stepOrder).toBe(2);
      expect(data.failure.error).toBe('保存按钮不可点击');
      expect(data.failure.page.elements[0]).toContain('button#del');
      expect(data.failure.note).toContain('未暂存任何修改');
    }
    // Step 1 already passed but still not staged (whole-round atomicity)
    expect(await stageOps()).toHaveLength(0);
    const end = emitLog.filter((e) => (e as { type?: string }).type === 'solidify_progress').at(-1) as { result: string; reason: string };
    expect(end).toMatchObject({ result: 'failed', reason: '保存按钮不可点击' });
  });

  it('失败动作（onAction ok=false）不收集：有成功动作照常固化；全失败 → aiTask 化不再留 null', async () => {
    const caseId = await seedCase({ steps: [{ instruction: '点击删除按钮' }] });
    stepQueue = [{ actions: [[{ type: 'click', selector: '#wrong' }, false], [{ type: 'click', selector: '#del' }, true]] }];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('solidified'); // The successful click is still collected
      expect(data.steps[0]).toMatchObject({ order: 1, status: 'solidified' });
    }
    // Re-verify: all actions fail → has instruction → solidified into an AI execution step (aiTask), so mechanical acceptance/replay no longer hits compile-missing
    const caseId2 = await seedCase({ steps: [{ instruction: '点击删除按钮' }] });
    stepQueue = [{ actions: [[{ type: 'click', selector: '#wrong' }, false]] }];
    const r2 = await buildSolidifyCaseTool(toolCtx()).execute({ caseId: caseId2 });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      const data2 = JSON.parse(r2.data!);
      expect(data2.result).toBe('solidified'); // aiTask conversion counts as solidified
      expect(data2.steps[0]).toMatchObject({ status: 'aiTask-fallback' });
      expect(String(data2.steps[0].reason)).toContain('无可映射动作');
      expect(data2.steps[0].compiled).toEqual([{ kind: 'aiTask', instruction: '点击删除按钮' }]);
    }
    expect(await stageOps()).toHaveLength(2); // 1 entry per round (mechanical mapping + aiTask conversion)
  });

  it('含 press 动作的步骤 → aiTask 化附原因，其余步骤正常固化', async () => {
    const caseId = await seedCase({ steps: [{ instruction: '键盘操作' }, { instruction: '点击删除按钮' }] });
    stepQueue = [
      { actions: [[{ type: 'fill', selector: '#q', value: 'x' }, true], [{ type: 'press', key: 'Enter' }, true]] },
      { actions: [[{ type: 'click', selector: '#del' }, true]] },
    ];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('solidified');
      expect(data.steps[0]).toMatchObject({ status: 'aiTask-fallback' });
      expect(String(data.steps[0].reason)).toContain('press');
      expect(data.steps[0].compiled).toEqual([{ kind: 'aiTask', instruction: '键盘操作' }]);
      expect(data.steps[1]).toMatchObject({ status: 'solidified' });
    }
    const ops = await stageOps();
    expect(ops).toHaveLength(2); // Step 1 aiTask conversion + step 2 mechanical mapping
  });

  it('凭据填充被拒步 → aiTask 化且 instruction 带自助登录提示（prod228 缺口 1）；重复固化幂等覆盖', async () => {
    const caseId = await seedCase({ steps: [{ instruction: '输入账号密码并登录' }] });
    stepQueue = [{ actions: [
      [{ type: 'fill', selector: '#user', value: '__ITEST_USERNAME__' }, true],
      [{ type: 'fill', selector: '#pwd', value: '__ITEST_PASSWORD__' }, true],
      [{ type: 'click', selector: '#loginBtn' }, true],
    ] }];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const stepId = (await pool.query(`SELECT id FROM test_steps WHERE case_id = $1`, [caseId])).rows[0]!.id as string;
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.steps[0]).toMatchObject({ status: 'aiTask-fallback' });
      const staged = data.steps[0].compiled as Array<{ kind: string; instruction: string }>;
      expect(staged[0]!.kind).toBe('aiTask');
      expect(staged[0]!.instruction.startsWith('输入账号密码并登录')).toBe(true); // Original instruction kept at the front
      expect(staged[0]!.instruction).toContain('__ITEST_USERNAME__');
      expect(staged[0]!.instruction).toContain('__ITEST_PASSWORD__');
      expect(staged[0]!.instruction).toContain('登录后状态');
    }
    expect(await stageOps()).toHaveLength(1);
    // Repeated solidification (deterministic localId solidify-<stepId>): upsert overwrites, no second staging entry
    stepQueue = [{ actions: [[{ type: 'click', selector: '#loginBtn' }, true]] }];
    const r2 = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r2.ok).toBe(true);
    const ops2 = await stageOps();
    expect(ops2).toHaveLength(1);
    expect(ops2[0]!.local_id).toBe(`solidify-${stepId}`);
    expect(ops2[0]!.payload).toEqual({
      action: 'update_step', caseId, stepId,
      compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#loginBtn' }] }],
    });
  });

  it('幂等：已固化的 aiTask 步（指令未变）→ unchanged-aiTask 不重映射不暂存，仅其余视觉步重跑', async () => {
    // Regression motivation: prod228 field report — non-credential aiTask-fallback steps were re-run and re-mapped on every re-solidification;
    // whenever the action trail changed, the artifact drifted. Solidification output should be a deterministic function of the instruction; already-solidified state stays untouched.
    const caseId = await seedCase({
      steps: [
        { instruction: '按下回车提交', compiled: [{ kind: 'aiTask', instruction: '按下回车提交' }] },
        { instruction: '点击删除按钮' },
      ],
    });
    const stepRows = await pool.query(`SELECT id FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId]);
    const stepId2 = stepRows.rows[1]!.id as string;
    stepQueue = [
      { actions: [[{ type: 'press', key: 'Enter' }, true]] }, // Step 1 still executes but is not collected
      { actions: [[{ type: 'click', selector: '#del' }, true]] },
    ];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.steps[0]).toMatchObject({ order: 1, status: 'unchanged-aiTask' });
    expect(data.steps[1]).toMatchObject({ order: 2, status: 'solidified' });
    const ops = await stageOps();
    expect(ops).toHaveLength(1); // Already-solidified step is no longer staged
    expect(ops[0]!.local_id).toBe(`solidify-${stepId2}`);
  });

  it('幂等：全部步骤已固化（机械 + aiTask 执行步）→ ok:false 短返回零执行，不启动浏览器', async () => {
    const caseId = await seedCase({
      steps: [
        { instruction: '点击删除按钮', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }] },
        { instruction: '按下回车提交', compiled: [{ kind: 'aiTask', instruction: '按下回车提交' }] },
      ],
    });
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('无需固化');
    const { runAiTask } = await import('../src/execute/aiTask.js');
    expect(runAiTask).not.toHaveBeenCalled();
    const { chromium } = await import('playwright-core');
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it('幂等豁免：指令被改过（≠ 存量 aiTask.instruction）→ 重固化放行，产物跟随新指令', async () => {
    const caseId = await seedCase({
      steps: [{ instruction: '改过的指令：按下回车', compiled: [{ kind: 'aiTask', instruction: '按下回车提交' }] }],
    });
    stepQueue = [{ actions: [[{ type: 'press', key: 'Enter' }, true]] }];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.steps[0]).toMatchObject({
      status: 'aiTask-fallback',
      compiled: [{ kind: 'aiTask', instruction: '改过的指令：按下回车' }],
    });
  });

  it('导航冗余提示：case.url 深链直达 + 首步「进入菜单」→ warning（advisory，不阻断固化）', async () => {
    // Regression motivation: prod228 field report — the case url deep-links straight to an asset detail page, yet the first step still says "enter the asset management menu",
    // so after solidification the replayed menu click navigates the page away from the deep-link landing page.
    const caseId = await seedCase({
      url: 'http://env.example/assets/detail',
      steps: [{ instruction: '进入资产管理菜单' }],
    });
    stepQueue = [{ actions: [[{ type: 'click', selector: '#menu-asset' }, true]] }];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { data: string }).data);
    expect(data.steps[0].status).toBe('solidified'); // Advisory only, does not affect the solidification result
    expect(String(data.steps[0].warning)).toContain('冗余');
  });

  it('导航冗余提示不误伤：根路径 url / 非菜单语义词首步 → 无 warning', async () => {
    const caseId = await seedCase({
      url: 'http://env.example/',
      steps: [{ instruction: '进入资产管理菜单' }],
    });
    const caseId2 = await seedCase({
      url: 'http://env.example/assets/detail',
      steps: [{ instruction: '点击删除按钮' }],
    });
    stepQueue = [{ actions: [[{ type: 'click', selector: '#menu-asset' }, true]] }];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r1 = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r1.ok).toBe(true);
    expect(JSON.parse((r1 as { data: string }).data).steps[0].warning).toBeUndefined();
    stepQueue = [{ actions: [[{ type: 'click', selector: '#del' }, true]] }];
    const r2 = await buildSolidifyCaseTool(toolCtx()).execute({ caseId: caseId2 });
    expect(r2.ok).toBe(true);
    expect(JSON.parse((r2 as { data: string }).data).steps[0].warning).toBeUndefined();
  });

  it('纯草稿用例（stage_case localId）：固化后整例重暂存（compiled 填充），不落 DB', async () => {
    const localId = randomUUID();
    const draftSteps = [
      { action: '点击删除按钮', compiled: null, assertion: null },
      { action: '填写规则名称', compiled: null, assertion: null },
    ];
    await pool.query(
      `INSERT INTO ai_stage_cases(thread_id, local_id, version_id, title, url, steps, staged_at)
       VALUES ('t1', $1, $2, '草稿用例', 'http://env.example/page', $3::jsonb, now())`,
      [localId, versionId, JSON.stringify(draftSteps)],
    );
    stepQueue = [
      { actions: [[{ type: 'click', selector: '#del' }, true]] },
      { actions: [[{ type: 'fill', selector: 'input[name="ruleName"]', value: '规则A' }, true]] },
    ];
    const emitLog: unknown[] = [];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx(emitLog)).execute({ caseId: localId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('solidified');
      expect(data.basedOn).toBe('staged');
    }
    // Whole-case restaging: steps' compiled filled in place
    const row = await pool.query(`SELECT steps FROM ai_stage_cases WHERE local_id = $1`, [localId]);
    const steps = row.rows[0]!.steps as Array<{ compiled: unknown[] | null }>;
    expect(steps[0]!.compiled).toEqual([{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }]);
    expect(steps[1]!.compiled).toEqual([
      { kind: 'fill', locator: [{ strategy: 'css', value: 'input[name="ruleName"]' }], value: '规则A' },
    ]);
    // Drafts produce no case_op staging; emitStage broadcasts kind=case
    expect(await stageOps()).toHaveLength(0);
    const stageEvents = emitLog.filter((e) => (e as { type?: string }).type === 'stage');
    expect(stageEvents).toHaveLength(1);
    expect(stageEvents[0]).toMatchObject({ kind: 'case', id: localId, action: 'stage' });
    // Nothing persisted anywhere
    const dbRows = await pool.query(`SELECT id FROM test_cases WHERE title = '草稿用例'`);
    expect(dbRows.rows).toHaveLength(0);
  });

  it('非 UUID 草稿 localId：跳过 uuid 列查询直查草稿（回归 prod228 invalid input syntax for type uuid）', async () => {
    const localId = 'login-a-positiven';
    await pool.query(
      `INSERT INTO ai_stage_cases(thread_id, local_id, version_id, title, url, steps, staged_at)
       VALUES ('t1', $1, $2, '草稿-短名localId', 'http://env.example/page', $3::jsonb, now())`,
      [localId, versionId, JSON.stringify([{ action: '点击删除按钮', compiled: null, assertion: null }])],
    );
    stepQueue = [{ actions: [[{ type: 'click', selector: '#del' }, true]] }];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId: localId });
    // Before the fix: query testCases.id (uuid column) directly first → invalid input syntax for type uuid, and the draft fallback never got a chance to run
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.data!)).toMatchObject({ result: 'solidified', basedOn: 'staged', caseId: localId });
  });

  it('草稿相对 url → resolveCaseUrl 拼默认 web 服务 origin（不落 about:blank）', async () => {
    // Regression: stage-tools constraints require AI to write a relative case.url; if the draft branch rendered the relative address literally, it would yield
    // targetUrl=undefined → about:blank. Here we assert the initial goto lands on the web service origin + path.
    const envRow = await pool.query(`SELECT id FROM test_environments WHERE project_id = $1 AND is_default = true`, [projectId]);
    const envId = envRow.rows[0]!.id as string;
    // beforeEach has already seeded the default web object into that default environment; rewrite its host/port to verify relative url joining
    await pool.query(
      `UPDATE environment_objects SET payload = $2::jsonb
       WHERE environment_id = $1 AND object_type = 'web' AND is_default = true`,
      [envId, JSON.stringify({ name: 'web', scheme: 'http', host: '10.0.0.1', port: 8080 })],
    );
    const localId = randomUUID();
    await pool.query(
      `INSERT INTO ai_stage_cases(thread_id, local_id, version_id, title, url, steps, staged_at)
       VALUES ('t1', $1, $2, '草稿相对url', '/page', $3::jsonb, now())`,
      [localId, versionId, JSON.stringify([{ action: '点击删除按钮', compiled: null, assertion: null }])],
    );
    stepQueue = [{ actions: [[{ type: 'click', selector: '#del' }, true]] }];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId: localId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.data!)).toMatchObject({ result: 'solidified', basedOn: 'staged' });
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { gotos: string[] } };
    expect(__testState.gotos).toContain('http://10.0.0.1:8080/page');
    expect(__testState.gotos.some((g) => !/^https?:\/\//.test(g))).toBe(false);
  });

  it('基于 stage_case_op 暂存叠加：update_step 置 null 回退视觉后固化 → basedOn=staged', async () => {
    // DB step is compiled; the staged update_step sets compiled to null (fallback to vision mode) → solidification based on the overlaid state
    const caseId = await seedCase({
      steps: [{ instruction: '点击删除按钮', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#old' }] }] }],
    });
    const stepRows = await pool.query(`SELECT id FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId]);
    const stepId = stepRows.rows[0]!.id as string;
    await pool.query(
      `INSERT INTO ai_stage_case_ops(thread_id, local_id, version_id, case_id, op, payload, summary, staged_at)
       VALUES ('t1', $1, $2, $3, 'update_step', $4::jsonb, '回退视觉模式', now())`,
      [randomUUID(), versionId, caseId, JSON.stringify({ action: 'update_step', caseId, stepId, compiled: null })],
    );
    stepQueue = [{ actions: [[{ type: 'click', selector: '#del' }, true]] }];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('solidified');
      expect(data.basedOn).toBe('staged');
      expect(data.stagedOpsApplied).toBe(1);
      expect(data.steps[0]).toMatchObject({ status: 'solidified' });
    }
    // Solidification staging (solidify-<stepId>) and the preceding fallback staging coexist in the same draft area
    const ops = await stageOps();
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.local_id)).toContain(`solidify-${stepId}`);
  });

  it('叠加态插入步（暂存 insert_step 未落库）固化 → compiled 写回该 insert 暂存行，不产出指向占位 stepId 的 update_step', async () => {
    // Regression motivation: prod228 2026-11-11 — solidification staged an overlaid-state step (id shaped like staged:<localId>, not yet in the DB)
    // as update_step(stepId='staged:1'); on persistence the non-uuid stepId → ZodError → the frontend only saw
    // "parameter validation failed, check your input"; and the failure did not roll back, so a user retry inserted the same step 3 times.
    const caseId = await seedCase({ steps: [{ instruction: '点击删除按钮' }] });
    const stepRows = await pool.query(`SELECT id FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId]);
    const dbStepId = stepRows.rows[0]!.id as string;
    // New step already inserted in staging but not yet persisted (overlaid-state id = staged:<localId of the insert op>)
    const insertLocalId = 'ins-local-1';
    await pool.query(
      `INSERT INTO ai_stage_case_ops(thread_id, local_id, version_id, case_id, op, payload, summary, staged_at)
       VALUES ('t1', $1, $2, $3, 'insert_step', $4::jsonb, '插入新步骤', now())`,
      [insertLocalId, versionId, caseId, JSON.stringify({ action: 'insert_step', caseId, instruction: '填写规则名称', compiled: null })],
    );
    stepQueue = [
      { actions: [[{ type: 'click', selector: '#del' }, true]] },
      { actions: [[{ type: 'fill', selector: 'input[name="ruleName"]', value: '规则A' }, true]] },
    ];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('solidified');
      expect(data.basedOn).toBe('staged');
      expect(data.steps).toHaveLength(2);
      expect(data.steps[1]).toMatchObject({ order: 2, status: 'solidified' });
    }
    const ops = await stageOps();
    // Key invariant: no update_step points at an overlaid-state step that is not yet persisted
    for (const o of ops) {
      const p = o.payload as { action?: string; stepId?: string };
      if (p.action === 'update_step') expect(String(p.stepId)).not.toMatch(/^staged:/);
    }
    // The overlaid-state step's compiled is written back to its own insert staging row (same localId overwrite, no new row)
    const insertOp = ops.find((o) => o.local_id === insertLocalId)!;
    expect(insertOp).toBeDefined();
    expect(insertOp.op).toBe('insert_step');
    expect(insertOp.payload).toMatchObject({
      action: 'insert_step', caseId, instruction: '填写规则名称',
      compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: 'input[name="ruleName"]' }], value: '规则A' }],
    });
    // DB step is still a plain update_step staging (deterministic localId)
    const dbOp = ops.find((o) => o.local_id === `solidify-${dbStepId}`)!;
    expect(dbOp).toBeDefined();
    expect(dbOp.op).toBe('update_step');
    expect(ops).toHaveLength(2);
  });

  it('ctx.liveView=false：不注册实时画面且 start 无 liveUrl（批量后台链路）；缺省会话行为不变', async () => {
    const { registerLiveView } = await import('../src/execute/liveView.js');
    // Off path: liveView=false → zero registration, start event without liveUrl
    const caseOff = await seedCase({ steps: [{ instruction: '点击删除按钮' }] });
    stepQueue = [{ actions: [[{ type: 'click', selector: '#del' }, true]] }];
    const emitOff: unknown[] = [];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const rOff = await buildSolidifyCaseTool({ ...toolCtx(emitOff), liveView: false }).execute({ caseId: caseOff });
    expect(rOff.ok).toBe(true);
    expect(registerLiveView).not.toHaveBeenCalled();
    const startOff = emitOff.find((e) => (e as { phase?: string }).phase === 'start') as { liveUrl?: string };
    expect(startOff.liveUrl).toBeUndefined();
    // Default (undefined): the session chain still registers and carries the stream address
    const caseOn = await seedCase({ steps: [{ instruction: '点击删除按钮' }] });
    stepQueue = [{ actions: [[{ type: 'click', selector: '#del' }, true]] }];
    const emitOn: unknown[] = [];
    const rOn = await buildSolidifyCaseTool(toolCtx(emitOn)).execute({ caseId: caseOn });
    expect(rOn.ok).toBe(true);
    expect(registerLiveView).toHaveBeenCalledTimes(1);
    const startOn = emitOn.find((e) => (e as { phase?: string }).phase === 'start') as { liveUrl?: string };
    expect(startOn.liveUrl).toContain('/live/');
  });

  it('登录态缓存：命中注入 storageState，执行后无条件回写', async () => {    const caseId = await seedCase({ steps: [{ instruction: '点击删除按钮' }] });
    stepQueue = [{ actions: [[{ type: 'click', selector: '#del' }, true]] }];
    const envIdRow = await pool.query(`SELECT id FROM test_environments WHERE project_id = $1 AND is_default = true`, [projectId]);
    const { saveLoginState, getLoginState } = await import('../src/pi/space/tools/loginStateCache.js');
    const fakeState = { cookies: [{ name: 'sid', value: 'warm' }], origins: [] };
    saveLoginState(`${envIdRow.rows[0]!.id}:`, fakeState as never);
    const emitLog: unknown[] = [];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx(emitLog)).execute({ caseId });
    expect(r.ok).toBe(true);
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { ctxOpts: Array<Record<string, unknown> | undefined> } };
    expect(__testState.ctxOpts[0]).toMatchObject({ storageState: fakeState });
    // Write-back: mock context.storageState returns sid=cached
    expect(getLoginState(`${envIdRow.rows[0]!.id}:`)).toEqual({ cookies: [{ name: 'sid', value: 'cached' }], origins: [] });
    const start = emitLog.find((e) => (e as { phase?: string }).phase === 'start') as { loginCache: string };
    expect(start.loginCache).toBe('hit');
  });
});

describe('solidify_case 轨迹缓存零执行路径', () => {
  /** Same field values as the effectiveSteps solidify builds internally from DB/draft rows (the hash covers only these 5 fields). */
  const hStep = (instruction: string) =>
    ({ instruction, compiled: null, assertion: null, sensitive: false, delayMs: null }) as never;
  const META = { url: 'http://env.example/page', defaultEnvId: null, versionId: '' };

  it('DB 用例缓存命中：零执行（无 runAiTask/浏览器/LLM），逐步 update_step 暂存照常', async () => {
    const caseId = await seedCase({ steps: [{ instruction: '点击删除按钮' }, { instruction: '填写规则名称' }] });
    const stepRows = await pool.query(`SELECT id FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId]);
    const [stepId1, stepId2] = stepRows.rows.map((r) => r.id as string);
    const { saveVerifiedTrace, traceKey, hashEffectiveSteps, hashVerifyMeta } =
      await import('../src/pi/space/tools/verifyTrace.js');
    saveVerifiedTrace(
      traceKey('t1', caseId),
      hashEffectiveSteps([hStep('点击删除按钮'), hStep('填写规则名称')] as never),
      hashVerifyMeta({ ...META, versionId }),
      new Map([
        [stepId1, [{ type: 'click', selector: '#del' }]],
        [stepId2, [{ type: 'fill', selector: 'input[name="ruleName"]', value: '规则A' }]],
      ]) as never,
    );
    // The cache path must come before the LLM precondition check (no client needed) — assert zero calls directly to avoid once-queue leakage across tests
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    const emitLog: unknown[] = [];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx(emitLog)).execute({ caseId });
    expect(r.ok).toBe(true);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    const { chromium } = await import('playwright-core');
    expect(runAiTask).not.toHaveBeenCalled();
    expect(chromium.launch).not.toHaveBeenCalled();
    expect(resolveLlmClient).not.toHaveBeenCalled();
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data).toMatchObject({ result: 'solidified', traceReused: true, basedOn: 'db' });
      expect(data.steps[0]).toMatchObject({ order: 1, status: 'solidified' });
      expect(data.steps[1]).toMatchObject({ order: 2, status: 'solidified' });
      expect(data.note).toContain('verify_case');
    }
    // Staging still writes rows as usual (deterministic localId + mapped compiled)
    const ops = await stageOps();
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ op: 'update_step', case_id: caseId, local_id: `solidify-${stepId1}` });
    expect(ops[0].payload).toEqual({
      action: 'update_step', caseId, stepId: stepId1,
      compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }],
    });
    // SSE: start (no liveUrl, with traceReused) → end
    const sse = emitLog.filter((e) => (e as { type?: string }).type === 'solidify_progress');
    expect(sse.map((e) => (e as { phase: string }).phase)).toEqual(['start', 'end']);
    expect(sse[0]).toMatchObject({ caseId, total: 2, solidifiable: 2, targetUrl: 'http://env.example/page', traceReused: true });
    expect(sse[1]).toMatchObject({ result: 'solidified', solidified: 2, kept: 0 });
    // DB steps still not persisted
    const after = await pool.query(`SELECT compiled FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId]);
    expect(after.rows[0]!.compiled).toBeNull();
  });

  it('草稿用例缓存命中：整例重暂存带 compiled，零执行', async () => {
    const localId = randomUUID();
    const draftSteps = [
      { action: '点击删除按钮', compiled: null, assertion: null },
      { action: '填写规则名称', compiled: null, assertion: null },
    ];
    await pool.query(
      `INSERT INTO ai_stage_cases(thread_id, local_id, version_id, title, url, steps, staged_at)
       VALUES ('t1', $1, $2, '草稿用例', 'http://env.example/page', $3::jsonb, now())`,
      [localId, versionId, JSON.stringify(draftSteps)],
    );
    const { saveVerifiedTrace, traceKey, hashEffectiveSteps, hashVerifyMeta } =
      await import('../src/pi/space/tools/verifyTrace.js');
    saveVerifiedTrace(
      traceKey('t1', localId),
      hashEffectiveSteps([hStep('点击删除按钮'), hStep('填写规则名称')] as never),
      hashVerifyMeta({ ...META, versionId }),
      new Map([
        ['staged-1', [{ type: 'click', selector: '#del' }]],
        ['staged-2', [{ type: 'fill', selector: 'input[name="ruleName"]', value: '规则A' }]],
      ]) as never,
    );
    const emitLog: unknown[] = [];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx(emitLog)).execute({ caseId: localId });
    expect(r.ok).toBe(true);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    expect(runAiTask).not.toHaveBeenCalled();
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data).toMatchObject({ result: 'solidified', traceReused: true, basedOn: 'staged' });
    }
    const row = await pool.query(`SELECT steps FROM ai_stage_cases WHERE local_id = $1`, [localId]);
    const steps = row.rows[0]!.steps as Array<{ compiled: unknown[] | null }>;
    expect(steps[0]!.compiled).toEqual([{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }]);
    expect(steps[1]!.compiled).toEqual([
      { kind: 'fill', locator: [{ strategy: 'css', value: 'input[name="ruleName"]' }], value: '规则A' },
    ]);
    expect(await stageOps()).toHaveLength(0); // Drafts produce no case_op
    const stageEvents = emitLog.filter((e) => (e as { type?: string }).type === 'stage');
    expect(stageEvents).toHaveLength(1);
    expect(stageEvents[0]).toMatchObject({ kind: 'case', id: localId, action: 'stage' });
  });

  it('三种过期（stepsHash 变 / metaHash 变 / 轨迹缺步）→ 删条目回退真跑', async () => {
    const { saveVerifiedTrace, traceKey, hashEffectiveSteps, hashVerifyMeta, getVerifiedTrace } =
      await import('../src/pi/space/tools/verifyTrace.js');
    const { runAiTask } = await import('../src/execute/aiTask.js');
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');

    // 1) stepsHash mismatch: the case's real instruction differs from what the trail hash was computed on
    const caseId1 = await seedCase({ steps: [{ instruction: '点击删除按钮' }] });
    const stepId1 = (await pool.query(`SELECT id FROM test_steps WHERE case_id = $1`, [caseId1])).rows[0]!.id as string;
    saveVerifiedTrace(
      traceKey('t1', caseId1),
      hashEffectiveSteps([hStep('已被修改的指令')] as never),
      hashVerifyMeta({ ...META, versionId }),
      new Map([[stepId1, [{ type: 'click', selector: '#del' }]]]) as never,
    );
    stepQueue = [{ actions: [[{ type: 'click', selector: '#del' }, true]] }];
    const r1 = await buildSolidifyCaseTool(toolCtx()).execute({ caseId: caseId1 });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(JSON.parse(r1.data!).traceReused).toBeUndefined();
    expect(getVerifiedTrace(traceKey('t1', caseId1))).toBeNull(); // Expired means deleted
    expect(runAiTask).toHaveBeenCalledTimes(1);

    // 2) metaHash mismatch: different environment = different SUT
    const caseId2 = await seedCase({ steps: [{ instruction: '点击删除按钮' }] });
    saveVerifiedTrace(
      traceKey('t1', caseId2),
      hashEffectiveSteps([hStep('点击删除按钮')] as never),
      hashVerifyMeta({ url: 'http://other.example/page', defaultEnvId: null, versionId }),
      new Map([[stepId1, [{ type: 'click', selector: '#del' }]]]) as never, // key is arbitrary: meta check fails first anyway
    );
    stepQueue = [{ actions: [[{ type: 'click', selector: '#del' }, true]] }];
    const r2 = await buildSolidifyCaseTool(toolCtx()).execute({ caseId: caseId2 });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(JSON.parse(r2.data!).traceReused).toBeUndefined();
    expect(runAiTask).toHaveBeenCalledTimes(2);

    // 3) Trail missing a step: two vision steps but only one cached → required incomplete
    const caseId3 = await seedCase({ steps: [{ instruction: '点击删除按钮' }, { instruction: '填写名称' }] });
    const ids3 = (await pool.query(`SELECT id FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId3]))
      .rows.map((r) => r.id as string);
    saveVerifiedTrace(
      traceKey('t1', caseId3),
      hashEffectiveSteps([hStep('点击删除按钮'), hStep('填写名称')] as never),
      hashVerifyMeta({ ...META, versionId }),
      new Map([[ids3[0]!, [{ type: 'click', selector: '#del' }]]]) as never,
    );
    stepQueue = [
      { actions: [[{ type: 'click', selector: '#del' }, true]] },
      { actions: [[{ type: 'fill', selector: 'input[name="ruleName"]', value: '规则A' }, true]] },
    ];
    const r3 = await buildSolidifyCaseTool(toolCtx()).execute({ caseId: caseId3 });
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(JSON.parse(r3.data!).traceReused).toBeUndefined();
    expect(runAiTask).toHaveBeenCalledTimes(4); // Real run executes step by step
  });

  it('空动作条目（步骤通过但无可映射动作）→ aiTask 化暂存，与真跑路径同结果', async () => {
    const caseId = await seedCase({ steps: [{ instruction: '人工核对页面' }, { instruction: '点击删除按钮' }] });
    const ids = (await pool.query(`SELECT id FROM test_steps WHERE case_id = $1 ORDER BY "order"`, [caseId]))
      .rows.map((r) => r.id as string);
    const { saveVerifiedTrace, traceKey, hashEffectiveSteps, hashVerifyMeta } =
      await import('../src/pi/space/tools/verifyTrace.js');
    saveVerifiedTrace(
      traceKey('t1', caseId),
      hashEffectiveSteps([hStep('人工核对页面'), hStep('点击删除按钮')] as never),
      hashVerifyMeta({ ...META, versionId }),
      new Map([
        [ids[0]!, []], // Empty array: step passed but no mappable action was collected
        [ids[1]!, [{ type: 'click', selector: '#del' }]],
      ]) as never,
    );
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    expect(runAiTask).not.toHaveBeenCalled();
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('solidified');
      expect(data.steps[0]).toMatchObject({ status: 'aiTask-fallback' });
      expect(String(data.steps[0].reason)).toContain('无可映射动作');
      expect(data.steps[0].compiled).toEqual([{ kind: 'aiTask', instruction: '人工核对页面' }]);
      expect(data.steps[1]).toMatchObject({ status: 'solidified' });
    }
    const ops = await stageOps();
    expect(ops).toHaveLength(2); // Step 1 aiTask conversion + step 2 mechanical mapping
  });
});

describe('solidify_case 注册', () => {
  it('buildSpaceTools 包含 solidify_case', async () => {
    const { buildSpaceTools } = await import('../src/pi/space/tools/index.js');
    const names = buildSpaceTools(toolCtx()).map((t) => t.name);
    expect(names).toContain('solidify_case');
  });
});

describe('solidify_case 超时预算', () => {
  it('全局看门狗随步数缩放（与 verify_case 同公式）：1-2 步保底 300s，3 步起线性 130s/步', async () => {
    // Regression motivation: a fixed 300s cannot fit multi-step cases — the AI phase ran 85~107s/step and step 4 was killed mid-flight
    // with "solidification timeout (300s) terminated". The budget must scale with step count for multi-step solidification to be viable.
    const { computeSolidifyTimeoutMs } = await import('../src/pi/space/tools/solidifyCase.js');
    expect(computeSolidifyTimeoutMs(0)).toBe(300_000); // Fallback (no-steps is blocked earlier, so 0 never happens)
    expect(computeSolidifyTimeoutMs(1)).toBe(300_000);
    expect(computeSolidifyTimeoutMs(2)).toBe(300_000); // 2×130k=260k < floor → still 300k
    expect(computeSolidifyTimeoutMs(3)).toBe(3 * 130_000); // 3×130k=390k crosses the floor, climbing linearly
    expect(computeSolidifyTimeoutMs(10)).toBe(10 * 130_000); // 10 steps ≈ 21.7min
    expect(computeSolidifyTimeoutMs(10)).toBeGreaterThan(300_000);
  });
});
