/**
 * Case-export data layer: DB queries + Chinese summaries of DSL steps + export tree building (pure functions, format-agnostic).
 * Serialization (xmind/docx) is rendered by the export-cases skill's python scripts from the buildExportPayload output —
 * the tree's levels and ordering (groups sorted by zh collation, version layer inserted for cross-version) are pinned in this file;
 * scripts only emit in payload order.
 * Hierarchy: root(version name) → [version (when cross-version)] → group → case → precondition/steps/expected outcome.
 * Predecessor: services/xmindExport.service.ts (2026-10-26 XMind export design).
 */

import { asc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groups, projectVersions, testCases, testSteps } from '../db/schema.js';

export interface ExportStepRow {
  order: number;
  instruction: string | null;
  /** Executable DSL array; null/empty = uncompiled. */
  compiled: unknown[] | null;
  /** Row-level assertion (assertText action jsonb). */
  assertion: unknown;
}

export interface ExportCaseRow {
  id: string;
  title: string;
  description: string | null;
  expectedOutcome: string | null;
  groupId: string;
  groupName: string;
  versionId: string;
  versionName: string;
  createdAt: Date;
  steps: ExportStepRow[];
}

/** Export tree node (JSON-safe: all strings; the dump tool serializes it straight to the skill script). */
export interface ExportNode {
  title: string;
  children?: ExportNode[];
}

const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface KnownAction {
  kind?: string;
  locator?: Array<{ strategy?: string; value?: string }>;
  intentLocator?: { contextText?: string };
  /** iframe frame chain (recorder artifact): non-empty means the target sits inside an iframe; summaries get the [iframe] prefix. */
  frameChain?: Array<{ locator?: unknown }>;
  url?: unknown;
  value?: unknown;
  sensitive?: boolean;
  name?: unknown;
  instruction?: unknown;
  equals?: unknown;
  match?: unknown;
  timeoutMs?: unknown;
  checked?: unknown;
  scrollTop?: unknown;
  scrollLeft?: unknown;
  method?: unknown;
  sql?: unknown;
  saveAs?: { varName?: unknown };
}

function targetText(a: KnownAction): string {
  const prefix = Array.isArray(a.frameChain) && a.frameChain.length > 0 ? '[iframe] ' : '';
  if (a.intentLocator?.contextText) return `${prefix}${a.intentLocator.contextText}`;
  const first = Array.isArray(a.locator) ? a.locator[0] : undefined;
  if (first?.value) return `${prefix}${first.strategy || 'css'}=${first.value}`;
  return '';
}

const MATCH_LABEL: Record<string, string> = {
  equals: '等于',
  contains: '包含',
  notContains: '不包含',
  regex: '正则匹配',
};

function valueText(a: KnownAction): string {
  if (a.sensitive) return '***';
  const v = a.value;
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'mode' in (v as Record<string, unknown>)) return '(自动生成)';
  return '';
}

function assertTextText(a: KnownAction): string {
  return `验证文本${MATCH_LABEL[str(a.match)] ?? '等于'}「${clip(str(a.equals), 30)}」`;
}

