import { describe, it, expect } from 'vitest';
import { estimateCompositeMaxLen } from '../src/lib/length-estimate.js';

describe('estimateCompositeMaxLen', () => {
  it('returns 0 for empty fragments (should be caught by Zod but defensive)', () => {
    expect(estimateCompositeMaxLen({ mode: 'composite', fragments: [] })).toBe(0);
  });
  it('sums fixed.length', () => {
    expect(
      estimateCompositeMaxLen({ mode: 'composite', fragments: [{ mode: 'fixed', value: 'abc' }] }),
    ).toBe(3);
  });
  it('treats randomNumber length as the upper bound', () => {
    expect(
      estimateCompositeMaxLen({
        mode: 'composite',
        fragments: [{ mode: 'randomNumber', min: 0, max: 99, length: 3 }],
      }),
    ).toBe(3);
  });
  it('uses max digits when no length', () => {
    expect(
      estimateCompositeMaxLen({
        mode: 'composite',
        fragments: [{ mode: 'randomNumber', min: 0, max: 9999 }],
      }),
    ).toBe(4);
  });
  it('date fragment length matches its format', () => {
    expect(
      estimateCompositeMaxLen({
        mode: 'composite',
        fragments: [{ mode: 'date', format: 'YYYY-MM-DD' }],
      }),
    ).toBe(10);
  });
  it('saturates above 1024', () => {
    const huge = { mode: 'composite' as const, fragments: [{ mode: 'fixed' as const, value: 'x'.repeat(2000) }] };
    expect(estimateCompositeMaxLen(huge)).toBeGreaterThan(1024);
  });
});
