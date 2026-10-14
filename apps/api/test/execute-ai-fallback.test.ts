import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';
import type { LLMClient, LLMResult } from '../src/agent/llm-client.js';

// 与 execute-cdp.test.ts 同构：整体 mock playwright-core（假 page + 可改 count 的 locator），
// 驱动 executeCaseReal → runStepsInContext。llmClient 通过 ctx.llmClient 注入，绕过 resolveLlmClient 读库。
vi.mock('playwright-core', () => {
  const makeLocator = () => ({
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
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
  };
});

import { executeCaseReal } from '../src/execute/cdp.js';

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
};

/** 脚本化 mock LLM：complete 按顺序回 JSON；脚本耗尽则抛错（模拟 AI 不可用/放弃）。 */
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

/** 永不命中的 locator：count 恒 0 → tryFirstMatch 全窗口 all locator candidates failed → LocatorAllFailed。 */
function missingLocator() {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    first: vi.fn().mockReturnThis(),
    count: vi.fn().mockResolvedValue(0),
  };
}

const ON = { compileMissing: true, locatorFailed: true };
const OFF = { compileMissing: false, locatorFailed: false };

describe('回放 AI 降级 — compiled DSL 为空（compile-missing）', () => {
  it('开关 off：仍抛 compile-missing 判失败，LLM 不被调用', async () => {
    const { llm, calls } = makeMockLlm([]);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000100',
      [{ order: 1, id: 's-1', instruction: '点击保存按钮', compiled: [] }],
      { reportId: 'r-cm-off', aiFallback: OFF, llmClient: llm },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/compile-missing/);
    expect(calls).toHaveLength(0);
  });

  it('开关 on + 有指令：用 instruction 调 AI 临场执行，步骤 passed + warning 标注', async () => {
    const { llm, calls } = makeMockLlm([{ done: true, summary: '已点击保存按钮' }]);
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve([{ selector: '#save', tag: 'button' }]));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000101',
      [{ order: 1, id: 's-2', instruction: '点击保存按钮', compiled: [] }],
      { reportId: 'r-cm-on', aiFallback: ON, llmClient: llm },
    );
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.warning).toMatch(/未编译，AI 按指令临场执行/);
    expect(results[0]!.degraded).toBe(true);
    expect(results[0]!.aiUsage?.calls).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('开关 on 但 AI 不可用（LLM 抛错）：回退原 compile-missing 失败', async () => {
    const { llm } = makeMockLlm([]); // 空脚本 → complete 抛错
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000102',
      [{ order: 1, id: 's-3', instruction: '点击保存按钮', compiled: [] }],
      { reportId: 'r-cm-ai-fail', aiFallback: ON, llmClient: llm },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/compile-missing/);
  });

  it('开关 on 但无 instruction：无指令不降级，仍 compile-missing 失败', async () => {
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

  it('开关 on 但 instruction 为空串：同样不降级，仍 compile-missing 失败', async () => {
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

describe('回放 AI 降级 — 元素识别失败（LocatorAllFailed）', () => {
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
    expect(results[0]!.warning).toMatch(/元素识别失败（/);
    expect(results[0]!.warning).toMatch(/count=0/);
    expect(results[0]!.degraded).toBe(true);
    expect(results[0]!.aiUsage?.calls).toBeGreaterThanOrEqual(1);
    expect(results[1]!.status).toBe('passed');
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

  it('开关 on 但本身是 aiTask 步骤：识别失败不降级，仍 LocatorAllFailed 失败', async () => {
    // aiTask 步骤本就在跑 AI，识别失败时再“按指令临场执行”无增益 → 维持原失败。
    // LLM 脚本给了 2 条：若降级误触发会消费第 2 条并“通过”，实测仍 failed 即证明 guard 生效。
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
});