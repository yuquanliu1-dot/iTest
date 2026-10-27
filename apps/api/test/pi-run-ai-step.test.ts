import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// run_ai_step（免暂存直跑 AI 相）编排契约测试：runAiTask / gotoWithLandedRetry /
// writeStepScreenshot / playwright / LLM client 打桩，聚焦会话生命周期——
// 同线程复用浏览器（页面状态跨调用保留）、目标地址三态、凭据占位符注入、登录态缓存读写。
// 注意：工具内部有模块级会话表，每个用例必须用唯一 threadId（否则跨用例复用泄漏的会话）。
vi.mock('../src/execute/aiTask.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/execute/aiTask.js')>();
  return { ...actual, runAiTask: vi.fn() };
});
vi.mock('../src/execute/cdp.js', () => ({
  writeStepScreenshot: vi.fn(async () => '/screenshots/aistep-x/step-1.png'),
  gotoWithLandedRetry: vi.fn(async (_page: unknown, targetUrl: string) => ({ landed: true, finalUrl: targetUrl })),
}));
vi.mock('../src/agent/llmSettings.js', () => ({
  resolveLlmClient: vi.fn(async () => ({
    config: { provider: 'anthropic', apiKey: 'fake', model: 'fake' },
    client: { provider: 'anthropic' as const, complete: async () => ({ kind: 'text' as const, value: '', provider: 'anthropic' as const, vision: false }) },
  })),
}));
// liveView 包 spy（真实行为不变：登记进内存表，liveUrl 由 key 组成）
vi.mock('../src/execute/liveView.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/execute/liveView.js')>();
  return { ...actual, registerLiveView: vi.fn(actual.registerLiveView) };
});
// playwright 桩：记录 launch 次数 / newContext 入参 / 产出的 page 对象。
// page 身份稳定（每次 newPage 返回独立对象并进 pages 数组），供「复用同一 page」断言。
vi.mock('playwright-core', () => {
  const state = {
    launches: 0,
    ctxOpts: [] as unknown[],
    pages: [] as object[],
  };
  return {
    chromium: {
      launch: vi.fn(async () => {
        state.launches += 1;
        return {
          newContext: vi.fn(async (opts?: unknown) => {
            state.ctxOpts.push(opts);
            return {
              newPage: async () => {
                const page = {
                  url: () => 'http://env.example/page',
                  isClosed: () => false,
                  screenshot: async () => Buffer.from('fake-png'),
                  close: async () => {},
                };
                state.pages.push(page);
                return page;
              },
              storageState: async () => ({ cookies: [{ name: 'sid', value: 'live' }], origins: [] }),
              close: async () => {},
            };
          }),
          close: async () => {},
        };
      }),
    },
    __testState: state,
  };
});

let container: StartedPostgreSqlContainer;
let pool: Pool;
let projectId: string;
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
  const { __testState } = (await import('playwright-core')) as unknown as {
    __testState: { launches: number; ctxOpts: unknown[]; pages: object[] };
  };
  __testState.launches = 0;
  __testState.ctxOpts.length = 0;
  __testState.pages.length = 0;
  // runAiTask 缺省自报通过；失败/异常用例用 mockImplementationOnce 覆写
  const { runAiTask } = await import('../src/execute/aiTask.js');
  vi.mocked(runAiTask).mockImplementation(async () => '{"status":"passed","reason":"ok","login":"not-needed"}');
  await pool.query(`TRUNCATE test_steps, test_cases, test_environments, environment_objects,
    requirements, "groups", projects, project_versions, ai_threads RESTART IDENTITY CASCADE`);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  versionId = seed.versionId;
  // 默认环境 + 默认 web 服务（无 login 凭据）：resolveWebOrigin → http://env.example
  const seedEnv = await pool.query(
    `INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '默认环境', true) RETURNING id`,
    [projectId],
  );
  await pool.query(
    `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES ($1, 'web', '默认', '{"name":"web","scheme":"http","host":"env.example"}', true)`,
    [seedEnv.rows[0]!.id],
  );
});

