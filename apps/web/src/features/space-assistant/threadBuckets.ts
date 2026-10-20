/** 列表分组键。顺序即展示顺序。 */
export const BUCKET_KEYS = ['today', 'yesterday', 'week', 'month', 'older'] as const;
export type BucketKey = (typeof BUCKET_KEYS)[number];

/** 本地自然日零点(非 24h 滚动)——「昨天」须与日历日对齐,才符合 DeepSeek 语义。 */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 按 updatedAt 落到五段之一。缺失/非法时间归「更早」。 */
export function bucketOf(updatedAt: string | undefined, now: Date = new Date()): BucketKey {
  if (!updatedAt) return 'older';
  const t = new Date(updatedAt);
  if (Number.isNaN(t.getTime())) return 'older';
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(t)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days <= 7) return 'week';
  if (days <= 30) return 'month';
  return 'older';
}

/** 把线程按桶分组,桶内按 updatedAt 降序,桶序按 BUCKET_KEYS。空桶不产出。 */
export function groupByBucket<T extends { id: string; updatedAt?: string | null }>(
  items: readonly T[],
  now: Date = new Date(),
): { key: BucketKey; items: T[] }[] {
  const byKey = new Map<BucketKey, T[]>();
  for (const it of items) {
    const k = bucketOf(it.updatedAt ?? undefined, now);
    const arr = byKey.get(k);
    if (arr) arr.push(it);
    else byKey.set(k, [it]);
  }
  for (const arr of byKey.values()) {
    arr.sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime());
  }
  return BUCKET_KEYS.filter((k) => byKey.has(k)).map((k) => ({ key: k, items: byKey.get(k)! }));
}
