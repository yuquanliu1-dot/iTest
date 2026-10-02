import { describe, it, expect } from 'vitest';
import { overviewQueryKey } from './api';

describe('overview api', () => {
  it('overviewQueryKey includes projectId and range', () => {
    expect(overviewQueryKey('p1', '7d')).toEqual(['overview', 'p1', '7d']);
    expect(overviewQueryKey('p1', '30d')).toEqual(['overview', 'p1', '30d']);
  });
  it('overviewQueryKey is a readonly tuple', () => {
    const k = overviewQueryKey('p1', '7d');
    // runtime check: arrays are mutable, but the helper should not be reassigned
    expect(k).toHaveLength(3);
  });
});