import { describe, it, expect } from 'vitest';
import { StepAction } from '@itest/shared';

describe('sql 动作 DSL', () => {
  it('解析最小形态并给默认', () => {
    const a = StepAction.parse({ kind: 'sql', sql: 'SELECT 1' });
    expect(a).toMatchObject({ kind: 'sql', params: [], limit: 50 });
    expect(a.kind === 'sql' ? a.dbRef : 'x').toBeUndefined();
  });

  it('带 dbRef / params / assertion', () => {
    const a = StepAction.parse({
      kind: 'sql', dbRef: 'olap', sql: 'SELECT * FROM dw.t WHERE id = ?', params: ['u1'], limit: 10,
      assertion: { match: 'contains', expected: 'x' },
    });
    expect(a).toMatchObject({ kind: 'sql', dbRef: 'olap', params: ['u1'], limit: 10 });
  });

  it('拒绝空 sql / 超长 sql / dbRef 超长', () => {
    expect(() => StepAction.parse({ kind: 'sql', sql: '' })).toThrow();
    expect(() => StepAction.parse({ kind: 'sql', sql: 'x'.repeat(9000) })).toThrow();
    expect(() => StepAction.parse({ kind: 'sql', sql: 'SELECT 1', dbRef: 'x'.repeat(65) })).toThrow();
  });

  it('既有 queryDb 语义不变', () => {
    const a = StepAction.parse({ kind: 'queryDb', table: 'test_cases' });
    expect(a).toMatchObject({ kind: 'queryDb', table: 'test_cases', limit: 50, columns: [] });
    expect(() => StepAction.parse({ kind: 'queryDb', table: 'not_a_table' })).toThrow();
  });
});
