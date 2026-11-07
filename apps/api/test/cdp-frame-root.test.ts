import { describe, it, expect, vi } from 'vitest';
import type { Page, Frame } from 'playwright-core';
import type { FrameChain } from '@itest/shared';
import { resolveFrameRoot } from '../src/execute/cdp.js';

// 帧链解析单测（mock root 注入，无浏览器/DB）：逐级 count→elementHandle→contentFrame 下钻 +
// 候选全落空抛 frame-unresolved（宁失败不误定位语义，2026-11-07 帧链录制批次）。

// 与 cdp.ts 引用的探测窗口同语义（locator-probe.ts 12×250ms）：mock 的 waitForTimeout 不推进
// 墙钟，轮数上限保证终止。
const LOCATOR_PROBE_WARMUP_ROUNDS = 1;

/** 可下钻的 mock Page/Frame：locator 按选择器匹配——只有 matchSelector 命中时返回 count，
 *  其余选择器一律 0（真实页面上不同候选指向不同元素，桩不能漏这个差异）。
 *  frame 存在且命中时 elementHandle 解析到 frame（contentFrame 返回它）。 */
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
    const inner = mockRoot('.btn', 1); // 最内层不再被探测（链终点），选择器任意
    const outer = mockRoot('.inner-frame', 1, inner); // level-2 在 outer 上探 '.inner-frame'
    const page = mockRoot('#outer-frame', 1, outer); // level-1 在 page 上探 '#outer-frame'
    const root = await resolveFrameRoot(page as unknown as Page, chain2('#outer-frame', '.inner-frame'));
    expect(root).toBe(inner);
  });

  it('候选首轮全落空时轮询重试后命中', async () => {
    // 首轮 count=0（iframe 晚挂载），之后变 1：递增计数器模拟晚挂载。
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
    // level-1 正常解析到外层帧；外层帧文档里探不到内层 iframe（count=0、无 frame 可解析）。
    const outer = mockRoot('.inner-frame', 0);
    const page = mockRoot('#outer-frame', 1, outer);
    await expect(
      resolveFrameRoot(page as unknown as Page, chain2('#outer-frame', '.inner-frame')),
    ).rejects.toThrow('frame-unresolved: 帧链第 2/2 级候选全部落空（iframe 未挂载或结构已变）');
  });

  it('elementHandle 解析到非 iframe（contentFrame null 形态）→ 该级落空报错', async () => {
    // elementHandle 存在但 contentFrame 返回 null（普通元素误配成帧候选）→ 不返回、继续探测直到抛错。
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
