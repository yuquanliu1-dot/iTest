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
