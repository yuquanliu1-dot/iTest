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
  it('LLMProviderError → LLMProviderError（不再是 Unknown）', () => {
    const e = new Error('LLM 网关返回空响应(无 content,可能被安全策略静默拦截)');
    e.name = 'LLMProviderError';
    expect(classify(e).reason).toBe('LLMProviderError');
  });
  it('LLMProviderError + durationMs>15s → 仍是 LLMProviderError，不被 SlowLoad 兜底吞掉', () => {
    // 回归动机:2026-10-13 prod228 网关缺 content 抛裸 TypeError,被 durationMs 兜底误报「页面加载过慢」。
    const e = new Error('LLM 网关返回空响应(无 content,可能被安全策略静默拦截)');
    e.name = 'LLMProviderError';
    expect(classify(e, { durationMs: 27992 }).reason).toBe('LLMProviderError');
    expect(classify(e, { durationMs: 27992 }).humanMessage).toContain('LLM');
  });
  it('durationMs > 15000 → SlowLoad（非 LLM 异常的既有兜底不受影响）', () => {
    const ctx = { durationMs: 20000 };
    expect(classify(new Error('not stable'), ctx).reason).toBe('SlowLoad');
  });
  it('sql 三类失败归类', () => {
    const mk = (name: string) => Object.assign(new Error('x'), { name });
    expect(classify(mk('SqlReadOnlyViolation'), { durationMs: 1 }).reason).toBe('SqlReadOnlyViolation');
    expect(classify(mk('SqlError'), { durationMs: 1 }).reason).toBe('SqlError');
    expect(classify(mk('SqlAssertionFailed'), { durationMs: 1 }).reason).toBe('SqlAssertionFailed');
    expect(classify(mk('SqlError'), { durationMs: 1 }).humanMessage).toMatch(/只读 SQL/);
  });
  it('EnvDbMissing 带 resource → 人话消息点名该 db', () => {
    const e = Object.assign(new Error('env-db-missing'), { name: 'EnvDbMissing', resource: 'olap' });
    expect(classify(e).reason).toBe('EnvDbMissing');
    expect(classify(e).humanMessage).toContain('olap');
  });
});