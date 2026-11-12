import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../Icon';
import { paginationRange } from '../../lib/paginationRange';

/**
 * Table footer paginator: total N items + page size + page numbers + go to page N.
 *
 * Control heights are uniformly 32px — the height of the Button `md` tier. `.input-sm` is 36px and would
 * differ by 4px next to the page buttons, so select/input heights are explicitly overridden to align with the md tier.
 */
const CONTROL_H = 32;

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

interface Props {
  page: number;
  pageSize: number;
  /** Total rows under the current filter (not the current page's row count). */
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageSizeOptions?: number[];
  /** Left slot of the footer (e.g. status stats); the controls themselves stay right-aligned. */
  left?: ReactNode;
}

export default function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  left,
}: Props) {
  const { t } = useTranslation();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const [jumpInput, setJumpInput] = useState('');

  // Clear the jump box after paging/changing page size to avoid leftover input from last time.
  useEffect(() => { setJumpInput(''); }, [page, pageSize, totalPages]);

  const commitJump = () => {
    const n = Math.floor(Number(jumpInput));
    setJumpInput('');
    if (!Number.isFinite(n) || n < 1) return;
    const target = Math.min(totalPages, n);
    if (target !== page) onPageChange(target);
  };

  const navBtnCls =
    'flex items-center justify-center rounded-[var(--radius-md)] border border-[var(--border)] ' +
    'bg-[var(--card)] text-[var(--muted-foreground)] ' +
    'hover:not-disabled:bg-[var(--muted)] disabled:cursor-not-allowed ' +
    'disabled:text-[var(--muted-foreground)] disabled:opacity-60';

  return (
    <div
      className="flex shrink-0 items-center gap-3"
      style={{
        padding: '8px 20px',
        fontSize: 12,
        color: 'var(--muted-foreground)',
      }}
    >
      {left}
      <div className="flex-1" />
      <div className="flex items-center justify-end gap-3">
      <span>{t('common:paginationTotal', { count: total })}</span>

      <select
        value={pageSize}
        onChange={(e) => onPageSizeChange(Number(e.target.value))}
        aria-label={t('common:paginationPageSizeAria')}
        // CRM style: drop input-base's border + light background; darken on hover.
        className="border-0 hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        style={{ height: CONTROL_H, padding: '0 8px', fontSize: 12, borderRadius: 'var(--radius-md)', cursor: 'pointer', background: 'var(--muted)/40', backgroundColor: 'color-mix(in oklch, var(--muted) 40%, transparent)' }}
      >
        {pageSizeOptions.map((size) => (
          <option key={size} value={size}>
            {t('common:paginationPageSize', { size })}
          </option>
        ))}
      </select>

      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            aria-label={t('common:paginationPrev')}
            className={navBtnCls}
            style={{ height: CONTROL_H, width: CONTROL_H }}
          >
            <Icon name="chevronLeft" size={14} />
          </button>

          {paginationRange(page, totalPages).map((item, i) =>
            item === 'gap' ? (
              <span key={`gap-${i}`} style={{ padding: '0 2px', color: 'var(--muted-foreground)' }}>
                …
              </span>
            ) : (
              <button
                key={item}
                type="button"
                onClick={() => onPageChange(item)}
                aria-label={String(item)}
                aria-current={item === page ? 'page' : undefined}
                className={
                  item === page
                    ? 'rounded-[var(--radius-md)] font-semibold'
                    : 'rounded-[var(--radius-md)] hover:bg-[var(--muted)]'
                }
                style={{
                  height: CONTROL_H,
                  minWidth: CONTROL_H,
                  padding: '0 8px',
                  border: 'none',
                  background: item === page ? 'var(--primary)' : 'transparent',
                  color: item === page ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {item}
              </button>
            ),
          )}

          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            aria-label={t('common:paginationNext')}
            className={navBtnCls}
            style={{ height: CONTROL_H, width: CONTROL_H }}
          >
            <Icon name="chevronRight" size={14} />
          </button>
        </div>
      )}

      {totalPages > 1 && (
        <span className="flex items-center gap-1.5">
          {t('common:paginationGoTo')}
          <input
            type="text"
            inputMode="numeric"
            value={jumpInput}
            onChange={(e) => setJumpInput(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') commitJump(); }}
            onBlur={commitJump}
            aria-label={t('common:paginationJumpToPage')}
            className="border-0 hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            style={{ height: CONTROL_H, width: 48, padding: '0 4px', fontSize: 12, textAlign: 'center', borderRadius: 'var(--radius-md)', backgroundColor: 'color-mix(in oklch, var(--muted) 40%, transparent)' }}
          />
          {t('common:paginationPageUnit')}
        </span>
      )}
      </div>
    </div>
  );
}