/** Server-side Chinese summary of a single DSL action: common actions rendered per kind; uncovered kinds degrade to the kind name / truncated JSON (server-side fixed Chinese, not routed through i18n). */
export function describeAction(a: KnownAction): string {
  const target = targetText(a);
  switch (a.kind) {
    case 'navigate': return `打开 ${clip(str(a.url), 60)}`;
    case 'click': return `点击 ${clip(target, 30)}`;
    case 'scroll': return `滚动 ${clip(target, 30)} 至 (${str(a.scrollTop)}, ${str(a.scrollLeft)})`;
    case 'hover': return `悬停 ${clip(target, 30)}`;
    case 'check': return a.checked === false ? '取消勾选' : '勾选';
    case 'waitFor': return target ? `等待 ${clip(target, 30)}` : `等待 ${typeof a.timeoutMs === 'number' ? a.timeoutMs : 5000}ms`;
    case 'assertVisible': return `验证 ${clip(target, 30)} 可见`;
    case 'fill': return `输入 ${clip(valueText(a), 40)}`;
    case 'select': return `选择 ${clip(str(a.value), 30)}`;
    case 'assertText': return assertTextText(a);
    case 'screenshot': return `截图 ${clip(str(a.name), 20)}`;
    case 'aiTask': return `AI 执行：${clip(str(a.instruction), 50)}`;
    case 'httpRequest': {
      const varName = str(a.saveAs?.varName);
      return `请求 ${str(a.method) || 'GET'} ${clip(str(a.url), 60)}${varName ? ` → {{${varName}}}` : ''}`;
    }
    case 'sql': return `执行 SQL：${clip(str(a.sql).replace(/\s+/g, ' ').trim(), 60)}`;
    default: return clip(str(a.kind) || JSON.stringify(a), 40);
  }
}

/** Multi-action chain "a → b → c". */
export function describeCompiled(compiled: unknown[] | null): string {
  const actions = (compiled ?? []).filter((c): c is KnownAction => !!c && typeof c === 'object');
  if (actions.length === 0) return '';
  return actions.map((a) => describeAction(a)).join(' → ');
}

/** Renders the row-level assertion (testSteps.assertion jsonb, assertText action). Returns '' when unparseable. */
export function describeAssertion(assertion: unknown): string {
  if (!assertion || typeof assertion !== 'object') return '';
  const a = assertion as KnownAction;
  if (a.kind !== 'assertText' || !str(a.equals)) return '';
  return assertTextText(a);
}

/** Step text: `N. instruction`; falls back to the DSL summary, then the assertion; all-empty steps are skipped. */
export function stepLine(i: number, s: ExportStepRow): string {
  const text = s.instruction?.trim() || describeCompiled(s.compiled) || describeAssertion(s.assertion);
  return `${i + 1}. ${text}`;
}

/** Splits expectedOutcome into numbered lines; an empty array = nothing to show. */
export function outcomeLines(expectedOutcome: string | null, steps: ExportStepRow[]): string[] {
  const lines = (expectedOutcome ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 0) return lines.map((l, i) => `${i + 1}. ${l}`);
  const assertions = steps.map((s) => describeAssertion(s.assertion)).filter(Boolean);
  return assertions.map((l, i) => `${i + 1}. ${l}`);
}

/** Tree building: groups sorted by name, cases by createdAt; a version layer is inserted for cross-version exports. */
export function buildExportTree(cases: ExportCaseRow[], rootTitle: string): ExportNode {
  const sorted = [...cases].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.title.localeCompare(b.title, 'zh'),
  );

  function caseNode(c: ExportCaseRow): ExportNode {
    const children: ExportNode[] = [];
    if (c.description?.trim()) {
      children.push({ title: '预置条件', children: [{ title: c.description.trim() }] });
    }
    const stepLines = c.steps
      .map((s, i) => stepLine(i, s))
      .filter((t) => !/^\d+\. $/.test(t)); // steps whose text is entirely empty are skipped
    if (stepLines.length > 0) children.push({ title: '测试步骤', children: stepLines.map((t) => ({ title: t })) });
    const outcomes = outcomeLines(c.expectedOutcome, c.steps);
    if (outcomes.length > 0) children.push({ title: '预期结果', children: outcomes.map((t) => ({ title: t })) });
    return { title: c.title, ...(children.length > 0 ? { children } : {}) };
  }

  function groupNode(groupName: string, groupCases: ExportCaseRow[]): ExportNode {
    return { title: groupName, children: groupCases.map(caseNode) };
  }

  const byGroup = new Map<string, ExportCaseRow[]>();
  for (const c of sorted) {
    const list = byGroup.get(c.groupName) ?? [];
    list.push(c);
    byGroup.set(c.groupName, list);
  }

  const byVersion = new Map<string, ExportCaseRow[]>();
  for (const c of sorted) {
    const list = byVersion.get(c.versionName) ?? [];
    list.push(c);
    byVersion.set(c.versionName, list);
  }

  if (byVersion.size > 1) {
    return {
      title: rootTitle,
      children: [...byVersion.entries()].map(([vName, vCases]) => {
        const groups = new Map<string, ExportCaseRow[]>();
        for (const c of vCases) {
          const list = groups.get(c.groupName) ?? [];
          list.push(c);
          groups.set(c.groupName, list);
        }
        return {
          title: vName,
          children: [...groups.keys()].sort((a, b) => a.localeCompare(b, 'zh')).map((g) => groupNode(g, groups.get(g)!)),
        };
      }),
    };
  }

  return {
    title: rootTitle,
    children: [...byGroup.keys()].sort((a, b) => a.localeCompare(b, 'zh')).map((g) => groupNode(g, byGroup.get(g)!)),
  };
}

