import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// aiTask 运行时缓存测试：真 cdp.ts（不 mock 整模块）+ playwright-core / aiTask.js /
// llmSettings.js 打桩 + testcontainer PG。核心断言都在 step_action_cache 表与
// ExecStepResult.cached 字段上——缓存是"自动挡固化"，对 test_steps.compiled 零侵入。
vi.mock('../src/execute/aiTask.js', () => ({
  runAiTask: vi.fn(),
  // 与真实同款语义（cdp.ts 凭它判定验证码指令走缓存豁免；aiActionMap 凭占位符常量拦截凭据固化）
  CAPTCHA_TASK_RE: /验证码|captcha/i,
  USER_PH: '__ITEST_USERNAME__',
  PASSWORD_PH: '__ITEST_PASSWORD__',
  SECRET_PH: '__ITEST_STEP_SECRET__',
  solveCaptchaOnce: vi.fn(async () => null),
  detectCaptchaFailure: vi.fn(() => false),
}));
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
  // clicks 记录机械执行的 click 选择器（缓存命中路径走 playwright，AI 路径走 runAiTask 桩）；
  // failClicks 注入缓存动作执行失败（页面分叉自愈场景）。
  const state = { clicks: [] as string[], failClicks: 0 };
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
    count: vi.fn(async () => 1),
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
let testState: { clicks: string[]; failClicks: number };

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
  runAiTask.mockImplementation(async (...args: unknown[]) => {
    const opts = args[4] as { onAction?: (a: Record<string, unknown>, ok: boolean) => void } | undefined;
    for (const [a, ok] of aiActions) opts?.onAction?.(a, ok);
    if (aiError) throw aiError;
    return 'done';
  });
  await pool.query(`TRUNCATE step_action_cache, test_steps, test_cases, test_environments, environment_objects,
    requirements, "groups", projects, project_versions RESTART IDENTITY CASCADE`);
  const seed = await seedProject(pool);
  groupId = seed.groupId;
  versionId = seed.versionId;
});

/** 造一个单 aiTask 步骤的 DB 用例，返回 (caseId, stepId)。 */
async function seedAiTaskCase(instruction: string): Promise<{ caseId: string; stepId: string }> {
  const caseId = randomUUID();
  await pool.query(
    `INSERT INTO test_cases(id, group_id, version_id, title, url, platform) VALUES ($1, $2, $3, '缓存用例', 'http://env.example/page', 'web')`,
    [caseId, groupId, versionId],
  );
  const r = await pool.query(
    `INSERT INTO test_steps(case_id, "order", source, compiled, instruction)
     VALUES ($1, 1, 'ai', $2::jsonb, $3) RETURNING id`,
    [caseId, JSON.stringify([{ kind: 'aiTask', instruction }]), instruction],
  );
  return { caseId, stepId: r.rows[0]!.id as string };
}

function replay(caseId: string, stepId: string, instruction: string, initialVars?: Record<string, string>) {
  return executeCaseReal(
    caseId,
    [{ order: 1, id: stepId, compiled: [{ kind: 'aiTask', instruction }] }],
    { reportId: `r-${randomUUID().slice(0, 8)}`, ...(initialVars ? { initialVars } : {}) },
  );
}

async function cacheRow(stepId: string): Promise<{ instruction: string; actions: unknown[]; hits: number } | null> {
  const r = await pool.query(`SELECT instruction, actions, hits FROM step_action_cache WHERE step_id = $1`, [stepId]);
  return (r.rows[0] as { instruction: string; actions: unknown[]; hits: number }) ?? null;
}

/** 缓存写入 / 命中计数是 fire-and-forget（回放不阻塞在缓存上），断言前轮询等它落库。 */
async function waitForCache(
  stepId: string,
  check: (row: { instruction: string; actions: unknown[]; hits: number }) => boolean,
): Promise<{ instruction: string; actions: unknown[]; hits: number }> {
  return vi.waitFor(async () => {
    const row = await cacheRow(stepId);
    if (!row || !check(row)) throw new Error(`cache row not ready: ${JSON.stringify(row)}`);
    return row;
  }, { timeout: 3000, interval: 20 });
}

