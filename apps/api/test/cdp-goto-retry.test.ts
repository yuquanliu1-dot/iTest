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
