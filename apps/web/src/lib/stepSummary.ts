// apps/web/src/lib/stepSummary.ts
import type { TFunction } from 'i18next';
/** Step overview (list/drawer preview/hover card) — human-readable summary, pure function, text via i18n keys. */

interface KnownAction {
  kind?: string;
  locator?: Array<{ strategy?: string; value?: string }>;
  intentLocator?: { semanticRole?: string; contextText?: string };
  /** iframe frame chain (recorder artifact): when non-empty the target is inside an iframe; the summary gets an [iframe] prefix. */
  frameChain?: Array<{ locator?: unknown }>;
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
  key?: unknown;
  [k: string]: unknown;
}

/** Step row shape: the dispatcher reads only compiled (the action column was DROPped); UI summary and kind inference share the same path.
 *  compiled is unknown[] to align with TestStep; the concrete dispatcher/AI compilation parses as StepAction[]. */
export interface StepRowLike {
  /** Row-level natural language. */
  instruction?: string | null;
  /** Executable DSL array; empty array/null/undefined means uncompiled. */
  compiled?: unknown[] | null;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Kind inference path: compiled[0]?.kind → ''. */
export function getKind(row: StepRowLike): string {
  const c = Array.isArray(row.compiled) ? row.compiled[0] : undefined;
  if (c && typeof c === 'object' && typeof (c as { kind?: string }).kind === 'string') {
    return (c as { kind: string }).kind;
  }
  return '';
}

/** Payload array chosen for the summary: the dispatcher executes compiled[0..n] in order. */
function pickAllActions(row: StepRowLike): KnownAction[] {
  if (!Array.isArray(row.compiled)) return [];
  return row.compiled.filter((c) => c && typeof c === 'object') as KnownAction[];
}

/** Whether uncompiled: aligned with the dispatcher — only a non-empty compiled array counts as compiled;
 *  empty array / null / undefined (legacy data's action column was DROPped; without compiled there is no replay) all count as uncompiled. */
export function isUncompiled(row: StepRowLike): boolean {
  return !Array.isArray(row.compiled) || row.compiled.length === 0;
}

/** Target description: semantic text first, else the first locator's strategy=value; with a frame chain adds an [iframe] prefix. */
function targetText(action: KnownAction): string {
  const prefix = Array.isArray(action.frameChain) && action.frameChain.length > 0 ? '[iframe] ' : '';
  const ctx = action.intentLocator?.contextText;
  if (ctx) return `${prefix}${ctx}`;
  const first = Array.isArray(action.locator) ? action.locator[0] : undefined;
  if (first && first.value) return `${prefix}${str(first.strategy) || 'css'}=${first.value}`;
  return '';
}

/** Generator values/match modes/field labels all go through i18n keys (rendered by t()). */
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

/** Match mode display key (unknown match returns ''). */
const MATCH_LABELS: Record<string, string> = {
  equals: 'cases:equalsOp',
  contains: 'cases:matchContains',
  notContains: 'cases:matchNotContains',
  regex: 'cases:stepSummary.matchRegex',
};

function matchLabelKey(action: KnownAction): string {
  return MATCH_LABELS[str(action.match)] ?? '';
}

/** Short summary of a single action (clipped), without the uncompiled prefix. */
function actionSummary(a: KnownAction, t: TFunction): string {
  const target = targetText(a);
  switch (a.kind) {
    case 'navigate':
      return t('cases:stepSummary.act.navigate', { url: clip(str(a.url), 40) });
    case 'click':
      return t('cases:stepSummary.act.click', { target: clip(target, 20) });
    case 'scroll':
      return t('cases:stepSummary.act.scroll', {
        target: clip(target, 20),
        top: str(a.scrollTop),
        left: str(a.scrollLeft),
      });
    case 'press':
      return t('cases:stepSummary.act.press', { target: clip(target, 20), key: str(a.key) || 'Enter' });
    case 'hover':
      return t('cases:stepSummary.act.hover', { target: clip(target, 20) });
    case 'check':
      return a.checked === false ? t('cases:stepSummary.act.uncheck') : t('cases:stepSummary.act.check');
    case 'waitFor':
      // Empty locator = fixed-duration wait; with locator = wait for the element to appear
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
    case 'observeLog': {
      const kw = Array.isArray(a.keywords) ? (a.keywords as unknown[]).map((v) => str(v)).filter(Boolean) : [];
      const base = kw.length
        ? t('cases:stepSummary.act.observeLogWithKw', { keywords: kw.join('/') })
        : t('cases:stepSummary.act.observeLog');
      const ref = str(a.syslogRef);
      return ref ? t('cases:stepSummary.act.observeLogWithRef', { ref, base }) : base;
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
    case 'sql': {
      const ref = str(a.dbRef);
      const oneLine = String(a.sql ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return ref
        ? t('cases:stepSummary.act.sqlWithRef', { db: ref, sql: oneLine })
        : t('cases:stepSummary.act.sql', { sql: oneLine });
    }
    default:
      return clip(JSON.stringify(a) ?? String(a), 40);
  }
}

/** Short summary for lists/hover cards (clipped).
 *  Takes the whole step row (instruction + compiled). Multi-action rows (AI emits a chain of DSL at once) enumerate the whole chain:
 *  "N steps total: a → b → …"; single-action rows keep the historical output unchanged. */
export function stepSummary(row: StepRowLike | unknown, t: TFunction): string {
  const r = (row ?? {}) as StepRowLike;
  const actions = pickAllActions(r);
  if (actions.length > 1) {
    return t('cases:stepSummary.multi', {
      count: actions.length,
      chain: actions.map((a) => actionSummary(a, t)).join(' → '),
    });
  }
  // Uncompiled (compiled is []) gets the UI prefix "⚠ uncompiled · "
  const uncompiledPrefix = isUncompiled(r) ? t('cases:stepSummary.uncompiledPrefix') : '';
  return uncompiledPrefix + actionSummary(actions[0] ?? {}, t);
}

/** Full field lines for a single action (reused by fullStepDescription; multi-action rows enumerated in blocks). */
function describeAction(a: KnownAction, t: TFunction): string[] {
  const lines: string[] = [];
  const push = (labelKey: string, v: string) => { if (v) lines.push(`${t(labelKey)}${v}`); };

  push('cases:stepSummary.fieldKind', str(a.kind));
  push('cases:stepSummary.fieldLocator', targetText(a));
  if (a.kind === 'press') push('cases:stepSummary.fieldKey', str(a.key) || 'Enter');
  if (a.kind === 'scroll') {
    push('cases:stepSummary.fieldScrollTop', str(a.scrollTop));
    push('cases:stepSummary.fieldScrollLeft', str(a.scrollLeft));
  }
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
    const assertion = a.assertion as { status?: unknown; match?: unknown; expected?: unknown; allowTransportFailure?: unknown } | undefined;
    if (assertion) {
      if (assertion.status !== undefined) push('cases:stepSummary.fieldAssertStatus', String(assertion.status));
      if (assertion.expected !== undefined) push('cases:stepSummary.fieldAssertBody', `${t(matchLabelKey(assertion as KnownAction) || 'cases:matchContains')}「${clip(str(assertion.expected), 60)}」`);
      if (assertion.allowTransportFailure === true) push('cases:stepSummary.fieldAssertTransportFailure', t('cases:httpAssertAllowTransportFailure'));
    }
  }
  if (a.kind === 'sendSyslog') {
    push('cases:stepSummary.fieldSyslogTarget', `${str(a.protocol) === 'tcp' ? 'TCP' : 'UDP'} ${str(a.host)}:${a.port == null ? '514' : String(a.port)}`);
    push('cases:stepSummary.fieldSyslogPri', `${str(a.facility) || 'user'}.${str(a.severity) || 'info'}`);
    push('cases:stepSummary.fieldSyslogMessage', clip(str(a.message), 200));
  }
  return lines;
}

/** Full description for tooltip/drawer preview: all key fields, unclipped. With line breaks.
 *  Multi-action rows enumerate the whole compiled chain in "【action i/N】" blocks, with the row-level instruction appended at the end. */
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
    // Fallback: JSON-serialize all fields, convenient for debugging unrecognized kinds
    try { return JSON.stringify(row, null, 2); } catch { return String(row); }
  }
  return lines.join('\n');
}