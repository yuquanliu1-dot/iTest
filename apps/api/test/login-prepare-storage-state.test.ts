import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page, Browser, BrowserContext } from 'playwright-core';

// 复用 playback-integration 思路：mock 整个 playwright-core，让 cdp 跑在受控 stub page 上。
// 关键点：singleton browser —— 所有 chromium.launch() 返回同一个对象，让跨测试的 spy 计数保持一致。
// launchCount / closeCount 用 beforeEach 重置。
const mockState = vi.hoisted(() => ({
  locatorCount: 1,
  clickReject: false,
  launchCount: 0,
  closeCount: 0,
  // 单例 browser/context —— 让所有 chromium.launch() 拿到同一个对象，便于断言 close 调用次数
  browser: undefined as unknown as Browser,
  ctx: undefined as unknown as BrowserContext,
  storageState: { cookies: [], origins: [] },
  newContextOpts: [] as unknown[],
  lastPage: undefined as unknown as Page,
}));

vi.mock('playwright-core', () => {
  const makeLocator = () => ({
    count: vi.fn().mockResolvedValue(mockState.locatorCount),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    pressSequentially: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    first: vi.fn().mockReturnThis(),
    inputValue: vi.fn().mockResolvedValue('val'),
    innerText: vi.fn().mockResolvedValue('val'),
    isVisible: vi.fn().mockResolvedValue(true),
    isChecked: vi.fn().mockResolvedValue(false),
    check: vi.fn().mockResolvedValue(undefined),
    uncheck: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
  });
  const makePage = (): Page => ({
    goto: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockImplementation(() => makeLocator()),
    getByText: vi.fn().mockImplementation(() => makeLocator()),
    getByRole: vi.fn().mockImplementation(() => makeLocator()),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('img')),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    url: vi.fn(() => 'https://example.com/'),
    evaluate: vi.fn().mockResolvedValue('已登录'),
    bringToFront: vi.fn().mockResolvedValue(undefined),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    context: () => ({ pages: () => [{}] }),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    addInitScript: vi.fn(),
    addScriptTag: vi.fn(),
    addStyleTag: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    isClosed: vi.fn().mockReturnValue(false),
    frames: () => [],
    mainFrame: () => ({}),
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue(''),
  } as unknown as Page);

  // 单例 ctx —— 每次 newContext(opts) 都记录 opts 并返回同一 ctx。
  const ctx: BrowserContext = {
    newPage: vi.fn().mockImplementation(async () => {
      const page = makePage();
      mockState.lastPage = page;
      return page;
    }),
    storageState: vi.fn().mockImplementation(async () => mockState.storageState),
    close: vi.fn().mockResolvedValue(undefined),
    cookies: vi.fn().mockResolvedValue([]),
    addCookies: vi.fn().mockResolvedValue(undefined),
    clearCookies: vi.fn().mockResolvedValue(undefined),
    route: vi.fn(),
    routeFromHAR: vi.fn(),
    unroute: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    addInitScript: vi.fn(),
    setExtraHTTPHeaders: vi.fn(),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    pages: vi.fn().mockReturnValue([]),
    browser: vi.fn(),
    tracing: { start: vi.fn(), stop: vi.fn() },
    request: vi.fn(),
    backgroundPages: vi.fn().mockReturnValue([]),
    serviceWorkers: vi.fn().mockReturnValue([]),
    newCDPSession: vi.fn(),
    routeWebSocket: vi.fn(),
  } as unknown as BrowserContext;

  const browser: Browser = {
    newContext: vi.fn().mockImplementation(async (opts: unknown) => {
      mockState.newContextOpts.push(opts);
      return ctx;
    }),
    close: vi.fn().mockImplementation(async () => {
      mockState.closeCount += 1;
    }),
    isConnected: vi.fn().mockReturnValue(true),
    newPage: vi.fn(),
    newBrowserCDPSession: vi.fn(),
    context: vi.fn(),
    contexts: vi.fn().mockReturnValue([]),
    version: vi.fn().mockReturnValue('mock'),
    userAgent: vi.fn().mockReturnValue('mock'),
  } as unknown as Browser;

  // 给单例 browser/context 加一个 stash 入口，方便测试通过 mockState.browser / ctx 拿到同一引用。
  Object.defineProperty(mockState, 'browser', { value: browser, writable: true, configurable: true });
  Object.defineProperty(mockState, 'ctx', { value: ctx, writable: true, configurable: true });

  return {
    chromium: {
      launch: vi.fn().mockImplementation(async () => {
        mockState.launchCount += 1;
        return browser;
      }),
    },
    __browser: browser,
    __ctx: ctx,
  };
});

import { executeCaseReal, executeCaseInBrowser } from '../src/execute/cdp.js';
import { loginPrepare } from '../src/execute/loginPrepare.js';

const SAMPLE_STEPS = [
  { order: 1, compiled: [{ kind: 'navigate' as const, url: 'https://example.com' }] },
];

beforeEach(() => {
  // mock 状态重置
  mockState.launchCount = 0;
  mockState.closeCount = 0;
  mockState.newContextOpts.length = 0;
  // mock spy 调用计数清零（保留 mock 引用；mock 函数本身是稳定的）
  (mockState.browser as unknown as { close: ReturnType<typeof vi.fn> }).close.mockClear();
  (mockState.ctx as unknown as { newPage: ReturnType<typeof vi.fn> }).newPage.mockClear();
  (mockState.ctx as unknown as { storageState: ReturnType<typeof vi.fn> }).storageState.mockClear();
});

