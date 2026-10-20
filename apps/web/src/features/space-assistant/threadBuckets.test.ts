import { describe, it, expect } from 'vitest';
import { bucketOf, groupByBucket } from './threadBuckets';

const NOW = new Date(2026, 9, 19, 15, 0, 0); // 2026-10-19 15:00 本地
const iso = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h, 0, 0).toISOString();

describe('bucketOf', () => {
  it('今天/昨天按自然日切分(非 24h 滚动)', () => {
    expect(bucketOf(iso(2026, 9, 19, 1), NOW)).toBe('today'); // 今日凌晨 1 点仍是今天
    expect(bucketOf(iso(2026, 9, 18, 23), NOW)).toBe('yesterday'); // 昨日 23 点仍算昨天
  });
  it('7 天内 / 30 天内 边界含端点', () => {
    expect(bucketOf(iso(2026, 9, 17), NOW)).toBe('week'); // 2 天前
    expect(bucketOf(iso(2026, 9, 12), NOW)).toBe('week'); // 恰好 7 天
    expect(bucketOf(iso(2026, 9, 11), NOW)).toBe('month'); // 8 天前
    expect(bucketOf(iso(2026, 8, 19), NOW)).toBe('month'); // 恰好 30 天
    expect(bucketOf(iso(2026, 8, 18), NOW)).toBe('older'); // 31 天前
  });
  it('跨月边界计数无 off-by-one', () => {
    expect(bucketOf(iso(2026, 8, 20), NOW)).toBe('month'); // 10-19 退 29 天 = 9-20,跨月减法
    expect(bucketOf(iso(2026, 8, 21), NOW)).toBe('month'); // 28 天前
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
  it('桶序固定 today→older,桶内按 updatedAt 降序,空桶不产出', () => {
    const rows = [
      { id: 'a', updatedAt: iso(2026, 9, 19, 10) }, // today
      { id: 'b', updatedAt: iso(2026, 9, 19, 14) }, // today(较新)
      { id: 'c', updatedAt: iso(2026, 9, 18, 10) }, // yesterday
      { id: 'd', updatedAt: iso(2026, 6, 1, 10) }, // older
    ];
    const g = groupByBucket(rows, NOW);
    expect(g.map((x) => x.key)).toEqual(['today', 'yesterday', 'older']);
    expect(g[0]!.items.map((x) => x.id)).toEqual(['b', 'a']); // 桶内降序
  });
  it('空数组产出空分组', () => {
    expect(groupByBucket([], NOW)).toEqual([]);
  });
});
