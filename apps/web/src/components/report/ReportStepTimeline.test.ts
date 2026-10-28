import { describe, it, expect } from 'vitest';
import { aiUsageText, cacheHitRate, fmtTokens } from './ReportStepTimeline';
import i18n from '../../i18n';

/** 真实 i18next 的 t（回归用：占位符残留只有真插值器能复现）。 */
const t = i18n.t.bind(i18n) as Parameters<typeof aiUsageText>[0];

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

describe('aiUsageText · 无缓存数据不残留 i18n 占位符', () => {
  it('零命中 → 不出现 {{cacheHitSuffix}} 字样（i18next 对 undefined 占位符原样保留，必须给空串）', () => {
    const text = aiUsageText(t, usage({ promptTokens: 1500, completionTokens: 100 }));
    expect(text).not.toContain('{{');
    expect(text).not.toContain('缓存命中');
    expect(text).toContain('1.6k');
  });

  it('有命中 → 追加「缓存命中 N%」', () => {
    const text = aiUsageText(t, usage({ promptTokens: 100, cacheReadTokens: 900 }));
    expect(text).toContain('缓存命中 90%');
  });
});
