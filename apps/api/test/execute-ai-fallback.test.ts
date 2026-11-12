import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright-core';
import type { LLMClient, LLMResult } from '../src/agent/llm-client.js';

// Same structure as execute-cdp.test.ts: playwright-core mocked wholesale (fake page + locator with a controllable count),
// driving executeCaseReal -> runStepsInContext. llmClient is injected via ctx.llmClient, bypassing resolveLlmClient's DB read.
vi.mock('playwright-core', () => {
  // pressSequentially typing trail: typedValues simulates a real input box (fill('') clears it, inputValue reads it back),
  // typedAll only appends -- used for credential-replacement assertions (two consecutive fills would wipe the earlier value).
  const typedValues: string[] = [];
  const typedAll: string[] = [];
  const makeLocator = () => ({
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn((v: string) => {
      if (v === '') typedValues.length = 0;
      return Promise.resolve(undefined);
    }),
    pressSequentially: vi.fn((v: string) => {
      typedValues.push(v);
      typedAll.push(v);
      return Promise.resolve(undefined);
    }),
    inputValue: vi.fn(() => Promise.resolve(typedValues.join(''))),
    hover: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(true),
    isChecked: vi.fn().mockResolvedValue(false),
    check: vi.fn().mockResolvedValue(undefined),
    uncheck: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    innerText: vi.fn().mockResolvedValue('{"code":0}'),
    filter: vi.fn().mockReturnThis(),
    first: vi.fn().mockReturnThis(),
    count: vi.fn().mockResolvedValue(1),
  });

  const locatorFn = vi.fn().mockReturnValue(makeLocator());

  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    locator: locatorFn,
    screenshot: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    url: vi.fn(() => 'https://example.com/path'),
    viewportSize: vi.fn(() => ({ width: 1280, height: 800 })),
    evaluate: vi.fn().mockResolvedValue([]),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
  };

  return {
    chromium: {
      launch: vi.fn().mockResolvedValue({
        newContext: () => ({ newPage: () => Promise.resolve(page) }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    },
    __page: page,
    __locator: locatorFn,
    __typed: typedAll,
  };
});

import { executeCaseReal } from '../src/execute/cdp.js';
import type { EnvCtx } from '../src/execute/envContext.js';

const mocked = await import('playwright-core') as unknown as {
  __page: Page & {
    goto: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    waitForTimeout: ReturnType<typeof vi.fn>;
    url: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
    keyboard: { press: ReturnType<typeof vi.fn> };
  };
  __locator: ReturnType<typeof vi.fn>;
  __typed: string[];
};

/** Scripted mock LLM: complete returns JSONs in order; throws when the script is exhausted (simulates AI unavailable/giving up). */
function makeMockLlm(script: Array<Record<string, unknown>>) {
  const calls: string[] = [];
  const llm: LLMClient = {
    provider: 'anthropic',
    async complete(): Promise<LLMResult> {
      calls.push('complete');
      const raw = script.shift();
      if (raw === undefined) throw new Error('mock script exhausted');
      return { kind: 'json', value: raw, provider: 'anthropic', vision: true };
    },
  };
  return { llm, calls };
}

/** Never-matching locator: count is always 0 -> tryFirstMatch reports all locator candidates failed across the whole window -> LocatorAllFailed. */
function missingLocator() {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    first: vi.fn().mockReturnThis(),
    count: vi.fn().mockResolvedValue(0),
  };
}

/** Env-context stub: login absent = environment has no credentials configured (the shape that triggers EnvMissing's upfront interception). */
function makeEnvCtx(login?: { user: string; password: string }): EnvCtx {
  return {
    envId: 'env-1',
    envName: '测试环境',
    webServices: [],
    resolveWebOrigin: () => null,
    baseUrl: null,
    ...(login ? { login: { ...login, loginUrl: null } } : {}),
    logins: new Map(),
    resolveLogin: (ref?: string | null) => (ref ? null : (login ? { ...login, loginUrl: null } : null)),
    hasCredentials: () => !!login,
    close: async () => undefined,
  } as EnvCtx;
}

// Since 2026-10-24 solidify became optional: the on-the-spot execution of NL visual steps (empty compiled + an instruction) is official execution semantics,
// governed by no switch; only "AI redo after a mechanical failure" is still governed by the locatorFailed switch.
const ON = { locatorFailed: true };
const OFF = { locatorFailed: false };

describe('NL 视觉步骤（空 compiled + 有指令）— 正式执行语义，不受降级开关管', () => {
  it('未传 aiFallback（locatorFailed 关 → runCase 不注入）：无条件 AI 临场执行，passed + degraded + warning', async () => {
    const { llm, calls } = makeMockLlm([{ done: true, summary: '已点击保存按钮' }]);
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve([{ selector: '#save', tag: 'button' }]));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000101',
      [{ order: 1, id: 's-2', instruction: '点击保存按钮', compiled: [] }],
      { reportId: 'r-cm-no-switch', llmClient: llm },
    );
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.warning).toMatch(/未编译，AI 按指令临场执行/);
    expect(results[0]!.degraded).toBe(true);
    expect(results[0]!.aiUsage?.calls).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('显式 aiFallback.locatorFailed=false 同样执行：与开关彻底解耦', async () => {
    const { llm, calls } = makeMockLlm([{ done: true, summary: '已点击保存按钮' }]);
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve([{ selector: '#save', tag: 'button' }]));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000105',
      [{ order: 1, id: 's-2b', instruction: '点击保存按钮', compiled: [] }],
      { reportId: 'r-cm-switch-off', aiFallback: OFF, llmClient: llm },
    );
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.warning).toMatch(/未编译，AI 按指令临场执行/);
    expect(results[0]!.degraded).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('AI 不可用（LLM 抛错）：回退原 compile-missing 失败', async () => {
    const { llm } = makeMockLlm([]); // empty script -> complete throws
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000102',
      [{ order: 1, id: 's-3', instruction: '点击保存按钮', compiled: [] }],
      { reportId: 'r-cm-ai-fail', llmClient: llm },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/compile-missing/);
  });

  it('无 instruction：无从执行，仍 compile-missing 失败，LLM 零调用', async () => {
    const { llm, calls } = makeMockLlm([]);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000103',
      [{ order: 1, id: 's-4', compiled: [] }],
      { reportId: 'r-cm-no-inst', aiFallback: ON, llmClient: llm },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/compile-missing/);
    expect(calls).toHaveLength(0);
  });

  it('instruction 为空串：同样 compile-missing 失败，LLM 零调用', async () => {
    const { llm, calls } = makeMockLlm([]);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000104',
      [{ order: 1, id: 's-5', instruction: '', compiled: [] }],
      { reportId: 'r-cm-empty-inst', aiFallback: ON, llmClient: llm },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/compile-missing/);
    expect(calls).toHaveLength(0);
  });
});

