import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// 机械步骤 locator 修复记忆测试：真 cdp.ts + playwright-core / aiTask.js 打桩 + testcontainer PG。
// 链路：作者候选全败 → AI 降级重做成功（degraded）→ 目标 selector 落 step_locator_cache；
// 后续回放缓存 locator 追加候选链末位零 LLM 命中；缓存失灵 → 再降级 → 覆写（hits 保留）。
vi.mock('../src/execute/aiTask.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/execute/aiTask.js')>();
  return {
    ...actual,
    runAiTask: vi.fn(),
    CAPTCHA_TASK_RE: /验证码|captcha/i,
    USER_PH: '__ITEST_USERNAME__',
    PASSWORD_PH: '__ITEST_PASSWORD__',
    SECRET_PH: '__ITEST_STEP_SECRET__',
    solveCaptchaOnce: vi.fn(async () => null),
    isCaptchaFailed: vi.fn(async () => false),
  };
});
vi.mock('../src/agent/llmSettings.js', () => ({
  resolveLlmClient: vi.fn(async () => ({
    config: { provider: 'anthropic', apiKey: 'fake', model: 'fake' },
    client: {
      provider: 'anthropic' as const,
      complete: async () => ({ kind: 'text' as const, value: '', provider: 'anthropic' as const, vision: false }),
    },
  })),
}));
vi.mock('playwright-core', () => {
  // deadSelectors：让指定选择器 count()=0（作者候选全败/缓存失灵的注入点），
  // 其余选择器 count()=1；filter() mockReturnThis 使可见性探测复用同一 count。
  const state = { clicks: [] as string[], failClicks: 0, deadSelectors: new Set<string>() };
  const makeLocator = (sel: string) => ({
    click: vi.fn(async () => {
      if (state.failClicks > 0) {
        state.failClicks -= 1;
        throw new Error('stale element: locator changed');
      }
      state.clicks.push(sel);
    }),
    fill: vi.fn(async () => undefined),
    hover: vi.fn(async () => undefined),
    waitFor: vi.fn(async () => undefined),
    isVisible: vi.fn(async () => true),
    isChecked: vi.fn(async () => false),
    check: vi.fn(async () => undefined),
    uncheck: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => undefined),
    innerText: vi.fn(async () => '{"code":0}'),
    inputValue: vi.fn(async () => 'v'),
    screenshot: vi.fn(async () => Buffer.from('fake-png')),
    filter: vi.fn().mockReturnThis(),
    first: vi.fn().mockReturnThis(),
    count: vi.fn(async () => (state.deadSelectors.has(sel) ? 0 : 1)),
    pressSequentially: vi.fn(async () => undefined),
  });
  const locatorFn = vi.fn((sel: string) => makeLocator(sel));
  const page = {
    goto: vi.fn(async () => undefined),
    locator: locatorFn,
    getByRole: vi.fn(() => makeLocator('role')),
    getByText: vi.fn(() => makeLocator('text')),
    screenshot: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    url: () => 'http://env.example/page',
    evaluate: vi.fn(async () => 'ok'),
    keyboard: { press: vi.fn(async () => undefined) },
  };
  return {
    chromium: {
      launch: vi.fn(async () => ({
        newContext: vi.fn(async () => ({ newPage: async () => page, close: async () => undefined })),
        close: async () => undefined,
      })),
    },
    __page: page,
    __locator: locatorFn,
    __testState: state,
  };
});

// cdp.js → db/client.js 在模块加载时读 DATABASE_URL，必须等 beforeAll 起好容器再动态 import。
let executeCaseReal: typeof import('../src/execute/cdp.js').executeCaseReal;
let runAiTask: ReturnType<typeof vi.fn>;
let testState: { clicks: string[]; failClicks: number; deadSelectors: Set<string> };

let container: StartedPostgreSqlContainer;
let pool: Pool;
let groupId: string;
let versionId: string;

