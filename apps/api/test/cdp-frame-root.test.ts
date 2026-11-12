import { describe, it, expect, vi } from 'vitest';
import type { Page, Frame } from 'playwright-core';
import type { FrameChain } from '@itest/shared';
import { resolveFrameRoot } from '../src/execute/cdp.js';

// Frame-chain resolution unit tests (mock root injection, no browser/DB): drill down level by level via count -> elementHandle -> contentFrame +
// throw frame-unresolved when all candidates miss (prefer failing over mis-locating; 2026-11-07 frame-chain recording batch).

// Same semantics as the probe window referenced by cdp.ts (locator-probe.ts 12x250ms): the mock's waitForTimeout doesn't advance
// the wall clock, so the round cap guarantees termination.
const LOCATOR_PROBE_WARMUP_ROUNDS = 1;

/** Drillable mock Page/Frame: locator matches by selector -- count is returned only when matchSelector hits,
 *  every other selector returns 0 (on a real page different candidates point at different elements; the stub must not blur that difference).
 *  When the frame exists and matches, elementHandle resolves to the frame (contentFrame returns it). */
function mockRoot(matchSelector: string, count: number, frame?: Frame): Frame {
  return {
    locator: (sel: string) => {
      const hit = sel === matchSelector ? count : 0;
      return {
        count: vi.fn(async () => hit),
        first: () => ({
          elementHandle: async () =>
            frame && hit > 0
              ? { contentFrame: async () => frame, dispose: async () => undefined }
              : null,
        }),
      };
    },
    getByText: () => ({ count: async () => 0 }),
    getByRole: () => ({ count: async () => 0 }),
    waitForTimeout: vi.fn(async () => undefined),
  } as unknown as Frame;
}

const chain2 = (outer: string, inner: string): FrameChain => [
  { locator: [{ strategy: 'css', value: outer }] },
  { locator: [{ strategy: 'css', value: inner }] },
];

describe('resolveFrameRoot', () => {
  it('两级链逐级下钻到最内层 Frame（首轮命中零等待）', async () => {
    const inner = mockRoot('.btn', 1); // the innermost level is no longer probed (chain endpoint); the selector is arbitrary
    const outer = mockRoot('.inner-frame', 1, inner); // level-2 probes '.inner-frame' on outer
    const page = mockRoot('#outer-frame', 1, outer); // level-1 probes '#outer-frame' on the page
    const root = await resolveFrameRoot(page as unknown as Page, chain2('#outer-frame', '.inner-frame'));
    expect(root).toBe(inner);
  });

  it('候选首轮全落空时轮询重试后命中', async () => {
    // First round count=0 (the iframe mounts late), then becomes 1: an incrementing counter simulates late mounting.
    let probes = 0;
    const frame = mockRoot('.btn', 1);
    const page = {
      locator: (_sel: string) => ({
        count: vi.fn(async () => (probes++ < LOCATOR_PROBE_WARMUP_ROUNDS ? 0 : 1)),
        first: () => ({
          elementHandle: async () => ({ contentFrame: async () => frame, dispose: async () => undefined }),
        }),
      }),
      getByText: () => ({ count: async () => 0 }),
      getByRole: () => ({ count: async () => 0 }),
      waitForTimeout: vi.fn(async () => undefined),
    } as unknown as Frame;
    const root = await resolveFrameRoot(page as unknown as Page, [
      { locator: [{ strategy: 'css', value: '.inner' }] },
    ]);
    expect(root).toBe(frame);
  });

  it('第 1 级候选全落空抛 frame-unresolved（1/1）', async () => {
    const page = mockRoot('#gone', 0);
    await expect(
      resolveFrameRoot(page as unknown as Page, [{ locator: [{ strategy: 'css', value: '#gone' }] }]),
    ).rejects.toThrow('frame-unresolved: 帧链第 1/1 级候选全部落空（iframe 未挂载或结构已变）');
  });

  it('第 2 级候选全落空抛 frame-unresolved（2/2）', async () => {
    // level-1 resolves to the outer frame normally; the outer frame's document can't find the inner iframe (count=0, no frame to resolve).
    const outer = mockRoot('.inner-frame', 0);
    const page = mockRoot('#outer-frame', 1, outer);
    await expect(
      resolveFrameRoot(page as unknown as Page, chain2('#outer-frame', '.inner-frame')),
    ).rejects.toThrow('frame-unresolved: 帧链第 2/2 级候选全部落空（iframe 未挂载或结构已变）');
  });

  it('elementHandle 解析到非 iframe（contentFrame null 形态）→ 该级落空报错', async () => {
    // elementHandle exists but contentFrame returns null (an ordinary element misconfigured as a frame candidate) -> no return, keep probing until it throws.
    const page = {
      locator: (_sel: string) => ({
        count: vi.fn(async () => 1),
        first: () => ({
          elementHandle: async () => ({ contentFrame: async () => null, dispose: async () => undefined }),
        }),
      }),
      getByText: () => ({ count: async () => 0 }),
      getByRole: () => ({ count: async () => 0 }),
      waitForTimeout: vi.fn(async () => undefined),
    } as unknown as Frame;
    await expect(
      resolveFrameRoot(page as unknown as Page, [{ locator: [{ strategy: 'css', value: '#not-a-frame' }] }]),
    ).rejects.toThrow('frame-unresolved');
  });
});
