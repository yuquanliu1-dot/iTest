import { describe, it, expect } from 'vitest';
import { classify } from '../src/execute/failureClassifier.js';

describe('failureClassifier', () => {
  it('ElementNotStable/disabled → DisabledTimeout', () => {
    const e = new Error('not stable'); (e as Error & { name: string; reason: string }).name = 'ElementNotStable';
    (e as Error & { name: string; reason: string }).reason = 'disabled';
    expect(classify(e).reason).toBe('DisabledTimeout');
  });
  it('tab-missing → TabMissing', () => {
    expect(classify(new Error('tab-missing: foo')).reason).toBe('TabMissing');
  });
  it('assertText failed → AssertionMismatch', () => {
    expect(classify(new Error('assertText failed (page/contains): expected 1, actual 2')).reason).toBe('AssertionMismatch');
  });
  it('attachment-missing → AttachmentMissing', () => {
    expect(classify(new Error('attachment-missing: x')).reason).toBe('AttachmentMissing');
  });
  it('secret-missing → SecretMissing', () => {
    expect(classify(new Error('secret-missing: step 1')).reason).toBe('SecretMissing');
  });
  it('locator all-failed → LocatorAllFailed', () => {
    expect(classify(new Error('all locator candidates failed')).reason).toBe('LocatorAllFailed');
  });
  it('count=0 → LocatorAllFailed', () => {
    expect(classify(new Error('count=0 (css)')).reason).toBe('LocatorAllFailed');
  });
  it('default → Unknown', () => {
    expect(classify(new Error('whatever')).reason).toBe('Unknown');
  });
  it('assertText failed + defaultKeywords → NotLoggedIn', () => {
    const ctx = { action: { kind: 'assertText', equals: '请先登录' } };
    expect(classify(new Error('assertText failed: expected "ok"'), ctx).reason).toBe('NotLoggedIn');
  });
  it('fill + duplicate key message → FixedValueConflict', () => {
    const ctx = { action: { kind: 'fill', value: 'x' } };
    expect(classify(new Error('unique constraint violation: duplicate key'), ctx).reason).toBe('FixedValueConflict');
  });
  it('durationMs > 15000 → SlowLoad', () => {
    const ctx = { durationMs: 20000 };
    expect(classify(new Error('not stable'), ctx).reason).toBe('SlowLoad');
  });
});