describe('回放 AI 降级 — 机械执行失败（任意失败原因）', () => {
  it('开关 off：仍 LocatorAllFailed 判失败', async () => {
    const { llm } = makeMockLlm([]);
    mocked.__locator.mockImplementationOnce(() => missingLocator());
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000110',
      [{ order: 1, id: 's-1', instruction: '点击已删除按钮', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#gone' }] }] }],
      { reportId: 'r-lf-off', aiFallback: OFF, llmClient: llm },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failureReason).toBe('LocatorAllFailed');
    // instruction snapshot: failed results carry it too, so the report page shows the intent for failed steps
    expect(results[0]!.instruction).toBe('点击已删除按钮');
  });

  it('开关 on + 有指令：AI 重做本步通过 + warning，并 continue 到下一步', async () => {
    const { llm } = makeMockLlm([{ done: true, summary: '已重做点按' }]);
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve([{ selector: '#btn', tag: 'button' }]));
    mocked.__locator.mockImplementationOnce(() => missingLocator());
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000111',
      [
        { order: 1, id: 's-1', instruction: '点击已删除按钮', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#gone' }] }] },
        { order: 2, id: 's-2', compiled: [{ kind: 'navigate', url: 'https://example.com/next' }] },
      ],
      { reportId: 'r-lf-on', aiFallback: ON, llmClient: llm },
    );
    expect(results).toHaveLength(2);
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.warning).toMatch(/机械执行失败（/);
    expect(results[0]!.warning).toMatch(/count=0/);
    expect(results[0]!.degraded).toBe(true);
    expect(results[0]!.aiUsage?.calls).toBeGreaterThanOrEqual(1);
    // instruction snapshot: the report page renders the step intent from it (degraded passed steps carry it as well)
    expect(results[0]!.instruction).toBe('点击已删除按钮');
    expect(results[0]!.compiled).toEqual([{ kind: 'click', locator: [{ strategy: 'css', value: '#gone' }] }]);
    expect(results[1]!.status).toBe('passed');
  });

  it('非 LocatorAllFailed 失败（AssertionMismatch）：同样降级 AI 重做通过', async () => {
    // Requirement wording: any mechanical failure degrades, not just element-identification failures. An assertText contains miss -> AssertionMismatch.
    const { llm } = makeMockLlm([{ done: true, summary: '已确认操作成功' }]);
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve('页面正文文本'));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000114',
      [{
        order: 1,
        id: 's-1',
        instruction: '断言页面显示操作成功',
        compiled: [{ kind: 'assertText', locator: [], target: 'page', match: 'contains', equals: '操作成功' }],
      }],
      { reportId: 'r-am-on', aiFallback: ON, llmClient: llm },
    );
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.warning).toMatch(/机械执行失败（/);
    expect(results[0]!.warning).toMatch(/assertText failed/);
    expect(results[0]!.degraded).toBe(true);
    expect(results[0]!.aiUsage?.calls).toBeGreaterThanOrEqual(1);
  });

  it('开关 on 但无 instruction：无指令不降级，仍 LocatorAllFailed 失败', async () => {
    const { llm, calls } = makeMockLlm([]);
    mocked.__locator.mockImplementationOnce(() => missingLocator());
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000112',
      [{ order: 1, id: 's-1', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#gone' }] }] }],
      { reportId: 'r-lf-no-inst', aiFallback: ON, llmClient: llm },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failureReason).toBe('LocatorAllFailed');
    expect(calls).toHaveLength(0);
  });

  it('开关 on 但 instruction 为空串：同样不降级，仍 LocatorAllFailed 失败', async () => {
    const { llm, calls } = makeMockLlm([]);
    mocked.__locator.mockImplementationOnce(() => missingLocator());
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000113',
      [{ order: 1, id: 's-1', instruction: '', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#gone' }] }] }],
      { reportId: 'r-lf-empty-inst', aiFallback: ON, llmClient: llm },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failureReason).toBe('LocatorAllFailed');
    expect(calls).toHaveLength(0);
  });

  it('开关 on + 有指令但 AI 降级抛错：仍失败 + warning 记录 AI 未成功 + aiUsage 有计数', async () => {
    // b7d40426 live-measured root cause: mechanical LocatorAllFailed -> degrade triggered -> runAiTask ran the LLM (onUsage already counted)
    // but the model returned {"fail":...} -> threw "aiTask 放弃". The old logic silently caught and fell back to the mechanical error, leaving an orphan
    // aiUsage in the report with no sign AI stepped in and failed to rescue. The script provides a fail response (non-empty script) to reproduce "AI was used but gave up".
    const { llm, calls } = makeMockLlm([{ fail: '找不到规则tab的关闭按钮' }]);
    mocked.__locator.mockImplementationOnce(() => missingLocator());
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000121',
      [{ order: 1, id: 's-1', instruction: '关闭打开的规则tab', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#gone' }] }] }],
      { reportId: 'r-lf-ai-err', aiFallback: ON, llmClient: llm },
    );
    // AI really was called (complete at least once)
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // still a mechanical failure (status/failureReason unchanged)
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failureReason).toBe('LocatorAllFailed');
    // no longer orphaned: warning records the unsuccessful AI degrade attempt + the give-up reason
    expect(results[0]!.warning).toMatch(/AI 降级尝试未成功/);
    expect(results[0]!.warning).toMatch(/aiTask 放弃/);
    expect(results[0]!.warning).toMatch(/找不到规则tab的关闭按钮/);
    // aiUsage has a count (echoing the warning, no longer a lone call record)
    expect(results[0]!.aiUsage?.calls).toBeGreaterThanOrEqual(1);
    // not a degraded pass
    expect(results[0]!.degraded).toBeUndefined();
  });

  it('开关 on 但本身是 aiTask 步骤：识别失败不降级，仍 LocatorAllFailed 失败', async () => {
    // An aiTask step is already running AI; redoing "per the instruction on the spot" after an identification failure adds nothing -> keep the original failure.
    // The LLM script provides 2 entries: if the degrade path misfires it would consume the 2nd and "pass"; the measured still-failed proves the guard works.
    const { llm } = makeMockLlm([
      { done: true, summary: '识别成功' },
      { done: true, summary: '重做成功' },
    ]);
    mocked.__locator.mockImplementationOnce(() => missingLocator());
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000120',
      [{
        order: 1,
        id: 's-1',
        instruction: '识别验证码并填入验证码输入框',
        compiled: [
          { kind: 'aiTask', instruction: '识别验证码并填入验证码输入框' },
          { kind: 'click', locator: [{ strategy: 'css', value: '#gone' }] },
        ],
      }],
      { reportId: 'r-lf-aitask', aiFallback: ON, llmClient: llm },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failureReason).toBe('LocatorAllFailed');
    expect(results[0]!.degraded).toBeUndefined();
  });

  it('非浏览器步骤（httpRequest）失败：不降级，LLM 零调用', async () => {
    // prod228 report 15dd42d9: the Host-header injection probe's httpRequest assertion failure (200 != 400) triggered the degrade,
    // but AI can only drive the browser and cannot set protected headers -> structurally impossible, burning 44.5s / 1 call for zero gain.
    // Asserts an httpRequest failure stays out of the degrade path: zero LLM calls, failureReason stays HttpRequestAssertionFailed.
    const srv = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
    try {
      const { llm, calls } = makeMockLlm([{ done: true, summary: '不应被调用' }]);
      const results = await executeCaseReal(
        '00000000-0000-0000-0000-000000000122',
        [{
          order: 1,
          id: 's-1',
          instruction: '发送 GET 请求，Host 头注入 SQL 注入探针，断言被 400 拒绝',
          compiled: [{
            kind: 'httpRequest',
            method: 'GET',
            url,
            headers: [{ key: 'Host', value: "' OR '1'='1" }],
            timeoutMs: 5000,
            assertion: { status: 400, match: 'contains', expected: '' },
          }],
        }],
        { reportId: 'r-lf-http', aiFallback: ON, llmClient: llm },
      );
      expect(results[0]!.status).toBe('failed');
      expect(results[0]!.failureReason).toBe('HttpRequestAssertionFailed');
      expect(results[0]!.degraded).toBeUndefined();
      expect(calls).toHaveLength(0);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe('回放 AI 降级 — 凭据占位符替换（2026-10-21 prod228 登录空转修复）', () => {
  it('NL 视觉步骤：AI fill 哨兵占位符被替换为环境 login 真实凭据', async () => {
    mocked.__typed.length = 0;
    const { llm } = makeMockLlm([
      {
        actions: [
          { type: 'fill', selector: '#user', value: '__ITEST_USERNAME__' },
          { type: 'fill', selector: '#pass', value: '__ITEST_PASSWORD__' },
        ],
        done: true,
        summary: '已填写凭据并登录',
      },
    ]);
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve([{ selector: '#user', tag: 'input' }]));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000130',
      [{ order: 1, id: 's-cred-1', instruction: '在登录页填写 __ITEST_USERNAME__ / __ITEST_PASSWORD__ 并登录', compiled: [] }],
      { reportId: 'r-cred-cm', llmClient: llm, envCtx: makeEnvCtx({ user: 'admin', password: 'pw9' }) },
    );
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.degraded).toBe(true);
    // what got typed is the real credential, not the literal placeholder
    expect(mocked.__typed).toContain('admin');
    expect(mocked.__typed).toContain('pw9');
    expect(mocked.__typed.join('|')).not.toMatch(/__ITEST_/);
  });

  it('NL 视觉步骤：模型输出花括号变体 {{ITEST_USERNAME}} 同样被替换；指令含凭据不算缺变量', async () => {
    mocked.__typed.length = 0;
    const { llm } = makeMockLlm([
      { actions: [{ type: 'fill', selector: '#user', value: '{{ITEST_USERNAME}}' }], done: true, summary: '已填写' },
    ]);
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve([{ selector: '#user', tag: 'input' }]));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000131',
      [{ order: 1, id: 's-cred-2', instruction: '在登录页填写 {{ITEST_USERNAME}} 登录', compiled: [] }],
      { reportId: 'r-cred-brace', llmClient: llm, envCtx: makeEnvCtx({ user: 'admin', password: 'pw9' }) },
    );
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.degraded).toBe(true);
    expect(mocked.__typed).toContain('admin');
    expect(mocked.__typed.join('|')).not.toContain('{{ITEST_USERNAME}}');
  });

  it('环境未配置 login + 指令引用凭据：EnvMissing 快速失败，LLM 零调用', async () => {
    // prod228 measured: a placeholder typed verbatim into the login form is a guaranteed failure; the AI spun across many rounds burning 12+ calls -- the precheck must intercept before any rounds are burned.
    const { llm, calls } = makeMockLlm([]);
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve([{ selector: '#user', tag: 'input' }]));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000132',
      [{ order: 1, id: 's-cred-3', instruction: '在登录页填写 __ITEST_USERNAME__ 登录', compiled: [] }],
      { reportId: 'r-cred-envmiss', llmClient: llm },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failureReason).toBe('EnvMissing');
    expect(results[0]!.error).toMatch(/env-missing/);
    expect(calls).toHaveLength(0);
  });

  it('locatorFailed 降级：机械失败后 AI 按指令重做，哨兵替换为真实凭据', async () => {
    mocked.__typed.length = 0;
    const { llm } = makeMockLlm([
      { actions: [{ type: 'fill', selector: '#user', value: '__ITEST_USERNAME__' }], done: true, summary: '已重做填写' },
    ]);
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve([{ selector: '#user', tag: 'input' }]));
    mocked.__locator.mockImplementationOnce(() => missingLocator());
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000133',
      [{ order: 1, id: 's-cred-4', instruction: '填写 __ITEST_USERNAME__ 后点击登录', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#gone' }] }] }],
      { reportId: 'r-cred-lf', aiFallback: ON, llmClient: llm, envCtx: makeEnvCtx({ user: 'admin', password: 'pw9' }) },
    );
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.degraded).toBe(true);
    expect(results[0]!.warning).toMatch(/机械执行失败（/);
    expect(mocked.__typed).toContain('admin');
    expect(mocked.__typed.join('|')).not.toMatch(/__ITEST_/);
  });

  it('compiled aiTask 分支：指令含 {{ITEST_USERNAME}} 不再 var-missing 判死，fill 值替换为真实凭据', async () => {
    // All degrade switches off: this exercises the compiled aiTask normal replay path (not a degrade), so degraded stays unset.
    mocked.__typed.length = 0;
    const { llm, calls } = makeMockLlm([
      { actions: [{ type: 'fill', selector: '#user', value: '{{ITEST_USERNAME}}' }], done: true, summary: '已填写登录' },
    ]);
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve([{ selector: '#user', tag: 'input' }]));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000134',
      [{ order: 1, id: 's-cred-5', compiled: [{ kind: 'aiTask', instruction: '填写 {{ITEST_USERNAME}} 完成登录' }] }],
      { reportId: 'r-cred-aitask', aiFallback: OFF, llmClient: llm, envCtx: makeEnvCtx({ user: 'admin', password: 'pw9' }) },
    );
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.degraded).toBeUndefined();
    expect(mocked.__typed).toContain('admin');
    expect(mocked.__typed.join('|')).not.toContain('{{ITEST_USERNAME}}');
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('机械回放 compiled fill：@ref 占位符取指定 web 的凭据', async () => {
    mocked.__typed.length = 0;
    const { llm } = makeMockLlm([]);
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve([]));
    const envCtx = {
      ...makeEnvCtx({ user: 'front_u', password: 'front_p' }),
      logins: new Map([['backend', { user: 'be_u', password: 'be_p', loginUrl: null }]]),
      resolveLogin: (ref?: string | null) => (ref === 'backend'
        ? { user: 'be_u', password: 'be_p', loginUrl: null }
        : { user: 'front_u', password: 'front_p', loginUrl: null }),
      hasCredentials: () => true,
    };
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000140',
      [{
        order: 1, id: 's-ref-1', instruction: '登录后端',
        compiled: [
          { kind: 'fill', locator: [{ strategy: 'css', value: '#u' }], value: '__ITEST_USERNAME@backend__' },
          { kind: 'fill', locator: [{ strategy: 'css', value: '#p' }], value: '__ITEST_PASSWORD@backend__' },
        ],
      }],
      { reportId: 'r-cred-ref', aiFallback: OFF, llmClient: llm, envCtx },
    );
    expect(results[0]!.status).toBe('passed');
    expect(mocked.__typed).toContain('be_u');
    expect(mocked.__typed).toContain('be_p');
    expect(mocked.__typed.join('|')).not.toContain('__ITEST_');
  });

  it('机械回放：@ref 指向不存在的 web → EnvMissing 判失败，不敲字面量', async () => {
    mocked.__typed.length = 0;
    const { llm } = makeMockLlm([]);
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve([]));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000141',
      [{
        order: 1, id: 's-ref-2', instruction: '登录不存在的前端',
        compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#u' }], value: '__ITEST_USERNAME@nope__' }],
      }],
      { reportId: 'r-cred-ref-miss', aiFallback: OFF, llmClient: llm, envCtx: makeEnvCtx({ user: 'u', password: 'p' }) },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failureReason).toBe('EnvMissing');
    expect(mocked.__typed.join('|')).not.toContain('__ITEST_');
  });

  it('无 @ref 的占位符落到用例绑定的 web 服务上（不同用例测不同 web）', async () => {
    mocked.__typed.length = 0;
    const { llm } = makeMockLlm([]);
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve([]));
    const envCtx = {
      ...makeEnvCtx({ user: 'front_u', password: 'front_p' }),
      logins: new Map<string, { user: string; password: string; loginUrl: null }>([
        ['backend', { user: 'be_u', password: 'be_p', loginUrl: null }],
      ]),
      resolveLogin: (ref?: string | null) => {
        if (ref === 'backend') return { user: 'be_u', password: 'be_p', loginUrl: null };
        if (ref) return null;
        return { user: 'front_u', password: 'front_p', loginUrl: null };
      },
      hasCredentials: () => true,
    };
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000142',
      [{
        order: 1, id: 's-bind-1', instruction: '登录并提交',
        compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#u' }], value: '__ITEST_USERNAME__' }],
      }],
      { reportId: 'r-cred-bind', aiFallback: OFF, llmClient: llm, envCtx, caseWebServiceRef: 'backend' },
    );
    expect(results[0]!.status).toBe('passed');
    expect(mocked.__typed).toContain('be_u');
    expect(mocked.__typed).not.toContain('front_u');
  });
});