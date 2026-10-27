import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
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

  // url() 跟随最近一次 goto 目标（真实浏览器行为；也让 init-goto 落地校验判定"已到达"不触发重试）
  let lastGotoUrl: string | undefined;
  const page = {
    goto: vi.fn((targetUrl: string) => {
      lastGotoUrl = targetUrl;
      return Promise.resolve(undefined);
    }),
    locator: locatorFn,
    getByRole,
    getByText,
    screenshot: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    url: vi.fn(() => lastGotoUrl ?? 'https://example.com/path'),
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
    // 单例 page 跨测试复用，nav 状态须逐测试归位（真实执行每次 newPage 从 about:blank 起）
    __resetNav: () => { lastGotoUrl = undefined; },
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
  __resetNav: () => void;
  __getByRole: ReturnType<typeof vi.fn>;
  __getByText: ReturnType<typeof vi.fn>;
  __locator: ReturnType<typeof vi.fn>;
};

// 单例 mock page 的 nav 状态逐测试归位（真实执行每次 newPage 从 about:blank 起）
beforeEach(() => mocked.__resetNav());

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
    // 步骤级开始时刻：报告页据此显示「开始 HH:MM:SS」
    expect(results[0]!.startedAt).toBeTruthy();
    expect(Number.isNaN(new Date(results[0]!.startedAt!).getTime())).toBe(false);
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
    // 失败步同样带开始时刻（报告页统一展示）
    expect(results[0]!.startedAt).toBeTruthy();
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

  it('waitFor 空定位 = 固定时长等待（睡 timeoutMs，不探测元素）', async () => {
    mocked.__page.waitForTimeout.mockClear();
    mocked.__locator.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000053',
      [{ order: 1, compiled: [{ kind: 'waitFor', locator: [], timeoutMs: 1200 }] }],
      { reportId: 'r-fixed-wait' },
    );
    expect(results[0]!.status).toBe('passed');
    expect(mocked.__page.waitForTimeout).toHaveBeenCalledWith(1200);
    // 空等待不解析任何 locator
    expect(mocked.__locator).not.toHaveBeenCalled();

    // 缺省 timeoutMs → 5000
    await executeCaseReal(
      '00000000-0000-0000-0000-000000054',
      [{ order: 1, compiled: [{ kind: 'waitFor', locator: [] }] }],
      { reportId: 'r-fixed-wait-default' },
    );
    expect(mocked.__page.waitForTimeout).toHaveBeenCalledWith(5000);
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
  // EnvCtx 新形态：凭据按命名 web 服务取（resolveLogin），旧的扁平 login 字段不再是解析源。
  const loginEnv = {
    envId: 'e-1',
    envName: '默认环境',
    baseUrl: null,
    webServices: [{ name: 'frontend', label: '默认', origin: 'http://env.example', isDefault: true }],
    logins: new Map([['frontend', { user: 'admin', password: 'S3cret!', loginUrl: null }]]),
    resolveLogin: (ref?: string | null) =>
      (ref ? loginEnv.logins.get(ref) : loginEnv.logins.get('frontend')) ?? null,
    hasCredentials: (ref: string) => loginEnv.logins.has(ref),
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

// ===== T6: runCase 相对 url 集成（testcontainers + 真实 DB；浏览器仍走上方 playwright mock）=====
// runCase → WebEngine → executeCaseReal：同一 mock chromium 驱动，断言 goto 目标 + WebServiceMissing 失败报告。
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

describe('runCase — 相对 url 与环境 web 服务', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let projectId: string;
  let groupId: string;

  const insertEnv = async (name: string, webObjs: Array<{ label: string; payload: object; isDefault: boolean }>): Promise<string> => {
    const e = await pool.query(`INSERT INTO test_environments(project_id, name) VALUES ($1, $2) RETURNING id`, [projectId, name]);
    const envId = e.rows[0]!.id as string;
    for (const o of webObjs) {
      await pool.query(
        `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES ($1, 'web', $2, $3::jsonb, $4)`,
        [envId, o.label, JSON.stringify(o.payload), o.isDefault],
      );
    }
    return envId;
  };

  const insertCase = async (url: string, defaultEnvId: string): Promise<string> => {
    const r = await pool.query(
      `INSERT INTO test_cases(group_id, title, url, default_env_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [groupId, `T6-${url}`, url, defaultEnvId],
    );
    return r.rows[0]!.id as string;
  };

  const latestReport = async (caseId: string): Promise<{ status: string; step_results: Array<{ failureReason?: string }> } | undefined> => {
    const r = await pool.query(`SELECT status, step_results FROM reports WHERE case_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`, [caseId]);
    return r.rows[0] as { status: string; step_results: Array<{ failureReason?: string }> } | undefined;
  };

  const waitReportDone = async (caseId: string, timeoutMs = 10000): Promise<{ status: string; step_results: Array<{ status?: string; failureReason?: string; error?: string }> }> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = await latestReport(caseId);
      if (row && row.status !== 'running') return row;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`report for case ${caseId} still running`);
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'nqh12UCAW+ZhepC+gqL/n1phEn5mo+xq82Key67ePXI=';
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(SCHEMA_SQL);
    const seed = await seedOrg(pool);
    const s = await seedProject(pool);
    projectId = s.projectId;
    groupId = s.groupId;
    // 本文件顶部静态 import cdp.js → db/client.js，pool 已按兜底 localhost 建好（上部单测未发过任何
    // 真实连接）。把共享 pool 的 connectionString 改指测试容器——runCase 走同一 pool，新连接落容器 DB。
    const { pool: sharedPool } = await import('../src/db/client.js');
    (sharedPool as unknown as { options: { connectionString: string } }).options.connectionString = container.getConnectionUri();
  }, 60000);

  afterAll(async () => {
    const { pool: sharedPool } = await import('../src/db/client.js');
    await sharedPool.end().catch(() => undefined);
    await pool.end();
    await container.stop();
  });

  it('相对 url + 环境 web 对象 → goto 拼接地址，报告 passed', async () => {
    const envId = await insertEnv('web-env', [
      { label: '前端', payload: { name: 'frontend', scheme: 'http', host: '10.0.0.1', port: 8080 }, isDefault: true },
    ]);
    const caseId = await insertCase('/login', envId);

    mocked.__page.goto.mockClear();
    const { runCase } = await import('../src/execute/runCase.js');
    const res = await runCase(caseId);
    await waitReportDone(caseId);

    expect(res.status).toBe('passed');
    expect(mocked.__page.goto.mock.calls.some((c) => c[0] === 'http://10.0.0.1:8080/login')).toBe(true);
  });

  it('web_<name> 系统变量注入 → navigate 步骤 {{web_frontend}} 替换为服务 origin,报告 passed', async () => {
    const envId = await insertEnv('web-env-inject', [
      { label: '前端', payload: { name: 'frontend', scheme: 'http', host: '10.0.0.1', port: 8080 }, isDefault: true },
    ]);
    // 绝对 case.url 直通(不走初始导航拼 origin);navigate 步骤的 {{web_frontend}} 依赖 T6 注入的
    // web_<name> 系统变量替换成 origin(=10.0.0.1:8080),而非写死。
    const caseId = await insertCase('http://init.example.com', envId);
    await pool.query(
      `INSERT INTO test_steps(case_id, "order", source, compiled) VALUES ($1, 1, 'manual', $2::jsonb)`,
      [caseId, JSON.stringify([{ kind: 'navigate', url: '{{web_frontend}}/login' }])],
    );

    mocked.__page.goto.mockClear();
    const { runCase } = await import('../src/execute/runCase.js');
    const res = await runCase(caseId);
    await waitReportDone(caseId);

    expect(res.status).toBe('passed');
    // substituteVars 把 {{web_frontend}} → http://10.0.0.1:8080,再拼 /login 成完整导航地址。
    expect(mocked.__page.goto.mock.calls.some((c) => c[0] === 'http://10.0.0.1:8080/login')).toBe(true);
  });

  it('navigate 步骤相对 url → 拼用例绑定 web 服务 origin,报告 passed', async () => {
    const envId = await insertEnv('web-env-nav-rel', [
      { label: '前端', payload: { name: 'frontend', scheme: 'http', host: '10.0.0.1', port: 8080 }, isDefault: true },
    ]);
    const caseId = await insertCase('http://init.example.com', envId);
    await pool.query(
      `INSERT INTO test_steps(case_id, "order", source, compiled) VALUES ($1, 1, 'manual', $2::jsonb)`,
      [caseId, JSON.stringify([{ kind: 'navigate', url: '/second/page' }])],
    );

    mocked.__page.goto.mockClear();
    const { runCase } = await import('../src/execute/runCase.js');
    const res = await runCase(caseId);
    await waitReportDone(caseId);

    expect(res.status).toBe('passed');
    // T7: navigate 步骤相对 url(/开头)拼用例绑定 web 服务 origin,而非沿用 init 页 origin。
    expect(mocked.__page.goto.mock.calls.some((c) => c[0] === 'http://10.0.0.1:8080/second/page')).toBe(true);
  });

  it('navigate 相对 url 但环境无 web 服务 → invalid-navigate-url 步骤失败', async () => {
    const envId = await insertEnv('no-web-nav-rel', []);
    const caseId = await insertCase('https://init.example.com', envId);
    await pool.query(
      `INSERT INTO test_steps(case_id, "order", source, compiled) VALUES ($1, 1, 'manual', $2::jsonb)`,
      [caseId, JSON.stringify([{ kind: 'navigate', url: '/x' }])],
    );

    mocked.__page.goto.mockClear();
    const { runCase } = await import('../src/execute/runCase.js');
    const res = await runCase(caseId);
    const row = await waitReportDone(caseId);

    expect(res.status).toBe('failed');
    expect(row.step_results[0]!.error).toMatch(/invalid-navigate-url/);
    expect(mocked.__page.goto.mock.calls.some((c) => c[0] === '/x')).toBe(false);
  });

  it('环境无 web 对象 + 相对 url → WebServiceMissing 失败报告', async () => {
    const envId = await insertEnv('no-web-env', []);
    const caseId = await insertCase('/login', envId);

    const { runCase } = await import('../src/execute/runCase.js');
    const res = await runCase(caseId);
    const row = await waitReportDone(caseId);

    expect(res.status).toBe('failed');
    expect(row.status).toBe('failed');
    expect(row.step_results[0]!.failureReason).toBe('WebServiceMissing');
  });

  it('黄金路径:同用例换环境(计划级 envOverride)执行 → 初始导航 origin 随环境 web 服务切换', async () => {
    // 验收点:同一相对 url + 绑定 frontend,经计划所在环境的 envOverride(runPlan 同款走线)执行,
    // goto 目标应随环境解析出不同的 origin——而非固化在用例上。
    const envA = await insertEnv('golden-env-a', [
      { label: '前端', payload: { name: 'frontend', scheme: 'http', host: '10.0.0.1', port: 8080 }, isDefault: true },
    ]);
    const envB = await insertEnv('golden-env-b', [
      { label: '前端', payload: { name: 'frontend', scheme: 'http', host: '192.168.1.10', port: 8080 }, isDefault: true },
    ]);
    // 用例不设 default_env_id:证明 origin 完全由计划环境(envOverride)决定。
    const c = await pool.query(
      `INSERT INTO test_cases(group_id, title, url, web_service_ref) VALUES ($1, 'golden', '/login', 'frontend') RETURNING id`,
      [groupId],
    );
    const caseId = c.rows[0]!.id as string;

    const { runCase } = await import('../src/execute/runCase.js');
    mocked.__page.goto.mockClear();
    const resA = await runCase(caseId, { envOverride: { envId: envA } });
    await waitReportDone(caseId);
    expect(resA.status).toBe('passed');
    expect(mocked.__page.goto.mock.calls.some((x) => x[0] === 'http://10.0.0.1:8080/login')).toBe(true);

    mocked.__page.goto.mockClear();
    const resB = await runCase(caseId, { envOverride: { envId: envB } });
    await waitReportDone(caseId);
    expect(resB.status).toBe('passed');
    expect(mocked.__page.goto.mock.calls.some((x) => x[0] === 'http://192.168.1.10:8080/login')).toBe(true);
  });
});

describe('sql 步骤分支（查被测系统自己的库）', () => {
  /** 假 EnvCtx：一个名为 olap 的 db 对象，池记录调用。 */
  function makeSqlEnv(rows: Record<string, unknown>[]) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      dialect: 'postgres' as const,
      async query(sql: string, params: unknown[]) {
        calls.push({ sql, params });
        return { rows };
      },
      async end() {},
    };
    const env = {
      envId: 'e-sql',
      envName: '默认环境',
      baseUrl: null,
      webServices: [],
      dbs: [{ label: 'olap', isDefault: true }],
      resolveDb: (ref?: string | null) =>
        (ref ? env.dbs.find((d) => d.label === ref) ?? null : env.dbs[0] ?? null),
      resolveDbPool: async (ref?: string | null) => {
        if (!env.resolveDb(ref)) {
          const e = new Error('env-db-missing');
          e.name = 'EnvDbMissing';
          throw e;
        }
        return pool;
      },
      close: async () => undefined,
    };
    return { env, calls };
  }

  it('按 dbRef 取池执行，结果落 step.sql', async () => {
    const { env, calls } = makeSqlEnv([{ id: 1, status: 'ok' }]);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000040',
      [{ order: 1, compiled: [{ kind: 'sql', dbRef: 'olap', sql: 'SELECT * FROM t' }] }],
      { reportId: 'r-sql-1', envCtx: env as never },
    );
    expect(results[0]!.status).toBe('passed');
    expect(calls[0]!.sql).toBe('SELECT * FROM t');
    expect(results[0]!.sql?.dbRef).toBe('olap');
    expect(results[0]!.sql?.rows).toEqual([{ id: 1, status: 'ok' }]);
  });

  it('断言不命中 → SqlAssertionFailed，rows 仍留在结果里', async () => {
    const { env } = makeSqlEnv([{ status: 'fail' }]);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000041',
      [{
        order: 1,
        compiled: [{
          kind: 'sql', dbRef: 'olap', sql: 'SELECT * FROM t',
          assertion: { match: 'contains', expected: 'ok' },
        }],
      }],
      { reportId: 'r-sql-2', envCtx: env as never },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failureReason).toBe('SqlAssertionFailed');
    expect(results[0]!.sql?.rows).toEqual([{ status: 'fail' }]);
  });

  it('dbRef 不存在 → EnvDbMissing', async () => {
    const { env } = makeSqlEnv([]);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000042',
      [{ order: 1, compiled: [{ kind: 'sql', dbRef: 'nope', sql: 'SELECT 1' }] }],
      { reportId: 'r-sql-3', envCtx: env as never },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.failureReason).toBe('EnvDbMissing');
  });
});

describe('locator 变量替换 — waitFor/assert* 的定位值带数据集变量', () => {
  it('waitFor text={{expectedError}} 替换成实际文案后再找（prod228 假通过根因）', async () => {
    mocked.__getByText.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000050',
      [{
        order: 1,
        compiled: [{
          kind: 'waitFor',
          locator: [{ strategy: 'text', value: '{{expectedError}}' }],
          timeoutMs: 1000,
        }],
      }],
      { reportId: 'r-waitfor-var', initialVars: { expectedError: '验证码不正确' } },
    );
    expect(results[0]!.status).toBe('passed');
    // 关键：不是字面模板串 {{expectedError}}，而是替换后的实际文案
    expect(mocked.__getByText).toHaveBeenCalledWith('验证码不正确');
    expect(mocked.__getByText).not.toHaveBeenCalledWith('{{expectedError}}');
  });

  it('assertVisible 的定位值同样被替换', async () => {
    mocked.__locator.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000051',
      [{
        order: 1,
        compiled: [{
          kind: 'assertVisible',
          locator: [{ strategy: 'css', value: '{{errorSelector}}' }],
        }],
      }],
      { reportId: 'r-assertvar-var', initialVars: { errorSelector: '.error-msg' } },
    );
    expect(results[0]!.status).toBe('passed');
    expect(mocked.__locator).toHaveBeenCalledWith('.error-msg');
  });

  it('变量缺失 → var-missing（不再拿字面模板串去等，必然超时的静默失效）', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000052',
      [{
        order: 1,
        compiled: [{
          kind: 'waitFor',
          locator: [{ strategy: 'text', value: '{{expectedError}}' }],
          timeoutMs: 1000,
        }],
      }],
      { reportId: 'r-waitfor-var-missing', initialVars: {} },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/var-missing/);
  });
});
