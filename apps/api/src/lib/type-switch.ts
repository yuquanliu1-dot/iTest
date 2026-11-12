import type { StepAction } from '@itest/shared';

const SWITCH_MATRIX: Record<string, Set<string>> = {
  click: new Set(['hover', 'assertText']),
  hover: new Set(['click']),
  assertText: new Set(['click']),
  fill: new Set(['select']),
  select: new Set(['fill']),
  waitFor: new Set(['assertVisible']),
  assertVisible: new Set(['waitFor']),
  scroll: new Set(['click', 'hover']),
};

export function canSwitch(from: string, to: string): boolean {
  if (from === to) return false;
  return SWITCH_MATRIX[from]?.has(to) ?? false;
}

/**
 * Step kind switching: keeps locator + intentLocator + frameChain (all 8 kinds in the matrix declare frame chains;
 * dropping the chain = replay lands in the top-level document); other fields are initialized to the target kind's defaults.
 * Unsupported switches return the original action (pointer-equal); the caller surfaces that to the user.
 */
export function switchAction(action: StepAction, to: string): StepAction {
  const from = action.kind;
  if (!canSwitch(from, to)) return action;

  const locator = (action as { locator: unknown }).locator;
  const intentLocator = (action as { intentLocator?: unknown }).intentLocator;
  const frameChain = (action as { frameChain?: unknown }).frameChain;
  const chainIf = () => (frameChain !== undefined ? { frameChain: frameChain as never } : {});

  switch (to) {
    case 'hover':
      return { kind: 'hover', locator: locator as never, ...(intentLocator !== undefined ? { intentLocator: intentLocator as never } : {}), ...chainIf() };
    case 'assertText':
      return {
        kind: 'assertText',
        locator: locator as never,
        intentLocator: intentLocator as never,
        target: 'specifiedElement',
        match: 'equals',
        equals: '',
        ...chainIf(),
      };
    case 'click':
      return { kind: 'click', locator: locator as never, intentLocator: intentLocator as never, ...chainIf() };
    case 'fill':
      return {
        kind: 'fill',
        locator: locator as never,
        intentLocator: intentLocator as never,
        value: ((action as { value?: unknown }).value as string) ?? '',
        ...chainIf(),
      };
    case 'select':
      return {
        kind: 'select',
        locator: locator as never,
        intentLocator: intentLocator as never,
        value: ((action as { value?: unknown }).value as string) ?? '',
        ...chainIf(),
      };
    case 'waitFor':
      return {
        kind: 'waitFor',
        locator: locator as never,
        intentLocator: intentLocator as never,
        timeoutMs: 5000,
        ...chainIf(),
      };
    case 'assertVisible':
      return { kind: 'assertVisible', locator: locator as never, intentLocator: intentLocator as never, ...chainIf() };
    case 'scroll':
      return {
        kind: 'scroll',
        locator: locator as never,
        intentLocator: intentLocator as never,
        scrollTop: 0,
        scrollLeft: 0,
        ...chainIf(),
      };
  }
  return action;
}