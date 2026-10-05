import { describe, it, expect } from 'vitest';
import { canSwitch, switchAction } from '../src/lib/type-switch.js';

describe('canSwitch', () => {
  it('allows click <-> hover', () => {
    expect(canSwitch('click', 'hover')).toBe(true);
    expect(canSwitch('hover', 'click')).toBe(true);
  });
  it('allows click <-> assertText', () => {
    expect(canSwitch('click', 'assertText')).toBe(true);
    expect(canSwitch('assertText', 'click')).toBe(true);
  });
  it('allows fill <-> select', () => {
    expect(canSwitch('fill', 'select')).toBe(true);
    expect(canSwitch('select', 'fill')).toBe(true);
  });
  it('allows waitFor <-> assertVisible', () => {
    expect(canSwitch('waitFor', 'assertVisible')).toBe(true);
    expect(canSwitch('assertVisible', 'waitFor')).toBe(true);
  });
  it('rejects switching involving navigate/upload/extract/aiTask/switchTab/screenshot/assertJson', () => {
    for (const k of ['navigate', 'upload', 'extract', 'aiTask', 'switchTab', 'screenshot', 'assertJson'] as const) {
      expect(canSwitch(k, 'click')).toBe(false);
      expect(canSwitch('click', k)).toBe(false);
    }
  });
});

describe('switchAction', () => {
  it('click -> assertText: keeps locator + intentLocator, adds equals/target/match defaults', () => {
    const out = switchAction(
      { kind: 'click', locator: [{ strategy: 'css', value: '#x' }], intentLocator: { semanticRole: 'x' } },
      'assertText',
    );
    expect(out).toEqual({
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '#x' }],
      intentLocator: { semanticRole: 'x' },
      target: 'specifiedElement',
      match: 'equals',
      equals: '',
    });
  });

  it('fill -> select: keeps locator + intentLocator, value coerced to string (warns via length 0 fallback)', () => {
    const out = switchAction(
      { kind: 'fill', locator: [{ strategy: 'css', value: '#x' }], value: 'hello' },
      'select',
    );
    expect(out).toEqual({
      kind: 'select',
      locator: [{ strategy: 'css', value: '#x' }],
      intentLocator: undefined,
      value: 'hello',
    });
  });

  it('waitFor -> assertVisible: keeps locator + intentLocator, drops timeoutMs', () => {
    const out = switchAction(
      { kind: 'waitFor', locator: [{ strategy: 'css', value: '#x' }], timeoutMs: 3000 },
      'assertVisible',
    );
    expect(out).toEqual({
      kind: 'assertVisible',
      locator: [{ strategy: 'css', value: '#x' }],
      intentLocator: undefined,
    });
    expect((out as { timeoutMs?: number }).timeoutMs).toBeUndefined();
  });

  it('returns original action unchanged for unsupported switch', () => {
    const orig = { kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }], fileId: 'abc' };
    const out = switchAction(orig, 'click');
    expect(out).toBe(orig);
  });
});