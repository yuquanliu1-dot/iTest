import { describe, it, expect, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { executeCaseInBrowser } from '../src/execute/cdp.js';

/** 覆盖 runStepsInContext 对 page 的已知调用面；未覆盖的方法按报错补 no-op（预期内的红绿迭代）。 */
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
    // 钩子契约返回 Promise<void>；vi.fn() 默认返回 undefined 会让 .catch 在真实现上炸掉。
    const hook = vi.fn(async () => {});
    const results = await executeCaseInBrowser(
      'case-x',
      [{ order: 1, compiled: null }], // compile-missing → 确定性失败，不触 dispatch
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
    // navigate 是 fake page 可满足的动作：goto + waitForLoadState 均为 no-op。
    // 不传 targetUrl → init-goto 跳过；preflight 收到 url:null 不发真实网络请求
    //（preflight.ts:12 对空 url 跳过 goto，其余探测均有内部 catch）。
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
