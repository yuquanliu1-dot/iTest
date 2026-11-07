import { describe, it, expect } from 'vitest';
import { mergeConsecutiveFills } from '../src/routes/recorder.js';

// 连续 fill 合并键回归：同 locator 才合并；frameChain 不同 = 不同帧里的同名目标，
// 合并把值写错帧（2026-11-07 帧链录制批次引入 chain 后的防护锚）。

type FillItem = { action: { kind?: string; locator?: unknown; value?: unknown; sensitive?: unknown; frameChain?: unknown } };
const act = (s: unknown) => (s as FillItem).action;
const fill = (value: string, frameChain?: unknown) =>
  ({ action: { kind: 'fill', locator: [{ strategy: 'css', value: '#kw' }], value, ...(frameChain !== undefined ? { frameChain } : {}) } });

describe('mergeConsecutiveFills', () => {
  it('同 locator 无链的连续 fill 合并保留最后值', () => {
    const out = mergeConsecutiveFills([fill('a'), fill('ab')]);
    expect(out).toHaveLength(1);
    expect(act(out[0]).value).toBe('ab');
  });

  it('locator 不同不合并', () => {
    const out = mergeConsecutiveFills([
      { action: { kind: 'fill', locator: [{ strategy: 'css', value: '#a' }], value: '1' } },
      { action: { kind: 'fill', locator: [{ strategy: 'css', value: '#b' }], value: '2' } },
    ]);
    expect(out).toHaveLength(2);
  });

  it('同 locator 但 frameChain 不同不合并（错帧防护）', () => {
    const chainA = [{ locator: [{ strategy: 'css', value: '#fa' }] }];
    const chainB = [{ locator: [{ strategy: 'css', value: '#fb' }] }];
    const out = mergeConsecutiveFills([fill('a', chainA), fill('b', chainB)]);
    expect(out).toHaveLength(2);
    expect(act(out[0]).value).toBe('a');
    expect(act(out[1]).value).toBe('b');
  });

  it('有链 vs 无链不合并', () => {
    const chain = [{ locator: [{ strategy: 'css', value: '#fa' }] }];
    const out = mergeConsecutiveFills([fill('a'), fill('b', chain)]);
    expect(out).toHaveLength(2);
  });

  it('同 locator 同链的连续 fill 正常合并', () => {
    const chain = [{ locator: [{ strategy: 'css', value: '#fa' }] }];
    const out = mergeConsecutiveFills([fill('a', chain), fill('ab', chain)]);
    expect(out).toHaveLength(1);
    expect(act(out[0]).value).toBe('ab');
    expect(act(out[0]).frameChain).toEqual(chain);
  });
});
