// apps/web/src/lib/stepSummary.ts
import type { TFunction } from 'i18next';
/** 步骤一览（列表/抽屉预览/悬浮卡）—— 人读摘要，纯函数，文案走 i18n key。 */

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

/** 选择 summary 用的 payload 数组：dispatcher 依序执行 compiled[0..n]。 */
function pickAllActions(row: StepRowLike): KnownAction[] {
  if (!Array.isArray(row.compiled)) return [];
  return row.compiled.filter((c) => c && typeof c === 'object') as KnownAction[];
}

/** 是否未编译：与 dispatcher 对齐 —— compiled 非空数组才视为已编译；
 *  空数组 / null / undefined（老数据 action 列已 DROP，无 compiled 即无法回放）都算未编译。 */
export function isUncompiled(row: StepRowLike): boolean {
  return !Array.isArray(row.compiled) || row.compiled.length === 0;
}

/** 定位对象描述：优先语义文案，否则首个 locator 的 strategy=value。 */
function targetText(action: KnownAction): string {
  const ctx = action.intentLocator?.contextText;
  if (ctx) return ctx;
  const first = Array.isArray(action.locator) ? action.locator[0] : undefined;
  if (first && first.value) return `${str(first.strategy) || 'css'}=${first.value}`;
  return '';
}

/** 生成器值/匹配方式/字段标签统一走 i18n key（由 t() 渲染）。 */
const GEN_LABELS: Record<string, string> = {
  randomString: 'cases:stepSummary.gen.randomString',
  randomNumber: 'cases:stepSummary.gen.randomNumber',
  timestamp: 'cases:stepSummary.gen.timestamp',
  prefixTimestamp: 'cases:stepSummary.gen.prefixTimestamp',
  composite: 'cases:stepSummary.gen.composite',
};

const GEN_FALLBACK = 'cases:stepSummary.gen.generated';

function valueText(action: KnownAction, t: TFunction): string {
  if (action.sensitive || action.value === '__sensitive__') return '***';
  const v = action.value;
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'mode' in (v as Record<string, unknown>)) {
    return `(${t(GEN_LABELS[str((v as { mode?: string }).mode)] ?? GEN_FALLBACK)})`;
  }
  return '';
}

/** 匹配方式展示 key（未知 match 返回 ''）。 */
const MATCH_LABELS: Record<string, string> = {
  equals: 'cases:equalsOp',
  contains: 'cases:matchContains',
  notContains: 'cases:matchNotContains',
  regex: 'cases:stepSummary.matchRegex',
};

function matchLabelKey(action: KnownAction): string {
  return MATCH_LABELS[str(action.match)] ?? '';
}

