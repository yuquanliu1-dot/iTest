/**
 * 分页参数统一钳制：page ≥1（上限 1e6）、limit 1..100。
 *
 * 非法值（NaN / 负数 / 0 / 超界）一律回退到默认或夹到边界，不报错——
 * 与 organizations.ts 的 `parseInt(...) || default` 同风格，但补了下限：
 * organizations 那版 limit/page 无下限，page=0 会让 PG 报 `OFFSET must not be negative`。
 */
export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_PAGE = 1_000_000;

export function parsePaging(q: Record<string, unknown>): { page: number; limit: number } {
  const rawPage = typeof q.page === 'string' ? Number.parseInt(q.page, 10) : Number.NaN;
  const rawLimit = typeof q.limit === 'string' ? Number.parseInt(q.limit, 10) : Number.NaN;
  const page = Math.min(Math.max(Number.isFinite(rawPage) ? rawPage : DEFAULT_PAGE, 1), MAX_PAGE);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT, 1), MAX_LIMIT);
  return { page, limit };
}
