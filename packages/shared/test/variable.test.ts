import { describe, it, expect } from 'vitest';
import { validateVariableName, collectVarRefs, substituteVars, safeRegex } from '../src/variable.js';

describe('validateVariableName', () => {
  it('accepts valid names', () => {
    expect(validateVariableName('orderId')).toEqual({ ok: true });
    expect(validateVariableName('_x')).toEqual({ ok: true });
    expect(validateVariableName('a1_b2')).toEqual({ ok: true });
  });
  it('rejects empty / too long / bad shape', () => {
    expect(validateVariableName('').ok).toBe(false);
    expect(validateVariableName('a'.repeat(65)).ok).toBe(false);
    expect(validateVariableName('1abc').ok).toBe(false);
    expect(validateVariableName('a-b').ok).toBe(false);
    expect(validateVariableName('订单号').ok).toBe(false);
  });
});

describe('collectVarRefs', () => {
  it('returns unique ordered names', () => {
    expect(collectVarRefs('{{a}}-{{b}}-{{a}}')).toEqual(['a', 'b']);
  });
  it('tolerates spaces inside braces', () => {
    expect(collectVarRefs('订单 {{ orderNo }}')).toEqual(['orderNo']);
  });
  it('returns [] when none', () => {
    expect(collectVarRefs('plain')).toEqual([]);
  });
});

describe('substituteVars', () => {
  it('replaces defined vars', () => {
    expect(substituteVars('订单{{orderNo}}', { orderNo: 'A1' })).toEqual({ value: '订单A1', missing: [] });
  });
  it('keeps template and lists missing', () => {
    const r = substituteVars('{{a}}-{{b}}-{{a}}', {});
    expect(r.value).toBe('{{a}}-{{b}}-{{a}}');
    expect(r.missing).toEqual(['a', 'b']);
  });
  it('does not resolve prototype-chain keys', () => {
    const r = substituteVars('{{toString}}', {});
    expect(r.missing).toEqual(['toString']);
  });
});

describe('safeRegex', () => {
  it('accepts normal patterns', () => {
    expect(safeRegex('^(.+?)（')).toEqual({ ok: true });
    expect(safeRegex('\\d{4}-\\d{2}-\\d{2}')).toEqual({ ok: true });
  });
  it('rejects nested quantifiers', () => {
    expect(safeRegex('(a+)+').ok).toBe(false);
    expect(safeRegex('(a*)*').ok).toBe(false);
  });
  it('rejects malformed patterns', () => {
    expect(safeRegex('(unclosed').ok).toBe(false);
  });
});
