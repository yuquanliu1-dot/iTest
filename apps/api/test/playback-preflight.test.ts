import { describe, it, expect, vi } from 'vitest';
import { preflight } from '../src/execute/preflight.js';

function pageWith(evaluateImpl: (fn: () => unknown) => Promise<unknown>, gotoImpl: () => Promise<unknown>) {
  return {
    evaluate: vi.fn().mockImplementation((fn: () => unknown) => evaluateImpl(fn)),
    goto: vi.fn().mockImplementation(() => gotoImpl()),
    url: vi.fn(() => 'https://example.com/login'),
    context: () => ({ pages: () => [{}, {}] }),
  } as never;
}

describe('preflight', () => {
  it('reports urlReachable=true when goto succeeds and body lacks defaultKeywords', async () => {
    const page = pageWith(async () => '欢迎回来', async () => undefined);
    const r = await preflight(page, { url: 'https://example.com/login', title: 'login' });
    expect(r.urlReachable).toBe(true);
    expect(r.loggedIn).toBe(true);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports urlReachable=false when goto throws', async () => {
    const page = pageWith(async () => '', async () => { throw new Error('net down'); });
    const r = await preflight(page, { url: 'https://x.test', title: 'x' });
    expect(r.urlReachable).toBe(false);
    expect(r.urlNote).toMatch(/net down/);
  });

  it('reports loggedIn=false when body contains 未登录', async () => {
    const page = pageWith(async () => '未登录，请先登录', async () => undefined);
    const r = await preflight(page, { url: 'https://x.test', title: 'x' });
    expect(r.urlReachable).toBe(true);
    expect(r.loggedIn).toBe(false);
  });

  it('skips navigate when url is empty', async () => {
    const page = pageWith(async () => 'x', async () => undefined);
    const r = await preflight(page, { url: '', title: 'x' });
    expect(r.urlReachable).toBe(true);
    expect(r.urlNote).toBeUndefined();
  });

  it('records tabsObserved from context.pages().length', async () => {
    const page = pageWith(async () => 'x', async () => undefined);
    const r = await preflight(page, { url: '', title: 'x' });
    expect(r.tabsObserved).toEqual([0, 1]);
  });
});
