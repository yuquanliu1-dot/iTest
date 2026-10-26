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
 * KPI 卡：软色图标章 + 前景色大数值 + 可选脚注行。
 * tone 传语义 var（如 var(--success)），图标章底色用 color-mix 派生。
 * 数值排版与主体一致（semibold + tabular-nums），脚注以 hairline 分隔。
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
      className="bg-card border rounded-[var(--radius-md)] p-4 cursor-pointer hover-card"
      style={{ minHeight: 104 }}
    >
      <div className="flex items-center gap-2">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-md"
          style={{
            background: `color-mix(in oklch, ${tone} 13%, transparent)`,
            color: tone,
          }}
        >
          <Icon name={iconName as 'beaker'} size={14} />
        </span>
        <span className="truncate text-[12.5px]" style={{ color: 'var(--muted-foreground)' }}>
          {label}
        </span>
      </div>
      <div
        className="mt-3 flex items-baseline gap-1.5 whitespace-nowrap font-semibold tabular-nums"
        style={{ fontSize: 24, lineHeight: 1, color: 'var(--foreground)' }}
      >
        {value}
        {suffix && (
          <span className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
            {suffix}
          </span>
        )}
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
