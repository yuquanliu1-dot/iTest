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