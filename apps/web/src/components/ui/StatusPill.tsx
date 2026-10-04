import type { ReactNode } from 'react';

export type StatusTone = 'success' | 'accent' | 'warning' | 'destructive' | 'muted' | 'info';

const toneStyles: Record<StatusTone, { background: string; color: string }> = {
  success: { background: 'var(--success-soft)', color: 'var(--success)' },
  accent: { background: 'var(--primary-soft)', color: 'var(--primary)' },
  warning: { background: 'var(--warning-soft)', color: 'var(--warning)' },
  destructive: { background: 'var(--destructive-soft)', color: 'var(--destructive)' },
  info: { background: 'var(--info-soft)', color: 'var(--info)' },
  muted: { background: 'var(--muted)', color: 'var(--muted-foreground)' },
};

/**
 * iTest 状态 → 语义色。
 * passed/completed/ready=success，running=accent（配 pulse 点），queued/pending/review=warning，failed=destructive，其余（draft/deprecated）=muted。
 */
export function statusTone(status: string): StatusTone {
  switch (status) {
    case 'passed': case 'completed': case 'ready': case 'success': return 'success';
    case 'running': return 'accent';
    case 'queued': case 'pending': case 'review': return 'warning';
    case 'failed': case 'error': return 'destructive';
    default: return 'muted';
  }
}

/** 标准 light-bg 状态 pill（复刻 iDO StatusPill 写法）；文案由调用方传入。 */
export default function StatusPill({
  status,
  tone,
  pulse,
  children,
}: {
  status?: string;
  tone?: StatusTone;
  /** running 类状态在文字前加脉冲圆点 */
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium leading-4"
      style={{ gap: pulse ? 5 : undefined, ...(toneStyles[tone ?? (status ? statusTone(status) : 'muted')]) }}
    >
      {pulse && (
        <span
          className="status-pulse"
          style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }}
        />
      )}
      {children}
    </span>
  );
}
