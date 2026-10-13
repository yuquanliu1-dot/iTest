import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'playwright-core';

// Mock playwright-core so we can verify dispatch logic without a real browser.
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
    inputValue: vi.fn().mockResolvedValue('input-val'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-image')),
    filter: vi.fn().mockReturnThis(),
    first: vi.fn().mockReturnThis(),
    count: vi.fn().mockResolvedValue(1),
    pressSequentially: vi.fn().mockResolvedValue(undefined),
  });

  const getByRole = vi.fn().mockReturnValue(makeLocator());
  const getByText = vi.fn().mockReturnValue(makeLocator());
  const locatorFn = vi.fn().mockReturnValue(makeLocator());

  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    locator: locatorFn,
    getByRole,
    getByText,
    screenshot: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    url: vi.fn(() => 'https://example.com/path'),
    evaluate: vi.fn().mockResolvedValue('登录成功'),
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
    __getByRole: getByRole,
    __getByText: getByText,
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
  __getByRole: ReturnType<typeof vi.fn>;
  __getByText: ReturnType<typeof vi.fn>;
  __locator: ReturnType<typeof vi.fn>;
};

describe('executeCaseReal — dispatch via mocked chromium', () => {
  it('navigate action forwards url + waitUntil to page.goto', async () => {
    mocked.__page.goto.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, compiled: [{ kind: 'navigate', url: 'https://example.com' }] }],
      { reportId: 'r-1' },
    );
    expect(mocked.__page.goto).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ timeout: 30000 }));
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('passed');
  });

  it('click action picks first locator candidate and invokes click()', async () => {
    mocked.__locator.mockClear();
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000002',
      [{ order: 1, compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#btn' }] }] }],
      { reportId: 'r-2' },
    );
    expect(mocked.__locator).toHaveBeenCalledWith('#btn');
  });

  it('fill action passes value through to fill()', async () => {
    const page = mocked.__page as unknown as { goto: ReturnType<typeof vi.fn>; screenshot: ReturnType<typeof vi.fn> };
    page.screenshot.mockClear();
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000003',
      [{ order: 1, compiled: [{ kind: 'fill', locator: [{ strategy: 'testId', value: 'user' }], value: 'alice' }] }],
      { reportId: 'r-3' },
    );
    expect(page.screenshot).toHaveBeenCalled();
  });

  it('failing step records error and stops the run', async () => {
    mocked.__page.goto.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000004',
      [
        { order: 1, compiled: [{ kind: 'navigate', url: 'https://x.test' }] },
        { order: 2, compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#nope' }] }] },
      ],
      { reportId: 'r-4' },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/boom/);
  });

  it('check action performs check only when state differs', async () => {
    mocked.__page.waitForTimeout.mockClear();
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, compiled: [{ kind: 'check', locator: [{ strategy: 'css', value: '#cb' }], checked: true }] }],
      { reportId: 'r-check' },
    );
    const loc = (mocked.__page.locator as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(loc.check).toHaveBeenCalled();
    expect(loc.uncheck).not.toHaveBeenCalled();
    expect(loc.isChecked).toHaveBeenCalled();
  });

  it('select action forwards materialized value to selectOption', async () => {
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, compiled: [{ kind: 'select', locator: [{ strategy: 'css', value: 'select' }], value: 'cn' }] }],
      { reportId: 'r-select' },
    );
    const loc = (mocked.__page.locator as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(loc.selectOption).toHaveBeenCalledWith('cn', expect.objectContaining({ timeout: 5000 }));
  });

  it('hover falls back to visible-filtered first() on strict mode violation', async () => {
    mocked.__locator.mockClear();
    // 录制场景常见：文本/CSS 命中多个元素（表格里重复的日期、同名链接）。
    const okHover = vi.fn().mockResolvedValue(undefined);
    const multi = {
      hover: vi.fn().mockRejectedValueOnce(new Error('strict mode violation: locator(\'tr\') resolved to 3 elements')),
      filter: vi.fn().mockReturnThis(),
      first: vi.fn().mockReturnValue({ hover: okHover }),
      count: vi.fn().mockResolvedValue(3),
    };
    mocked.__locator.mockImplementationOnce(() => multi as never);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000027',
      [{ order: 1, compiled: [{ kind: 'hover', locator: [{ strategy: 'css', value: 'tr' }] }] }],
      { reportId: 'r-hover-strict' },
    );
    expect(results[0]!.status).toBe('passed');
    expect(multi.filter).toHaveBeenCalledWith({ visible: true });
    expect(multi.first).toHaveBeenCalled();
    expect(okHover).toHaveBeenCalled();
  });

  it('click strict-mode 兜底先过滤 visible 再 first（隐藏克隆不得劫持）', async () => {
    mocked.__locator.mockClear();
    // 规则查看 回测回归：[title="查看"] 命中 7 个（Element-UI .hidden-columns 里的 display:none
    // 模板克隆 DOM 顺序在前），裸 .first() 会抓到不可见副本等到超时。
    const okClick = vi.fn().mockResolvedValue(undefined);
    const multi = {
      click: vi
        .fn()
        .mockRejectedValueOnce(new Error('strict mode violation: locator(\'[title="查看"]\') resolved to 7 elements')),
      filter: vi.fn().mockReturnThis(),
      first: vi.fn().mockReturnValue({ click: okClick }),
      count: vi.fn().mockResolvedValue(7),
    };
    // 两次 Once：初次 click 与兜底路径二次 tryFirstMatch 各解析一次 locator，都要拿到 multi
    mocked.__locator.mockImplementationOnce(() => multi as never);
    mocked.__locator.mockImplementationOnce(() => multi as never);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000028',
      [{ order: 1, compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '[title="查看"]' }] }] }],
      { reportId: 'r-click-strict' },
    );
    expect(results[0]!.status).toBe('passed');
    expect(multi.filter).toHaveBeenCalledWith({ visible: true });
    expect(okClick).toHaveBeenCalled();
  });

  it('upload without bound fileId fails attachment-missing', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, compiled: [{ kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }] }] }],
      { reportId: 'r-upload' },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/attachment-missing/);
  });

  it('extract action stores element value into vars for later fill', async () => {
    // 必须清历史：本用例按 mock.results[1] 取 fill 步骤的 locator，前面用例残留的调用会挤偏下标
    mocked.__locator.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [
        { order: 1, compiled: [{ kind: 'extract', locator: [{ strategy: 'css', value: '#no' }], varName: 'orderNo' }] },
        { order: 2, compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#f' }], value: '{{orderNo}}' }] },
      ],
      { reportId: 'r-extract' },
    );
    expect(results.every((r) => r.status === 'passed')).toBe(true);
    const loc = (mocked.__page.locator as ReturnType<typeof vi.fn>).mock.results[1]!.value;
    expect(loc.pressSequentially).toHaveBeenCalledWith('input-val', expect.anything());
  });

  it('unresolved {{var}} fails the step with missing var name', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#f' }], value: '{{nope}}' }] }],
      { reportId: 'r-var' },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/nope/);
  });

  it('assertJson deep-compares parsed element text', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, compiled: [{ kind: 'assertJson', locator: [{ strategy: 'css', value: 'pre' }], equals: { code: 0 } }] }],
      { reportId: 'r-json' },
    );
    expect(results[0]!.status).toBe('passed');
  });

  it('applies delayMs via page.waitForTimeout before dispatch', async () => {
    mocked.__page.waitForTimeout.mockClear();
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, delayMs: 300, compiled: [{ kind: 'navigate', url: 'https://example.com' }] }],
      { reportId: 'r-delay' },
    );
    expect(mocked.__page.waitForTimeout).toHaveBeenCalledWith(300);
  });

  it('waits for networkidle before capturing step screenshot', async () => {
    const waitForLoadState = (mocked.__page as unknown as { waitForLoadState: ReturnType<typeof vi.fn> }).waitForLoadState;
    waitForLoadState.mockClear();
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, compiled: [{ kind: 'navigate', url: 'https://example.com' }] }],
      { reportId: 'r-settle' },
    );
    expect(waitForLoadState).toHaveBeenCalledWith('networkidle', expect.objectContaining({ timeout: 2000 }));
  });

  it('switchTab action uses tabMap to switch the page context', async () => {
    const bringToFront = vi.fn().mockResolvedValue(undefined);
    (mocked.__page as unknown as { bringToFront: ReturnType<typeof vi.fn> }).bringToFront = bringToFront;
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000010',
      [{ order: 1, compiled: [{ kind: 'switchTab', tabRef: 'session-x|tab#1' }] }],
      { reportId: 'r-switch', tabMap: new Map([['session-x|tab#1', mocked.__page]]) },
    );
    expect(bringToFront).toHaveBeenCalled();
    expect(results[0]!.status).toBe('passed');
  });

  it('steps after switchTab operate on the switched page', async () => {
    const otherPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue({
        click: vi.fn().mockResolvedValue(undefined),
        first: vi.fn().mockReturnThis(),
      }),
      screenshot: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      bringToFront: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page & { locator: ReturnType<typeof vi.fn> };
    const firstPage = mocked.__page;
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000016',
      [
        { order: 1, compiled: [{ kind: 'switchTab', tabRef: 'session-x|tab#1' }] },
        { order: 2, compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#after-switch' }] }] },
      ],
      { reportId: 'r-switch-follow', tabMap: new Map([['session-x|tab#1', otherPage]]) },
    );
    expect(results.map((r) => r.status)).toEqual(['passed', 'passed']);
    expect(otherPage.locator).toHaveBeenCalledWith('#after-switch');
    expect((firstPage.locator as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith('#after-switch');
  });

  it('switchTab without matching tabMap entry fails with tab-missing', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000011',
      [{ order: 1, compiled: [{ kind: 'switchTab', tabRef: 'session-x|tab#9' }] }],
      { reportId: 'r-miss', tabMap: new Map() },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/tab-missing/);
  });

  it('init goto is skipped when step 0 is a navigate with the same url', async () => {
    mocked.__page.goto.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000050',
      [{ order: 1, compiled: [{ kind: 'navigate', url: 'https://init.example.com' }] }],
      { reportId: 'r-dedupe' },
      'https://init.example.com',
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('passed');
    // init goto 被跳过；只剩 step 自身的 navigate + preflight 的二次 goto
    expect(mocked.__page.goto).toHaveBeenCalledTimes(2);
    expect(mocked.__page.goto).toHaveBeenCalledWith('https://init.example.com', expect.anything());
  });

  it('init goto fires when step 0 is a navigate with a different url', async () => {
    mocked.__page.goto.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000051',
      [{ order: 1, compiled: [{ kind: 'navigate', url: 'https://other.example.com' }] }],
      { reportId: 'r-dedupe-2' },
      'https://init.example.com',
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('passed');
    // init + step + preflight
    expect(mocked.__page.goto).toHaveBeenCalledTimes(3);
  });

  it('init goto fires when steps[0] is not a navigate', async () => {
    mocked.__page.goto.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000052',
      [{ order: 1, compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#x' }] }] }],
      { reportId: 'r-init-only' },
      'https://init.example.com',
    );
    expect(results).toHaveLength(1);
    // init + preflight（没有 step navigate）
    expect(mocked.__page.goto).toHaveBeenCalledTimes(2);
    expect(mocked.__page.goto).toHaveBeenCalledWith('https://init.example.com', expect.anything());
  });

  it('upload action calls setInputFiles with stored_path', async () => {
    const setInputFiles = vi.fn().mockResolvedValue(undefined);
    mocked.__locator.mockReturnValueOnce({ setInputFiles } as never);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000012',
      [{ order: 1, compiled: [{ kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }], fileId: 'fake-id' }] }],
      { reportId: 'r-up', attachmentResolver: async () => ({ storedPath: '/tmp/x.bin', originalName: 'x.bin' }) },
    );
    expect(setInputFiles).toHaveBeenCalledWith('/tmp/x.bin', { timeout: 5000 });
    expect(results[0]!.status).toBe('passed');
  });

  it('upload without resolver or db row fails attachment-missing', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000013',
      [{ order: 1, compiled: [{ kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }], fileId: 'nope' }] }],
      { reportId: 'r-up-miss', attachmentResolver: async () => null },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/attachment-missing/);
  });

  it('sensitive fill resolves plaintext via secretResolver', async () => {
    const pressSequentially = vi.fn().mockResolvedValue(undefined);
    mocked.__locator.mockReturnValueOnce({ fill: vi.fn().mockResolvedValue(undefined), pressSequentially } as never);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000014',
      [{ order: 1, compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: 'input[type=password]' }], value: '__sensitive__', sensitive: true }], id: 'step-1' }],
      { reportId: 'r-secret', secretResolver: async (stepId: string) => (stepId === 'step-1' ? 'hunter2' : null) },
    );
    expect(pressSequentially).toHaveBeenCalledWith('hunter2', expect.anything());
    expect(results[0]!.status).toBe('passed');
  });

  it('sensitive fill without resolver value fails secret-missing', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000015',
      [{ order: 1, compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: 'input[type=password]' }], value: '__sensitive__', sensitive: true }], id: 'step-2' }],
      { reportId: 'r-secret-miss', secretResolver: async () => null },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/secret-missing/);
  });
});

