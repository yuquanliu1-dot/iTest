import { describe, it, expect } from 'vitest';
import { bucketOf, groupByBucket } from './threadBuckets';

const NOW = new Date(2026, 9, 19, 15, 0, 0); // 2026-10-19 15:00 local
const iso = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h, 0, 0).toISOString();

describe('bucketOf', () => {
  it('今天/昨天按自然日切分(非 24h 滚动)', () => {
    expect(bucketOf(iso(2026, 9, 19, 1), NOW)).toBe('today'); // 1 AM today is still today
    expect(bucketOf(iso(2026, 9, 18, 23), NOW)).toBe('yesterday'); // yesterday 23:00 still counts as yesterday
  });
  it('7 天内 / 30 天内 边界含端点', () => {
    expect(bucketOf(iso(2026, 9, 17), NOW)).toBe('week'); // 2 days ago
    expect(bucketOf(iso(2026, 9, 12), NOW)).toBe('week'); // exactly 7 days
    expect(bucketOf(iso(2026, 9, 11), NOW)).toBe('month'); // 8 days ago
    expect(bucketOf(iso(2026, 8, 19), NOW)).toBe('month'); // exactly 30 days
    expect(bucketOf(iso(2026, 8, 18), NOW)).toBe('older'); // 31 days ago
  });
  it('跨月边界计数无 off-by-one', () => {
    expect(bucketOf(iso(2026, 8, 20), NOW)).toBe('month'); // 10-19 minus 29 days = 9-20, cross-month subtraction
    expect(bucketOf(iso(2026, 8, 21), NOW)).toBe('month'); // 28 days ago
  });
  it('缺失/非法时间归「更早」', () => {
    expect(bucketOf(undefined, NOW)).toBe('older');
    expect(bucketOf('not-a-date', NOW)).toBe('older');
  });
  it('未来时间(时钟漂移)不炸,归今天', () => {
    expect(bucketOf(iso(2026, 9, 20), NOW)).toBe('today');
  });
});

describe('groupByBucket', () => {
  it('桶序固定 today→older,桶内按 createdAt 降序,空桶不产出', () => {
    const rows = [
      { id: 'a', createdAt: iso(2026, 9, 19, 10) }, // today
      { id: 'b', createdAt: iso(2026, 9, 19, 14) }, // today (newer)
      { id: 'c', createdAt: iso(2026, 9, 18, 10) }, // yesterday
      { id: 'd', createdAt: iso(2026, 6, 1, 10) }, // older
    ];
    const g = groupByBucket(rows, NOW);
    expect(g.map((x) => x.key)).toEqual(['today', 'yesterday', 'older']);
    expect(g[0]!.items.map((x) => x.id)).toEqual(['b', 'a']); // descending within bucket
  });
  it('空数组产出空分组', () => {
    expect(groupByBucket([], NOW)).toEqual([]);
  });
});
