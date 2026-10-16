import { useState, type ReactNode } from 'react';
import Icon from '../Icon';

/** 可折叠区块：标题行常驻（chevron + 文案），内容区可收起。默认展开。
 *  右侧栏用它把「实时画面」/「暂存对象」两块独立折叠，互不影响。
 *  divider=false 去掉底部分隔线——列内最后一个区块传 false，否则会在空白区拉一道无意义的横线。 */
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
        className="flex w-full shrink-0 items-center gap-1.5 px-4 py-2.5 text-left text-[12px] font-medium"
        style={{ color: 'var(--muted-foreground)' }}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} style={{ flexShrink: 0 }} />
        {title}
      </button>
      {open && <div className="flex-1 min-h-0">{children}</div>}
    </div>
  );
}