describe('phase3 — three-tier locator', () => {
  it('tries intent semanticRole before CSS fallback', async () => {
    mocked.__locator.mockClear();
    mocked.__getByText.mockClear();
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000020',
      [
        {
          order: 1,
          compiled: [{
            kind: 'click',
            locator: [{ strategy: 'css', value: '.btn' }],
            intentLocator: { semanticRole: 'loginBtn' },
          }],
        },
      ],
      { reportId: 'r-3loc-1' },
    );
    const firstCall = mocked.__locator.mock.calls[0]?.[0];
    expect(firstCall).toBe('[data-testid="loginBtn"]');
  });

  it('falls back from primary CSS to stable #id when primary throws', async () => {
    mocked.__locator.mockClear();
    // 第一次 locator 调用抛错，模拟主 CSS 找不到
    mocked.__locator.mockImplementationOnce(() => ({
      click: vi.fn().mockImplementation(() => Promise.reject(new Error('not found'))),
      first: vi.fn().mockReturnThis(),
      count: vi.fn().mockResolvedValue(0),
    }) as never);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000021',
      [
        {
          order: 1,
          compiled: [{
            kind: 'click',
            locator: [
              { strategy: 'css', value: '.primary-btn' },
              { strategy: 'css', value: '#submit' },
            ],
          }],
        },
      ],
      { reportId: 'r-3loc-2' },
    );
    expect(results[0]!.status).toBe('passed');
    expect(mocked.__locator.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('phase3 — assertText target×match', () => {
  it('specifiedElement + equals (default)', async () => {
    mocked.__locator.mockClear();
    const fillMock = (mocked.__locator as unknown as { mockImplementationOnce: (fn: () => unknown) => unknown }).mockImplementationOnce(() => ({
      innerText: vi.fn().mockResolvedValue('ok'),
      first: vi.fn().mockReturnThis(),
      count: vi.fn().mockResolvedValue(1),
    } as never));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000022',
      [
        {
          order: 1,
          compiled: [{
            kind: 'assertText',
            locator: [{ strategy: 'css', value: '.msg' }],
            equals: 'ok',
          }],
        },
      ],
      { reportId: 'r-assert-eq' },
    );
    expect(results[0]!.status).toBe('passed');
  });

  it('page + contains matches body innerText', async () => {
    mocked.__locator.mockClear();
    mocked.__getByText.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000023',
      [
        {
          order: 1,
          compiled: [{
            kind: 'assertText',
            locator: [],
            target: 'page',
            match: 'contains',
            equals: '登录成功',
          }],
        },
      ],
      { reportId: 'r-assert-page' },
    );
    expect(results[0]!.status).toBe('passed');
  });

  it('url + regex matches location.href', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000024',
      [
        {
          order: 1,
          compiled: [{
            kind: 'assertText',
            locator: [],
            target: 'url',
            match: 'regex',
            equals: '^https://example\\.com/',
          }],
        },
      ],
      { reportId: 'r-assert-url' },
    );
    expect(results[0]!.status).toBe('passed');
  });

  it('errorMessage target without .ant-message throws', async () => {
    mocked.__locator.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000025',
      [
        {
          order: 1,
          compiled: [{
            kind: 'assertText',
            locator: [],
            target: 'errorMessage',
            match: 'contains',
            equals: '权限不足',
          }],
        },
      ],
      { reportId: 'r-assert-err' },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/errorMessage/);
  });
});

