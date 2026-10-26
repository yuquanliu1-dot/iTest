# 用例导出 XMind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用例可导出为 XMind 思维导图（版本→分组→用例→预置条件/测试步骤/预期结果），列表页按钮 + AI 助手下载卡两个入口。

**Architecture:** 服务端统一生成（`apps/api/src/services/xmindExport.service.ts` 纯函数树构建 + 双格式序列化 + archiver 打 zip）。列表页 `POST /api/cases/export-xmind` 直下二进制；AI 工具 `export_cases_xmind` 生成同一 buffer，经新 SSE `artifact` 事件推送下载卡，`GET /api/assistant/threads/:id/artifacts/:token` 换文件。

**Tech Stack:** vitest（api 单测）、archiver（已在 api 依赖）、Express Router、zustand（web 事件 store）、i18next。

**Spec:** `docs/superpowers/specs/2026-10-26-case-export-xmind-design.md`

**已知约束：**
- `index.ts` 未导出 app、仓库无路由级测试先例 → 路由层用 dev server + curl 手工冒烟（Task 7），自动化只覆盖纯函数。
- web i18n 有 key 对照测试（`apps/web/src/i18n/i18n.test.ts`），zh-CN 与 en-US 必须同步加 key。
- 测试运行在仓库根：`pnpm --filter api test`（vitest 已配 `TESTCONTAINSERS_RYUK_DISABLED`）。

---

### Task 1: 树构建纯函数 `buildXmindTree`（TDD）

**Files:**
- Create: `apps/api/src/services/xmindExport.service.ts`
- Test: `apps/api/src/services/xmindExport.service.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/api/src/services/xmindExport.service.test.ts` 全文：

```ts
import { describe, it, expect } from 'vitest';
import { buildXmindTree, type ExportCaseRow } from './xmindExport.service.js';

function mkCase(over: Partial<ExportCaseRow> = {}): ExportCaseRow {
  return {
    id: over.id ?? crypto.randomUUID(),
    title: over.title ?? '验证登录成功',
    description: over.description ?? '1.系统运行正常',
    expectedOutcome: over.expectedOutcome ?? '1.跳转首页',
    groupId: over.groupId ?? 'g1',
    groupName: over.groupName ?? '登录模块',
    versionId: over.versionId ?? 'v1',
    versionName: over.versionName ?? 'V2.3',
    createdAt: over.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    steps: over.steps ?? [
      { order: 1, instruction: '打开登录页', compiled: null, assertion: null },
      { order: 2, instruction: '', compiled: [{ kind: 'click', locator: [{ strategy: 'css', value: '.btn-login' }] }], assertion: null },
      { order: 3, instruction: '', compiled: null, assertion: { kind: 'assertText', match: 'equals', equals: '登录成功' } },
    ],
  };
}

describe('buildXmindTree', () => {
  it('root=版本名，一层分组、二层用例、三层三要素', () => {
    const tree = buildXmindTree([mkCase()], 'V2.3');
    expect(tree.title).toBe('V2.3');
    expect(tree.children).toHaveLength(1);
    const group = tree.children![0]!;
    expect(group.title).toBe('登录模块');
    expect(group.children).toHaveLength(1);
    const c = group.children![0]!;
    expect(c.title).toBe('验证登录成功');
    expect(c.children!.map((n) => n.title)).toEqual(['预置条件', '测试步骤', '预期结果']);
    const steps = c.children![1]!.children!;
    expect(steps[0]!.title).toBe('1. 打开登录页');
    // instruction 空 → DSL 摘要
    expect(steps[1]!.title).toBe('2. 点击 css=.btn-login');
    // 无 instruction 无 compiled → assertion 兜底渲染
    expect(steps[2]!.title).toBe('3. 验证文本等于「登录成功」');
  });

  it('同分组多用例合并到一个分组节点；分组按名称排序；用例按 createdAt 排序', () => {
    const a = mkCase({ title: '用例A', groupName: 'B组', createdAt: new Date('2026-01-02T00:00:00Z') });
    const b = mkCase({ title: '用例B', groupName: 'B组', createdAt: new Date('2026-01-01T00:00:00Z') });
    const c = mkCase({ title: '用例C', groupName: 'A组' });
    const tree = buildXmindTree([a, b, c], 'V2.3');
    expect(tree.children!.map((g) => g.title)).toEqual(['A组', 'B组']);
    expect(tree.children![1]!.children!.map((x) => x.title)).toEqual(['用例B', '用例A']);
  });

  it('跨版本时在 root 与分组之间插版本层', () => {
    const tree = buildXmindTree(
      [mkCase({ versionName: 'V2.3' }), mkCase({ versionName: 'V2.4' })],
      '导出',
    );
    expect(tree.children!.map((n) => n.title)).toEqual(['V2.3', 'V2.4']);
    expect(tree.children![0]!.children![0]!.title).toBe('登录模块');
  });

  it('空字段省略：无 description/expectedOutcome/steps 的用例只出标题节点', () => {
    const tree = buildXmindTree(
      [mkCase({ description: null, expectedOutcome: null, steps: [] })],
      'V2.3',
    );
    const c = tree.children![0]!.children![0]!;
    expect(c.children).toBeUndefined();
  });

  it('expectedOutcome 优先，多行拆编号；为空时逐条行级断言兜底', () => {
    const withOutcome = buildXmindTree([mkCase({ expectedOutcome: '第一行\n第二行' })], 'V').children![0]!.children![0]!;
    expect(withOutcome.children![2]!.children!.map((n) => n.title)).toEqual(['1. 第一行', '2. 第二行']);
    const noOutcome = buildXmindTree(
      [mkCase({ expectedOutcome: null, steps: [
        { order: 1, instruction: 'a', compiled: null, assertion: { kind: 'assertText', match: 'contains', equals: '成功' } },
      ] })],
      'V',
    ).children![0]!.children![0]!;
    expect(noOutcome.children![2]!.children![0]!.title).toBe('1. 验证文本包含「成功」');
  });

  it('多动作 compiled 链用 → 串联；敏感值掩码', () => {
    const tree = buildXmindTree(
      [mkCase({ steps: [
        { order: 1, instruction: '', compiled: [
          { kind: 'fill', locator: [{ strategy: 'css', value: '#pw' }], value: 'secret', sensitive: true },
          { kind: 'click', locator: [{ strategy: 'css', value: '.submit' }] },
        ], assertion: null },
      ] })],
      'V',
    );
    expect(tree.children![0]!.children![0]!.children![1]!.children![0]!.title)
      .toBe('1. 输入 *** → 点击 css=.submit');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter api exec vitest run src/services/xmindExport.service.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

`apps/api/src/services/xmindExport.service.ts`（本 Task 只写树构建与渲染辅助，序列化/打包在 Task 2/3 补）：

```ts
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

