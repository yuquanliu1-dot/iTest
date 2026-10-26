// apps/web/src/lib/solidifyProgress.test.ts
import { describe, it, expect } from 'vitest';
import {
  batchProgressPercent,
  isSolidifyRunning,
  runningCaseIds,
  type SolidifyBatchRef,
} from './solidifyProgress';

describe('isSolidifyRunning', () => {
  it('在途状态（queued/solidifying/verifying）为 true', () => {
    expect(isSolidifyRunning('queued')).toBe(true);
    expect(isSolidifyRunning('solidifying')).toBe(true);
    expect(isSolidifyRunning('verifying')).toBe(true);
  });

  it('终态（passed / 各 _failed）为 false', () => {
    expect(isSolidifyRunning('passed')).toBe(false);
    expect(isSolidifyRunning('solidify_failed')).toBe(false);
    expect(isSolidifyRunning('materialize_failed')).toBe(false);
    expect(isSolidifyRunning('verify_failed')).toBe(false);
  });
});

describe('runningCaseIds', () => {
  it('只收在途行的 caseId；同批次已终态的行不标', () => {
    const batches: SolidifyBatchRef[] = [
      {
        total: 3,
        passed: 1,
        failed: 0,
        running: 2,
        cases: [
          { caseId: 'c1', status: 'passed' },
          { caseId: 'c2', status: 'solidifying' },
          { caseId: 'c3', status: 'verifying' },
        ],
      },
    ];
    expect([...runningCaseIds(batches)].sort()).toEqual(['c2', 'c3']);
  });

  it('多个批次合并；空输入返回空集', () => {
    const batches: SolidifyBatchRef[] = [
      { total: 1, passed: 0, failed: 0, running: 1, cases: [{ caseId: 'a', status: 'queued' }] },
      { total: 1, passed: 0, failed: 0, running: 1, cases: [{ caseId: 'b', status: 'solidifying' }] },
    ];
    expect([...runningCaseIds(batches)].sort()).toEqual(['a', 'b']);
    expect(runningCaseIds([]).size).toBe(0);
  });
});

describe('batchProgressPercent', () => {
  it('分子 = 已出终态的行（passed + failed），在途行不计入', () => {
    expect(batchProgressPercent({ total: 4, passed: 1, failed: 1, running: 2, cases: [] })).toBe(50);
  });

  it('全部完成 → 100%；total 为 0 → 0%', () => {
    expect(batchProgressPercent({ total: 2, passed: 2, failed: 0, running: 0, cases: [] })).toBe(100);
    expect(batchProgressPercent({ total: 0, passed: 0, failed: 0, running: 0, cases: [] })).toBe(0);
  });
});
