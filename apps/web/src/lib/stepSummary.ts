// apps/web/src/lib/stepSummary.ts
/** 步骤正文的人类可读摘要（列表展示用）；纯函数，不依赖任何组件。 */

interface KnownAction {
  kind?: string;
  locator?: Array<{ strategy?: string; value?: string }>;
  intentLocator?: { semanticRole?: string; contextText?: string };
  value?: unknown;
  sensitive?: boolean;
  url?: unknown;
  name?: unknown;
  instruction?: unknown;
  match?: unknown;
  equals?: unknown;
  tabRef?: unknown;
  varName?: unknown;
  checked?: unknown;
  table?: unknown;
  keywords?: unknown;
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
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'mode' in (v as Record<string, unknown>)) {
    return `(${GEN_LABELS[str((v as { mode?: string }).mode)] ?? '生成值'})`;
  }
  return '';
}

const MATCH_LABELS: Record<string, string> = { equals: '等于', contains: '包含', notContains: '不包含', regex: '正则' };

/** 列表/悬浮卡片用的简短摘要（已 clip）。 */
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
      return a.checked === false ? '取消勾选' : '勾选';
    case 'waitFor':
      return `等待元素 ${clip(t, 20)}`;
    case 'assertVisible':
      return `断言可见 ${clip(t, 20)}`;
    case 'fill':
      return `输入 ${clip(valueText(a), 40)}`;
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
    case 'aiTask':
      return `智能：${clip(str(a.instruction), 40)}`;
    case 'queryDb':
      return `查 ${str(a.table)}`;
    case 'observeLog': {
      const kw = Array.isArray(a.keywords) ? (a.keywords as unknown[]).map((v) => str(v)).filter(Boolean) : [];
      return `观察日志${kw.length ? ' · ' + kw.join('/') : ''}`;
    }
    default:
      return clip(JSON.stringify(action) ?? String(action), 40);
  }
}

/** tooltip/抽屉预览用的完整描述：所有关键字段，不截断；带换行。 */
export function fullStepDescription(action: unknown): string {
  const a = (action ?? {}) as KnownAction;
  const lines: string[] = [];
  const push = (k: string, v: string) => { if (v) lines.push(`${k}：${v}`); };

  push('类型', str(a.kind));
  push('定位', targetText(a));
  if (Array.isArray(a.locator) && a.locator.length > 1) {
    const extra = a.locator
      .slice(1)
      .map((l) => `${str(l.strategy) || 'css'}=${str(l.value ?? '')}`)
      .join('\n  ');
    if (extra) lines.push(`备用定位：\n  ${extra}`);
  }
  push('URL', str(a.url));
  if (a.value !== undefined) push('值', valueText(a));
  push('断言匹配', MATCH_LABELS[str(a.match)] ?? '');
  push('断言等于', str(a.equals));
  push('标签页', str(a.tabRef));
  push('抽取变量', str(a.varName));
  push('指令', str(a.instruction));
  push('表名', str(a.table));
  if (Array.isArray(a.keywords)) push('日志关键字', (a.keywords as unknown[]).map((v) => str(v)).filter(Boolean).join(' / '));

  if (lines.length === 0) {
    // 兜底：JSON 序列化所有字段，便于调试未识别 kind
    try { return JSON.stringify(action, null, 2); } catch { return String(action); }
  }
  return lines.join('\n');
}