describe('phase3 — step-level assertion (test_steps.assertion)', () => {
  it('passes step when assertion matches body innerText (canonical shape)', async () => {
    // mock 的 page.evaluate 返回 '登录成功'，body contains 断言应当 pass。
    mocked.__locator.mockClear();
    // 用 mockImplementation 把整段测试里所有 evaluate 都钉成期望值，
    // 否则 mockClear/mockResolvedValueOnce 的组合会让前序测试残留状态干扰本次。
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve('登录成功'));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000030',
      [
        {
          order: 1,
          compiled: [{ kind: 'navigate', url: 'https://example.com' }],
          assertion: {
            kind: 'assertText',
            locator: [],
            target: 'page',
            match: 'contains',
            equals: '登录成功',
          },
        },
      ],
      { reportId: 'r-step-assert-pass' },
    );
    expect(results[0]!.status).toBe('passed');
  });

  it('skips whole-page fuzzy text assertion (Track 1: expectedOutcome + vision is the final judgement)', async () => {
    // target:'page' + locator:[] + match:'contains' 是 AI 写出来的描述性短语断言形态
    // （"登录表单正常展示"等），cdp.ts:normalizeStepAssertion 主动 filter，不再让回放因
    // page innerText 不命中而误报 failed。用例级 expectedOutcome + vision 才是终态判定。
    mocked.__locator.mockClear();
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve('不匹配的页面'));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000031',
      [
        {
          order: 1,
          compiled: [{ kind: 'navigate', url: 'https://example.com' }],
          assertion: {
            kind: 'assertText',
            locator: [],
            target: 'page',
            match: 'contains',
            equals: '登录成功',
          },
        },
      ],
      { reportId: 'r-step-assert-fail' },
    );
    expect(results[0]!.status).toBe('passed');
  });

  it('legacy assertion shape {kind,text} is normalised to canonical and runs', async () => {
    // 老 AI 保存路径留下的 {kind:'assertText', text:'...'}; 不走 save 也能跑通。
    mocked.__locator.mockClear();
    mocked.__page.evaluate.mockReset();
    mocked.__page.evaluate.mockImplementation(() => Promise.resolve('页面标题显示为"元素管理 - 低代码测试平台"'));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000032',
      [
        {
          order: 1,
          compiled: [{ kind: 'navigate', url: 'https://example.com' }],
          assertion: { kind: 'assertText', text: '页面标题显示为"元素管理 - 低代码测试平台"' },
        },
      ],
      { reportId: 'r-step-assert-legacy' },
    );
    expect(results[0]!.status).toBe('passed');
  });

  it('action failure short-circuits before assertion runs', async () => {
    // action 失败时（navigate reject）→ 直接 failed；断言不会"补救"成功。
    mocked.__page.evaluate.mockReset();
    mocked.__page.goto.mockImplementationOnce(() => Promise.reject(new Error('net down')));
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000033',
      [
        {
          order: 1,
          compiled: [{ kind: 'navigate', url: 'https://example.com' }],
          assertion: {
            kind: 'assertText',
            locator: [],
            target: 'page',
            match: 'contains',
            equals: 'anything',
          },
        },
      ],
      { reportId: 'r-step-assert-action-fails' },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/net down/);
  });
});