/** 单个动作的简短摘要（已 clip），不带未编译前缀。 */
function actionSummary(a: KnownAction, t: TFunction): string {
  const target = targetText(a);
  switch (a.kind) {
    case 'navigate':
      return t('cases:stepSummary.act.navigate', { url: clip(str(a.url), 40) });
    case 'click':
      return t('cases:stepSummary.act.click', { target: clip(target, 20) });
    case 'hover':
      return t('cases:stepSummary.act.hover', { target: clip(target, 20) });
    case 'check':
      return a.checked === false ? t('cases:stepSummary.act.uncheck') : t('cases:stepSummary.act.check');
    case 'waitFor':
      // 空定位 = 固定时长等待；有定位 = 等待元素出现
      if (!target) return t('cases:stepSummary.act.waitFixed', { ms: typeof a.timeoutMs === 'number' ? a.timeoutMs : 5000 });
      return t('cases:stepSummary.act.waitElement', { target: clip(target, 20) });
    case 'assertVisible':
      return t('cases:stepSummary.act.assertVisible', { target: clip(target, 20) });
    case 'fill':
      return t('cases:stepSummary.act.fill', { value: clip(valueText(a, t), 40) });
    case 'select':
      return t('cases:stepSummary.act.select', { value: clip(str(a.value), 20) });
    case 'assertText':
      return t('cases:stepSummary.act.assertText', {
        match: t(matchLabelKey(a) || 'cases:equalsOp'),
        text: clip(str(a.equals), 20),
      });
    case 'assertJson':
      return t('cases:stepSummary.act.assertJson');
    case 'screenshot':
      return t('cases:stepSummary.act.screenshot', { name: clip(str(a.name), 20) });
    case 'upload':
      return t('cases:stepSummary.act.upload');
    case 'switchTab':
      return t('cases:stepSummary.act.switchTab', { tab: clip(str(a.tabRef), 20) });
    case 'extract':
      return t('cases:stepSummary.act.extract', { name: `{{${clip(str(a.varName), 30)}}}` });
    case 'aiTask':
      return t('cases:stepSummary.act.aiTask', { instruction: clip(str(a.instruction), 40) });
    case 'queryDb':
      return t('cases:stepSummary.act.queryDb', { table: str(a.table) });
    case 'observeLog': {
      const kw = Array.isArray(a.keywords) ? (a.keywords as unknown[]).map((v) => str(v)).filter(Boolean) : [];
      return kw.length
        ? t('cases:stepSummary.act.observeLogWithKw', { keywords: kw.join('/') })
        : t('cases:stepSummary.act.observeLog');
    }
    case 'httpRequest': {
      const saveAs = a.saveAs as { varName?: unknown } | undefined;
      const arrow = saveAs && typeof saveAs.varName === 'string' && saveAs.varName ? ` → {{${saveAs.varName}}}` : '';
      return t('cases:stepSummary.act.httpRequest', {
        method: str(a.method) || 'GET',
        url: clip(str(a.url), 40),
        arrow,
      });
    }
    case 'sendSyslog':
      return t('cases:stepSummary.act.sendSyslog', {
        protocol: str(a.protocol) === 'tcp' ? 'TCP' : 'UDP',
        host: clip(str(a.host), 30),
        port: a.port == null ? '514' : String(a.port),
        message: clip(str(a.message), 30),
      });
    default:
      return clip(JSON.stringify(a) ?? String(a), 40);
  }
}

/** 列表/悬浮卡片用的简短摘要（已 clip）。
 *  接收整 step 行（instruction + compiled）。多动作行（AI 一次产出一串 DSL）枚举整条链：
 *  「共 N 步：a → b → …」；单动作行保持历史输出不变。 */
export function stepSummary(row: StepRowLike | unknown, t: TFunction): string {
  const r = (row ?? {}) as StepRowLike;
  const actions = pickAllActions(r);
  if (actions.length > 1) {
    return t('cases:stepSummary.multi', {
      count: actions.length,
      chain: actions.map((a) => actionSummary(a, t)).join(' → '),
    });
  }
  // 未编译（compiled 是 []）时 UI 前缀「⚠ 未编译 · 」
  const uncompiledPrefix = isUncompiled(r) ? t('cases:stepSummary.uncompiledPrefix') : '';
  return uncompiledPrefix + actionSummary(actions[0] ?? {}, t);
}

