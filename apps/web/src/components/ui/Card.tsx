import type { ReactNode, CSSProperties } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** When true or onClick is provided, applies .hover-card to elevate the hover state. */
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
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: paddingMap[padding],
        ...(interactive ? { cursor: 'pointer' } : {}),
        ...style,
      }}
    >
      {children}
    </div>
  );
}
