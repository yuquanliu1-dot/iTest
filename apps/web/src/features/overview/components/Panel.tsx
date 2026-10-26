import type { ReactNode } from 'react';

/**
 * 工作台面板：与主体卡片同款（bg-card + border + radius-md）。
 * header 区为「标题 + 右侧副标题」两栏，副标题用 muted 小字。
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
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>
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