/** 单个 DSL 动作的服务端中文摘要（与 web stepSummary 同口径，固定中文不走 i18n）。 */
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
    case 'assertText': return `验证文本${MATCH_LABEL[str(a.match)] ?? '等于'}「${clip(str(a.equals), 30)}」`;
    case 'screenshot': return `截图 ${clip(str(a.name), 20)}`;
    case 'aiTask': return `AI 执行：${clip(str(a.instruction), 50)}`;
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
  return `验证文本${MATCH_LABEL[str(a.match)] ?? '等于'}「${clip(str(a.equals), 30)}」`;
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter api exec vitest run src/services/xmindExport.service.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/xmindExport.service.ts apps/api/src/services/xmindExport.service.test.ts
git commit -m "feat(api): xmind 导出树构建纯函数——分组/版本分层 + 步骤/断言渲染"
```

---

### Task 2: 双格式序列化 `renderXmindWorkbook`（TDD）

**Files:**
- Modify: `apps/api/src/services/xmindExport.service.ts`（追加）
- Test: `apps/api/src/services/xmindExport.service.test.ts`（追加）

- [ ] **Step 1: 追加失败测试**

在 `xmindExport.service.test.ts` 末尾追加：

```ts
import { renderXmindWorkbook, type XmindNode } from './xmindExport.service.js';

