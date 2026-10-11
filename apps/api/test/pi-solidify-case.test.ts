import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// 固化编排测试：runAiTask 打桩并借 opts.onAction 模拟 AI 动作收集（模块级 mock 下收集钩子
// 由测试手动驱动），writeStepScreenshot / extractPageElements 打桩，聚焦 solidify_case 编排契约。
vi.mock('../src/execute/aiTask.js', () => ({ runAiTask: vi.fn() }));
vi.mock('../src/execute/cdp.js', () => ({
  writeStepScreenshot: vi.fn(async () => '/screenshots/solidify-x/step-1.png'),
  // verifyCase.js（solidifyCase 复用其 buildStepInstruction/占位符）与 visionAssert 的传递依赖
  executeCaseInBrowser: vi.fn(),
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
vi.mock('../src/agent/llmSettings.js', () => ({
  resolveLlmClient: vi.fn(async () => ({
    config: { provider: 'anthropic', apiKey: 'fake', model: 'fake' },
    client: { provider: 'anthropic' as const, complete: async () => ({ kind: 'text' as const, value: '', provider: 'anthropic' as const, vision: false }) },
  })),
}));
// judgeCaseOutcome 仅经 verifyCase→visionAssert 传递加载，固化链路不调用；打桩隔绝其真实依赖
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

/** 每步 runAiTask 行为脚本：按调用序消费（步骤 fail-stop 语义下队列剩余项即"未执行"）。 */
interface StepSpec {
  /** (动作, 是否成功) 序列——成功动作进收集 */
  actions?: Array<[Record<string, unknown>, boolean]>;
  summary?: string;
  reject?: Error;
}
let stepQueue: StepSpec[] = [];
/** 每次调用时刻 valueSub(SECRET_PH) 的快照（循环结束后 stepSecret 已被重置，只能当场采样）。 */
let secretProbes: string[] = [];

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
    secretProbes.push(opts?.valueSub?.('__ITEST_STEP_SECRET__') ?? '');
    const step = stepQueue.shift() ?? {};
    for (const [a, ok] of step.actions ?? []) opts?.onAction?.(a, ok);
    if (step.reject) throw step.reject;
    return step.summary ?? '{"status":"passed","reason":"ok","login":"not-needed"}';
  });
  await pool.query(`TRUNCATE test_steps, test_cases, test_environments, environment_objects,
    requirements, "groups", projects, project_versions, ai_threads, ai_workspace_state, ai_stage_case_ops, ai_stage_cases
    RESTART IDENTITY CASCADE`);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  groupId = seed.groupId;
  versionId = seed.versionId;
  await pool.query(
    `INSERT INTO test_environments(project_id, name, is_default, base_url) VALUES ($1, '默认环境', true, 'http://env.example')`,
    [projectId],
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
  const r = await pool.query(`SELECT local_id, op, payload, case_id FROM ai_stage_case_ops WHERE thread_id = 't1'`);
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

  it('press / wait 无 DSL 对应 → 整步阻断', async () => {
    const { mapAiActionsToCompiled } = await import('../src/pi/space/tools/solidifyCase.js');
    const press = mapAiActionsToCompiled([{ type: 'click', selector: '#a' }, { type: 'press', key: 'Enter' }]);
    expect(press.ok).toBe(false);
    if (!press.ok) expect(press.reason).toContain('press');
    const wait = mapAiActionsToCompiled([{ type: 'wait', ms: 500 }]);
    expect(wait.ok).toBe(false);
    if (!wait.ok) expect(wait.reason).toContain('wait');
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
    if (!r.ok) expect(r.error).toContain('没有视觉模式步骤');
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
    // 暂存 update_step：确定性 localId（solidify-<stepId>）+ 映射后的 compiled 载荷
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
    // emitStage 广播 kind=case_op（前端暂存预览）
    const stageEvents = emitLog.filter((e) => (e as { type?: string }).type === 'stage');
    expect(stageEvents).toHaveLength(2);
    expect(stageEvents[0]).toMatchObject({ kind: 'case_op', id: `solidify-${stepId1}`, action: 'stage' });
    // solidify_progress SSE 序列：start → end（用户选定的最小相位指示）
    const sse = emitLog.filter((e) => (e as { type?: string }).type === 'solidify_progress');
    expect(sse.map((e) => (e as { phase: string }).phase)).toEqual(['start', 'end']);
    expect(sse[0]).toMatchObject({ caseId, total: 2, solidifiable: 2, targetUrl: 'http://env.example/page', loginCache: 'miss' });
    expect(sse[1]).toMatchObject({ result: 'solidified', solidified: 2, kept: 0 });
    // 固化不落库：DB 步骤 compiled 保持 NULL（等待 verify_case 验收 + 用户勾选保存）
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
    expect(opts.valueSub('普通值')).toBe('普通值'); // 无凭据环境：占位符替换为空、字面量原样
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
      {}, // 敏感步骤照常 AI 执行（占位符协议），但动作不收集
      {}, // 已编译步骤执行（compiled 作参考），不属固化候选
      { actions: [[{ type: 'click', selector: '#del' }, true]] },
    ];
    const emitLog: unknown[] = [];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx(emitLog)).execute({ caseId });
    expect(r.ok).toBe(true);
    const { runAiTask } = await import('../src/execute/aiTask.js');
    expect(runAiTask).toHaveBeenCalledTimes(3); // 所有步骤都真实执行（副作用与执行一致）
    // 敏感步骤提示词注入 __ITEST_STEP_SECRET__ 段（与 verify_case 同协议）
    const sensitiveInstruction = String(vi.mocked(runAiTask).mock.calls[0]![1]);
    expect(sensitiveInstruction).toContain('__ITEST_STEP_SECRET__');
    expect(secretProbes[0]).toBe('StepSecret!9'); // 调用时刻快照（循环结束后 stepSecret 已重置）
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
    expect(ops).toHaveLength(1); // 仅第 3 步
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
    // 第 1 步已通过也不暂存（整轮原子）
    expect(await stageOps()).toHaveLength(0);
    const end = emitLog.filter((e) => (e as { type?: string }).type === 'solidify_progress').at(-1) as { result: string; reason: string };
    expect(end).toMatchObject({ result: 'failed', reason: '保存按钮不可点击' });
  });

  it('失败动作（onAction ok=false）不收集 → 该步 kept-aiTask（无可映射动作）', async () => {
    const caseId = await seedCase({ steps: [{ instruction: '点击删除按钮' }] });
    stepQueue = [{ actions: [[{ type: 'click', selector: '#wrong' }, false], [{ type: 'click', selector: '#del' }, true]] }];
    const { buildSolidifyCaseTool } = await import('../src/pi/space/tools/solidifyCase.js');
    const r = await buildSolidifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('solidified'); // 成功的那个 click 仍被收集
      expect(data.steps[0]).toMatchObject({ order: 1, status: 'solidified' });
    }
    // 再验：全部动作失败 → kept-aiTask + nothing-solidified
    const caseId2 = await seedCase({ steps: [{ instruction: '点击删除按钮' }] });
    stepQueue = [{ actions: [[{ type: 'click', selector: '#wrong' }, false]] }];
    const r2 = await buildSolidifyCaseTool(toolCtx()).execute({ caseId: caseId2 });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      const data2 = JSON.parse(r2.data!);
      expect(data2.result).toBe('nothing-solidified');
      expect(data2.steps[0]).toMatchObject({ status: 'kept-aiTask' });
      expect(String(data2.steps[0].reason)).toContain('无可映射动作');
    }
    expect(await stageOps()).toHaveLength(1); // 仅第一轮的 1 条
  });

  it('含 press 动作的步骤 → kept-aiTask 附原因，其余步骤正常固化', async () => {
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
      expect(data.steps[0]).toMatchObject({ status: 'kept-aiTask' });
      expect(String(data.steps[0].reason)).toContain('press');
      expect(data.steps[1]).toMatchObject({ status: 'solidified' });
    }
    const ops = await stageOps();
    expect(ops).toHaveLength(1); // 仅第 2 步产生暂存
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
    // 整例重暂存：steps 的 compiled 被就地填充
    const row = await pool.query(`SELECT steps FROM ai_stage_cases WHERE local_id = $1`, [localId]);
    const steps = row.rows[0]!.steps as Array<{ compiled: unknown[] | null }>;
    expect(steps[0]!.compiled).toEqual([{ kind: 'click', locator: [{ strategy: 'css', value: '#del' }] }]);
    expect(steps[1]!.compiled).toEqual([
      { kind: 'fill', locator: [{ strategy: 'css', value: 'input[name="ruleName"]' }], value: '规则A' },
    ]);
    // 草稿不产生 case_op 暂存，emitStage 广播 kind=case
    expect(await stageOps()).toHaveLength(0);
    const stageEvents = emitLog.filter((e) => (e as { type?: string }).type === 'stage');
    expect(stageEvents).toHaveLength(1);
    expect(stageEvents[0]).toMatchObject({ kind: 'case', id: localId, action: 'stage' });
    // 全程不落库
    const dbRows = await pool.query(`SELECT id FROM test_cases WHERE title = '草稿用例'`);
    expect(dbRows.rows).toHaveLength(0);
  });

  it('基于 stage_case_op 暂存叠加：update_step 置 null 回退视觉后固化 → basedOn=staged', async () => {
    // DB 步骤已编译；暂存 update_step 把 compiled 置 null（回退视觉模式）→ 固化基于叠加态
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
    // 固化暂存（solidify-<stepId>）与前置回退暂存共存于同一草稿区
    const ops = await stageOps();
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.local_id)).toContain(`solidify-${stepId}`);
  });

  it('登录态缓存：命中注入 storageState，执行后无条件回写', async () => {
    const caseId = await seedCase({ steps: [{ instruction: '点击删除按钮' }] });
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
    // 回写：mock context.storageState 返回 sid=cached
    expect(getLoginState(`${envIdRow.rows[0]!.id}:`)).toEqual({ cookies: [{ name: 'sid', value: 'cached' }], origins: [] });
    const start = emitLog.find((e) => (e as { phase?: string }).phase === 'start') as { loginCache: string };
    expect(start.loginCache).toBe('hit');
  });
});

describe('solidify_case 注册', () => {
  it('buildSpaceTools 包含 solidify_case', async () => {
    const { buildSpaceTools } = await import('../src/pi/space/tools/index.js');
    const names = buildSpaceTools(toolCtx()).map((t) => t.name);
    expect(names).toContain('solidify_case');
  });
});
