/**
 * 图表序列色与语义色集中导出,所有 recharts 组件必须从这里取色。
 * 颜色全部来自 design token(--color-chart-1..5),不在 TSX 写 hex。
 */
export const chartColors = {
  chart1: 'var(--color-chart-1)',
  chart2: 'var(--color-chart-2)',
  chart3: 'var(--color-chart-3)',
  chart4: 'var(--color-chart-4)',
  chart5: 'var(--color-chart-5)',
  chart1Soft: 'var(--color-chart-1-soft)',
  chart2Soft: 'var(--color-chart-2-soft)',
  chart3Soft: 'var(--color-chart-3-soft)',
  chart4Soft: 'var(--color-chart-4-soft)',
  chart5Soft: 'var(--color-chart-5-soft)',
  success: 'var(--color-success)',
  destructive: 'var(--color-destructive)',
  accent: 'var(--color-accent)',
  foregroundMuted: 'var(--color-foreground-muted)',
  foregroundSecondary: 'var(--color-foreground-secondary)',
  foreground: 'var(--color-foreground)',
  border: 'var(--color-border)',
} as const;

/** recharts 通用 Tooltip 样式(由 chart 派生 ctx 组件使用)。 */
export const tooltipContentStyle = {
  background: 'var(--color-surface-overlay)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--color-foreground)',
} as const;
