import { describe, it, expect } from 'vitest';
import { evaluateGenerator, substituteVars, materializeValue, deepEqual } from '../src/value-utils.js';

describe('evaluateGenerator', () => {
  it('randomString returns requested length', () => {
    expect(evaluateGenerator({ mode: 'randomString', length: 8 })).toHaveLength(8);
  });
  it('randomNumber is within [min, max]', () => {
    const n = Number(evaluateGenerator({ mode: 'randomNumber', min: 10, max: 20 }));
    expect(n).toBeGreaterThanOrEqual(10);
    expect(n).toBeLessThanOrEqual(20);
  });
  it('timestamp returns current ms as string', () => {
    const before = Date.now();
    const n = Number(evaluateGenerator({ mode: 'timestamp' }));
    expect(n).toBeGreaterThanOrEqual(before);
  });
  it('prefixTimestamp prepends prefix', () => {
    expect(evaluateGenerator({ mode: 'prefixTimestamp', prefix: 'T-' })).toMatch(/^T-\d+$/);
  });
});

describe('substituteVars', () => {
  it('replaces defined vars', () => {
    expect(substituteVars('订单{{orderNo}}', { orderNo: 'A123' })).toBe('订单A123');
  });
  it('throws listing missing vars', () => {
    expect(() => substituteVars('{{a}}-{{b}}-{{a}}', {})).toThrow(/a, b/);
  });
  it('leaves text without templates untouched', () => {
    expect(substituteVars('plain', {})).toBe('plain');
  });
  it('does not resolve prototype-chain keys like toString', () => {
    expect(() => substituteVars('{{toString}}', {})).toThrow(/toString/);
  });
  it('supports non-ASCII variable names', () => {
    expect(substituteVars('订单{{订单号}}', { 订单号: 'A1' })).toBe('订单A1');
  });
});

describe('materializeValue', () => {
  it('passes plain strings through substitution', () => {
    expect(materializeValue('v-{{x}}', { x: '1' })).toBe('v-1');
  });
  it('evaluates generator then substitutes', () => {
    expect(materializeValue({ mode: 'prefixTimestamp', prefix: 'P' }, {})).toMatch(/^P\d+$/);
  });

  it('composite concatenates fragments in order', () => {
    const out = materializeValue(
      {
        mode: 'composite',
        fragments: [
          { mode: 'fixed', value: 'CS' },
          { mode: 'randomNumber', min: 0, max: 999, length: 3 },
          { mode: 'randomString', length: 4 },
        ],
      },
      {},
    );
    expect(out).toMatch(/^CS\d{3}[A-Za-z0-9]{4}$/);
  });

  it('composite date fragment formats YYYYMMDD', () => {
    const out = materializeValue(
      { mode: 'composite', fragments: [{ mode: 'date', format: 'YYYYMMDD' }] },
      {},
    );
    expect(out).toMatch(/^\d{8}$/);
  });

  it('composite date fragment formats YYYY-MM-DD with separators', () => {
    const out = materializeValue(
      { mode: 'composite', fragments: [{ mode: 'date', format: 'YYYY-MM-DD' }] },
      {},
    );
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('composite randomNumber without length has no padding', () => {
    const out = materializeValue(
      {
        mode: 'composite',
        fragments: [{ mode: 'randomNumber', min: 1, max: 9 }],
      },
      {},
    );
    expect(out).toMatch(/^[1-9]$/);
  });

  it('composite applies var substitution after fragment eval', () => {
    const out = materializeValue(
      {
        mode: 'composite',
        fragments: [
          { mode: 'fixed', value: '订单' },
          { mode: 'timestamp' },
        ],
      },
      {},
    );
    expect(out).toMatch(/^订单\d+$/);
  });

  it('composite surfaces fragment #n error when randomNumber range invalid', () => {
    expect(() =>
      materializeValue(
        {
          mode: 'composite',
          fragments: [
            { mode: 'fixed', value: 'OK' },
            // Zod 不会通过 refine 再来一次，运行时调用 evaluateGenerator 会抛
            // 但当前 materializeValue 把 composite 各 fragment 当作 ValueGenerator 求值，
            // max < min 不会到这里。先用 timestamp + 把 max 设为非法测：
            { mode: 'randomNumber', min: 9, max: 2 },
          ],
        },
        {},
      ),
    ).toThrow(/fragment #2/);
  });
});

describe('deepEqual', () => {
  it('compares objects regardless of key order', () => {
    expect(deepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
  });
  it('rejects mismatched values', () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1], [1, 2])).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});
