/**
 * Compiled-step normalizer: absorbs the model's natural output shapes so shape anomalies don't become a tool parameter-validation failure.
 *
 * Regression background (prod228 session 2026-10-21T07-36-23): the model's stage_case was rejected by parameter validation 5 times in a row,
 * each retry recompiling a version of the steps and burning LLM turns for nothing. Two shapes:
 *   - locator: {"item":[{...},{...}]} (candidates array inside an item shell) → zod reports "Expected object, received array"
 *   - timeoutMs: "20000" (string) → zod reports "Expected number, received string"
 */
import { describe, it, expect } from 'vitest';
import { normalizeCompiledStep } from '../src/pi/tools.js';
import { StepAction } from '@itest/shared';

describe('normalizeCompiledStep', () => {
  it('locator 直接是候选数组时原样保留', () => {
    const step = { kind: 'click', locator: [{ strategy: 'css', value: '#a' }] };
    expect(normalizeCompiledStep(step)).toEqual(step);
  });

  it('locator 是单对象 {strategy,value} → 包成数组', () => {
    const r = normalizeCompiledStep({ kind: 'click', locator: { strategy: 'css', value: '#a' } }) as StepAction;
    expect(r.locator).toEqual([{ strategy: 'css', value: '#a' }]);
  });

  it('locator 是 {item:{strategy,value}} 外壳 → 剥成 [{strategy,value}]', () => {
    const r = normalizeCompiledStep({ kind: 'click', locator: { item: { strategy: 'css', value: '#a' } } }) as StepAction;
    expect(r.locator).toEqual([{ strategy: 'css', value: '#a' }]);
  });

  it('locator 是 {item:[{...},{...}]} 外壳（item 为数组）→ 摊平成候选数组', () => {
    const r = normalizeCompiledStep({
      kind: 'click',
      locator: { item: [{ strategy: 'css', value: '.rowbox button' }, { strategy: 'role', value: "button[name='查询']" }] },
    }) as StepAction;
    expect(r.locator).toEqual([
      { strategy: 'css', value: '.rowbox button' },
      { strategy: 'role', value: "button[name='查询']" },
    ]);
  });

  it('locator 候选被多包一层数组 [[{...},{...}]] → 剥到只剩候选数组', () => {
    const r = normalizeCompiledStep({
      kind: 'click',
      locator: [[{ strategy: 'css', value: '#a' }, { strategy: 'text', value: 'A' }]],
    }) as StepAction;
    expect(r.locator).toEqual([{ strategy: 'css', value: '#a' }, { strategy: 'text', value: 'A' }]);
  });

  it('混合嵌套（数组里混着 {item:[...]} 外壳）→ 全部摊平', () => {
    const r = normalizeCompiledStep({
      kind: 'click',
      locator: [{ item: [{ strategy: 'css', value: '#a' }] }, { strategy: 'text', value: 'A' }],
    }) as StepAction;
    expect(r.locator).toEqual([{ strategy: 'css', value: '#a' }, { strategy: 'text', value: 'A' }]);
  });

  it('timeoutMs 字符串 → 数值化', () => {
    const r = normalizeCompiledStep({ kind: 'waitFor', locator: [], timeoutMs: '20000' }) as StepAction;
    expect((r as { timeoutMs?: number }).timeoutMs).toBe(20000);
  });

  it('非数字串原样保留（交给 zod 报明确错误）', () => {
    const r = normalizeCompiledStep({ kind: 'waitFor', locator: [], timeoutMs: 'abc' }) as StepAction;
    expect((r as { timeoutMs?: unknown }).timeoutMs).toBe('abc');
  });

  it('无 locator 字段的步骤原样透传', () => {
    const step = { kind: 'navigate', url: '/x' };
    expect(normalizeCompiledStep(step)).toEqual(step);
  });

  it('归一化后的形状能通过 StepAction 校验', () => {
    const r = StepAction.parse(
      normalizeCompiledStep({
        kind: 'waitFor',
        locator: { item: { strategy: 'css', value: '#tablecommon' } },
        timeoutMs: '20000',
      }),
    );
    expect(r.kind).toBe('waitFor');
    expect((r as { timeoutMs?: number }).timeoutMs).toBe(20000);
  });
});
