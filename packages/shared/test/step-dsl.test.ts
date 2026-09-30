import { describe, it, expect } from 'vitest';
import { StepAction, Locator } from '../src/step-dsl.js';

describe('step-dsl', () => {
  it('accepts valid click action', () => {
    const r = StepAction.safeParse({
      kind: 'click',
      locator: [{ strategy: 'role', value: 'button[name="Submit"]' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects click action with empty locator array', () => {
    const r = StepAction.safeParse({ kind: 'click', locator: [] });
    expect(r.success).toBe(false);
  });

  it('accepts valid fill action', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'testId', value: 'email' }],
      value: 'a@b.com',
    });
    expect(r.success).toBe(true);
  });

  it('rejects fill action without value', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'testId', value: 'email' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects navigate with non-URL string', () => {
    const r = StepAction.safeParse({ kind: 'navigate', url: 'not-a-url' });
    expect(r.success).toBe(false);
  });

  it('accepts locator with all strategies', () => {
    for (const s of ['role', 'text', 'testId', 'css', 'xpath'] as const) {
      const r = Locator.safeParse({ strategy: s, value: 'foo' });
      expect(r.success).toBe(true);
    }
  });

  it('rejects locator with unknown strategy', () => {
    const r = Locator.safeParse({ strategy: 'bogus', value: 'foo' });
    expect(r.success).toBe(false);
  });
});

describe('step-dsl — phase1 new kinds', () => {
  it('accepts check action', () => {
    const r = StepAction.safeParse({
      kind: 'check',
      locator: [{ strategy: 'role', value: 'checkbox[name="同意"]' }],
      checked: true,
    });
    expect(r.success).toBe(true);
  });

  it('accepts select action', () => {
    const r = StepAction.safeParse({
      kind: 'select',
      locator: [{ strategy: 'css', value: 'select' }],
      value: 'cn',
    });
    expect(r.success).toBe(true);
  });

  it('accepts upload action without fileName', () => {
    const r = StepAction.safeParse({
      kind: 'upload',
      locator: [{ strategy: 'css', value: 'input[type=file]' }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts assertJson action', () => {
    const r = StepAction.safeParse({
      kind: 'assertJson',
      locator: [{ strategy: 'css', value: 'pre' }],
      equals: { code: 0 },
    });
    expect(r.success).toBe(true);
  });

  it('accepts extract action', () => {
    const r = StepAction.safeParse({
      kind: 'extract',
      locator: [{ strategy: 'css', value: '.order-no' }],
      varName: 'orderNo',
    });
    expect(r.success).toBe(true);
  });

  it('accepts aiStep with compiled steps', () => {
    const r = StepAction.safeParse({
      kind: 'aiStep',
      instruction: '关闭弹窗',
      compiled: [{ kind: 'assertVisible', locator: [{ strategy: 'role', value: 'main' }] }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts aiStep with compiled = null', () => {
    const r = StepAction.safeParse({ kind: 'aiStep', instruction: 'x', compiled: null });
    expect(r.success).toBe(true);
  });

  it('rejects extract without varName', () => {
    const r = StepAction.safeParse({
      kind: 'extract',
      locator: [{ strategy: 'css', value: '.x' }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts fill with generator value', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: { mode: 'prefixTimestamp', prefix: '测试-' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects fill with unknown generator mode', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: { mode: 'uuid' },
    });
    expect(r.success).toBe(false);
  });

  it('accepts aiStep nested inside aiStep compiled (recursion)', () => {
    const r = StepAction.safeParse({
      kind: 'aiStep',
      instruction: '外层',
      compiled: [{ kind: 'aiStep', instruction: '内层', compiled: null }],
    });
    expect(r.success).toBe(true);
  });

  it('generator defaults materialize on parse', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#x' }],
      value: { mode: 'randomString' },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.kind === 'fill') {
      const v = r.data.value as { mode: string; length: number };
      expect(v.length).toBe(12);
    }
  });
});