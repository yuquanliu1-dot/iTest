import { describe, it, expect } from 'vitest';
import { caseStatusLabel } from './format';

describe('caseStatusLabel', () => {
  it('四态状态 i18n key 映射', () => {
    expect(caseStatusLabel('draft')).toBe('cases:status.draft');
    expect(caseStatusLabel('review')).toBe('cases:status.review');
    expect(caseStatusLabel('ready')).toBe('cases:status.ready');
    expect(caseStatusLabel('deprecated')).toBe('cases:status.deprecated');
  });

  it('未知值回退原文', () => {
    expect(caseStatusLabel('weird')).toBe('weird');
  });
});
