/**
 * Central export of chart series and semantic colors; every recharts component must take colors from here.
 * All colors come from design tokens (--chart-1..5); no hex literals in TSX.
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
  /** Neutral series color: expresses only "present/absent" facts, carries no verdict semantics */
  neutral: 'var(--muted-foreground)',
} as const;

/**
 * RCA root-cause category colors. Same source as the main RCA badge (RcaBlock.tsx):
 * system defect red / environment yellow / case issue and other gray.
 * The overview distribution chart and plan table badges share this one table so the two don't drift apart.
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

/** Shared recharts tooltip styling (used by chart-derived ctx components). */
export const tooltipContentStyle = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--foreground)',
} as const;