describe('locator probe window — SPA 深链挂载滞后的有界轮询', () => {
  it('count=0 for early rounds then mounted → passes within window', async () => {
    // 回测 8a178d83 根因回归：networkidle 后页面仍未挂载完，探测放弃 ~2s 后元素才出现。
    // 前 2 轮 count=0、第 3 轮变 1 → 轮询窗口内应命中而非判失败。
    let calls = 0;
    const late = {
      click: vi.fn().mockResolvedValue(undefined),
      first: vi.fn().mockReturnThis(),
      count: vi.fn().mockImplementation(async () => (calls++ < 2 ? 0 : 1)),
    };
    mocked.__locator.mockImplementationOnce(() => late as never);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000040',
      [{ order: 1, compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#late' }] }] }],
      { reportId: 'r-late-mount' },
    );
    expect(results[0]!.status).toBe('passed');
    expect(late.count).toHaveBeenCalledTimes(3); // 前 2 轮 miss，第 3 轮命中
    expect(late.click).toHaveBeenCalled();
  });

  it('all candidates miss across full window → fails with count=0', async () => {
    const never = {
      click: vi.fn().mockResolvedValue(undefined),
      first: vi.fn().mockReturnThis(),
      count: vi.fn().mockResolvedValue(0),
    };
    mocked.__locator.mockImplementationOnce(() => never as never);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000041',
      [{ order: 1, compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#gone' }] }] }],
      { reportId: 'r-never-mount' },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/count=0/);
    // 有界轮询而非单次重试：单候选在窗口内被轮转探测满 12 轮
    expect(never.count).toHaveBeenCalledTimes(12);
  });
});

describe('Fix C — visibility-aware probe (tryFirstMatch)', () => {
  it('raw 单匹配不可见 → 窗口内轮询等到可见实例，点击落在可见子集上（克隆/导入导出 签名①自愈）', async () => {
    mocked.__locator.mockClear();
    // prod228 克隆解析规则 step-0 复现形态：链式选择器解析到唯一匹配但不可见
    //（Element-UI 固定列/模板克隆），行重渲染后可见实例才出现。
    const okClick = vi.fn().mockResolvedValue(undefined);
    let visProbes = 0;
    const visibleLoc = {
      click: okClick,
      count: vi.fn().mockImplementation(async () => (visProbes++ < 2 ? 0 : 1)),
    };
    const raw = {
      click: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(1),
      filter: vi.fn().mockReturnValue(visibleLoc),
    };
    mocked.__locator.mockImplementationOnce(() => raw as never);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000060',
      [{ order: 1, compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#clone-icon' }] }] }],
      { reportId: 'r-fixc-late-visible' },
    );
    expect(results[0]!.status).toBe('passed');
    expect(raw.click).not.toHaveBeenCalled(); // 永远不点 raw（可能命中不可见副本）
    expect(raw.filter).toHaveBeenCalledWith({ visible: true });
    expect(okClick).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it('全窗口无可见实例 → 失败并报 none visible，不点击不可见元素（签名①不可自愈时诚实失败）', async () => {
    mocked.__locator.mockClear();
    const raw = {
      click: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(1),
      filter: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
    };
    mocked.__locator.mockImplementationOnce(() => raw as never);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000061',
      [{ order: 1, compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#gone-hidden' }] }] }],
      { reportId: 'r-fixc-never-visible' },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/none visible/);
    expect(raw.click).not.toHaveBeenCalled();
  });

  it('候选1 仅解析到不可见实例 → 落到候选2 的可见实例（导入导出 checkbox 形态）', async () => {
    mocked.__locator.mockClear();
    const badClick = vi.fn().mockResolvedValue(undefined);
    const okClick = vi.fn().mockResolvedValue(undefined);
    const cand1 = {
      click: badClick,
      count: vi.fn().mockResolvedValue(1),
      filter: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
    };
    const cand2Visible = { click: okClick, count: vi.fn().mockResolvedValue(1) };
    const cand2 = {
      count: vi.fn().mockResolvedValue(1),
      filter: vi.fn().mockReturnValue(cand2Visible),
    };
    mocked.__locator.mockImplementationOnce(() => cand1 as never);
    mocked.__locator.mockImplementationOnce(() => cand2 as never);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000062',
      [{
        order: 1,
        compiled: [{
          kind: 'click',
          locator: [
            { strategy: 'css', value: '#a' },
            { strategy: 'css', value: '#b' },
          ],
        }],
      }],
      { reportId: 'r-fixc-candidate-fallthrough' },
    );
    expect(results[0]!.status).toBe('passed');
    expect(badClick).not.toHaveBeenCalled();
    expect(okClick).toHaveBeenCalled();
  });

  it('raw 与可见子集同时命中 → 点击派发到可见子集而非 raw（查看/编辑 签名② force 空转）', async () => {
    mocked.__locator.mockClear();
    // 查看/编辑 复现形态：raw 解析成功且 force click"通过"，但点到不可见副本无实际效果。
    // Fix C 后返回可见子集，动作天然作用于真实元素。
    const rawClick = vi.fn().mockResolvedValue(undefined);
    const okClick = vi.fn().mockResolvedValue(undefined);
    const visibleLoc = { click: okClick, count: vi.fn().mockResolvedValue(1) };
    const raw = { click: rawClick, count: vi.fn().mockResolvedValue(1), filter: vi.fn().mockReturnValue(visibleLoc) };
    mocked.__locator.mockImplementationOnce(() => raw as never);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000063',
      [{ order: 1, compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '#view-icon' }] }] }],
      { reportId: 'r-fixc-visible-subset' },
    );
    expect(results[0]!.status).toBe('passed');
    expect(okClick).toHaveBeenCalled();
    expect(rawClick).not.toHaveBeenCalled();
  });
});

