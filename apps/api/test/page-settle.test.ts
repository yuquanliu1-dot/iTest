import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { waitForPageSettled } from '../src/execute/pageSettle.js';

/** 假 page：evaluate 脚本化回指纹值；waitForLoadState/waitForTimeout 均为 no-op。
 *  settleMs 给到 1ms 让测试里 mock 同步 resolve 的 waitForTimeout 也能推进循环。 */
function makePage(fingerprints: number[]) {
  let i = 0;
  const page = {
    evaluate: vi.fn(async () => fingerprints[Math.min(i++, fingerprints.length - 1)] ?? -1),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  };
  return page as unknown as Page & { evaluate: ReturnType<typeof vi.fn> };
}

describe('waitForPageSettled', () => {
  it('连拍两次指纹一致即收敛：稳定页只需 ~3 次采样', async () => {
    const page = makePage([7, 7, 7, 7, 7]);
    await waitForPageSettled(page, { timeoutMs: 10000, settleMs: 1 });
    // 1 次 networkidle 后采样：首轮 prev=-2 未匹配；第 2、3 次指纹==prev → stable≥2 收敛返回
    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(page.waitForLoadState).toHaveBeenCalledTimes(1);
  });

  it('指纹持续变化：跑到迭代上限仍不抛错（best-effort）', async () => {
    // 指纹每次都不同 → stable 恒 0，循环跑到上限后安静返回（Date.now() 粗粒度下提前结束也合法）。
    // 只断言「采过 ≥1 次且不抛错」，不断言精确次数（会随墙钟漂移）。
    const page = makePage([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    await expect(waitForPageSettled(page, { timeoutMs: 2000, settleMs: 50 })).resolves.toBeUndefined();
    expect(page.evaluate.mock.calls.length).toBeGreaterThan(0);
    // 全程无抛错
    for (const r of page.evaluate.mock.results) expect(r.type).not.toBe('throw');
  });

  it('networkidle 失败（如被 mock 抛错）不阻塞后续采样', async () => {
    const page = makePage([5, 5, 5, 5]);
    page.waitForLoadState.mockRejectedValue(new Error('nope'));
    await expect(waitForPageSettled(page, { timeoutMs: 10000, settleMs: 1 })).resolves.toBeUndefined();
    expect(page.waitForLoadState).toHaveBeenCalledTimes(1);
    // 稳定指纹仍收敛
    expect(page.evaluate).toHaveBeenCalledTimes(3);
  });

  it('evaluate 异常（指纹回 -1）不视为稳定，跑到迭代上限仍不抛错', async () => {
    const page = makePage([-1, -1, -1, -1]);
    // 指纹 -1：cur>=0 判定失败 → stable 恒 0，不收敛，跑到上限安静返回
    await expect(waitForPageSettled(page, { timeoutMs: 2000, settleMs: 50 })).resolves.toBeUndefined();
    expect(page.evaluate.mock.calls.length).toBeGreaterThan(0);
  });
});
