import { describe, it, expect, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { executeCaseInBrowser } from '../src/execute/cdp.js';

/** Covers runStepsInContext's known call surface on page; uncovered methods throw and get no-op'd as errors surface (expected red-green iteration). */
function fakePage() {
  return {
    url: () => 'about:blank',
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    screenshot: async () => Buffer.alloc(0),
    evaluate: async () => { throw new Error('no evaluate in fake'); },
    locator: () => { throw new Error('no locator in fake'); },
    content: async () => '<html></html>',
    close: async () => {},
  } as unknown as Page;
}

function fakeContext(page: Page) {
  return { newPage: async () => page } as unknown as BrowserContext;
}

describe('executeCaseInBrowser onFailurePage 钩子', () => {
  it('步骤失败时触发：携带失败步骤下标与当前页，结果仍为 failed', async () => {
    const page = fakePage();
    // The hook contract returns Promise<void>; vi.fn()'s default undefined return would blow up .catch on a real implementation.
    const hook = vi.fn(async () => {});
    const results = await executeCaseInBrowser(
      'case-x',
      [{ order: 1, compiled: null }], // compile-missing -> deterministic failure, dispatch never reached
      { reportId: 'ut-onfailure' },
      {} as Browser,
      fakeContext(page),
      undefined,
      undefined,
      undefined,
      undefined,
      hook,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toContain('compile-missing');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]![0]).toBe(page);
    expect(hook.mock.calls[0]![1]).toBe(0);
  });

  it('全部通过时不触发钩子；不传钩子行为不变', async () => {
    const page = fakePage();
    const hook = vi.fn();
    // navigate is an action the fake page can satisfy: goto + waitForLoadState are both no-ops.
    // No targetUrl passed -> init-goto is skipped; preflight receives url:null and sends no real network request
    // (preflight.ts:12 skips goto for an empty url; the other probes all have internal catches).
    const results = await executeCaseInBrowser(
      'case-y',
      [{ order: 1, compiled: [{ kind: 'navigate', url: 'https://example.com/' }] }],
      { reportId: 'ut-onfailure-2' },
      {} as Browser,
      fakeContext(page),
      undefined,
      undefined,
      undefined,
      undefined,
      hook,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('passed');
    expect(hook).not.toHaveBeenCalled();

    const noHook = await executeCaseInBrowser(
      'case-y',
      [{ order: 1, compiled: null }],
      { reportId: 'ut-onfailure-3' },
      {} as Browser,
      fakeContext(fakePage()),
    );
    expect(noHook[0]!.status).toBe('failed');
  });
});
