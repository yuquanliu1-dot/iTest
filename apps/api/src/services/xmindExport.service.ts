/**
 * 用例导出 XMind：树构建（纯函数）。
 * 层级：root(版本名) → [版本(跨版本时)] → 分组 → 用例 → 预置条件/测试步骤/预期结果。
 * 设计文档：docs/superpowers/specs/2026-10-26-case-export-xmind-design.md
 */

export interface ExportStepRow {
  order: number;
  instruction: string | null;
  /** 可执行 DSL 数组；null/空 = 未编译。 */
  compiled: unknown[] | null;
  /** 行级断言（assertText action jsonb）。 */
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

export interface XmindNode {
  title: string;
  children?: XmindNode[];
}

const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface KnownAction {
  kind?: string;
  locator?: Array<{ strategy?: string; value?: string }>;
  intentLocator?: { contextText?: string };
  url?: unknown;
  value?: unknown;
  sensitive?: boolean;
  name?: unknown;
  instruction?: unknown;
  equals?: unknown;
  match?: unknown;
  timeoutMs?: unknown;
  checked?: unknown;
  method?: unknown;
  sql?: unknown;
  saveAs?: { varName?: unknown };
}

function targetText(a: KnownAction): string {
  if (a.intentLocator?.contextText) return a.intentLocator.contextText;
  const first = Array.isArray(a.locator) ? a.locator[0] : undefined;
  if (first?.value) return `${first.strategy || 'css'}=${first.value}`;
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

/** 单个 DSL 动作的服务端中文摘要：常用动作逐 kind 渲染；未覆盖的 kind 降级为 kind 名/JSON 截断（服务端固定中文不走 i18n）。 */
export function describeAction(a: KnownAction): string {
  const target = targetText(a);
  switch (a.kind) {
    case 'navigate': return `打开 ${clip(str(a.url), 60)}`;
    case 'click': return `点击 ${clip(target, 30)}`;
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

/** 多动作链「a → b → c」。 */
export function describeCompiled(compiled: unknown[] | null): string {
  const actions = (compiled ?? []).filter((c): c is KnownAction => !!c && typeof c === 'object');
  if (actions.length === 0) return '';
  return actions.map((a) => describeAction(a)).join(' → ');
}

/** 行级断言（testSteps.assertion jsonb，assertText action）渲染。不可解析返回 ''。 */
export function describeAssertion(assertion: unknown): string {
  if (!assertion || typeof assertion !== 'object') return '';
  const a = assertion as KnownAction;
  if (a.kind !== 'assertText' || !str(a.equals)) return '';
  return assertTextText(a);
}

/** 步骤文本：`N. instruction`，空则 DSL 摘要，再空则断言，全空跳过。 */
export function stepLine(i: number, s: ExportStepRow): string {
  const text = s.instruction?.trim() || describeCompiled(s.compiled) || describeAssertion(s.assertion);
  return `${i + 1}. ${text}`;
}

/** expectedOutcome 多行拆编号；空数组 = 没有内容。 */
export function outcomeLines(expectedOutcome: string | null, steps: ExportStepRow[]): string[] {
  const lines = (expectedOutcome ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 0) return lines.map((l, i) => `${i + 1}. ${l}`);
  const assertions = steps.map((s) => describeAssertion(s.assertion)).filter(Boolean);
  return assertions.map((l, i) => `${i + 1}. ${l}`);
}

/** 树构建：分组按名称排序，用例按 createdAt 排序；跨版本时插版本层。 */
export function buildXmindTree(cases: ExportCaseRow[], rootTitle: string): XmindNode {
  const sorted = [...cases].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.title.localeCompare(b.title, 'zh'),
  );

  function caseNode(c: ExportCaseRow): XmindNode {
    const children: XmindNode[] = [];
    if (c.description?.trim()) {
      children.push({ title: '预置条件', children: [{ title: c.description.trim() }] });
    }
    const stepLines = c.steps
      .map((s, i) => stepLine(i, s))
      .filter((t) => !/^\d+\. $/.test(t)); // 全空文本的步骤跳过
    if (stepLines.length > 0) children.push({ title: '测试步骤', children: stepLines.map((t) => ({ title: t })) });
    const outcomes = outcomeLines(c.expectedOutcome, c.steps);
    if (outcomes.length > 0) children.push({ title: '预期结果', children: outcomes.map((t) => ({ title: t })) });
    return { title: c.title, ...(children.length > 0 ? { children } : {}) };
  }

  function groupNode(groupName: string, groupCases: ExportCaseRow[]): XmindNode {
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
