import { useNavigate } from 'react-router-dom';
import Icon from '../../../components/Icon';

export interface KpiStripCardProps {
  label: string;
  value: number | string;
  iconName: string;
  tone: string;
  to: string;
  suffix?: string;
  /** 卡底分隔线下的脚注（如「待固化 214 步」） */
  footLabel?: string;
}

/**
 * KPI 卡（工作台深色版）：软色图标章 + 前景色大数值 + 可选脚注行。
 * tone 传语义 var（如 var(--success)），图标章底色用 color-mix 派生。
 */
export default function KpiStripCard({
  label,
  value,
  iconName,
  tone,
  to,
  suffix,
  footLabel,
}: KpiStripCardProps) {
  const navigate = useNavigate();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(to)}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate(to); }}
      data-stagger-item
      className="bg-card border border-[var(--border)] rounded-[var(--radius-md)] p-4 cursor-pointer hover-card"
      style={{ minHeight: 108 }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
          style={{
            background: `color-mix(in oklch, ${tone} 13%, transparent)`,
            color: tone,
            display: 'inline-flex',
          }}
        >
          <Icon name={iconName as 'beaker'} size={14} />
        </span>
        <span
          className="truncate text-[12.5px]"
          style={{ color: 'var(--muted-foreground)' }}
        >
          {label}
        </span>
      </div>
      <div
        style={{
          fontSize: 26,
          fontWeight: 700,
          marginTop: 12,
          color: 'var(--foreground)',
          lineHeight: 1,
          whiteSpace: 'nowrap',
        }}
      >
        {value}
        {suffix && (
          <span style={{ fontSize: 12.5, fontWeight: 500, marginLeft: 5, color: 'var(--muted-foreground)' }}>
            {suffix}
          </span>
        )}
      </div>
      {footLabel != null && (
        <div
          className="mt-3 truncate pt-2.5 text-[12px]"
          style={{ borderTop: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
        >
          {footLabel}
        </div>
      )}
    </div>
  );
}
