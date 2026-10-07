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

describe('initialVars（数据集列作为初始变量）', () => {
  it('初始变量不报 undefined/forwardRefs', () => {
    const report = buildVariableReport([ex('token'), fillAction('{{username}}'), fillAction('{{token}}')], ['username']);
    expect(report.undefined).toEqual([]);
    expect(report.forwardRefs).toEqual([]);
  });

  it('extract 覆盖同名列不报 duplicates（运行时后写生效，合法）', () => {
    const report = buildVariableReport([ex('username'), fillAction('{{username}}')], ['username']);
    expect(report.duplicates).toEqual([]);
  });

  it('不在初始变量里的引用仍报 undefined', () => {
    const report = buildVariableReport([fillAction('{{nope}}')], ['username']);
    expect(report.undefined).toEqual([{ stepOrder: 0, field: 'fill.value', name: 'nope' }]);
  });
});
