import { useState, type ReactNode } from 'react';
import Icon from '../Icon';

/** Collapsible panel: the title row is always visible (chevron + label); the content area can collapse. Expanded by default.
 *  The right rail uses it to collapse "live view" / "staged objects" independently of each other.
 *  divider=false removes the bottom divider — pass false for the last panel in a column, otherwise it draws a meaningless line across blank space. */
export default function CollapsiblePanel({
  title,
  defaultOpen = true,
  divider = true,
  children,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  divider?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className="flex flex-col min-h-0"
      style={divider ? { borderBottom: '1px solid var(--border)' } : undefined}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="btn-tint flex w-full shrink-0 items-center gap-1.5 px-4 py-2.5 text-left text-[12px] font-medium hover:text-[var(--foreground)]"
        style={{ color: 'var(--muted-foreground)' }}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} style={{ flexShrink: 0 }} />
        {title}
      </button>
      {open && <div className="flex flex-col flex-1 min-h-0">{children}</div>}
    </div>
  );
}