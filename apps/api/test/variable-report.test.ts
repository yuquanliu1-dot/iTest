import { describe, it, expect } from 'vitest';
import { buildVariableReport } from '../src/lib/variable-report.js';
import type { StepAction } from '@itest/shared';

const fillAction = (value: string): StepAction => ({
  kind: 'fill',
  locator: [{ strategy: 'css', value: '#x' }],
  value,
});

const ex = (varName: string, mode: 'completeValue' | 'regex' = 'completeValue', pattern?: string): StepAction => ({
  kind: 'extract',
  locator: [{ strategy: 'css', value: 'a' }],
  varName,
  mode,
  ...(pattern ? { pattern } : {}),
});

describe('buildVariableReport', () => {
  it('flags undefined var reference', () => {
    const report = buildVariableReport([fillAction('订单{{orderNo}}')]);
    expect(report.undefined).toEqual([{ stepOrder: 0, field: 'fill.value', name: 'orderNo' }]);
  });

  it('flags duplicate extract varName', () => {
    const report = buildVariableReport([ex('a'), ex('a')]);
    expect(report.duplicates).toEqual([{ name: 'a', definedAt: [0, 1] }]);
  });

  it('flags forward ref', () => {
    const report = buildVariableReport([
      fillAction('{{x}}'),
      fillAction('{{y}}'),
      ex('x'),
      ex('y'),
    ]);
    expect(report.forwardRefs).toEqual([
      { stepOrder: 0, field: 'fill.value', name: 'x' },
      { stepOrder: 1, field: 'fill.value', name: 'y' },
    ]);
    expect(report.undefined).toEqual([]);
  });

  it('flags regex issues for extract regex mode', () => {
    const report = buildVariableReport([
      { kind: 'extract', locator: [{ strategy: 'css', value: 'a' }], varName: 'x', mode: 'regex', pattern: '(a+)+' },
    ]);
    expect(report.regexIssues).toHaveLength(1);
    expect(report.regexIssues[0]!.stepOrder).toBe(0);
  });

  it('clean report when all vars defined first', () => {
    const report = buildVariableReport([ex('x'), fillAction('{{x}}')]);
    expect(report.undefined).toEqual([]);
    expect(report.duplicates).toEqual([]);
    expect(report.forwardRefs).toEqual([]);
    expect(report.regexIssues).toEqual([]);
    expect(report.invalidNames).toEqual([]);
  });

  it('flags invalid extract varName', () => {
    const report = buildVariableReport([
      { kind: 'extract', locator: [{ strategy: 'css', value: 'a' }], varName: '1bad', mode: 'completeValue' },
    ]);
    expect(report.invalidNames).toHaveLength(1);
    expect(report.invalidNames[0]!.stepOrder).toBe(0);
  });
});