/** 每次回放的 runAiTask 行为脚本（onAction 注入 + 可注入 reject）。 */
let aiActions: Array<[Record<string, unknown>, boolean]> = [];
let aiError: Error | null = null;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  ({ executeCaseReal } = await import('../src/execute/cdp.js'));
  ({ runAiTask } = await import('../src/execute/aiTask.js'));
  testState = ((await import('playwright-core')) as unknown as { __testState: typeof testState }).__testState;
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  aiActions = [];
  aiError = null;
  testState.clicks.length = 0;
  testState.failClicks = 0;
  testState.deadSelectors.clear();
  runAiTask.mockImplementation(async (...args: unknown[]) => {
    const opts = args[4] as {
      onAction?: (a: Record<string, unknown>, ok: boolean) => void;
      onUsage?: (r: Record<string, unknown>) => void;
    } | undefined;
    opts?.onUsage?.({ usage: { promptTokens: 100, completionTokens: 50 }, durationMs: 1500, model: 'fake-model' });
    for (const [a, ok] of aiActions) opts?.onAction?.(a, ok);
    if (aiError) throw aiError;
    return 'done';
  });
  await pool.query(`TRUNCATE step_action_cache, step_locator_cache, test_steps, test_cases, test_environments,
    environment_objects, requirements, "groups", projects, project_versions RESTART IDENTITY CASCADE`);
  const seed = await seedProject(pool);
  groupId = seed.groupId;
  versionId = seed.versionId;
});

/** 造一个单机械步骤的 DB 用例（作者候选 css，附行级指令供降级），返回 (caseId, stepId)。 */
async function seedMechCase(
  instruction: string,
  compiled: Array<Record<string, unknown>>,
): Promise<{ caseId: string; stepId: string }> {
  const caseId = randomUUID();
  await pool.query(
    `INSERT INTO test_cases(id, group_id, version_id, title, url, platform) VALUES ($1, $2, $3, '修复缓存用例', 'http://env.example/page', 'web')`,
    [caseId, groupId, versionId],
  );
  const r = await pool.query(
    `INSERT INTO test_steps(case_id, "order", source, compiled, instruction)
     VALUES ($1, 1, 'ai', $2::jsonb, $3) RETURNING id`,
    [caseId, JSON.stringify(compiled), instruction],
  );
  return { caseId, stepId: r.rows[0]!.id as string };
}

type ReplayStep = { order: number; id?: string; instruction?: string; compiled?: Array<Record<string, unknown>> };

function replay(caseId: string, steps: ReplayStep[], initialVars?: Record<string, string>) {
  return executeCaseReal(
    caseId,
    steps,
    {
      reportId: `r-${randomUUID().slice(0, 8)}`,
      aiFallback: { locatorFailed: true },
      ...(initialVars ? { initialVars } : {}),
    },
  );
}

async function cacheRow(stepId: string): Promise<{ action_kind: string; locator: { strategy: string; value: string }; hits: number } | null> {
  const r = await pool.query(`SELECT action_kind, locator, hits FROM step_locator_cache WHERE step_id = $1`, [stepId]);
  return (r.rows[0] as { action_kind: string; locator: { strategy: string; value: string }; hits: number }) ?? null;
}

