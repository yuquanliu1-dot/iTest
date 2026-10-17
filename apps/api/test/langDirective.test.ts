import { describe, it, expect } from 'vitest';
import { langDirective, aiLangFrom } from '../src/agent/langDirective.js';

describe('langDirective', () => {
  it('en/zh 指令块都包含定位文本分离规则', () => {
    for (const lang of ['en-US', 'zh-CN'] as const) {
      const d = langDirective(lang);
      expect(d).toContain(lang);
      expect(d).toContain('NEVER translate');
      expect(d).toContain('page snapshot');
      expect(d).toContain('output language rules');
    }
  });
});

describe('aiLangFrom', () => {
  it('未知/缺失回落 zh-CN', () => {
    expect(aiLangFrom('en-US')).toBe('en-US');
    expect(aiLangFrom('ja-JP')).toBe('zh-CN');
    expect(aiLangFrom(null)).toBe('zh-CN');
    expect(aiLangFrom(undefined)).toBe('zh-CN');
  });
});