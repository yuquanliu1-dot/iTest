import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { normalizeUrlForLandedCheck, gotoWithLandedRetry } from '../src/execute/cdp.js';

// init goto 落地校验重试单测（prod228 2026-10-27 实录：SOC qiankun 深链冷启动 6 轮中 1 轮
// 被静态兜底路由弹回首页——重试一次通常能赢路由守卫竞态）。只测 helper 本身，不需要浏览器/DB。

/** url() 依调用序返回 urls 中的值（越界取最后一个），模拟每轮 goto 后的最终地址。 */
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

// —— 页面内容探针（prod228 02c812ea 回归）——
// 旧 fakePage 无 evaluate：探针拿不到结果立即放弃等待，上方 4 用例即隐式覆盖该路径。
// 下面用带 evaluate/waitForTimeout 的 fake（waitForTimeout 立即 resolve，墙钟不推进，
// 靠 waitForPageSubstance 的 maxIters 兜底终止，与真实 deadline 行为等价）。
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
    expect(page.goto).toHaveBeenCalledTimes(1); // 内容超时不触发第二轮 goto
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
