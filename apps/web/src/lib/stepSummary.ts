// apps/web/src/lib/stepSummary.ts
/** 步骤正文的人类可读摘要（列表展示用）；纯函数，不依赖任何组件。 */

interface KnownAction {
  kind?: string;
  locator?: Array<{ strategy?: string; value?: string }>;
  intentLocator?: { semanticRole?: string; contextText?: string };
  value?: unknown;
  sensitive?: boolean;
  [k: string]: unknown;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 定位对象描述：优先语义文案，否则首个 locator 的 strategy=value。 */
function targetText(action: KnownAction): string {
  const ctx = action.intentLocator?.contextText;
  if (ctx) return ctx;
  const first = Array.isArray(action.locator) ? action.locator[0] : undefined;
  if (first && first.value) return `${str(first.strategy) || 'css'}=${first.value}`;
  return '';
}

const GEN_LABELS: Record<string, string> = {
  randomString: '随机字符串',
  randomNumber: '随机数字',
  timestamp: '时间戳',
  prefixTimestamp: '前缀+时间戳',
  composite: '组合值',
};

function valueText(action: KnownAction): string {
  if (action.sensitive || action.value === '__sensitive__') return '***';
  const v = action.value;
  if (typeof v === 'string') return clip(v, 20);
  if (v && typeof v === 'object' && 'mode' in (v as Record<string, unknown>)) {
    return `(${GEN_LABELS[str((v as { mode?: string }).mode)] ?? '生成值'})`;
  }
  return '';
}

const MATCH_LABELS: Record<string, string> = { equals: '等于', contains: '包含', notContains: '不包含', regex: '正则' };

export function stepSummary(action: unknown): string {
  const a = (action ?? {}) as KnownAction;
  const t = targetText(a);
  switch (a.kind) {
    case 'navigate':
      return `打开 ${clip(str(a.url), 40)}`;
    case 'click':
      return `点击 ${clip(t, 20)}`;
    case 'hover':
      return `悬停 ${clip(t, 20)}`;
    case 'check':
      return '勾选';
    case 'waitFor':
      return `等待元素 ${clip(t, 20)}`;
    case 'assertVisible':
      return `断言可见 ${clip(t, 20)}`;
    case 'fill':
      return `输入 ${valueText(a)}`;
    case 'select':
      return `选择 ${clip(str(a.value), 20)}`;
    case 'assertText':
      return `断言文本 ${MATCH_LABELS[str(a.match)] ?? '等于'}「${clip(str(a.equals), 20)}」`;
    case 'assertJson':
      return '断言 JSON';
    case 'screenshot':
      return `截图 ${clip(str(a.name), 20)}`;
    case 'upload':
      return '上传文件';
    case 'switchTab':
      return `切换标签页 ${clip(str(a.tabRef), 20)}`;
    case 'extract':
      return `提取 → {{${clip(str(a.varName), 30)}}}`;
    case 'aiStep':
      return `AI：${clip(str(a.instruction), 40)}`;
    default:
      return clip(JSON.stringify(action), 40);
  }
}
