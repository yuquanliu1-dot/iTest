/**
 * 图表序列色与语义色集中导出,所有 recharts 组件必须从这里取色。
 * 颜色全部来自 design token(--chart-1..5),不在 TSX 写 hex。
 */
export const chartColors = {
  chart1: 'var(--chart-1)',
  chart2: 'var(--chart-2)',
  chart3: 'var(--chart-3)',
  chart4: 'var(--chart-4)',
  chart5: 'var(--chart-5)',
  chart1Soft: 'var(--chart-1-soft)',
  chart2Soft: 'var(--chart-2-soft)',
  chart3Soft: 'var(--chart-3-soft)',
  chart4Soft: 'var(--chart-4-soft)',
  chart5Soft: 'var(--chart-5-soft)',
  success: 'var(--success)',
  destructive: 'var(--destructive)',
  accent: 'var(--primary)',
  foregroundMuted: 'var(--muted-foreground)',
  foregroundSecondary: 'var(--muted-foreground)',
  foreground: 'var(--foreground)',
  border: 'var(--border)',
  /** 中性序列色:只表示"有/无"这类事实,不承载判定语义 */
  neutral: 'var(--muted-foreground)',
} as const;

/**
 * RCA 根因分类配色。与主体 RCA 徽章(RcaBlock.tsx)同源:
 * 系统缺陷红 / 环境黄 / 用例问题与其他灰。
 * 概览页的分布图与计划表徽标共用这一份,避免两处各写一套后漂移。
 */
export const RCA_CATEGORY_COLOR: Record<string, string> = {
  system_defect: 'var(--destructive)',
  environment: 'var(--warning)',
  case_issue: 'var(--muted-foreground)',
  other: 'var(--muted-foreground)',
};

export const RCA_CATEGORY_BG: Record<string, string> = {
  system_defect: 'var(--destructive-soft)',
  environment: 'var(--warning-soft)',
  case_issue: 'var(--muted)',
  other: 'var(--muted)',
};

/** recharts 通用 Tooltip 样式(由 chart 派生 ctx 组件使用)。 */
export const tooltipContentStyle = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--foreground)',
} as const;
