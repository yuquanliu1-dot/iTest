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
 * iTest status → semantic color.
 * passed/completed/ready=success, running=accent (with a pulse dot), queued/pending/review=warning, failed=destructive, the rest (draft/deprecated)=muted.
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

/** Standard light-bg status pill (mirrors the iDO StatusPill implementation); the label is passed in by the caller. */
export default function StatusPill({
  status,
  tone,
  pulse,
  children,
}: {
  status?: string;
  tone?: StatusTone;
  /** Running-like statuses get a pulsing dot before the text */
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
