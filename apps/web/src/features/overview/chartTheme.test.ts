import { describe, it, expect } from 'vitest';
import { chartColors, tooltipContentStyle } from './chartTheme';

describe('chartTheme', () => {
  it('exposes the 5 main chart colors', () => {
    for (const key of ['chart1', 'chart2', 'chart3', 'chart4', 'chart5']) {
      expect(chartColors[key as keyof typeof chartColors]).toMatch(/^var\(--color-chart-[1-5]\)$/);
    }
  });

  it('exposes 5 soft alpha variants', () => {
    for (const key of ['chart1Soft', 'chart2Soft', 'chart3Soft', 'chart4Soft', 'chart5Soft']) {
      expect(chartColors[key as keyof typeof chartColors]).toMatch(/^var\(--color-chart-[1-5]-soft\)$/);
    }
  });

  it('exposes semantic tokens that reference foreground/border/status variables', () => {
    expect(chartColors.success).toBe('var(--color-success)');
    expect(chartColors.destructive).toBe('var(--color-destructive)');
    expect(chartColors.accent).toBe('var(--color-accent)');
    expect(chartColors.foreground).toBe('var(--color-foreground)');
    expect(chartColors.foregroundSecondary).toBe('var(--color-foreground-secondary)');
    expect(chartColors.foregroundMuted).toBe('var(--color-foreground-muted)');
    expect(chartColors.border).toBe('var(--color-border)');
  });

  it('tooltipContentStyle has the expected shape', () => {
    expect(tooltipContentStyle).toMatchObject({
      background: 'var(--color-surface-overlay)',
      border: '1px solid var(--color-border)',
      borderRadius: 8,
      fontSize: 12,
      color: 'var(--color-foreground)',
    });
  });
});