async function cacheRowCount(): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM step_locator_cache`);
  return r.rows[0]!.n as number;
}

/** 缓存写入 / 命中计数是 fire-and-forget（回放不阻塞在缓存上），断言前轮询等它落库。 */
async function waitForCache(
  stepId: string,
  check: (row: NonNullable<Awaited<ReturnType<typeof cacheRow>>>) => boolean,
): Promise<NonNullable<Awaited<ReturnType<typeof cacheRow>>>> {
  return vi.waitFor(async () => {
    const row = await cacheRow(stepId);
    if (!row || !check(row)) throw new Error(`cache row not ready: ${JSON.stringify(row)}`);
    return row;
  }, { timeout: 3000, interval: 20 });
}

const clickStep = (): Array<Record<string, unknown>> => [
  { kind: 'click', locator: [{ strategy: 'css', value: '#gone' }] },
];

describe('机械步骤 locator 修复记忆', () => {
  it('(a) 首次：作者候选全败 → AI 降级成功 → 目标 selector 落缓存', async () => {
    const { caseId, stepId } = await seedMechCase('点击提交按钮', clickStep('点击提交按钮'));
    testState.deadSelectors.add('#gone');
    aiActions = [[{ type: 'click', selector: '#fixed-btn' }, true]];

    const results = await replay(caseId, [{ order: 1, id: stepId, instruction: '点击提交按钮', compiled: clickStep('点击提交按钮') }]);
    expect(results[0]).toMatchObject({ status: 'passed', degraded: true });
    expect(results[0]!.warning).toContain('机械执行失败（');
    expect(results[0]!.healed).toBeUndefined(); // 降级通过不算 healed（口径不变）
    expect(runAiTask).toHaveBeenCalledTimes(1);
    const row = await waitForCache(stepId, (r) => r.locator?.value === '#fixed-btn');
    expect(row).toMatchObject({ action_kind: 'click', hits: 0 });
    expect(row.locator).toEqual({ strategy: 'css', value: '#fixed-btn' });
  });

  it('(b) 二次回放：缓存追加候选链末位零 LLM 命中，hitLocator + warning + hits 累计', async () => {
    const { caseId, stepId } = await seedMechCase('点击提交按钮', clickStep('点击提交按钮'));
    testState.deadSelectors.add('#gone');
    aiActions = [[{ type: 'click', selector: '#fixed-btn' }, true]];
    await replay(caseId, [{ order: 1, id: stepId, instruction: '点击提交按钮', compiled: clickStep('点击提交按钮') }]);
    await waitForCache(stepId, (r) => r.locator?.value === '#fixed-btn');

    aiActions = []; // 若误走 AI 相也无动作可收
    runAiTask.mockClear();
    const results = await replay(caseId, [{ order: 1, id: stepId, instruction: '点击提交按钮', compiled: clickStep('点击提交按钮') }]);
    expect(results[0]).toMatchObject({ status: 'passed' });
    expect(results[0]!.degraded).toBeUndefined(); // 纯机械命中不进降级口径
    expect(results[0]!.aiUsage).toBeUndefined(); // 零 LLM
    expect(results[0]!.hitLocator).toEqual({ kind: 'repair-cache', value: '#fixed-btn' });
    expect(results[0]!.warning).toContain('locator 修复缓存命中：#fixed-btn');
    expect(runAiTask).not.toHaveBeenCalled();
    expect((await waitForCache(stepId, (r) => r.hits === 1)).hits).toBe(1);
  });

  it('(c) 缓存失灵 → 再降级 → 覆写 locator 且 hits 保留', async () => {
    const { caseId, stepId } = await seedMechCase('点击提交按钮', clickStep('点击提交按钮'));
    testState.deadSelectors.add('#gone');
    testState.deadSelectors.add('#fixed-btn');
    await pool.query(
      `INSERT INTO step_locator_cache(step_id, action_kind, locator, hits) VALUES ($1, 'click', $2::jsonb, 3)`,
      [stepId, JSON.stringify({ strategy: 'css', value: '#fixed-btn' })],
    );
    aiActions = [[{ type: 'click', selector: '#fixed-v2' }, true]];

    const results = await replay(caseId, [{ order: 1, id: stepId, instruction: '点击提交按钮', compiled: clickStep('点击提交按钮') }]);
    expect(results[0]).toMatchObject({ status: 'passed', degraded: true });
    expect(runAiTask).toHaveBeenCalledTimes(1);
    const row = await waitForCache(stepId, (r) => r.locator?.value === '#fixed-v2');
    expect(row.action_kind).toBe('click');
    expect(row.hits).toBe(3); // upsert 覆写不动计数
  });

  it('(d1) 指令含数据集变量：降级可过但不落缓存（防物化 selector 跨行冻结）', async () => {
    const { caseId, stepId } = await seedMechCase('填写 {{username}} 后提交', [
      { kind: 'fill', locator: [{ strategy: 'css', value: '#gone' }], value: 'x' },
    ]);
    testState.deadSelectors.add('#gone');
    aiActions = [[{ type: 'fill', selector: '#fixed-input', value: 'u1' }, true]];

    const results = await replay(
      caseId,
      [{ order: 1, id: stepId, instruction: '填写 {{username}} 后提交', compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#gone' }], value: 'x' }] }],
      { username: 'u1' },
    );
    expect(results[0]).toMatchObject({ status: 'passed', degraded: true });
    await vi.waitFor(async () => {
      if ((await cacheRowCount()) !== 0) throw new Error('cache should stay empty');
    }, { timeout: 500, interval: 20 });
    expect(await cacheRow(stepId)).toBeNull();
  });

  it('(d2/d3) 专有语法 / 激活态 class selector：降级可过但不落缓存', async () => {
    for (const selector of ['div >> nth=0', 'a.router-link-active', 'button']) {
      const { caseId, stepId } = await seedMechCase('点击提交按钮', clickStep('点击提交按钮'));
      testState.deadSelectors.add('#gone');
      aiActions = [[{ type: 'click', selector }, true]];
      const results = await replay(caseId, [{ order: 1, id: stepId, instruction: '点击提交按钮', compiled: clickStep('点击提交按钮') }]);
      expect(results[0]).toMatchObject({ status: 'passed', degraded: true });
      await vi.waitFor(async () => {
        if ((await cacheRowCount()) !== 0) throw new Error(`cache should stay empty for ${selector}`);
      }, { timeout: 500, interval: 20 });
      expect(await cacheRow(stepId)).toBeNull();
    }
  });

  it('(d4) 非 UUID stepId（草稿 staged-N）：读短路 + 不落库不崩', async () => {
    const { caseId, stepId } = await seedMechCase('点击提交按钮', clickStep('点击提交按钮'));
    testState.deadSelectors.add('#gone');
    aiActions = [[{ type: 'click', selector: '#fixed-btn' }, true]];

    const results = await replay(caseId, [{ order: 1, id: 'staged-1', instruction: '点击提交按钮', compiled: clickStep('点击提交按钮') }]);
    expect(results[0]).toMatchObject({ status: 'passed', degraded: true });
    await vi.waitFor(async () => {
      if ((await cacheRowCount()) !== 0) throw new Error('cache should stay empty');
    }, { timeout: 500, interval: 20 });
    expect(await cacheRowCount()).toBe(0);
    void stepId; // DB 行 id 与运行时 step id 无关（运行时用的是 staged-1）
  });

  it('(e) kind 隔离：缓存只注入同 kind 动作，click 不吃 fill 的缓存', async () => {
    const compiled = [
      { kind: 'fill', locator: [{ strategy: 'css', value: '#gone' }], value: 'x' },
      { kind: 'click', locator: [{ strategy: 'css', value: '#btn2' }] },
    ];
    const { caseId, stepId } = await seedMechCase('填写并提交', compiled);
    testState.deadSelectors.add('#gone');
    aiActions = [[{ type: 'click', selector: '#fixed-btn' }, true]]; // AI 修的是 fill 目标
    await replay(caseId, [{ order: 1, id: stepId, instruction: '填写并提交', compiled }]);
    const row = await waitForCache(stepId, (r) => r.locator?.value === '#fixed-btn');
    expect(row.action_kind).toBe('fill');

    // 二次回放：fill 吃缓存命中；click 的 #btn2 也挂了——若 kind 隔离失效（click 误吃缓存）则零 LLM 通过
    testState.deadSelectors.add('#btn2');
    aiActions = [];
    runAiTask.mockClear();
    const results = await replay(caseId, [{ order: 1, id: stepId, instruction: '填写并提交', compiled }]);
    expect(results[0]!.status).toBe('passed'); // fill 缓存命中后 click 失败 → 再次降级兜底
    expect(runAiTask).toHaveBeenCalledTimes(1); // click 未受缓存保护 → 必再走一次 AI
    expect(await cacheRow(stepId)).toMatchObject({ action_kind: 'fill' }); // 无 click/fill selector 可收 → 缓存不被覆写
  });
});
