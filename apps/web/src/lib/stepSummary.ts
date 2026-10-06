// apps/web/src/lib/stepSummary.ts
import type { StepAction } from '@itest/shared';
/** 步骤一览（列表/抽屉预览/悬浮卡）—— 人读摘要，纯函数，不依赖任何组件。 */

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

/** step 行形状：dispatcher 唯一读 compiled（action 列已 DROP），UI 摘要与 kind 推断沿用同一路径。
 *  compiled 用 unknown[] 对齐 TestStep；具体 dispatcher/AI 编译按 StepAction[] 解析。 */
export interface StepRowLike {
  /** 行级自然语言。 */
  instruction?: string | null;
  /** 可执行 DSL 数组；空数组/null/undefined 表示未编译。 */
  compiled?: unknown[] | null;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** kind 推断路径：compiled[0]?.kind → ''。 */
export function getKind(row: StepRowLike): string {
  const c = Array.isArray(row.compiled) ? row.compiled[0] : undefined;
  if (c && typeof c === 'object' && typeof (c as { kind?: string }).kind === 'string') {
    return (c as { kind: string }).kind;
  }
  return '';
}

/** 选择 summary 用的 payload：compiled[0]（dispatcher 唯一回放依据）。 */
function pickAction(row: StepRowLike): KnownAction {
  const c = Array.isArray(row.compiled) ? row.compiled[0] : undefined;
  return (c && typeof c === 'object' ? c : {}) as KnownAction;
}

/** 是否未编译：与 dispatcher 对齐 —— compiled 非空数组才视为已编译；
 *  空数组 / null / undefined（老数据 action 列已 DROP，无 compiled 即无法回放）都算未编译。 */
export function isUncompiled(row: StepRowLike): boolean {
  return !Array.isArray(row.compiled) || row.compiled.length === 0;
}

// 兼容旧类型引用
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _StepAction = StepAction;

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

/** 列表/悬浮卡片用的简短摘要（已 clip）。
 *  接收整 step 行（instruction + compiled + 老 action），kind 与 payload 均沿 compiled 优先。 */
export function stepSummary(row: StepRowLike | unknown): string {
  const r = (row ?? {}) as StepRowLike;
  const a = pickAction(r);
  const t = targetText(a);
  // 未编译（compiled 是 []）时 UI 前缀「⚠ 未编译 · 」
  const uncompiledPrefix = isUncompiled(r) ? '⚠ 未编译 · ' : '';
  switch (a.kind) {
    case 'navigate':
      return uncompiledPrefix + `打开 ${clip(str(a.url), 40)}`;
    case 'click':
      return uncompiledPrefix + `点击 ${clip(t, 20)}`;
    case 'hover':
      return uncompiledPrefix + `悬停 ${clip(t, 20)}`;
    case 'check':
      return uncompiledPrefix + (a.checked === false ? '取消勾选' : '勾选');
    case 'waitFor':
      return uncompiledPrefix + `等待元素 ${clip(t, 20)}`;
    case 'assertVisible':
      return uncompiledPrefix + `断言可见 ${clip(t, 20)}`;
    case 'fill':
      return uncompiledPrefix + `输入 ${clip(valueText(a), 40)}`;
    case 'select':
      return uncompiledPrefix + `选择 ${clip(str(a.value), 20)}`;
    case 'assertText':
      return uncompiledPrefix + `断言文本 ${MATCH_LABELS[str(a.match)] ?? '等于'}「${clip(str(a.equals), 20)}」`;
    case 'assertJson':
      return uncompiledPrefix + '断言 JSON';
    case 'screenshot':
      return uncompiledPrefix + `截图 ${clip(str(a.name), 20)}`;
    case 'upload':
      return uncompiledPrefix + '上传文件';
    case 'switchTab':
      return uncompiledPrefix + `切换标签页 ${clip(str(a.tabRef), 20)}`;
    case 'extract':
      return uncompiledPrefix + `提取 → {{${clip(str(a.varName), 30)}}}`;
    case 'aiTask':
      return uncompiledPrefix + `智能：${clip(str(a.instruction), 40)}`;
    case 'queryDb':
      return uncompiledPrefix + `查 ${str(a.table)}`;
    case 'observeLog': {
      const kw = Array.isArray(a.keywords) ? (a.keywords as unknown[]).map((v) => str(v)).filter(Boolean) : [];
      return uncompiledPrefix + `观察日志${kw.length ? ' · ' + kw.join('/') : ''}`;
    }
    default:
      return uncompiledPrefix + clip(JSON.stringify(a) ?? String(a), 40);
  }
}

/** tooltip/抽屉预览用的完整描述：所有关键字段，不截断。带换行。 */
export function fullStepDescription(row: StepRowLike | unknown): string {
  const r = (row ?? {}) as StepRowLike;
  const a = pickAction(r);
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
  push('自然语言', str(r.instruction));
  if (isUncompiled(r)) push('编译状态', '未编译 · 点右侧「AI 编译」补');

  if (lines.length === 0 || (lines.length === 1 && lines[0]?.startsWith('类型：'))) {
    // 兜底：JSON 序列化所有字段，便于调试未识别 kind
    try { return JSON.stringify(row, null, 2); } catch { return String(row); }
  }
  return lines.join('\n');
}