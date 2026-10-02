// apps/web/src/lib/stepValidation.test.ts
import { describe, it, expect } from 'vitest';
import { validateStepEdit } from './stepValidation';

const click = { kind: 'click', locator: [{ strategy: 'css', value: '#btn' }] };

describe('validateStepEdit', () => {
  it('合法 click 通过', () => {
    expect(validateStepEdit({ action: click }).ok).toBe(true);
  });

  it('locator 候选值为空', () => {
    const r = validateStepEdit({ action: { kind: 'click', locator: [{ strategy: 'css', value: '' }] } });
    expect(r.ok).toBe(false);
    expect(r.errors['action.locator.0.value']).toContain('候选 1');
  });

  it('locator 数组为空（click 要求 min(1)）', () => {
    const r = validateStepEdit({ action: { kind: 'click', locator: [] } });
    expect(r.errors['action.locator']).toBeTruthy();
  });

  it('navigate URL 不合法', () => {
    const r = validateStepEdit({ action: { kind: 'navigate', url: 'notaurl' } });
    expect(r.errors['action.url']).toBeTruthy();
  });

  it('delayMs 越界 / 非整数', () => {
    expect(validateStepEdit({ action: click, delayMs: 60001 }).errors.delayMs).toBeTruthy();
    expect(validateStepEdit({ action: click, delayMs: -1 }).errors.delayMs).toBeTruthy();
    expect(validateStepEdit({ action: click, delayMs: 100.5 }).errors.delayMs).toBeTruthy();
    expect(validateStepEdit({ action: click, delayMs: 500 }).ok).toBe(true);
  });

  it('name 超 200 字', () => {
    const r = validateStepEdit({ action: click, name: 'x'.repeat(201) });
    expect(r.errors.name).toBeTruthy();
  });

  it('extract 缺 varName', () => {
    const r = validateStepEdit({ action: { kind: 'extract', locator: click.locator, mode: 'completeValue', varName: '' } });
    expect(r.errors['action.varName']).toBeTruthy();
  });

  it('switchTab 缺 tabRef', () => {
    const r = validateStepEdit({ action: { kind: 'switchTab', tabRef: '' } });
    expect(r.errors['action.tabRef']).toBeTruthy();
  });

  it('组合值总长超 1024 被 zod refine 拦截', () => {
    const fragments = Array.from({ length: 15 }, () => ({ mode: 'randomString', length: 100 }));
    const r = validateStepEdit({ action: { kind: 'fill', locator: click.locator, value: { mode: 'composite', fragments } } });
    expect(r.errors['action.value.fragments']).toBeTruthy();
  });

  it('敏感 fill 占位值合法（密码重输由抽屉负责）', () => {
    const r = validateStepEdit({ action: { kind: 'fill', locator: click.locator, value: 'newpwd', sensitive: true } });
    expect(r.ok).toBe(true);
  });
});
