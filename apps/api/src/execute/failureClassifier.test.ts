import { describe, it, expect } from 'vitest';
import { classify } from './failureClassifier.js';

const newReasons = [
  'QueryDbError',
  'QueryDbTableNotAllowed',
  'QueryDbColumnNotAllowed',
  'QueryDbAssertionFailed',
  'EnvMissing',
  'EnvDbMissing',
  'EnvSyslogMissing',
  'SyslogConnectFailed',
  'SyslogAuthFailed',
  'SyslogFileMissing',
  'SyslogTimeout',
  'LogAssertionFailed',
] as const;

describe('classify - new failure reasons', () => {
  for (const name of newReasons) {
    it(`classifies ${name}`, () => {
      const err = Object.assign(new Error(`failure: ${name}`), { name });
      expect(classify(err).reason).toBe(name);
    });
  }
});

describe('classify - existing classification smoke', () => {
  it('classifies DisabledTimeout from ElementNotStable disabled', () => {
    const err = Object.assign(new Error('disabled'), { name: 'ElementNotStable', reason: 'disabled' });
    expect(classify(err).reason).toBe('DisabledTimeout');
  });

  it('classifies LoadingTimeout from ElementNotStable loading', () => {
    const err = Object.assign(new Error('loading'), { name: 'ElementNotStable', reason: 'loading' });
    expect(classify(err).reason).toBe('LoadingTimeout');
  });

  it('classifies OverlayTimeout from ElementNotStable overlay', () => {
    const err = Object.assign(new Error('overlay'), { name: 'ElementNotStable', reason: 'overlay' });
    expect(classify(err).reason).toBe('OverlayTimeout');
  });

  it('classifies AssertionMismatch on plain assertText failure', () => {
    const err = new Error('assertText failed');
    expect(classify(err).reason).toBe('AssertionMismatch');
  });

  it('classifies NotLoggedIn when equals contains 未登录', () => {
    const err = new Error('assertText failed');
    expect(classify(err, { action: { kind: 'assertText', equals: '请先登录' } }).reason).toBe('NotLoggedIn');
  });

  it('classifies SlowLoad when durationMs > 15000', () => {
    const err = new Error('some failure');
    expect(classify(err, { durationMs: 20000 }).reason).toBe('SlowLoad');
  });

  it('falls back to Unknown', () => {
    const err = new Error('totally unrelated');
    expect(classify(err).reason).toBe('Unknown');
  });

  it('classifies LocatorAllFailed by message', () => {
    const err = new Error('all locator candidates failed');
    expect(classify(err).reason).toBe('LocatorAllFailed');
  });
});
