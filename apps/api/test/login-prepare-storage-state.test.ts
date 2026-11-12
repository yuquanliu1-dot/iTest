import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page, Browser, BrowserContext } from 'playwright-core';

// Reuses the playback-integration approach: mock the whole playwright-core so cdp runs on a controlled stub page.
// Key point: singleton browser — every chromium.launch() returns the same object, keeping spy counts consistent across tests.
// launchCount / closeCount are reset in beforeEach.
const mockState = vi.hoisted(() => ({
  locatorCount: 1,
  clickReject: false,
  launchCount: 0,
  closeCount: 0,
  // Probe page main-response status (null = no response object / 200); body text (null = keep the 'val' default)
  gotoStatus: null as number | null,
  bodyText: null as string | null,
  // Singleton browser/context — every chromium.launch() gets the same object, so close-call counts are easy to assert
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
    innerText: vi.fn().mockImplementation(async () => mockState.bodyText ?? 'val'),
    isVisible: vi.fn().mockResolvedValue(true),
    isChecked: vi.fn().mockResolvedValue(false),
    check: vi.fn().mockResolvedValue(undefined),
    uncheck: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
  });
  const makePage = (): Page => ({
    goto: vi.fn().mockImplementation(async () =>
      mockState.gotoStatus != null ? { status: () => mockState.gotoStatus } : undefined,
    ),
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

  // Singleton ctx — every newContext(opts) records opts and returns the same ctx.
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

  // Give the singleton browser/context a stash entry so tests can reach the same reference via mockState.browser / ctx.
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
  // mock state reset
  mockState.launchCount = 0;
  mockState.closeCount = 0;
  mockState.newContextOpts.length = 0;
  mockState.locatorCount = 1;
  mockState.gotoStatus = null;
  mockState.bodyText = null;
  // reset mock spy call counts (keep mock references; the mock functions themselves are stable)
  (mockState.browser as unknown as { close: ReturnType<typeof vi.fn> }).close.mockClear();
  (mockState.ctx as unknown as { newPage: ReturnType<typeof vi.fn> }).newPage.mockClear();
  (mockState.ctx as unknown as { storageState: ReturnType<typeof vi.fn> }).storageState.mockClear();
});

describe('executeCaseInBrowser — shares caller-owned browser+ctx', () => {
  it('does NOT call chromium.launch (browser pre-supplied)', async () => {
    // Take the singleton browser reference directly via mockState.browser — the cdp path must not call chromium.launch again.
    const browser = mockState.browser;
    const ctx = mockState.ctx;
    mockState.launchCount = 0; // reset
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
    // On the takeOwnership path, finally must not close the browser
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
          return { passed: true, storageState: await ctx.storageState() }; // takeOwnership not passed
        },
      },
    );
    expect(result.status).toBe('passed');
    expect(result.storageState).toBeDefined();
    // The default path calls browser.close in finally
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

  it('loginUrl 相对但无 defaultWebOrigin → failed(拼接不出绝对地址)', async () => {
    const res = await loginPrepare(
      { enabled: true, detectionUrl: 'https://login.example.com/', unauthorizedKeywords: null },
      {
        autoLogin: { user: 'u', password: 'p', loginUrl: '/login.html' },
        loginCaseRunner: async () => ({ passed: false }),
      },
    );
    expect(res.status).toBe('failed');
    expect(res.reason).toBe('auto login: loginUrl is relative but no default web origin');
  });
});

// prod228 bd6a1cf0 (2026-11-03) regression: the probe URL landed on a Whitelabel 404 error page — no URL login
// markers, no password field, no unauthorized keywords → the old exclusion-style check produced "no login signals,
// logged in" → the login case was silently skipped. After the fix: HTTP≥400 or an error-page signature → treated as
// logged out, so the login case runs.
describe('loginPrepare — 探测错误页不再判已登录', () => {
  const cfg = {
    enabled: true,
    caseId: '00000000-0000-0000-0000-0000000000c3',
    // page.url() mock is fixed to https://example.com/ (no login markers); the password field is controlled by locatorCount
    detectionUrl: 'https://app.example.com/',
    unauthorizedKeywords: null,
  };

  it('主响应 HTTP 404 → 不判已登录，执行登录用例', async () => {
    mockState.gotoStatus = 404;
    mockState.locatorCount = 0; // no password field: the old logic would misjudge "no login signals" here
    const runner = vi.fn(async () => ({ passed: true }));
    const result = await loginPrepare(cfg, { loginCaseRunner: runner });
    expect(result.status).toBe('passed');
    expect(result.reason).toBe('login case executed');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('主响应 HTTP 502 → 同样执行登录用例（状态码通用）', async () => {
    mockState.gotoStatus = 502;
    mockState.locatorCount = 0;
    const runner = vi.fn(async () => ({ passed: true }));
    const result = await loginPrepare(cfg, { loginCaseRunner: runner });
    expect(result.status).toBe('passed');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('HTTP 200 + Whitelabel 错误页签名 body → 走签名分支执行登录用例', async () => {
    mockState.gotoStatus = null; // no response object (or 200)
    mockState.locatorCount = 0;
    mockState.bodyText = 'Whitelabel Error Page\nThis application has no explicit mapping for /error\n404 Not Found';
    const runner = vi.fn(async () => ({ passed: true }));
    const result = await loginPrepare(cfg, { loginCaseRunner: runner });
    expect(result.status).toBe('passed');
    expect(result.reason).toBe('login case executed');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('回归守卫：正常 body 无登录信号 → 仍 skipped（no login signals），不执行登录用例', async () => {
    mockState.gotoStatus = null;
    mockState.locatorCount = 0;
    mockState.bodyText = 'Welcome to portal home';
    const runner = vi.fn(async () => ({ passed: true }));
    const result = await loginPrepare(cfg, { loginCaseRunner: runner });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no login signals');
    expect(runner).not.toHaveBeenCalled();
  });
});
