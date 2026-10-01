import type { StepAction } from '@itest/shared';

const SWITCH_MATRIX: Record<string, Set<string>> = {
  click: new Set(['hover', 'assertText']),
  hover: new Set(['click']),
  assertText: new Set(['click']),
  fill: new Set(['select']),
  select: new Set(['fill']),
  waitFor: new Set(['assertVisible']),
  assertVisible: new Set(['waitFor']),
};

export function canSwitch(from: string, to: string): boolean {
  if (from === to) return false;
  return SWITCH_MATRIX[from]?.has(to) ?? false;
}

/**
 * 步骤 kind 切换：保留 locator + intentLocator；其他字段按目标 kind 的默认初始化。
 * 不支持的切换返回原 action（指针相等），由调用方提示用户。
 */
export function switchAction(action: StepAction, to: string): StepAction {
  const from = action.kind;
  if (!canSwitch(from, to)) return action;

  const locator = (action as { locator: unknown }).locator;
  const intentLocator = (action as { intentLocator?: unknown }).intentLocator;

  switch (to) {
    case 'hover':
      return { kind: 'hover', locator: locator as never, ...(intentLocator !== undefined ? { intentLocator: intentLocator as never } : {}) };
    case 'assertText':
      return {
        kind: 'assertText',
        locator: locator as never,
        intentLocator: intentLocator as never,
        target: 'specifiedElement',
        match: 'equals',
        equals: '',
      };
    case 'click':
      return { kind: 'click', locator: locator as never, intentLocator: intentLocator as never };
    case 'fill':
      return {
        kind: 'fill',
        locator: locator as never,
        intentLocator: intentLocator as never,
        value: ((action as { value?: unknown }).value as string) ?? '',
      };
    case 'select':
      return {
        kind: 'select',
        locator: locator as never,
        intentLocator: intentLocator as never,
        value: ((action as { value?: unknown }).value as string) ?? '',
      };
    case 'waitFor':
      return {
        kind: 'waitFor',
        locator: locator as never,
        intentLocator: intentLocator as never,
        timeoutMs: 5000,
      };
    case 'assertVisible':
      return { kind: 'assertVisible', locator: locator as never, intentLocator: intentLocator as never };
  }
  return action;
}