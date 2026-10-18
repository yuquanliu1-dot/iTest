import type { ReactNode } from 'react';
import Icon, { type IconName } from '../Icon';

export default function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
  /** 卡片内的小空态（列表容器里的一行），收紧留白；整页空态保持默认的大留白。 */
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 text-center ${compact ? 'py-6' : 'py-16'}`}
      style={{ color: 'var(--muted-foreground)' }}
    >
      <Icon name={icon} size={compact ? 20 : 28} style={{ color: 'var(--muted-foreground)' }} />
      <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--muted-foreground)' }}>{title}</div>
      {description && <div style={{ fontSize: 12, maxWidth: 320 }}>{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
