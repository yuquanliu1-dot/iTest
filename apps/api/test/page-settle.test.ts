import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { waitForPageSettled } from '../src/execute/pageSettle.js';

/** Fake page: evaluate returns scripted fingerprint values; waitForLoadState/waitForTimeout are no-ops.
 *  settleMs is set to 1ms so the synchronously-resolved mocked waitForTimeout can still advance the loop. */
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
    // Sampled after one networkidle: first round prev=-2 doesn't match; the 2nd and 3rd fingerprints == prev → stable≥2, converges and returns
    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(page.waitForLoadState).toHaveBeenCalledTimes(1);
  });

  it('指纹持续变化：跑到迭代上限仍不抛错（best-effort）', async () => {
    // The fingerprint changes every time → stable stays 0; the loop runs to its cap and returns quietly (an early exit under coarse Date.now() granularity is also legal).
    // Only assert "sampled ≥1 time and never threw", not the exact count (it drifts with the wall clock).
    const page = makePage([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    await expect(waitForPageSettled(page, { timeoutMs: 2000, settleMs: 50 })).resolves.toBeUndefined();
    expect(page.evaluate.mock.calls.length).toBeGreaterThan(0);
    // No throw anywhere
    for (const r of page.evaluate.mock.results) expect(r.type).not.toBe('throw');
  });

  it('networkidle 失败（如被 mock 抛错）不阻塞后续采样', async () => {
    const page = makePage([5, 5, 5, 5]);
    page.waitForLoadState.mockRejectedValue(new Error('nope'));
    await expect(waitForPageSettled(page, { timeoutMs: 10000, settleMs: 1 })).resolves.toBeUndefined();
    expect(page.waitForLoadState).toHaveBeenCalledTimes(1);
    // Stable fingerprints still converge
    expect(page.evaluate).toHaveBeenCalledTimes(3);
  });

  it('evaluate 异常（指纹回 -1）不视为稳定，跑到迭代上限仍不抛错', async () => {
    const page = makePage([-1, -1, -1, -1]);
    // Fingerprint -1: the cur>=0 check fails → stable stays 0, never converges, runs to the cap and returns quietly
    await expect(waitForPageSettled(page, { timeoutMs: 2000, settleMs: 50 })).resolves.toBeUndefined();
    expect(page.evaluate.mock.calls.length).toBeGreaterThan(0);
  });
});
