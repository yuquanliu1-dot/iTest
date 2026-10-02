import { useNavigate } from 'react-router-dom';
import Icon from '../../../components/Icon';

export interface KpiStripCardProps {
  label: string;
  value: number | string;
  iconName: string;
  tone: string;
  to: string;
  suffix?: string;
}

export default function KpiStripCard({ label, value, iconName, tone, to, suffix }: KpiStripCardProps) {
  const navigate = useNavigate();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(to)}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate(to); }}
      data-stagger-item
      className="glass-panel rounded-[12px] p-5 cursor-pointer hover-card"
      style={{ minHeight: 92 }}
    >
      <div className="flex items-center justify-between">
        <span style={{ fontSize: 12, color: 'var(--color-foreground-secondary)' }}>{label}</span>
        <span className="kpi-icon" style={{ color: tone, display: 'inline-flex' }}>
          <Icon name={iconName as 'beaker'} size={14} />
        </span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, marginTop: 8, color: tone, lineHeight: 1 }}>
        {value}
        {suffix && <span style={{ fontSize: 14, fontWeight: 500, marginLeft: 4 }}>{suffix}</span>}
      </div>
    </div>
  );
}