describe('renderXmindWorkbook', () => {
  const tree: XmindNode = {
    title: 'V2.3 <root> & "引号"',
    children: [{ title: '分组A', children: [{ title: '用例一\n第二行' }] }],
  };
  const wb = renderXmindWorkbook(tree);

  it('四件齐全', () => {
    expect(Object.keys(wb).sort()).toEqual(['content.json', 'content.xml', 'manifest.json', 'metadata.json']);
  });

  it('content.json 结构与参考文件一致（单 sheet + rootTopic + structureClass）', () => {
    const sheets = JSON.parse(wb['content.json']!) as Array<{ class: string; rootTopic: Record<string, unknown> }>;
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.class).toBe('sheet');
    expect(sheets[0]!.rootTopic.title).toBe('V2.3 <root> & "引号"');
    expect(sheets[0]!.rootTopic.structureClass).toBe('org.xmind.ui.logic.right');
    const children = (sheets[0]!.rootTopic.children as { attached: Array<{ title: string }> }).attached;
    expect(children[0]!.title).toBe('分组A');
  });

  it('content.xml well-formed 且特殊字符已转义、换行保留', () => {
    const xml = wb['content.xml']!;
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('<xmap-content');
    expect(xml).toContain('V2.3 &lt;root&gt; &amp; "引号"');
    expect(xml).toContain('用例一\n第二行');
    // 粗校验标签配对
    expect(xml.match(/<topic /g)?.length).toBe(xml.match(/<\/topic>/g)?.length);
  });

  it('metadata/manifest 为固定形状', () => {
    expect(JSON.parse(wb['metadata.json']!)).toMatchObject({ creator: { name: 'iTest' } });
    const manifest = JSON.parse(wb['manifest.json']!) as { 'file-entries': Record<string, unknown> };
    expect(Object.keys(manifest['file-entries']).sort()).toEqual(['content.json', 'content.xml', 'metadata.json']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter api exec vitest run src/services/xmindExport.service.test.ts`
Expected: FAIL（renderXmindWorkbook 未导出）

- [ ] **Step 3: 实现（追加到 xmindExport.service.ts）**

```ts
import { randomUUID } from 'node:crypto';

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function topicToJson(n: XmindNode, isRoot: boolean): Record<string, unknown> {
  const t: Record<string, unknown> = { id: randomUUID(), class: 'topic', title: n.title };
  if (isRoot) t.structureClass = 'org.xmind.ui.logic.right';
  if (n.children?.length) {
    t.children = { attached: n.children.map((c) => topicToJson(c, false)) };
  }
  return t;
}

function topicToXml(n: XmindNode, isRoot: boolean): string {
  const attrs = isRoot ? ' structure-class="org.xmind.ui.logic.right"' : '';
  const inner = `<title>${escapeXml(n.title)}</title>`;
  const children = n.children?.length
    ? `<children><topics type="attached">${n.children.map((c) => topicToXml(c, false)).join('')}</topics></children>`
    : '';
  return `<topic id="${randomUUID()}"${attrs}>${inner}${children}</topic>`;
}

/** 双格式序列化：content.json(XMind 2020+/ZEN) + content.xml(XMind 8) + metadata + manifest。 */
export function renderXmindWorkbook(root: XmindNode): Record<string, string> {
  const contentJson = JSON.stringify([
    {
      id: randomUUID(),
      class: 'sheet',
      title: 'Sheet 1',
      rootTopic: topicToJson(root, true),
    },
  ]);
  const contentXml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0">
  <sheet id="${randomUUID()}">
    ${topicToXml(root, true)}
  </sheet>
</xmap-content>
`;
  const metadataJson = JSON.stringify({
    dataStructureVersion: '2',
    layoutEngineVersion: '3',
    creator: { name: 'iTest', version: '1.0' },
  });
  const manifestJson = JSON.stringify({
    'file-entries': { 'content.json': {}, 'content.xml': {}, 'metadata.json': {} },
  });
  return {
    'content.json': contentJson,
    'content.xml': contentXml,
    'metadata.json': metadataJson,
    'manifest.json': manifestJson,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter api exec vitest run src/services/xmindExport.service.test.ts`
Expected: PASS（10 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/xmindExport.service.ts apps/api/src/services/xmindExport.service.test.ts
git commit -m "feat(api): xmind 双格式序列化——content.json + content.xml 同内容"
```

---

### Task 3: 数据装载与 zip 打包 `loadExportCases` / `buildXmindBuffer`（TDD）

**Files:**
- Modify: `apps/api/src/services/xmindExport.service.ts`（追加）
- Test: `apps/api/src/services/xmindExport.service.test.ts`（追加）

- [ ] **Step 1: 追加失败测试（zip 部分）**

```ts
import { zipXmind, exportFilename } from './xmindExport.service.js';

describe('zipXmind + exportFilename', () => {
  it('产出合法 zip（PK 魔数）且包含全部条目体积', async () => {
    const buf = await zipXmind({ 'content.json': '{"a":1}', 'content.xml': '<x/>' });
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    expect(buf.length).toBeGreaterThan(100);
  });
  it('文件名带版本名与时间戳', () => {
    const name = exportFilename('V2.3', new Date('2026-10-26T08:09:10'));
    expect(name).toBe('V2.3-用例-20261026-080910.xmind');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter api exec vitest run src/services/xmindExport.service.test.ts`
Expected: FAIL（zipXmind 未导出）

- [ ] **Step 3: 实现（追加）**

```ts
import archiver from 'archiver';
import { asc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groups, projectVersions, testCases, testSteps } from '../db/schema.js';

/** 内存打 zip。 */
export async function zipXmind(entries: Record<string, string>): Promise<Buffer> {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', () => resolve());
    archive.on('error', reject);
  });
  for (const [name, content] of Object.entries(entries)) archive.append(content, { name });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

export function exportFilename(versionName: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${versionName}-用例-${ts}.xmind`;
}

/** 批量拉用例 + 步骤 + 分组名/版本名。caseIds 里查不到的静默忽略（调用方负责可见性）。 */
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
    versionId: r.versionId,
    versionName: vName.get(r.versionId) ?? '未命名版本',
    createdAt: r.createdAt,
    steps: (stepsByCase.get(r.id) ?? []).sort((a, b) => a.order - b.order),
  }));
}

/** 组合：用例集合 → {zip buffer, 文件名}。rootTitle 缺省用第一个用例的版本名。 */
export async function buildXmindBuffer(
  cases: ExportCaseRow[],
  rootTitle?: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const filename = exportFilename(cases[0]!.versionName);
  const tree = buildXmindTree(cases, rootTitle?.trim() || cases[0]!.versionName);
  const buffer = await zipXmind(renderXmindWorkbook(tree));
  return { buffer, filename };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter api exec vitest run src/services/xmindExport.service.test.ts`
Expected: PASS（12 tests）

- [ ] **Step 5: typecheck**

Run: `pnpm --filter api typecheck`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/xmindExport.service.ts apps/api/src/services/xmindExport.service.test.ts
git commit -m "feat(api): xmind 导出数据装载与 zip 打包（archiver 内存打包）"
```

---

### Task 4: 列表页导出路由 `POST /api/cases/export-xmind`

**Files:**
- Modify: `apps/api/src/routes/cases.ts`
- Modify: `apps/api/src/lib/`（无——RFC 5987 helper 放在 Task 6 的 artifacts.ts，此处内联）

- [ ] **Step 1: 加路由**

在 `apps/api/src/routes/cases.ts` 中，`casesRoute.get('/solidify-batches', ...)` **之前**（单段路径避开未来动态段抢占，与 /solidify-batches 同款注释）插入：

```ts
/** 用例导出 XMind（勾选集合/当前筛选结果全量 id，前端始终传显式 caseIds）。
 *  注册在动态段之前——单段路径 /export-xmind，与 /solidify-batches 同款预防。 */
casesRoute.post('/export-xmind', async (req, res) => {
  const body = z.object({
    caseIds: z.array(z.string().uuid()).min(1).max(2000),
    rootTitle: z.string().min(1).max(200).optional(),
  }).parse(req.body);
  const cases = await loadExportCases(body.caseIds);
  // 可见性：分组 → 项目，仅保留调用者可见项目内的用例；全不可见 → 404
  const gids = [...new Set(cases.map((c) => c.groupId))];
  const groupProjects = gids.length
    ? await db.select({ id: groups.id, projectId: groups.projectId }).from(groups).where(inArray(groups.id, gids))
    : [];
  const visiblePids = new Set(await visibleProjectIds(req.user!));
  const visibleSet = new Set(groupProjects.filter((g) => visiblePids.has(g.projectId)).map((g) => g.id));
  const visibleCases = cases.filter((c) => visibleSet.has(c.groupId));
  if (visibleCases.length === 0) throw new HttpError(404, 'not_found', 'no visible cases to export');
  const { buffer, filename } = await buildXmindBuffer(visibleCases, body.rootTitle);
  const asciiName = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(buffer);
});
```

同文件 import 行追加（第 8 行 `cases.service` import 后）：

```ts
import { loadExportCases, buildXmindBuffer } from '../services/xmindExport.service.js';
```

（`visibleProjectIds`、`groups`、`inArray`、`z`、`HttpError` 该文件已有 import。）

- [ ] **Step 2: typecheck**

Run: `pnpm --filter api typecheck`
Expected: 无错误

- [ ] **Step 3: dev 冒烟（可选，无 dev server 时跳过，Task 7 统一冒烟）**

```bash
cd apps/api && curl -s -c /tmp/itest-cookie.txt -X POST http://localhost:54321/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Itest@2026"}' | head -c 200
curl -s -b /tmp/itest-cookie.txt -X POST http://localhost:54321/api/cases/export-xmind -H 'Content-Type: application/json' -d '{"caseIds":["<任一真实caseId>"]}' -o /tmp/export-smoke.xmind -w '%{http_code} %{content_type}\n'
file /tmp/export-smoke.xmind   # 期望: Zip archive data
unzip -l /tmp/export-smoke.xmind  # 期望: content.json/content.xml/metadata.json/manifest.json
```
Expected: `200 application/zip`；zip 含四件。

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/cases.ts
git commit -m "feat(api): POST /cases/export-xmind——显式 caseIds 导出 + 项目可见性过滤"
```

---

### Task 5: 列表页前端按钮 + api client + i18n

**Files:**
- Modify: `apps/web/src/api/client.ts`（cases 段 + 下载函数）
- Modify: `apps/web/src/pages/GroupsPage.tsx:907-941`（selection.actions）
- Modify: `apps/web/src/i18n/locales/zh-CN/groups.json`、`apps/web/src/i18n/locales/en-US/groups.json`

- [ ] **Step 1: api client 加导出方法**

`apps/web/src/api/client.ts` 的 `cases: {` 段内（`updateStatusBatch` 之后）追加：

```ts
    /** 导出 XMind：fetch → blob（request<T> 走 JSON 解析，二进制单独走 fetch，同 downloadExtensionZip）。 */
    exportXmind: async (caseIds: string[], rootTitle?: string): Promise<{ blob: Blob; filename: string }> => {
      const r = await fetch(`${BASE}/cases/export-xmind`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseIds, ...(rootTitle ? { rootTitle } : {}) }),
      });
      if (!r.ok) {
        if (r.status === 401) throw new ApiError(401, '未登录或会话已过期');
        const body = await r.json().catch(() => ({}));
        throw new ApiError(r.status, body.message ?? `HTTP ${r.status}`);
      }
      const dispo = r.headers.get('Content-Disposition') ?? '';
      const m = dispo.match(/filename\*=UTF-8''([^;]+)/);
      const filename = m ? decodeURIComponent(m[1]!) : 'cases.xmind';
      return { blob: await r.blob(), filename };
    },
```

- [ ] **Step 2: i18n key**

`apps/web/src/i18n/locales/zh-CN/groups.json` 加（`batchSolidify` 附近）：

```json
  "exportXmind": "导出 XMind",
  "exportingXmind": "导出中…",
  "exportXmindFailed": "导出失败",
```

`apps/web/src/i18n/locales/en-US/groups.json` 加：

```json
  "exportXmind": "Export XMind",
  "exportingXmind": "Exporting…",
  "exportXmindFailed": "Export failed",
```

- [ ] **Step 3: GroupsPage 加按钮**

`apps/web/src/pages/GroupsPage.tsx`：

批量 mutation 区（`batchSolidify` useMutation 之后，约 :352）加：

```tsx
	const [exportingXmind, setExportingXmind] = useState(false);
	const { toast } = useToast(); // 若该页已有 toast hook 用既有变量名
	const exportXmind = async () => {
		const ids = selection.count > 0 ? selection.ids : rows.map((r) => r.id);
		if (ids.length === 0) return;
		setExportingXmind(true);
		try {
			const { blob, filename } = await api.cases.exportXmind(ids);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			a.click();
			URL.revokeObjectURL(url);
		} catch {
			toast({ title: t('groups:exportXmindFailed'), variant: 'destructive' });
		} finally {
			setExportingXmind(false);
		}
	};
```

注意：先 grep 该页是否已有 toast 用法（`grep -n "toast" apps/web/src/pages/GroupsPage.tsx`）。若无 toast 先例，用该页批量操作失败时同款提示方式（`useToast` 来自 `@/components/ui/toast` 或项目内等价物，以实际为准；两侧都不存在时改为 `alert(t('groups:exportXmindFailed'))`——保持与页面现状一致的最小方案）。

`selection.actions`（约 :907）里「批量固化」按钮之后加：

```tsx
										<Button size="sm" variant="ghost" disabled={exportingXmind || rows.length === 0} onClick={exportXmind}>
											<Icon name="download" size={12} />
												{exportingXmind ? t('groups:exportingXmind') : t('groups:exportXmind')}
										</Button>
```

`rows` 变量名以该页实际为准（`grep -n "const rows" apps/web/src/pages/GroupsPage.tsx`——DataTable 的 `rows={rows}` 已存在，同名可用）。
`Icon name="download"`：先 `grep -rn '"download"' apps/web/src/components/Icon*` 确认图标存在；不存在则用 `name="copy"` 同款已有图标。

- [ ] **Step 4: web typecheck + i18n 测试**

Run: `pnpm --filter web typecheck && pnpm --filter web test -- src/i18n/i18n.test.ts`
Expected: 均通过（zh/en key 齐全）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/pages/GroupsPage.tsx apps/web/src/i18n/locales/zh-CN/groups.json apps/web/src/i18n/locales/en-US/groups.json
git commit -m "feat(web): 用例列表「导出 XMind」按钮——勾选优先/无勾选导出当前筛选结果"
```

---

### Task 6: artifact 文件通道（登记 + 下载路由）

**Files:**
- Create: `apps/api/src/pi/space/artifacts.ts`
- Modify: `apps/api/src/pi/space/router.ts`

- [ ] **Step 1: 写 artifacts.ts**

`apps/api/src/pi/space/artifacts.ts` 全文：

```ts
/**
 * AI 产出文件的临时托管（thread 级）。
 * 工具生成 buffer → registerArtifact 落盘 .data/exports/<token>.xmind → SSE artifact 事件
 * 携 token/name/size → 前端下载卡 → GET /threads/:id/artifacts/:token 换文件。
 * token 30min TTL；登记时惰性清扫过期文件（含进程重启后的磁盘孤儿，按 mtime）。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const EXPORT_DIR = join(process.cwd(), '.data', 'exports');
const TTL_MS = 30 * 60_000;

interface ArtifactRecord {
  path: string;
  name: string;
  size: number;
  expiresAt: number;
}

const artifacts = new Map<string, ArtifactRecord>();

async function sweep(): Promise<void> {
  await mkdir(EXPORT_DIR, { recursive: true }).catch(() => {});
  let names: string[] = [];
  try {
    names = await readdir(EXPORT_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    names
      .filter((n) => n.endsWith('.xmind'))
      .map(async (n) => {
        const p = join(EXPORT_DIR, n);
        try {
          const st = await stat(p);
          if (now - st.mtimeMs > TTL_MS) await unlink(p);
        } catch {
          /* 已被并发清扫 */
        }
      }),
  );
  for (const [t, a] of artifacts) {
    if (now > a.expiresAt) artifacts.delete(t);
  }
}

export async function registerArtifact(buffer: Buffer, name: string): Promise<string> {
  void sweep();
  await mkdir(EXPORT_DIR, { recursive: true });
  const token = randomUUID();
  const path = join(EXPORT_DIR, `${token}.xmind`);
  await writeFile(path, buffer);
  artifacts.set(token, { path, name, size: buffer.length, expiresAt: Date.now() + TTL_MS });
  return token;
}

/** 过期/不存在返回 null（路由层转 410）。 */
export function getArtifact(token: string): ArtifactRecord | null {
  const a = artifacts.get(token);
  if (!a) return null;
  if (Date.now() > a.expiresAt) {
    artifacts.delete(token);
    return null;
  }
  return a;
}

export async function readArtifactFile(a: ArtifactRecord): Promise<Buffer> {
  return readFile(a.path);
}

/** RFC 5987：ASCII 兜底 + filename* 中文。 */
export function contentDispositionUtf8(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
```

- [ ] **Step 2: router.ts 加下载路由**

`apps/api/src/pi/space/router.ts`，在 `spaceRoute.use(stageRoute);`（约 :390）之前插入：

```ts
/** AI 产出文件下载（artifact 事件携带的 token 换文件流）。
 *  鉴权 = 线程可见（与 SSE 同款）；过期/不存在 410；文件被清扫 404。 */
spaceRoute.get('/threads/:id/artifacts/:token', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const a = getArtifact(req.params.token!);
  if (!a) throw new HttpError(410, 'artifact_expired', '文件已过期或不存在');
  let buf: Buffer;
  try {
    buf = await readArtifactFile(a);
  } catch {
    throw new HttpError(404, 'not_found', '文件已被清理');
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDispositionUtf8(a.name));
  res.send(buf);
});
```

import 行追加：

```ts
import { getArtifact, readArtifactFile, contentDispositionUtf8 } from './artifacts.js';
```

- [ ] **Step 3: 单测（纯函数部分）**

Create: `apps/api/src/pi/space/artifacts.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { contentDispositionUtf8 } from './artifacts.js';

describe('contentDispositionUtf8', () => {
  it('中文文件名走 filename*，ASCII 兜底不含非 ASCII', () => {
    const v = contentDispositionUtf8('V2.3-用例-20261026.xmind');
    expect(v.startsWith('attachment; filename="')).toBe(true);
    expect(v).toContain("filename*=UTF-8''");
    expect(v).toContain(encodeURIComponent('V2.3-用例-20261026.xmind'));
    const ascii = v.split(';')[1]!.trim();
    expect(/^filename="[ -~]+"$/.test(ascii)).toBe(true);
  });
});
```

Run: `pnpm --filter api exec vitest run src/pi/space/artifacts.test.ts`
Expected: PASS

- [ ] **Step 4: typecheck + Commit**

Run: `pnpm --filter api typecheck`

```bash
git add apps/api/src/pi/space/artifacts.ts apps/api/src/pi/space/artifacts.test.ts apps/api/src/pi/space/router.ts
git commit -m "feat(api): AI 产出文件临时托管——token 登记下载通道 + SSE artifact 前置"
```

---

### Task 7: AI 工具 `export_cases_xmind`

**Files:**
- Create: `apps/api/src/pi/space/tools/exportCasesXmind.ts`
- Modify: `apps/api/src/pi/space/tools/index.ts`

- [ ] **Step 1: 写工具**

`apps/api/src/pi/space/tools/exportCasesXmind.ts` 全文：

```ts
/**
 * export_cases_xmind：把当前版本的用例导出为 XMind 文件，经下载卡推送给用户。
 * 与列表页共用 services/xmindExport.service 的树构建/序列化/打包——内容不经 LLM 之手，零幻觉。
 * 范围：caseIds（显式集合，须 ∈ 当前版本）> groupId > keyword > 全版本。
 */
import { Type } from '@earendil-works/pi-ai';
import { inArray, eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { testCases } from '../../../db/schema.js';
import { searchCasesInVersion } from '../../../services/cases.service.js';
import { loadExportCases, buildXmindBuffer } from '../../../services/xmindExport.service.js';
import { registerArtifact } from '../artifacts.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

export function buildExportCasesXmindTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'export_cases_xmind',
    description:
      '把当前版本的用例导出为 XMind 思维导图文件（层级：版本→分组→用例→预置条件/测试步骤/预期结果），生成后下载卡推送给用户点击下载。用户要交付文档/评审材料/汇总用例时使用。范围四选一：caseIds 优先，其次 groupId，再次 keyword，都缺省=当前版本全部用例。',
    parameters: Type.Object({
      caseIds: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
      groupId: Type.Optional(Type.String()),
      keyword: Type.Optional(Type.String({ maxLength: 200 })),
      title: Type.Optional(Type.String({ maxLength: 200, description: '根节点标题（也是文件名前缀），缺省用版本名' })),
    }),
    promptGuidelines: [
      '导出内容直接来自库内数据（标题/步骤 instruction/预期结果），不要在对话里复述全部用例内容，简单说明导出范围与用例数即可。',
      '用户没说范围时先确认：全版本 / 某分组 / 按关键词。确认后调用本工具。',
    ],
    execute: async (input) => {
      const v = input as { caseIds?: string[]; groupId?: string; keyword?: string; title?: string };
      let caseIds: string[];
      if (Array.isArray(v.caseIds) && v.caseIds.length > 0) {
        const rows = await db
          .select({ id: testCases.id, versionId: testCases.versionId })
          .from(testCases)
          .where(inArray(testCases.id, v.caseIds.slice(0, 500)));
        const ok = rows.filter((r) => r.versionId === ctx.versionId).map((r) => r.id);
        if (ok.length === 0) return { ok: false, error: '给定的用例都不在当前版本内' };
        caseIds = ok;
      } else {
        const rows = await searchCasesInVersion(ctx.versionId, { groupId: v.groupId, keyword: v.keyword, limit: 1000 });
        caseIds = rows.map((r) => r.id);
      }
      if (caseIds.length === 0) return { ok: false, error: '没有匹配的用例，未生成文件' };
      const cases = await loadExportCases(caseIds);
      if (cases.length === 0) return { ok: false, error: '没有匹配的用例，未生成文件' };
      const { buffer, filename } = await buildXmindBuffer(cases, v.title || undefined);
      const token = await registerArtifact(buffer, filename);
      ctx.emit({ type: 'artifact', token, name: filename, size: buffer.length, count: cases.length });
      return { ok: true, data: `已生成「${filename}」（${cases.length} 条用例），下载卡已推送给用户` };
    },
  };
}
```

注意：`searchCasesInVersion` 的 groupId 参数不校验归属，错的 groupId 只会得到 0 结果 → 走 error 分支，可接受。

- [ ] **Step 2: 注册进 buildSpaceTools**

`apps/api/src/pi/space/tools/index.ts`：

import 区加：

```ts
import { buildExportCasesXmindTool } from './exportCasesXmind.js';
```

`buildSpaceTools` 内 `tools.push(buildVerifyCaseTool(ctx));`（约 :78）之前加：

```ts
  tools.push(buildExportCasesXmindTool(ctx));
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter api typecheck`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/pi/space/tools/exportCasesXmind.ts apps/api/src/pi/space/tools/index.ts
git commit -m "feat(api): AI 工具 export_cases_xmind——同源导出 + artifact 下载卡"
```

---

### Task 8: 前端 artifact 事件 + 下载卡 + i18n

**Files:**
- Modify: `apps/web/src/features/space-assistant/spaceEventsStore.ts`
- Modify: `apps/web/src/features/space-assistant/SpaceThreadPane.tsx`
- Modify: `apps/web/src/api/client.ts`（assistant 下载函数）
- Modify: `apps/web/src/i18n/locales/zh-CN/assistant.json`、`apps/web/src/i18n/locales/en-US/assistant.json`

- [ ] **Step 1: api client 加下载函数**

`apps/web/src/api/client.ts` 的 `downloadExtensionZip` 之后加（顶层，不在 cases 段内）：

```ts
  downloadArtifact: async (threadId: string, token: string): Promise<{ blob: Blob; filename: string }> => {
    const r = await fetch(`${BASE}/assistant/threads/${threadId}/artifacts/${token}`, { credentials: 'same-origin' });
    if (!r.ok) {
      if (r.status === 401) throw new ApiError(401, '未登录或会话已过期');
      const body = await r.json().catch(() => ({}));
      throw new ApiError(r.status, body.message ?? `HTTP ${r.status}`);
    }
    const dispo = r.headers.get('Content-Disposition') ?? '';
    const m = dispo.match(/filename\*=UTF-8''([^;]+)/);
    const filename = m ? decodeURIComponent(m[1]!) : 'artifact.xmind';
    return { blob: await r.blob(), filename };
  },
```

- [ ] **Step 2: spaceEventsStore 加 artifact 分支**

`spaceEventsStore.ts`：

类型区（`SolidifyProgressState` 之后）加：

```ts
/** artifact SSE 事件（AI 产出文件下载卡）。 */
export interface ArtifactItem {
  token: string;
  name: string;
  size: number;
  count?: number;
  at: string;
}
```

`SpaceEventsState` 接口加字段与方法：

```ts
  /** threadId → AI 产出文件列表（artifact 事件驱动；每线程上限 20，新的挤掉最旧的）。 */
  artifactsByThread: Map<string, ArtifactItem[]>;
```

state 初始值（`stagedSelection: new Map(),` 之后）加：

```ts
  artifactsByThread: new Map(),
```

`ingest` 内（`solidify_progress` 分支之后、函数收尾前）加：

```ts
    if (e.type === 'artifact') {
      const item: ArtifactItem = {
        token: String(e.token ?? ''),
        name: String(e.name ?? 'export.xmind'),
        size: Number(e.size ?? 0),
        ...(typeof e.count === 'number' ? { count: e.count } : {}),
        at: new Date().toISOString(),
      };
      if (!item.token) return;
      const tid = typeof e.threadId === 'string' && e.threadId ? e.threadId : get().threadId;
      set((s) => {
        const list = s.artifactsByThread.get(tid) ?? [];
        if (list.some((x) => x.token === item.token)) return s; // 重放去重（token 天然幂等）
        const next = new Map(s.artifactsByThread);
        next.set(tid, [...list.slice(-19), item]);
        return { artifactsByThread: next };
      });
      return;
    }
```

`reset()` 的返回对象里加 `artifactsByThread: new Map(),`。

- [ ] **Step 3: SpaceThreadPane 加下载卡**

`SpaceThreadPane.tsx`：

import 区加：

```tsx
import { useSpaceEventsStore, type ArtifactItem } from './spaceEventsStore';
import { api } from '@/api/client';
```

（`api` 若已 import 则合并；以文件现有 import 为准。）

`SolidifyProgressCard` 组件之后新增：

```tsx
/** AI 产出文件下载卡：artifact SSE 事件驱动，文件名+大小+下载按钮。 */
function ArtifactCards({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const items = useSpaceEventsStore((s) => s.artifactsByThread.get(threadId)) ?? [];
  if (items.length === 0) return null;
  const download = async (item: ArtifactItem) => {
    const { blob, filename } = await api.downloadArtifact(threadId, item.token);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      {items.map((item) => (
        <div
          key={item.token}
          className="fade-up mb-2 flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-[12px]"
          style={{ background: 'var(--muted)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
        >
          <Icon name="download" size={12} style={{ flexShrink: 0, color: 'var(--primary)' }} />
          <span className="min-w-0 truncate">{item.name}</span>
          <span className="flex-shrink-0" style={{ color: 'var(--muted-foreground)' }}>
            {Math.max(1, Math.round(item.size / 1024))} KB{item.count != null ? ` · ${t('assistant:artifact.count', { count: item.count })}` : ''}
          </span>
          <Button size="sm" variant="ghost" className="ml-auto flex-shrink-0" onClick={() => void download(item)}>
            {t('assistant:artifact.download')}
          </Button>
        </div>
      ))}
    </>
  );
}
```

`Icon` / `Button` 若未 import，按该文件既有 import 来源补（`grep -n "import.*Icon\|import.*Button" apps/web/src/features/space-assistant/SpaceThreadPane.tsx`）。

挂载点：`<SolidifyProgressCard />`（约 :50）之后加：

```tsx
          <ArtifactCards threadId={threadId} />
```

- [ ] **Step 4: i18n key**

`apps/web/src/i18n/locales/zh-CN/assistant.json` 顶层加：

```json
  "artifact": {
    "download": "下载",
    "count": "{{count}} 条用例"
  },
```

`apps/web/src/i18n/locales/en-US/assistant.json` 加：

```json
  "artifact": {
    "download": "Download",
    "count": "{{count}} cases"
  },
```

- [ ] **Step 5: typecheck + i18n 测试**

Run: `pnpm --filter web typecheck && pnpm --filter web test -- src/i18n/i18n.test.ts`
Expected: 均通过

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/space-assistant/spaceEventsStore.ts apps/web/src/features/space-assistant/SpaceThreadPane.tsx apps/web/src/api/client.ts apps/web/src/i18n/locales/zh-CN/assistant.json apps/web/src/i18n/locales/en-US/assistant.json
git commit -m "feat(web): AI 助手 artifact 下载卡——SSE 事件 + token 换文件"
```

---

### Task 9: 全量验证 + 真机冒烟

**Files:** 无新改动（验证任务）

- [ ] **Step 1: api/web 全量 typecheck + 单测**

```bash
pnpm --filter api typecheck && pnpm --filter web typecheck
pnpm --filter api test
pnpm --filter web test -- src/i18n/i18n.test.ts
```
Expected: 全绿（注意本地基线噪声：sendSyslog 基线即红、全量并发偶发假失败——失败先单跑复现再判回归）

- [ ] **Step 2: dev server 冒烟——列表页导出**

```bash
# dev api + dev web 起着的前提下（dev PG 容器 itest-pg；admin/Itest@2026）
curl -s -c /tmp/itest-cookie.txt -X POST http://localhost:54321/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Itest@2026"}' > /dev/null
CASE_ID=$(curl -s -b /tmp/itest-cookie.txt 'http://localhost:54321/api/cases?projectId=<真实projectId>' | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["id"])')
curl -s -b /tmp/itest-cookie.txt -X POST http://localhost:54321/api/cases/export-xmind -H 'Content-Type: application/json' -d "{\"caseIds\":[\"$CASE_ID\"]}" -o /tmp/export-smoke.xmind -w '%{http_code}\n'
unzip -l /tmp/export-smoke.xmind
unzip -p /tmp/export-smoke.xmind content.json | python3 -m json.tool | head -30
```
Expected: `200`；zip 四件；content.json 层级正确。浏览器里打开用例列表 → 勾选/不勾选点「导出 XMind」→ 文件下载 → 用 XMind 打开核对。

- [ ] **Step 3: dev 冒烟——AI 助手导出**

浏览器打开某版本工作台 → AI 助手输入「导出当前版本所有用例为 xmind」→ 观察：
1. 聊天区下方出现下载卡（文件名 + 大小 + 下载按钮）
2. 点击下载 → 文件打开正常
3. 断线重连（刷新页面）后 60min 内卡片仍在

- [ ] **Step 4: 收尾**

全部通过后向用户汇报，等待用户确认后再议 push/发版。

---

## Self-Review 记录

- **Spec 覆盖**：树构建（Task 1）、双格式（Task 2）、数据装载/打包/命名（Task 3）、列表页路由（Task 4）、前端按钮（Task 5）、artifact 通道（Task 6）、AI 工具（Task 7）、前端下载卡（Task 8）、验证（Task 9）——spec §3-§7 全覆盖。
- **占位符**：无 TBD/TODO；两处「以文件现有 import 为准」是防 import 重复的显式核对指令，非占位。
- **类型一致性**：`ExportCaseRow`/`ExportStepRow`/`XmindNode`（Task 1 定义）→ `renderXmindWorkbook`（Task 2 消费 XmindNode）→ `loadExportCases` 返回 `ExportCaseRow[]`（Task 3）→ 路由/工具消费（Task 4/7）；`registerArtifact(token)`/`getArtifact`/`contentDispositionUtf8`（Task 6 定义，Task 7 消费 registerArtifact）；`ArtifactItem`（Task 8 定义+消费）——已核对一致。
