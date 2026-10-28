import { describe, it, expect } from 'vitest';
import { cacheHitRate, fmtTokens } from './ReportStepTimeline';

/** 与 apps/api execute/aiUsage.ts 的 AiUsageStat 对齐（缓存字段老报告缺省）。 */
function usage(over: Partial<{ promptTokens: number; completionTokens: number; cacheReadTokens?: number }>) {
  return {
    calls: 1,
    promptTokens: 0,
    completionTokens: 0,
    modelCallMs: 0,
    retries: 0,
    ...over,
  };
}

describe('cacheHitRate', () => {
  it('有缓存命中时给出百分比（命中 / (新计算 + 命中)）', () => {
    expect(cacheHitRate(usage({ promptTokens: 100, cacheReadTokens: 900 }))).toBe(90);
  });

  it('零命中返回 null（不出示命中率）', () => {
    expect(cacheHitRate(usage({ promptTokens: 100, cacheReadTokens: 0 }))).toBeNull();
  });

  it('老报告无缓存字段 → null', () => {
    expect(cacheHitRate(usage({ promptTokens: 100 }))).toBeNull();
  });

  it('分母为 0 → null（不除零）', () => {
    expect(cacheHitRate(usage({ promptTokens: 0, cacheReadTokens: 0 }))).toBeNull();
  });

  it('纯缓存命中（promptTokens=0）→ 100%', () => {
    expect(cacheHitRate(usage({ promptTokens: 0, cacheReadTokens: 500 }))).toBe(100);
  });
});

describe('fmtTokens', () => {
  it('千位缩写', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1234)).toBe('1.2k');
  });
});