/** Bulk-fetches cases + steps + group/version names. caseIds that resolve to nothing are silently ignored (visibility is the caller's job). */
export async function loadExportCases(caseIds: string[]): Promise<ExportCaseRow[]> {
  if (caseIds.length === 0) return [];
  const rows = await db
    .select({
      id: testCases.id,
      title: testCases.title,
      description: testCases.description,
      expectedOutcome: testCases.expectedOutcome,
      groupId: testCases.groupId,
      versionId: testCases.versionId,
      createdAt: testCases.createdAt,
    })
    .from(testCases)
    .where(inArray(testCases.id, caseIds));
  if (rows.length === 0) return [];
  const stepRows = await db
    .select({
      caseId: testSteps.caseId,
      order: testSteps.order,
      instruction: testSteps.instruction,
      compiled: testSteps.compiled,
      assertion: testSteps.assertion,
    })
    .from(testSteps)
    .where(inArray(testSteps.caseId, rows.map((r) => r.id)))
    .orderBy(asc(testSteps.order));
  const gids = [...new Set(rows.map((r) => r.groupId))];
  const groupRows = await db.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, gids));
  const gName = new Map(groupRows.map((g) => [g.id, g.name]));
  const vids = [...new Set(rows.map((r) => r.versionId))];
  const versionRows = await db.select({ id: projectVersions.id, name: projectVersions.name }).from(projectVersions).where(inArray(projectVersions.id, vids));
  const vName = new Map(versionRows.map((v) => [v.id, v.name]));
  const stepsByCase = new Map<string, ExportStepRow[]>();
  for (const s of stepRows) {
    const list = stepsByCase.get(s.caseId) ?? [];
    list.push({ order: s.order, instruction: s.instruction, compiled: s.compiled, assertion: s.assertion });
    stepsByCase.set(s.caseId, list);
  }
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    expectedOutcome: r.expectedOutcome,
    groupId: r.groupId,
    groupName: gName.get(r.groupId) ?? '未分组',
    versionName: vName.get(r.versionId) ?? '未命名版本',
    versionId: r.versionId,
    createdAt: r.createdAt,
    steps: (stepsByCase.get(r.id) ?? []).sort((a, b) => a.order - b.order),
  }));
}

/** Export payload: the JSON shape the dump_cases_payload tool writes to disk and the export-cases skill script consumes.
 *  baseName feeds the script's file name (`{baseName}-用例-{时间戳}.{ext}`); the tree's leaves are already rendered text lines. */
export interface ExportPayload {
  baseName: string;
  count: number;
  tree: ExportNode;
}

/** Composition: a set of cases → JSON-safe payload. rootTitle defaults to the first case's version name. */
export function buildExportPayload(cases: ExportCaseRow[], rootTitle?: string): ExportPayload {
  const baseName = rootTitle?.trim() || cases[0]!.versionName;
  return {
    baseName,
    count: cases.length,
    tree: buildExportTree(cases, baseName),
  };
}
