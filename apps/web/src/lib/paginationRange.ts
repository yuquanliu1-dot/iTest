/** 省略号占位，代表被折叠的一段页码。 */
export type PageItem = number | 'gap';

/**
 * 分页器要显示的页码序列。
 *
 * 页数少（≤7）时全列；多了就收成「1 … 4 5 6 … 20」——首尾页恒在，
 * 中间保留当前页 ±1 的窗口，被省略的连续区间用一个 'gap' 表示。
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
