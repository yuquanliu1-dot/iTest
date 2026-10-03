import type { ReactNode } from 'react';

export interface DataTableColumn<T> {
  key: string;
  /** Header label shown in the table header row. */
  header: ReactNode;
  /** Cell render function. */
  render: (row: T, index: number) => ReactNode;
  /** Tailwind grid column track — e.g. 'minmax(28px,32px)' or '2fr'. */
  width: string;
  /** Optional explicit className for the cell container. */
  cellClassName?: string;
  /** Optional className for the header cell. */
  headerClassName?: string;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  /** Stable React key extractor. */
  rowKey: (row: T) => string;
  /** Called when a row is clicked. */
  onRowClick?: (row: T) => void;
  /** Optional row-level className. */
  rowClassName?: (row: T) => string | undefined;
  /** Container className passthrough. */
  className?: string;
  /** Optional aria-label for the table region. */
  'aria-label'?: string;
}

/** Generic header + body grid table.
 *  Header row uses background-subtle + bottom border, body rows are list-row-clickable
 *  and share the same border rhythm. The exact column track string is composed by the
 *  caller from each column's `width` so the layout matches the iTest design grid used
 *  in GroupsPage / Reports. */
export default function DataTable<T>({ columns, rows, rowKey, onRowClick, rowClassName, className = '', ...rest }: DataTableProps<T>) {
  const gridCols = `grid-cols-[${columns.map((c) => c.width).join('_')}]`;
  const clickable = !!onRowClick;
  return (
    <div className={className} role="grid" aria-label={rest['aria-label']}>
      <div
        className={`grid ${gridCols} items-center px-5 py-[10px] shrink-0 gap-2`}
        style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}
        role="row"
      >
        {columns.map((c) => (
          <span
            key={c.key}
            className={`text-[11px] font-medium uppercase tracking-[0.03em] ${c.headerClassName ?? ''}`}
            style={{ color: 'var(--color-foreground-muted)' }}
            role="columnheader"
          >
            {c.header}
          </span>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto" role="rowgroup">
        {rows.map((row, i) => (
          <div
            key={rowKey(row)}
            role="row"
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={`grid ${gridCols} items-center px-5 py-[12px] gap-2 ${clickable ? 'list-row-clickable' : ''} ${rowClassName?.(row) ?? ''}`}
            style={{ borderBottom: '1px solid var(--color-muted)' }}
          >
            {columns.map((c) => (
              <span key={c.key} className={c.cellClassName ?? ''} role="cell">
                {c.render(row, i)}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
