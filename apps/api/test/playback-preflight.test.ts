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

  // prod228 02c812ea regression: preflight's second goto of the same URL = a full page reload (waits only for domcontentloaded),
  // throwing a slow SPA back to its startup phase → step 1 charges into a blank page and hits LocatorAllFailed. When init-goto has
  // already happened, the caller passes skipNavigate=true and navigation must not happen again here.
  it('skipNavigate=true: 不再 goto，urlReachable 直接 true，body 检查照常执行', async () => {
    const page = pageWith(async () => 'ok', async () => undefined);
    const r = await preflight(page, { url: 'https://x.test/app', title: 'x' }, { skipNavigate: true });
    expect(page.goto).not.toHaveBeenCalled();
    expect(r.urlReachable).toBe(true);
    expect(r.urlNote).toBeUndefined();
    expect(r.loggedIn).toBe(true);
    expect(page.evaluate).toHaveBeenCalled();
  });

  it('skipNavigate 缺省时保持旧行为：仍 goto 一次', async () => {
    const page = pageWith(async () => 'ok', async () => undefined);
    await preflight(page, { url: 'https://x.test/app', title: 'x' });
    expect(page.goto).toHaveBeenCalledTimes(1);
  });
});
