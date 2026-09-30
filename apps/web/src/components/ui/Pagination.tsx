import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Icon from '../Icon';
import { paginationRange } from '../../lib/paginationRange';

/**
 * 表格页脚分页器：共 N 条 + 每页条数 + 页码 + 前往第 N 页。
 *
 * 控件高度统一取 32px —— Button `md` 档的高度。`.input-sm` 是 36px，与页码按钮
 * 并排会差 4px，故这里显式覆盖 select/input 的高度对齐到 md 档。
 */
const CONTROL_H = 32;

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

interface Props {
  page: number;
  pageSize: number;
  /** 当前筛选条件下的总行数（不是当前页行数）。 */
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageSizeOptions?: number[];
  /** 页脚左侧插槽（如状态统计）；不传则保持原有右对齐布局。 */
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
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const [jumpInput, setJumpInput] = useState('');

  // 翻页/改每页条数后把跳页框清空，避免残留上一次的输入。
  useEffect(() => { setJumpInput(''); }, [page, pageSize, totalPages]);

  const commitJump = () => {
    const n = Math.floor(Number(jumpInput));
    setJumpInput('');
    if (!Number.isFinite(n) || n < 1) return;
    const target = Math.min(totalPages, n);
    if (target !== page) onPageChange(target);
  };

  const navBtnCls =
    'flex items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] ' +
    'bg-[var(--color-background-elevated)] text-[var(--color-foreground-secondary)] ' +
    'hover:not-disabled:bg-[var(--color-muted)] disabled:cursor-not-allowed ' +
    'disabled:text-[var(--color-foreground-disabled)] disabled:opacity-60';

  return (
    <div
      className="flex shrink-0 items-center gap-3"
      style={{
        padding: '8px 20px',
        borderTop: '1px solid var(--color-border)',
        fontSize: 12,
        color: 'var(--color-foreground-secondary)',
      }}
    >
      {left ? (
        <>
          {left}
          <div className="flex-1" />
        </>
      ) : null}
      <div className="flex items-center justify-end gap-3">
      <span>共 {total} 条</span>

      <select
        value={pageSize}
        onChange={(e) => onPageSizeChange(Number(e.target.value))}
        aria-label="每页条数"
        className="input-base input-inline"
        style={{ height: CONTROL_H, padding: '0 8px', fontSize: 12, borderRadius: 'var(--radius-md)', cursor: 'pointer' }}
      >
        {pageSizeOptions.map((size) => (
          <option key={size} value={size}>
            {size} 条/页
          </option>
        ))}
      </select>

      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            aria-label="上一页"
            className={navBtnCls}
            style={{ height: CONTROL_H, width: CONTROL_H }}
          >
            <Icon name="chevronLeft" size={14} />
          </button>

          {paginationRange(page, totalPages).map((item, i) =>
            item === 'gap' ? (
              <span key={`gap-${i}`} style={{ padding: '0 2px', color: 'var(--color-foreground-disabled)' }}>
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
                    : 'rounded-[var(--radius-md)] hover:bg-[var(--color-muted)]'
                }
                style={{
                  height: CONTROL_H,
                  minWidth: CONTROL_H,
                  padding: '0 8px',
                  border: 'none',
                  background: item === page ? 'var(--color-accent)' : 'transparent',
                  color: item === page ? 'var(--color-accent-foreground)' : 'var(--color-foreground-secondary)',
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
            aria-label="下一页"
            className={navBtnCls}
            style={{ height: CONTROL_H, width: CONTROL_H }}
          >
            <Icon name="chevronRight" size={14} />
          </button>
        </div>
      )}

      {totalPages > 1 && (
        <span className="flex items-center gap-1.5">
          前往
          <input
            type="text"
            inputMode="numeric"
            value={jumpInput}
            onChange={(e) => setJumpInput(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') commitJump(); }}
            onBlur={commitJump}
            aria-label="跳转到页"
            className="input-base"
            style={{ height: CONTROL_H, width: 48, padding: '0 4px', fontSize: 12, textAlign: 'center', borderRadius: 'var(--radius-md)' }}
          />
          页
        </span>
      )}
      </div>
    </div>
  );
}
