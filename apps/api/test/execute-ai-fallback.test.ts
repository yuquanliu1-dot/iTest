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
    // 说明快照：failed 结果同样携带，报告页失败步也能看到意图
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
    // 说明快照：报告页据此展示步骤意图（降级 passed 也带）
    expect(results[0]!.instruction).toBe('点击已删除按钮');
    expect(results[0]!.compiled).toEqual([{ kind: 'click', locator: [{ strategy: 'css', value: '#gone' }] }]);
    expect(results[1]!.status).toBe('passed');
  });

  it('非 LocatorAllFailed 失败（AssertionMismatch）：同样降级 AI 重做通过', async () => {
    // 需求口径：任意机械执行失败都降级，不限元素识别失败。assertText contains 不命中 → AssertionMismatch。
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
    // b7d40426 实测根因：机械 LocatorAllFailed → 触发降级 → runAiTask 跑了 LLM（onUsage 已计数）
    // 但模型回 {"fail":...} → 抛 "aiTask 放弃"。旧逻辑静默 catch 落回机械报错，报告只留孤立
    // aiUsage 看不出 AI 已介入却没救回来。脚本给一条 fail 响应（非空脚本）以复现"用到了 AI 但放弃"。
    const { llm, calls } = makeMockLlm([{ fail: '找不到规则tab的关闭按钮' }]);
    mocked.__locator.mockImplementationOnce(() => missingLocator());
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000121',
      [{ order: 1, id: 's-1', instruction: '关闭打开的规则tab', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#gone' }] }] }],
      { reportId: 'r-lf-ai-err', aiFallback: ON, llmClient: llm },
    );
    // AI 确实被调用过（complete 至少一次）
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // 仍维持机械失败（status/failureReason 不变）
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failureReason).toBe('LocatorAllFailed');
    // 不再孤立：warning 记录 AI 降级尝试未成功 + 放弃原因
    expect(results[0]!.warning).toMatch(/AI 降级尝试未成功/);
    expect(results[0]!.warning).toMatch(/aiTask 放弃/);
    expect(results[0]!.warning).toMatch(/找不到规则tab的关闭按钮/);
    // aiUsage 有计数（与 warning 呼应，不再是孤零零的调用记录）
    expect(results[0]!.aiUsage?.calls).toBeGreaterThanOrEqual(1);
    // 未降级通过
    expect(results[0]!.degraded).toBeUndefined();
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