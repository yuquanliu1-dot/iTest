import { describe, it, expect } from 'vitest';
import { statusTone } from './StatusPill';

describe('statusTone', () => {
  it('用例四态配色', () => {
    expect(statusTone('draft')).toBe('muted');
    expect(statusTone('review')).toBe('warning');
    expect(statusTone('ready')).toBe('success');
    expect(statusTone('deprecated')).toBe('muted');
  });

  it('既有映射不回归', () => {
    expect(statusTone('passed')).toBe('success');
    expect(statusTone('running')).toBe('accent');
    expect(statusTone('failed')).toBe('destructive');
  });
});
