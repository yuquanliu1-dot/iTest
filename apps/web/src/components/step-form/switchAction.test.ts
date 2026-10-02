import { describe, it, expect } from 'vitest';
import { switchAction, kindNeedsLocator } from './switchAction';
import type { StepClip } from '../../stores/stepClipboard';

const clipOf = (action: unknown): StepClip => ({ action, source: 'manual', name: 'n', delayMs: 100 });
const loc = [{ strategy: 'role', value: 'button' }];

describe('switchAction', () => {
  it('click → fill 保留 locator/intentLocator/name/delayMs', () => {
    const out = switchAction(clipOf({ kind: 'click', locator: loc, intentLocator: { semanticRole: 'button', contextText: '登录' } }), 'fill');
    const a = out.action as Record<string, unknown>;
    expect(a.kind).toBe('fill');
    expect(a.locator).toEqual(loc);
    expect(a.intentLocator).toEqual({ semanticRole: 'button', contextText: '登录' });
    expect(out.name).toBe('n');
    expect(out.delayMs).toBe(100);
    expect(a.value).toBe('');
  });

  it('fill → select 保留字符串值', () => {
    const out = switchAction(clipOf({ kind: 'fill', locator: loc, value: 'SH' }), 'select');
    expect((out.action as Record<string, unknown>).value).toBe('SH');
  });

  it('敏感 fill → select 不外带占位值/敏感标记', () => {
    const out = switchAction(clipOf({ kind: 'fill', locator: loc, value: '__sensitive__', sensitive: true }), 'select');
    const a = out.action as Record<string, unknown>;
    expect(a.value).toBe('');
    expect(a.sensitive).toBeUndefined();
  });

  it('navigate → click 补默认 locator 候选', () => {
    const out = switchAction(clipOf({ kind: 'navigate', url: 'https://a.com' }), 'click');
    expect((out.action as Record<string, unknown>).locator).toEqual([{ strategy: 'css', value: '' }]);
  });

  it('click → navigate 丢弃 locator，url 为空串', () => {
    const out = switchAction(clipOf({ kind: 'click', locator: loc }), 'navigate');
    expect(out.action).toEqual({ kind: 'navigate', url: '' });
  });

  it('click → assertText 带默认 target/match', () => {
    const out = switchAction(clipOf({ kind: 'click', locator: loc }), 'assertText');
    expect(out.action).toEqual({ kind: 'assertText', locator: loc, target: 'specifiedElement', match: 'equals', equals: '' });
  });

  it('click → extract 保留 locator', () => {
    const out = switchAction(clipOf({ kind: 'click', locator: loc }), 'extract');
    expect((out.action as Record<string, unknown>).locator).toEqual(loc);
  });

  it('click → aiStep / switchTab / screenshot 无 locator', () => {
    expect(switchAction(clipOf({ kind: 'click', locator: loc }), 'aiStep').action).toEqual({ kind: 'aiStep', instruction: '', compiled: null });
    expect(switchAction(clipOf({ kind: 'click', locator: loc }), 'switchTab').action).toEqual({ kind: 'switchTab', tabRef: '' });
    expect(switchAction(clipOf({ kind: 'click', locator: loc }), 'screenshot').action).toEqual({ kind: 'screenshot', name: '' });
  });

  it('kindNeedsLocator 覆盖 13 种', () => {
    for (const k of ['click', 'hover', 'fill', 'select', 'check', 'waitFor', 'assertVisible', 'assertText', 'assertJson', 'upload', 'extract']) {
      expect(kindNeedsLocator(k)).toBe(true);
    }
    for (const k of ['navigate', 'switchTab', 'screenshot', 'aiStep']) {
      expect(kindNeedsLocator(k)).toBe(false);
    }
  });
});
