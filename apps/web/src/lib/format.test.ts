import { describe, it, expect } from 'vitest';
import { caseStatusLabel } from './format';

describe('caseStatusLabel', () => {
  it('四态中文映射', () => {
    expect(caseStatusLabel('draft')).toBe('草稿');
    expect(caseStatusLabel('review')).toBe('评审中');
    expect(caseStatusLabel('ready')).toBe('就绪');
    expect(caseStatusLabel('deprecated')).toBe('废弃');
  });

  it('未知值回退原文', () => {
    expect(caseStatusLabel('weird')).toBe('weird');
  });
});
