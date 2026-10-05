import type { StepClip } from '../../stores/stepClipboard';

export const STEP_KINDS = [
  'navigate', 'click', 'fill', 'select', 'check', 'hover', 'waitFor',
  'assertVisible', 'assertText', 'assertJson', 'extract', 'upload',
  'switchTab', 'screenshot', 'aiStep', 'aiTask', 'queryDb', 'observeLog', 'solveCaptcha',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

const WITH_LOCATOR: ReadonlySet<string> = new Set([
  'click', 'hover', 'fill', 'select', 'check', 'waitFor',
  'assertVisible', 'assertText', 'assertJson', 'upload', 'extract',
]);

export function kindNeedsLocator(kind: string): boolean {
  return WITH_LOCATOR.has(kind);
}

/** 类型切换：保留 locator/intentLocator/name/delayMs/source 等兼容字段；敏感值与不兼容字段丢弃。 */
export function switchAction(clip: StepClip, to: StepKind): StepClip {
  const src = (clip.action ?? {}) as Record<string, unknown>;
  const srcLocator = Array.isArray(src.locator) && src.locator.length > 0 ? src.locator : undefined;
  const locator = kindNeedsLocator(to) ? (srcLocator ?? [{ strategy: 'css', value: '' }]) : undefined;
  const intentLocator = locator && src.intentLocator ? src.intentLocator : undefined;
  const base = () => ({ ...(intentLocator ? { intentLocator } : {}) });

  // 敏感 fill 的值是 '__sensitive__' 占位，任何切换都不携带
  const srcValue =
    typeof src.value === 'string' && !(src.sensitive || src.value === '__sensitive__') ? src.value : '';

  let action: Record<string, unknown>;
  switch (to) {
    case 'navigate':
      action = { kind: 'navigate', url: '' };
      break;
    case 'click':
    case 'hover':
    case 'assertVisible':
      action = { kind: to, locator: locator!, ...base() };
      break;
    case 'waitFor':
      action = { kind: 'waitFor', locator: locator!, ...base() };
      break;
    case 'fill':
      action = { kind: 'fill', locator: locator!, value: srcValue, ...base() };
      break;
    case 'select':
      action = { kind: 'select', locator: locator!, value: srcValue, ...base() };
      break;
    case 'check':
      action = { kind: 'check', locator: locator!, checked: true, ...base() };
      break;
    case 'assertText':
      action = { kind: 'assertText', locator: locator!, target: 'specifiedElement', match: 'equals', equals: '', ...base() };
      break;
    case 'assertJson':
      action = { kind: 'assertJson', locator: locator!, equals: null, ...base() };
      break;
    case 'upload':
      action = { kind: 'upload', locator: locator!, fileId: '', ...base() };
      break;
    case 'extract':
      action = { kind: 'extract', locator: locator!, varName: '', mode: 'completeValue', ...base() };
      break;
    case 'switchTab':
      action = { kind: 'switchTab', tabRef: '' };
      break;
    case 'screenshot':
      action = { kind: 'screenshot', name: '' };
      break;
    case 'aiStep':
      action = { kind: 'aiStep', instruction: '', compiled: null };
      break;
    case 'aiTask':
      action = { kind: 'aiTask', instruction: typeof src.instruction === 'string' ? src.instruction : '' };
      break;
    case 'queryDb':
      action = { kind: 'queryDb', table: 'test_cases', where: [], columns: [], limit: 50 };
      break;
    case 'observeLog':
      action = { kind: 'observeLog', windowMs: 60000, keywords: [], fromLine: 200 };
      break;
    case 'solveCaptcha':
      // 双 locator（图片 + 输入框）,复用 src.locator 作为输入框候选
      action = {
        kind: 'solveCaptcha',
        imageLocator: [{ strategy: 'css', value: '' }],
        inputLocator: locator ?? [{ strategy: 'css', value: '' }],
        ...base(),
      };
      break;
  }

  return { action, source: clip.source, name: clip.name, delayMs: clip.delayMs };
}
