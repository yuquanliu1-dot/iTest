import type { StepClip } from '../../stores/stepClipboard';

export const STEP_KINDS = [
  'navigate', 'click', 'fill', 'select', 'check', 'hover', 'waitFor',
  'assertVisible', 'assertText', 'assertJson', 'extract', 'upload',
  'switchTab', 'screenshot', 'aiTask', 'queryDb', 'observeLog', 'httpRequest', 'sendSyslog', 'sql',
  'tap', 'swipe', 'setAppearance', 'setNetwork', 'setLocation',
  'appOpen', 'appBack', 'appRestart', 'home',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

const WITH_LOCATOR: ReadonlySet<string> = new Set([
  'click', 'hover', 'fill', 'select', 'check', 'waitFor',
  'assertVisible', 'assertText', 'assertJson', 'upload', 'extract',
  'tap', 'swipe',
]);

export function kindNeedsLocator(kind: string): boolean {
  return WITH_LOCATOR.has(kind);
}

/** 类型切换：保留 locator/intentLocator/instruction/source 等兼容字段；敏感值与不兼容字段丢弃。
 *  2026-10-07：name 列退役,switchAction 不再读写 name。 */
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
    case 'aiTask':
      action = { kind: 'aiTask', instruction: typeof src.instruction === 'string' ? src.instruction : '' };
      break;
    case 'queryDb':
      action = { kind: 'queryDb', table: 'test_cases', where: [], columns: [], limit: 50 };
      break;
    case 'observeLog':
      action = { kind: 'observeLog', windowMs: 60000, keywords: [], fromLine: 200 };
      break;
    case 'httpRequest':
      action = { kind: 'httpRequest', method: 'GET', url: '', headers: [], timeoutMs: 10000 };
      break;
    case 'sendSyslog':
      action = { kind: 'sendSyslog', protocol: 'udp', host: '', port: 514, facility: 'user', severity: 'info', message: '', timeoutMs: 5000 };
      break;
    case 'sql':
      action = { kind: 'sql', sql: '', params: [], limit: 50 };
      break;
    case 'tap':
      action = { kind: 'tap', locator: locator!, ...base() };
      break;
    case 'swipe':
      action = {
        kind: 'swipe',
        from: srcLocator ?? [{ strategy: 'accessibilityId', value: '' }],
        to: [{ strategy: 'accessibilityId', value: '' }],
      };
      break;
    case 'setAppearance':
      action = { kind: 'setAppearance', mode: 'light' };
      break;
    case 'setNetwork':
      action = { kind: 'setNetwork', state: 'online' };
      break;
    case 'setLocation':
      action = { kind: 'setLocation', latitude: 0, longitude: 0 };
      break;
    case 'appOpen':
      action = { kind: 'appOpen' };
      break;
    case 'appBack':
      action = { kind: 'appBack' };
      break;
    case 'appRestart':
      action = { kind: 'appRestart' };
      break;
    case 'home':
      action = { kind: 'home' };
      break;
  }

  return { action, source: clip.source, instruction: clip.instruction, delayMs: clip.delayMs };
}
