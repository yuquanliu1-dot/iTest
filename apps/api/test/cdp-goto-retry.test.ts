import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { normalizeUrlForLandedCheck, gotoWithLandedRetry } from '../src/execute/cdp.js';

// init goto landed-check retry unit tests (prod228 2026-10-27 live record: 1 of 6 rounds of the SOC qiankun deep-link cold start
// got bounced back to the home page by the static fallback route -- retrying once usually wins the route-guard race). Only the helper itself is tested; no browser/DB needed.

/** url() returns the values from urls in call order (out of range returns the last), simulating the final address after each goto round. */
function fakePage(urls: string[]): Page {
  let i = 0;
  return {
    goto: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    url: () => urls[Math.min(i++, urls.length - 1)],
  } as unknown as Page;
}

describe('normalizeUrlForLandedCheck', () => {
  it('归一 origin/path 小写、去尾斜杠、去 search、保留 hash', () => {
    expect(normalizeUrlForLandedCheck('https://Host.com/app/page/')).toBe('https://host.com/app/page');
    expect(normalizeUrlForLandedCheck('https://host.com/app/page?tab=1')).toBe('https://host.com/app/page');
    expect(normalizeUrlForLandedCheck('https://host.com/app/page#/detail')).toBe('https://host.com/app/page#/detail');
    expect(normalizeUrlForLandedCheck('https://host.com/app/page/?x=1#/detail')).toBe('https://host.com/app/page#/detail');
  });

  it('非 URL 字符串原样返回（不抛错）', () => {
    expect(normalizeUrlForLandedCheck('about:blank')).toBe('about:blank');
  });
});

describe('gotoWithLandedRetry', () => {
  const target = 'https://host.test/siemapp/siem/businessmgr/incidentmgr';

  it('首次 goto 即落地：不再重试', async () => {
    const page = fakePage([target]);
    const r = await gotoWithLandedRetry(page, target);
    expect(r).toEqual({ landed: true, finalUrl: target });
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it('被弹回首页后重试一次落地：goto 共 2 次', async () => {
    const page = fakePage(['https://host.test/siemapp/siem/platformhome/home', target]);
    const r = await gotoWithLandedRetry(page, target);
    expect(r.landed).toBe(true);
    expect(page.goto).toHaveBeenCalledTimes(2);
  });

  it('两次都未落地：landed=false 返回实际地址，goto 恰好 2 次（不第三次）', async () => {
    const home = 'https://host.test/siemapp/siem/platformhome/home';
    const page = fakePage([home, home]);
    const r = await gotoWithLandedRetry(page, target);
    expect(r).toEqual({ landed: false, finalUrl: home });
    expect(page.goto).toHaveBeenCalledTimes(2);
  });

  it('尾斜杠/大小写差异视为落地（归一比较）', async () => {
    const page = fakePage(['https://HOST.test/siemapp/siem/businessmgr/incidentmgr/']);
    const r = await gotoWithLandedRetry(page, target);
    expect(r.landed).toBe(true);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });
});

// -- Page content probe (prod228 02c812ea regression) --
// The old fakePage had no evaluate: the probe gave up waiting immediately without a result, and the 4 cases above implicitly covered that path.
// Below, a fake with evaluate/waitForTimeout is used (waitForTimeout resolves immediately, the wall clock doesn't advance,
// and termination relies on waitForPageSubstance's maxIters fallback -- equivalent to the real deadline behavior).
function substancePage(urls: string[], evaluateResults: boolean[]) {
  let i = 0;
  let e = 0;
  return {
    goto: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    url: () => urls[Math.min(i++, urls.length - 1)],
    evaluate: vi.fn(async () => evaluateResults[Math.min(e++, evaluateResults.length - 1)]),
    waitForTimeout: vi.fn(async () => undefined),
  };
}

describe('gotoWithLandedRetry — 页面内容探针', () => {
  const target = 'https://host.test/mrm/numberLevel.view';

  it('URL 落地后等内容出现：空白 2 轮后出现 → landed=true、goto 仍 1 次', async () => {
    const page = substancePage([target], [false, false, true]);
    const r = await gotoWithLandedRetry(page as unknown as Page, target);
    expect(r).toEqual({ landed: true, finalUrl: target });
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.evaluate.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('恒空白：maxIters 兜底终止，仍 landed=true 不抛（超时只告警不阻断）', async () => {
    const page = substancePage([target], [false]);
    const r = await gotoWithLandedRetry(page as unknown as Page, target);
    expect(r.landed).toBe(true);
    expect(page.goto).toHaveBeenCalledTimes(1); // a content timeout doesn't trigger a second goto
    expect(page.evaluate.mock.calls.length).toBeGreaterThan(5);
  });

  it('两轮都未落地：内容探针不参与（只在落地分支等待），重试语义不变', async () => {
    const page = substancePage(['https://host.test/home', 'https://host.test/home'], [true]);
    const r = await gotoWithLandedRetry(page as unknown as Page, target);
    expect(r.landed).toBe(false);
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});