/** 单个动作的完整字段行（fullStepDescription 复用；多动作行按块枚举）。 */
function describeAction(a: KnownAction, t: TFunction): string[] {
  const lines: string[] = [];
  const push = (labelKey: string, v: string) => { if (v) lines.push(`${t(labelKey)}${v}`); };

  push('cases:stepSummary.fieldKind', str(a.kind));
  push('cases:stepSummary.fieldLocator', targetText(a));
  if (Array.isArray(a.locator) && a.locator.length > 1) {
    const extra = a.locator
      .slice(1)
      .map((l) => `${str(l.strategy) || 'css'}=${str(l.value ?? '')}`)
      .join('\n  ');
    if (extra) lines.push(`${t('cases:stepSummary.fieldBackupLocator')}${extra}`);
  }
  push('cases:stepSummary.fieldUrl', str(a.url));
  if (a.value !== undefined) push('cases:stepSummary.fieldValue', valueText(a, t));
  const matchKey = matchLabelKey(a);
  if (matchKey) push('cases:stepSummary.fieldAssertMatch', t(matchKey));
  push('cases:stepSummary.fieldAssertEquals', str(a.equals));
  push('cases:stepSummary.fieldTab', str(a.tabRef));
  push('cases:stepSummary.fieldExtractVar', str(a.varName));
  push('cases:stepSummary.fieldInstruction', str(a.instruction));
  push('cases:stepSummary.fieldTable', str(a.table));
  if (Array.isArray(a.keywords)) push('cases:stepSummary.fieldLogKeywords', (a.keywords as unknown[]).map((v) => str(v)).filter(Boolean).join(' / '));
  if (a.kind === 'httpRequest') {
    push('cases:stepSummary.fieldHttpMethod', str(a.method));
    push('cases:stepSummary.fieldHttpBody', typeof a.body === 'string' ? clip(a.body, 200) : '');
    if (a.carryLoginState) lines.push(t('cases:stepSummary.httpCarryLogin'));
    const saveAs = a.saveAs as { varName?: unknown; from?: unknown; path?: unknown } | undefined;
    if (saveAs) {
      const from = saveAs.from === 'status' ? t('cases:saveVarFromStatus') : t('cases:saveVarFromBody');
      push('cases:stepSummary.fieldExtractVar', `{{${str(saveAs.varName)}}} ← ${from}${saveAs.path ? `.${str(saveAs.path)}` : ''}`);
    }
    const assertion = a.assertion as { status?: unknown; match?: unknown; expected?: unknown } | undefined;
    if (assertion) {
      if (assertion.status !== undefined) push('cases:stepSummary.fieldAssertStatus', String(assertion.status));
      if (assertion.expected !== undefined) push('cases:stepSummary.fieldAssertBody', `${t(matchLabelKey(assertion as KnownAction) || 'cases:matchContains')}「${clip(str(assertion.expected), 60)}」`);
    }
  }
  if (a.kind === 'sendSyslog') {
    push('cases:stepSummary.fieldSyslogTarget', `${str(a.protocol) === 'tcp' ? 'TCP' : 'UDP'} ${str(a.host)}:${a.port == null ? '514' : String(a.port)}`);
    push('cases:stepSummary.fieldSyslogPri', `${str(a.facility) || 'user'}.${str(a.severity) || 'info'}`);
    push('cases:stepSummary.fieldSyslogMessage', clip(str(a.message), 200));
  }
  return lines;
}

/** tooltip/抽屉预览用的完整描述：所有关键字段，不截断。带换行。
 *  多动作行按「【动作 i/N】」分块枚举整条 compiled 链，行级 instruction 附在末尾。 */
export function fullStepDescription(row: StepRowLike | unknown, t: TFunction): string {
  const r = (row ?? {}) as StepRowLike;
  const actions = pickAllActions(r);

  const footer: string[] = [];
  const pushFooter = (labelKey: string, v: string) => { if (v) footer.push(`${t(labelKey)}${v}`); };
  pushFooter('cases:stepSummary.fieldNaturalLang', str(r.instruction));
  if (isUncompiled(r)) footer.push(t('cases:stepSummary.compileStateUncompiled'));

  if (actions.length > 1) {
    const blocks = actions.map((a, i) => `${t('cases:stepSummary.actionBlock', { i: i + 1, n: actions.length })}\n${describeAction(a, t).join('\n')}`);
    if (footer.length) blocks.push(footer.join('\n'));
    return blocks.join('\n\n');
  }

  const lines = describeAction(actions[0] ?? {}, t);
  lines.push(...footer);

  if (lines.length === 0 || (lines.length === 1 && lines[0]?.startsWith(t('cases:stepSummary.fieldKind')))) {
    // 兜底：JSON 序列化所有字段，便于调试未识别 kind
    try { return JSON.stringify(row, null, 2); } catch { return String(row); }
  }
  return lines.join('\n');
}