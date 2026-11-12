/** List bucket keys. Order is the display order. */
export const BUCKET_KEYS = ['today', 'yesterday', 'week', 'month', 'older'] as const;
export type BucketKey = (typeof BUCKET_KEYS)[number];

/** Local calendar-day midnight (not a rolling 24h) — "yesterday" must align with calendar days to match DeepSeek semantics. */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Map createdAt into one of the five buckets. Missing/invalid times fall to "older". */
export function bucketOf(createdAt: string | undefined, now: Date = new Date()): BucketKey {
  if (!createdAt) return 'older';
  const t = new Date(createdAt);
  if (Number.isNaN(t.getTime())) return 'older';
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(t)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days <= 7) return 'week';
  if (days <= 30) return 'month';
  return 'older';
}

/** Group threads by bucket, descending by createdAt within a bucket, bucket order per BUCKET_KEYS. Empty buckets produce nothing.
 *  Anchor = creation time (the list's sort key): updatedAt gets bumped by renames/new messages, old threads shouldn't float buckets because of it. */
export function groupByBucket<T extends { id: string; createdAt?: string | null }>(
  items: readonly T[],
  now: Date = new Date(),
): { key: BucketKey; items: T[] }[] {
  const byKey = new Map<BucketKey, T[]>();
  for (const it of items) {
    const k = bucketOf(it.createdAt ?? undefined, now);
    const arr = byKey.get(k);
    if (arr) arr.push(it);
    else byKey.set(k, [it]);
  }
  for (const arr of byKey.values()) {
    arr.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
  }
  return BUCKET_KEYS.filter((k) => byKey.has(k)).map((k) => ({ key: k, items: byKey.get(k)! }));
}