describe('aiTask 运行时动作缓存', () => {
  it('首次回放：AI 执行 + 动作收集 → 缓存落库（不机械执行）', async () => {
    const { caseId, stepId } = await seedAiTaskCase('点击删除按钮');
    aiActions = [
      [{ type: 'click', selector: '#del' }, true],
      [{ type: 'fill', selector: 'input[name="ruleName"]', value: '规则A' }, true],
      [{ type: 'screenshot', selector: 'body' }, true], // 观察性动作不进缓存
    ];
    const results = await replay(caseId, stepId, '点击删除按钮');
    expect(results[0]).toMatchObject({ status: 'passed' });
    expect(results[0]!.cached).toBeUndefined();
    expect(runAiTask).toHaveBeenCalledTimes(1);
    expect(testState.clicks).toEqual([]); // AI 相由 runAiTask 桩执行,未经 playwright
    const row = await waitForCache(stepId, (r) => Array.isArray(r.actions) && r.actions.length === 2);
    expect(row).toMatchObject({ instruction: '点击删除按钮', hits: 0 });
    expect(row.actions).toEqual([
      { kind: 'click', locator: [{ strategy: 'css', value: '#del' }] },
      { kind: 'fill', locator: [{ strategy: 'css', value: 'input[name="ruleName"]' }], value: '规则A' },
    ]);
    // 对用例定义零侵入
    const step = await pool.query(`SELECT compiled FROM test_steps WHERE id = $1`, [stepId]);
    expect(step.rows[0]!.compiled).toEqual([{ kind: 'aiTask', instruction: '点击删除按钮' }]);
  });

  it('二次回放：缓存命中机械执行（零 LLM），cached=true + hits 累计', async () => {
    const { caseId, stepId } = await seedAiTaskCase('点击删除按钮');
    aiActions = [[{ type: 'click', selector: '#del' }, true]];
    await replay(caseId, stepId, '点击删除按钮');
    await waitForCache(stepId, (r) => r.actions.length === 1); // 等首写落库,二次回放才有得命中

    aiActions = []; // 若误走 AI 相也无动作可收
    runAiTask.mockClear();
    testState.clicks.length = 0;
    const results = await replay(caseId, stepId, '点击删除按钮');
    expect(results[0]).toMatchObject({ status: 'passed', cached: true });
    expect(results[0]!.warning).toContain('缓存命中');
    expect(runAiTask).not.toHaveBeenCalled(); // 全程零 LLM
    expect(testState.clicks).toEqual(['#del']); // 缓存动作经 playwright 机械执行
    expect((await waitForCache(stepId, (r) => r.hits === 1)).hits).toBe(1);
  });

  it('缓存分叉自愈：缓存动作执行失败 → 静默回退 AI 重做并覆写缓存', async () => {
    const { caseId, stepId } = await seedAiTaskCase('点击删除按钮');
    aiActions = [[{ type: 'click', selector: '#del' }, true]];
    await replay(caseId, stepId, '点击删除按钮');
    await waitForCache(stepId, (r) => r.actions.length === 1);

    testState.failClicks = 1; // 页面分叉：缓存选择器点击失败一次
    aiActions = [[{ type: 'click', selector: '#del2' }, true]];
    runAiTask.mockClear();
    const results = await replay(caseId, stepId, '点击删除按钮');
    expect(results[0]).toMatchObject({ status: 'passed' }); // 回退相不算命中
    expect(results[0]!.cached).toBeUndefined();
    expect(runAiTask).toHaveBeenCalledTimes(1); // 回退 AI
    // 就地覆写
    const row = await waitForCache(stepId, (r) =>
      JSON.stringify(r.actions).includes('#del2'));
    expect(row.actions).toEqual([{ kind: 'click', locator: [{ strategy: 'css', value: '#del2' }] }]);
    // 第三次回放：新缓存已可命中
    aiActions = [];
    runAiTask.mockClear();
    testState.clicks.length = 0;
    const r3 = await replay(caseId, stepId, '点击删除按钮');
    expect(r3[0]).toMatchObject({ status: 'passed', cached: true });
    expect(runAiTask).not.toHaveBeenCalled();
  });

  it('AI 路径失败 → 步骤 failed（fail-stop 语义不变），不写缓存', async () => {
    const { caseId, stepId } = await seedAiTaskCase('点击删除按钮');
    aiActions = [[{ type: 'click', selector: '#del' }, true]];
    aiError = new Error('AI 不可用');
    const results = await replay(caseId, stepId, '点击删除按钮');
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toContain('AI 不可用');
    expect(await cacheRow(stepId)).toBeNull();
  });

  it('指令修改 → 缓存过期 miss → 走 AI 并以新指令覆写', async () => {
    const { caseId, stepId } = await seedAiTaskCase('旧指令');
    aiActions = [[{ type: 'click', selector: '#old' }, true]];
    await replay(caseId, stepId, '旧指令');

    aiActions = [[{ type: 'click', selector: '#new' }, true]];
    runAiTask.mockClear();
    const results = await replay(caseId, stepId, '新指令'); // 同 stepId 不同 instruction
    expect(results[0]).toMatchObject({ status: 'passed' });
    expect(results[0]!.cached).toBeUndefined();
    expect(runAiTask).toHaveBeenCalledTimes(1);
    const row = await waitForCache(stepId, (r) => r.instruction === '新指令');
    expect(row.actions).toEqual([{ kind: 'click', locator: [{ strategy: 'css', value: '#new' }] }]);
  });

  it('验证码指令：永不读/写缓存（每次必须真识别）', async () => {
    const { caseId, stepId } = await seedAiTaskCase('识别验证码图片中的字符并填入验证码输入框');
    aiActions = [[{ type: 'fill', selector: '#captcha', value: '1234' }, true]];
    const results = await replay(caseId, stepId, '识别验证码图片中的字符并填入验证码输入框');
    expect(results[0]).toMatchObject({ status: 'passed' });
    expect(results[0]!.cached).toBeUndefined();
    expect(runAiTask).toHaveBeenCalledTimes(1);
    expect(await cacheRow(stepId)).toBeNull();
    // 二次回放同样走 AI
    runAiTask.mockClear();
    await replay(caseId, stepId, '识别验证码图片中的字符并填入验证码输入框');
    expect(runAiTask).toHaveBeenCalledTimes(1);
    expect(await cacheRow(stepId)).toBeNull();
  });

  it('数据集变量指令（{{var}}）：替换后与模板不一致 → 不缓存', async () => {
    const { caseId, stepId } = await seedAiTaskCase('在搜索框输入 {{keyword}} 并提交');
    aiActions = [[{ type: 'fill', selector: '#q', value: '规则A' }, true]];
    const results = await replay(caseId, stepId, '在搜索框输入 {{keyword}} 并提交', { keyword: '规则A' });
    expect(results[0]).toMatchObject({ status: 'passed' });
    // runAiTask 收到的是物化后的指令
    expect(String(vi.mocked(runAiTask).mock.calls[0]![1])).toContain('规则A');
    expect(await cacheRow(stepId)).toBeNull(); // 物化值冻结进缓存会跨行复用出错,v1 豁免
  });

  it('不可映射动作（press）：步骤照常通过但不写缓存', async () => {
    const { caseId, stepId } = await seedAiTaskCase('填入关键词后回车');
    aiActions = [
      [{ type: 'fill', selector: '#q', value: 'x' }, true],
      [{ type: 'press', key: 'Enter' }, true],
    ];
    const results = await replay(caseId, stepId, '填入关键词后回车');
    expect(results[0]).toMatchObject({ status: 'passed' });
    expect(await cacheRow(stepId)).toBeNull();
  });
});