describe('phase3 — composite value at execute', () => {
  it('composite fill uses materialized fragment value', async () => {
    mocked.__locator.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000026',
      [
        {
          order: 1,
          compiled: [{
            kind: 'fill',
            locator: [{ strategy: 'css', value: '#name' }],
            value: {
              mode: 'composite',
              fragments: [
                { mode: 'fixed', value: 'CS' },
                { mode: 'randomNumber', length: 3 },
              ],
            },
          }],
        },
      ],
      { reportId: 'r-composite' },
    );
    expect(results[0]!.status).toBe('passed');
    // 找出本次 composite 的最后一次 pressSequentially 调用（fill() 现在只清空，键入改走 pressSequentially）
    const fillCalls = (mocked.__locator.mock.results[mocked.__locator.mock.results.length - 1]!.value as { pressSequentially: ReturnType<typeof vi.fn> }).pressSequentially.mock.calls;
    const lastFillArg = fillCalls[fillCalls.length - 1]?.[0];
    expect(lastFillArg).toMatch(/^CS\d{3}$/);
  });
});
describe('机械 fill 的环境凭据占位符（compiled 不再需要明文密码）', () => {
  const loginEnv = {
    envId: 'e-1',
    baseUrl: null,
    login: { user: 'admin', password: 'S3cret!', loginUrl: null },
    close: async () => undefined,
  };

  /** 最近一次 locator mock 的 pressSequentially 实参（fill 后键入路径）。 */
  function lastTypedValue(): unknown {
    const loc = mocked.__locator.mock.results[mocked.__locator.mock.results.length - 1]!.value as {
      pressSequentially: ReturnType<typeof vi.fn>;
    };
    const calls = loc.pressSequentially.mock.calls;
    return calls[calls.length - 1]?.[0];
  }

  beforeEach(() => { mocked.__locator.mockClear(); });

  it('__ITEST_USERNAME__ → 环境 login.user（不把字面量敲进表单）', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000030',
      [{ order: 1, compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#u' }], value: '__ITEST_USERNAME__' }] }],
      { reportId: 'r-ph-user', envCtx: loginEnv as never },
    );
    expect(results[0]!.status).toBe('passed');
    expect(lastTypedValue()).toBe('admin');
  });

  it('__ITEST_PASSWORD__ → 环境 login.password（2026-10-13 prod228 回归）', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000031',
      [{ order: 1, compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#p' }], value: '__ITEST_PASSWORD__' }] }],
      { reportId: 'r-ph-pass', envCtx: loginEnv as never },
    );
    expect(results[0]!.status).toBe('passed');
    expect(lastTypedValue()).toBe('S3cret!');
  });

  it('环境未配 login → EnvMissing 失败，绝不静默填字面量', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000032',
      [{ order: 1, compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#p' }], value: '__ITEST_PASSWORD__' }] }],
      { reportId: 'r-ph-none' },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/env-missing/);
  });

  it('__ITEST_STEP_SECRET__ 在机械路径无密文可解 → SecretMissing 失败', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000033',
      [{ order: 1, compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#s' }], value: '__ITEST_STEP_SECRET__' }] }],
      { reportId: 'r-ph-secret', envCtx: loginEnv as never },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/secret-missing/);
  });

  it('非占位符值不受影响（普通 fill 照常）', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000034',
      [{ order: 1, compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#n' }], value: 'alice' }] }],
      { reportId: 'r-ph-plain', envCtx: loginEnv as never },
    );
    expect(results[0]!.status).toBe('passed');
    expect(lastTypedValue()).toBe('alice');
  });

  it('__ITEST_PASSWORD__ 嵌在 {{变量}} 里：先物化再替换占位符', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000035',
      [{ order: 1, compiled: [{ kind: 'fill', locator: [{ strategy: 'css', value: '#p' }], value: '{{pw}}' }] }],
      { reportId: 'r-ph-var', envCtx: loginEnv as never, initialVars: { pw: '__ITEST_PASSWORD__' } },
    );
    expect(results[0]!.status).toBe('passed');
    expect(lastTypedValue()).toBe('S3cret!');
  });
});