describe('executeCaseInBrowser — shares caller-owned browser+ctx', () => {
  it('does NOT call chromium.launch (browser pre-supplied)', async () => {
    // 通过 mockState.browser 直接拿单例浏览器引用 —— cdp 路径不应再调 chromium.launch。
    const browser = mockState.browser;
    const ctx = mockState.ctx;
    mockState.launchCount = 0; // 重置
    await executeCaseInBrowser(
      '00000000-0000-0000-0000-0000000000a1',
      SAMPLE_STEPS,
      { reportId: 'r-inb-1' },
      browser,
      ctx,
    );
    expect(mockState.launchCount).toBe(0);
  });

  it('does NOT call browser.close() on the caller-owned browser', async () => {
    const browser = mockState.browser;
    const ctx = mockState.ctx;
    mockState.closeCount = 0;
    await executeCaseInBrowser(
      '00000000-0000-0000-0000-0000000000a2',
      SAMPLE_STEPS,
      { reportId: 'r-inb-2' },
      browser,
      ctx,
    );
    expect((browser as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
    expect(mockState.closeCount).toBe(0);
  });

  it('runs steps using the provided context (newPage called on it)', async () => {
    const browser = mockState.browser;
    const ctx = mockState.ctx;
    await executeCaseInBrowser(
      '00000000-0000-0000-0000-0000000000a3',
      SAMPLE_STEPS,
      { reportId: 'r-inb-3' },
      browser,
      ctx,
    );
    expect((ctx as unknown as { newPage: ReturnType<typeof vi.fn> }).newPage).toHaveBeenCalled();
  });
});

describe('executeCaseReal — regression: still launches & closes', () => {
  it('calls chromium.launch exactly once and closes once', async () => {
    await executeCaseReal(
      '00000000-0000-0000-0000-0000000000b1',
      SAMPLE_STEPS,
      { reportId: 'r-real-1' },
    );
    expect(mockState.launchCount).toBe(1);
    expect(mockState.closeCount).toBe(1);
  });

  it('injects storageState into newContext options', async () => {
    const ss = { cookies: [{ name: 'sess', value: 'abc' }], origins: [] };
    await executeCaseReal(
      '00000000-0000-0000-0000-0000000000b2',
      SAMPLE_STEPS,
      { reportId: 'r-real-2' },
      undefined,
      ss,
    );
    expect(mockState.newContextOpts).toHaveLength(1);
    expect(mockState.newContextOpts[0]).toEqual(expect.objectContaining({ storageState: ss }));
  });
});

describe('loginPrepare — takeOwnership flow keeps browser alive', () => {
  it('caller takeOwnership=true → loginPrepare does NOT close browser', async () => {
    let observedBrowser: Browser | null = null;
    const result = await loginPrepare(
      {
        enabled: true,
        caseId: '00000000-0000-0000-0000-0000000000c1',
        detectionUrl: 'https://example.com/login',
        unauthorizedKeywords: null,
      },
      {
        loginCaseRunner: async (_cid, _ctx, browser) => {
          observedBrowser = browser;
          return { passed: true, storageState: mockState.storageState, takeOwnership: true };
        },
      },
    );
    expect(result.status).toBe('passed');
    expect(result.storageState).toBeDefined();
    // takeOwnership 路径下 finally 不应 close browser
    expect((observedBrowser as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled();
    expect(mockState.closeCount).toBe(0);
  });

  it('takeOwnership absent → loginPrepare closes browser (default behavior)', async () => {
    let observedBrowser: Browser | null = null;
    const result = await loginPrepare(
      {
        enabled: true,
        caseId: '00000000-0000-0000-0000-0000000000c2',
        detectionUrl: 'https://example.com/login',
        unauthorizedKeywords: null,
      },
      {
        loginCaseRunner: async (_cid, ctx, browser) => {
          observedBrowser = browser;
          return { passed: true, storageState: await ctx.storageState() }; // 不传 takeOwnership
        },
      },
    );
    expect(result.status).toBe('passed');
    expect(result.storageState).toBeDefined();
    // default 路径 finally 调 browser.close
    expect((observedBrowser as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    expect(mockState.closeCount).toBe(1);
  });
});

describe('loginPrepare — autoFillLogin 相对 loginUrl 拼接', () => {
  it('loginUrl 以 / 开头 + defaultWebOrigin → page.goto 收到拼接后的完整 URL', async () => {
    await loginPrepare(
      { enabled: true, detectionUrl: 'https://login.example.com/', unauthorizedKeywords: null },
      {
        autoLogin: { user: 'u', password: 'p', loginUrl: '/login.html' },
        defaultWebOrigin: 'http://10.0.0.1:8080',
        loginCaseRunner: async () => ({ passed: false }),
      },
    );
    const page = mockState.lastPage as unknown as { goto: ReturnType<typeof vi.fn> };
    expect(page.goto).toHaveBeenCalledWith('http://10.0.0.1:8080/login.html', expect.anything());
  });

  it('绝对 loginUrl + defaultWebOrigin → goto 直通，不拼 origin', async () => {
    await loginPrepare(
      { enabled: true, detectionUrl: 'https://login.example.com/', unauthorizedKeywords: null },
      {
        autoLogin: { user: 'u', password: 'p', loginUrl: 'https://sso.example.com/login' },
        defaultWebOrigin: 'http://10.0.0.1:8080',
        loginCaseRunner: async () => ({ passed: false }),
      },
    );
    const page = mockState.lastPage as unknown as { goto: ReturnType<typeof vi.fn> };
    expect(page.goto).toHaveBeenCalledWith('https://sso.example.com/login', expect.anything());
  });
});
