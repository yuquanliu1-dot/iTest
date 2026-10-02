import type { ReactNode, CSSProperties } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** 当为 true 或提供 onClick 时，应用 .hover-card 提升悬停态。 */
  hoverable?: boolean;
  onClick?: () => void;
}

const paddingMap: Record<string, string> = {
  none: '0',
  sm: '8px',
  md: '16px',
  lg: '24px',
};

export default function Card({
  children,
  className = '',
  style,
  padding = 'md',
  hoverable,
  onClick,
}: CardProps) {
  const interactive = hoverable ?? !!onClick;
  return (
    <div
      className={`${interactive ? 'hover-card ' : ''}${className}`}
      onClick={onClick}
      style={{
        background: 'var(--color-background-elevated)',
        border: '1px solid var(--color-glass-border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
        padding: paddingMap[padding],
        ...(interactive ? { cursor: 'pointer' } : {}),
        ...style,
      }}
    >
      {children}
    </div>
  );
}
