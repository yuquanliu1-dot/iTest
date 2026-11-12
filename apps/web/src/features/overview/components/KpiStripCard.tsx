import { useNavigate } from 'react-router-dom';
import Icon from '../../../components/Icon';

export interface KpiStripCardProps {
  label: string;
  value: number | string;
  iconName: string;
  to: string;
  suffix?: string;
  /** Footnote below the card's bottom divider (e.g. "214 steps pending solidify") */
  footLabel?: string;
}

/**
 * KPI card: icon chip + large value + optional footnote row.
 * The icon chip is uniformly neutral bg/color — color is reserved for verdicts (pass/fail); the metric card itself takes no stance.
 * Value typography matches the main body (semibold + tabular-nums); the footnote is separated by a hairline.
 */
export default function KpiStripCard({ label, value, iconName, to, suffix, footLabel }: KpiStripCardProps) {
  const navigate = useNavigate();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(to)}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate(to); }}
      data-stagger-item
      className="bg-card border rounded-[var(--radius-md)] p-4 cursor-pointer hover-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <span className="flex items-center gap-2">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-md"
          style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
        >
          <Icon name={iconName as 'beaker'} size={16} />
        </span>
        <span className="truncate text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          {label}
        </span>
      </span>
      <div className="mt-3">
        <Value value={value} suffix={suffix} />
      </div>
      {footLabel != null && (
        <div
          className="mt-3 truncate border-t pt-2 text-[12px]"
          style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
        >
          {footLabel}
        </div>
      )}
    </div>
  );
}

/** Metric value: tabular numbers + optional percent suffix */
function Value({ value, suffix }: { value: number | string; suffix?: string }) {
  return (
    <span
      className="flex items-baseline gap-1 whitespace-nowrap font-semibold tabular-nums"
      style={{ fontSize: 24, lineHeight: 1, color: 'var(--foreground)' }}
    >
      {value}
      {suffix && (
        <span className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
          {suffix}
        </span>
      )}
    </span>
  );
}