async function seedLoginObject(): Promise<void> {
  const { encrypt } = await import('../src/lib/secret-crypto.js');
  const enc = encrypt('Passw0rd!');
  // 先降级 beforeEach 插入的默认环境（唯一部分索引 test_environments_project_default_uq），再插新默认
  await pool.query(`UPDATE test_environments SET is_default = false WHERE project_id = $1`, [projectId]);
  const env = await pool.query(
    `INSERT INTO test_environments(project_id, name, is_default) VALUES ($1, '登录环境', true) RETURNING id`,
    [projectId],
  );
  // 0041 起登录凭据并入默认 web 服务对象：user/loginUrl/secret 内嵌 payload
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

/** 当前默认环境 id（loginStateCache 的 key 组成部分） */
async function defaultEnvId(): Promise<string> {
  const r = await pool.query(`SELECT id FROM test_environments WHERE project_id = $1 AND is_default = true`, [projectId]);
  return r.rows[0]!.id as string;
}

interface EmitLogEntry {
  type: string;
  phase: string;
  instruction?: string;
  targetUrl?: string;
  loginCache?: string;
  loginUser?: string | null;
  liveUrl?: string;
  result?: string;
  reason?: string;
  durationMs?: number;
  login?: string;
}

function toolCtx(tid: string, emitLog: EmitLogEntry[]) {
  return {
    threadId: tid,
    versionId,
    projectId,
    repo: { cwd: null, issue: null, noRepo: false },
    emit: (e: unknown) => emitLog.push(e as EmitLogEntry),
  };
}

const PASSED_JSON = '{"status":"passed","reason":"ok","login":"not-needed"}';

describe('run_ai_step 前置校验', () => {
  it('LLM 未配置 → ok:false，不启动浏览器', async () => {
    const { resolveLlmClient } = await import('../src/agent/llmSettings.js');
    vi.mocked(resolveLlmClient).mockRejectedValueOnce(new Error('未配置 provider'));
    const { buildRunAiStepTool } = await import('../src/pi/space/tools/runAiStep.js');
    const r = await buildRunAiStepTool(toolCtx('t-' + randomUUID(), [])).execute({ instruction: '点一下' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('AI 相直跑失败');
    const { chromium } = await import('playwright-core');
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it('首次调用无 url 且环境无 web 服务 → ok:false 缺少目标地址', async () => {
    await pool.query(`DELETE FROM environment_objects`);
    const { buildRunAiStepTool } = await import('../src/pi/space/tools/runAiStep.js');
    const r = await buildRunAiStepTool(toolCtx('t-' + randomUUID(), [])).execute({ instruction: '点一下' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('缺少目标地址');
    const { chromium } = await import('playwright-core');
    expect(chromium.launch).not.toHaveBeenCalled();
  });
});

describe('run_ai_step 编排', () => {
  it('无 login：首次缺省 url 用环境默认 origin 兜底；指令含用户文本与输出契约、无凭据段', async () => {
    const tid = 't-' + randomUUID();
    const emitLog: EmitLogEntry[] = [];
    const { buildRunAiStepTool } = await import('../src/pi/space/tools/runAiStep.js');
    const r = await buildRunAiStepTool(toolCtx(tid, emitLog)).execute({ instruction: '点击查询按钮' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = JSON.parse(r.data!) as { result: string; instruction: string; login: string; pageUrl: string; screenshot: string };
    expect(data.result).toBe('passed');
    expect(data.instruction).toBe('点击查询按钮');
    expect(data.login).toBe('not-needed');
    expect(data.pageUrl).toBe('http://env.example/page');
    expect(data.screenshot).toBe('/screenshots/aistep-x/step-1.png');
    // 初始导航：环境默认 web origin
    const { gotoWithLandedRetry } = await import('../src/execute/cdp.js');
    expect(vi.mocked(gotoWithLandedRetry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gotoWithLandedRetry).mock.calls[0]![1]).toBe('http://env.example');
    // 提示词：用户指令 + 输出契约；无凭据 → 不出现登录凭据段与占位符
    const { runAiTask } = await import('../src/execute/aiTask.js');
    expect(vi.mocked(runAiTask)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runAiTask).mock.calls[0]!;
    expect(call[1]).toContain('点击查询按钮');
    expect(call[1]).toContain('输出契约');
    expect(call[1]).not.toContain('登录凭据');
    expect(call[1]).not.toContain('__ITEST');
    expect(call[3]).toBe(false); // desktop
    expect(typeof call[4].valueSub).toBe('function');
    // SSE 进度：start（含 liveUrl 前缀）→ end
    const start = emitLog.find((e) => e.phase === 'start')!;
    expect(start.type).toBe('ai_step_progress');
    expect(start.instruction).toBe('点击查询按钮');
    expect(start.targetUrl).toBe('http://env.example');
    expect(start.loginCache).toBe('miss');
    expect(start.loginUser).toBeNull();
    expect(start.liveUrl).toMatch(new RegExp(`^/api/assistant/threads/${tid}/live/`));
    const end = emitLog.find((e) => e.phase === 'end')!;
    expect(end.result).toBe('passed');
    expect(typeof end.durationMs).toBe('number');
  });

  it('会话复用：同线程第二次调用不重建浏览器、不重复导航、runAiTask 拿到同一 page', async () => {
    const tid = 't-' + randomUUID();
    const { buildRunAiStepTool } = await import('../src/pi/space/tools/runAiStep.js');
    const tool = buildRunAiStepTool(toolCtx(tid, []));
    const r1 = await tool.execute({ instruction: '打开高级筛选' });
    const r2 = await tool.execute({ instruction: '勾选「只看未处理」' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { launches: number; pages: object[] } };
    expect(__testState.launches).toBe(1);
    expect(__testState.pages.length).toBe(1);
    const { gotoWithLandedRetry } = await import('../src/execute/cdp.js');
    expect(vi.mocked(gotoWithLandedRetry)).toHaveBeenCalledTimes(1); // 第二次未传 url → 不导航
    const { runAiTask } = await import('../src/execute/aiTask.js');
    expect(vi.mocked(runAiTask)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAiTask).mock.calls[0]![0]).toBe(__testState.pages[0]);
    expect(vi.mocked(runAiTask).mock.calls[1]![0]).toBe(__testState.pages[0]);
  });

  it('续会话显式换页：传 url 导航到新地址', async () => {
    const tid = 't-' + randomUUID();
    const emitLog: EmitLogEntry[] = [];
    const { buildRunAiStepTool } = await import('../src/pi/space/tools/runAiStep.js');
    const tool = buildRunAiStepTool(toolCtx(tid, emitLog));
    await tool.execute({ instruction: '第一步' });
    await tool.execute({ instruction: '第二步', url: 'http://env.example/other' });
    const { gotoWithLandedRetry } = await import('../src/execute/cdp.js');
    expect(vi.mocked(gotoWithLandedRetry)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(gotoWithLandedRetry).mock.calls[1]![1]).toBe('http://env.example/other');
    const starts = emitLog.filter((e) => e.phase === 'start');
    expect(starts[1]!.targetUrl).toBe('http://env.example/other');
  });

  it('LLM 自报 failed → result failed + reason 透传（SSE end 同步失败）', async () => {
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockImplementationOnce(async () => '{"status":"failed","reason":"按钮置灰不可点击"}');
    const emitLog: EmitLogEntry[] = [];
    const { buildRunAiStepTool } = await import('../src/pi/space/tools/runAiStep.js');
    const r = await buildRunAiStepTool(toolCtx('t-' + randomUUID(), emitLog)).execute({ instruction: '点击提交' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = JSON.parse(r.data!) as { result: string; reason: string | null };
    expect(data.result).toBe('failed');
    expect(data.reason).toBe('按钮置灰不可点击');
    const end = emitLog.find((e) => e.phase === 'end')!;
    expect(end.result).toBe('failed');
    expect(end.reason).toBe('按钮置灰不可点击');
  });

  it('runAiTask 抛错 → result failed + 错误消息截断透传', async () => {
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockRejectedValueOnce(new Error('AI 轮次耗尽'));
    const { buildRunAiStepTool } = await import('../src/pi/space/tools/runAiStep.js');
    const r = await buildRunAiStepTool(toolCtx('t-' + randomUUID(), [])).execute({ instruction: '点击提交' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = JSON.parse(r.data!) as { result: string; reason: string | null };
    expect(data.result).toBe('failed');
    expect(data.reason).toContain('AI 轮次耗尽');
  });

  it('非契约 JSON 输出 → 仍判 passed，原文进 warning 供人工核查', async () => {
    const { runAiTask } = await import('../src/execute/aiTask.js');
    vi.mocked(runAiTask).mockImplementationOnce(async () => '看起来完成了');
    const { buildRunAiStepTool } = await import('../src/pi/space/tools/runAiStep.js');
    const r = await buildRunAiStepTool(toolCtx('t-' + randomUUID(), [])).execute({ instruction: '点击提交' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = JSON.parse(r.data!) as { result: string; warning?: string };
    expect(data.result).toBe('passed');
    expect(data.warning).toBe('看起来完成了');
  });

  it('配置登录凭据：占位符进提示词（真实值不进）、valueSub 可解析、缓存命中注入 storageState、跑完回写', async () => {
    await seedLoginObject();
    const { loginStateKey, saveLoginState, getLoginState } = await import('../src/pi/space/tools/loginStateCache.js');
    const envId = await defaultEnvId();
    const key = loginStateKey(envId, 'qa01');
    saveLoginState(key, { cookies: [{ name: 'sid', value: 'cached' }], origins: [] });
    const emitLog: EmitLogEntry[] = [];
    const { buildRunAiStepTool } = await import('../src/pi/space/tools/runAiStep.js');
    const r = await buildRunAiStepTool(toolCtx('t-' + randomUUID(), emitLog)).execute({ instruction: '打开告警列表' });
    expect(r.ok).toBe(true);
    // 缓存命中：newContext 注入 storageState；start 事件回显 hit/qa01
    const { __testState } = (await import('playwright-core')) as unknown as { __testState: { ctxOpts: Array<unknown> } };
    expect((__testState.ctxOpts[0] as { storageState?: { cookies: Array<{ value: string }> } }).storageState?.cookies[0]?.value).toBe('cached');
    const start = emitLog.find((e) => e.phase === 'start')!;
    expect(start.loginCache).toBe('hit');
    expect(start.loginUser).toBe('qa01');
    // 提示词：@web 占位符形态 + 登录凭据段；真实密码绝不出现
    const { runAiTask } = await import('../src/execute/aiTask.js');
    const call = vi.mocked(runAiTask).mock.calls[0]!;
    expect(call[1]).toContain('__ITEST_USERNAME@web__');
    expect(call[1]).toContain('登录凭据');
    expect(call[1]).not.toContain('Passw0rd!');
    // valueSub：@web 占位符解析到真实用户名
    expect(call[4].valueSub('__ITEST_USERNAME@web__')).toBe('qa01');
    // 登录态回写（storageState 桩返回 sid=live）
    const after = getLoginState(key);
    expect(after?.cookies[0]?.value).toBe('live');
  });
});

describe('run_ai_step 注册', () => {
  it('buildSpaceTools 包含 run_ai_step', async () => {
    const { buildSpaceTools } = await import('../src/pi/space/tools/index.js');
    const names = buildSpaceTools(toolCtx('t-' + randomUUID(), []) as never).map((t) => t.name);
    expect(names).toContain('run_ai_step');
  });

  it('工具文案声明免草稿语义与会话复用（agent 依赖文案选路）', async () => {
    const { buildRunAiStepTool } = await import('../src/pi/space/tools/runAiStep.js');
    const tool = buildRunAiStepTool(toolCtx('t-' + randomUUID(), []));
    expect(tool.description).toContain('无需先创建');
    expect(tool.description).toContain('边跑边讨论');
    const guidelines = tool.promptGuidelines!.join('\n');
    expect(guidelines).toContain('不用写用例');
    expect(guidelines).toContain('不要每条都传 url');
    // 跑完即定型：暂存 → 固化 + mechanical 验收，禁止再跑一遍 full AI 相实测（步骤刚真实执行过）
    expect(guidelines).toContain('stage_case');
    expect(guidelines).toContain('solidify_case');
    expect(guidelines).toContain('不要再跑 verify_case(mode="full")');
  });
});
