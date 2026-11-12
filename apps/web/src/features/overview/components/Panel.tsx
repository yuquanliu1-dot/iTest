import type { ReactNode } from 'react';

/**
 * Workbench panel: same styling as the main cards (bg-card + border + radius-md).
 * The header area is a two-column "title + right-side subtitle" layout, with the subtitle in small muted text.
 * Title hierarchy comes from font size and color, not bolding: 14px / 500, foreground color.
 */
export function Panel({
  title,
  subtitle,
  children,
  className = '',
  bodyClassName = '',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`bg-card border rounded-[var(--radius-md)] p-4 ${className}`}>
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h3 className="text-[14px] font-medium" style={{ color: 'var(--foreground)' }}>
          {title}
        </h3>
        {subtitle != null && (
          <span className="shrink-0 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            {subtitle}
          </span>
        )}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
