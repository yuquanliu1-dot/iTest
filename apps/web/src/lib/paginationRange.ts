/** Ellipsis placeholder representing a collapsed span of page numbers. */
export type PageItem = number | 'gap';

/**
 * The page-number sequence a paginator should display.
 *
 * With few pages (≤7) list all; otherwise collapse into "1 … 4 5 6 … 20" — first and last pages are always present,
 * a ±1 window around the current page is kept in the middle, and each omitted contiguous span is one 'gap'.
 */
export function paginationRange(current: number, totalPages: number): PageItem[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);

  const items: PageItem[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(totalPages - 1, current + 1);

  if (start > 2) items.push('gap');
  for (let p = start; p <= end; p++) items.push(p);
  if (end < totalPages - 1) items.push('gap');
  items.push(totalPages);

  return items;
}
