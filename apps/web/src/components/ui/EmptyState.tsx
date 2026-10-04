import type { ReactNode } from 'react';
import Icon, { type IconName } from '../Icon';

export default function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 py-16 text-center"
      style={{ color: 'var(--muted-foreground)' }}
    >
      <Icon name={icon} size={28} style={{ color: 'var(--muted-foreground)' }} />
      <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--muted-foreground)' }}>{title}</div>
      {description && <div style={{ fontSize: 12, maxWidth: 320 }}>{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
