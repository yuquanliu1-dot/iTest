/**
 * Unified clamping of pagination params: page ≥1 (cap 1e6), limit 1..100.
 *
 * Invalid values (NaN / negative / 0 / out of range) always fall back to the default or clamp to the boundary, no error —
 * same style as organizations.ts's `parseInt(...) || default`, but with the floor added:
 * the organizations version had no lower bound for limit/page, and page=0 made PG throw `OFFSET must not be negative`.
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
