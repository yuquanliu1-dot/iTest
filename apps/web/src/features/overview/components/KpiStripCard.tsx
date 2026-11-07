import { useNavigate } from 'react-router-dom';
import Icon from '../../../components/Icon';

export interface KpiStripCardProps {
  label: string;
  value: number | string;
  iconName: string;
  to: string;
  suffix?: string;
  /** 卡底分隔线下的脚注（如「待固化 214 步」） */
  footLabel?: string;
}

/**
 * KPI 卡：图标章 + 大数值 + 可选脚注行。
 * 图标章统一中性底/中性色 —— 彩色留给判定（通过/失败），指标卡本身不表态。
 * 数值排版与主体一致（semibold + tabular-nums），脚注以 hairline 分隔。
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

/** 指标数值：等宽数字 + 可选百分号后缀 */
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
