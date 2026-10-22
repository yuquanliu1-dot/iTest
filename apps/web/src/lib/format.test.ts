import { describe, it, expect } from 'vitest';
import { caseStatusLabel, clockTime } from './format';

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

describe('clockTime', () => {
  it('输出本机时区的 HH:MM:SS（补零）', () => {
    const d = new Date(2026, 0, 2, 9, 5, 7);
    expect(clockTime(d.toISOString())).toBe('09:05:07');
  });

  it('非法输入不抛，回退占位符', () => {
    expect(clockTime('not-a-date')).toBe('—');
  });
});
