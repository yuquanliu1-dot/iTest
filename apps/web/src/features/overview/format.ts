/** Workbench number/duration formatting (pure functions, easy to unit test). */

/** ms → "12m18s" / "42s"; null/undefined → '—' */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

/** 0..1 → "86.4" (one decimal place); non-finite input → 0 */
export function formatPct(rate: number): string {
  if (!Number.isFinite(rate)) return '0';
  return (rate * 100).toFixed(1).replace(/\.0$/, '');
}
