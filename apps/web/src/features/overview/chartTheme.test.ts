import { describe, it, expect } from 'vitest';
import { chartColors, tooltipContentStyle } from './chartTheme';

describe('chartTheme', () => {
  it('returns all 5 chart colors', () => {
    expect(Object.keys(chartColors)).toEqual(['chart1', 'chart2', 'chart3', 'chart4', 'chart5']);
  });
  it('every color is a non-empty string starting with var(--color-chart-)', () => {
    for (const c of Object.values(chartColors)) {
      expect(typeof c).toBe('string');
      expect(c.length).toBeGreaterThan(0);
      expect(c.startsWith('var(--color-chart-')).toBe(true);
    }
  });
  it('tooltipContentStyle has background and border keys', () => {
    expect(tooltipContentStyle).toHaveProperty('background');
    expect(tooltipContentStyle).toHaveProperty('border');
    expect(tooltipContentStyle).toHaveProperty('fontSize');
  });
});
