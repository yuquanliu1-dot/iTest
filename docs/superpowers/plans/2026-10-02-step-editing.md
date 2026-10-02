# 用例步骤编辑优化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 CaseDetail 的步骤列表从 JSON 原文升级为中文摘要 + 右侧结构化编辑抽屉（15 种类型全覆盖、locator 可编辑、自由类型切换）+ dnd-kit 拖拽排序 + 单步复制/定位粘贴 + 保存前前端 zod 校验。

**Architecture:** 纯前端改造，零后端改动。新代码分五块：`lib/stepSummary.ts`（摘要纯函数）、`lib/stepValidation.ts`（基于 `@itest/shared` 的 `StepAction` zod 前置校验）、`components/step-form/switchAction.ts`（全类型切换+字段保留）、`components/step-form/LocatorArrayEditor.tsx` + `FillValueEditor.tsx`（受控复用组件）、`components/StepEditDrawer.tsx`（Radix Dialog 右侧抽屉，替换 StepEditModal.tsx）。拖拽用 dnd-kit，走 `PUT /steps/reorder`（保 step id），拖拽前手动推撤销快照。

**Tech Stack:** React 19、Radix Dialog（已装）、@dnd-kit/*（新装）、zod（已装）、vitest（已装）。

**对 spec 的两处偏差（更简实现，意图不变）：**
1. spec 列出的 `ActionFields.tsx` 不单独建文件——各类型差异字段直接内联在 StepEditDrawer 的表单子组件里（与原 Modal 相同的状态模型，降低迁移风险）；复用组件 LocatorArrayEditor/FillValueEditor 照建。
2. 单步复制不绕 stepClipboard，直接 `mutateSteps` splice 插入该步副本（与粘贴同一条全量替换写路径，行为等价、代码少）。

**关键背景（实现者必读）：**
- `StepClip` 类型（`apps/web/src/stores/stepClipboard.ts`）：`{ action: unknown; source: string; name?: string | null; delayMs?: number | null }`，无 id。
- 撤销栈：`CaseDetail.tsx` 的 `historyRef`（`StepClip[][]`，20 层）+ `mutateSteps()`（推快照后调 `replaceSteps` 全量替换）。`undo()` = `replaceSteps.mutate(snapshot)`。
- `PUT /cases/:id/steps`（replaceSteps）会**删全部重插，step id 全部重新生成**；`PUT /cases/:id/steps/reorder`（`api.cases.reorderSteps(id, stepIds)`）保 id、只重写 order。
- 敏感 fill：GET 返回 `action.value === '__sensitive__'` 占位 + `sensitive: true`；编辑时必须重输密码（pwdDraft）才能保存。此行为原样保留。
- 保存路径上传 side effects：replaceSteps 会自动编译 aiStep、加密敏感值、做变量体检——前端无需重复做。
- 后端约束（`apps/api/src/routes/steps.ts:126-127`）：`name ≤ 200`、`delayMs 为 0–60000 整数`。
- `@itest/shared`（TS 源码直出，pnpm workspace 链接）导出 `StepAction`（zod discriminatedUnion，15 种 kind）与 `Locator` 类型。web 目前只有 type-only import；本计划 Task 3 首次运行时引入，若 vitest/vite 解析失败，fallback：在 `apps/web/vite.config.ts` 加 `resolve: { alias: { '@itest/shared': '<repo>/packages/shared/src/index.ts' } }`。
- 15 种 kind：`navigate, click, fill, hover, waitFor, assertText, assertVisible, screenshot, check, select, upload, switchTab, assertJson, extract, aiStep`（定义见 `packages/shared/src/step-dsl.ts`）。
- 全程在 main checkout 工作；dev server（web 5173 / api 54321）可能已在跑，改完在浏览器验证。

---

### Task 1: 安装 dnd-kit 依赖

**Files:** 无代码改动，只改 `apps/web/package.json` + lockfile。

- [ ] **Step 1: 安装**

```bash
pnpm --filter @itest/web add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

Expected: 三个包写入 `apps/web/package.json` dependencies，lockfile 更新，无报错。

- [ ] **Step 2: 验证 typecheck 仍过**

```bash
pnpm --filter @itest/web typecheck
```

Expected: 无错误退出。

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): add dnd-kit for step drag reorder"
```

---

### Task 2: stepSummary 摘要纯函数（TDD）

**Files:**
- Create: `apps/web/src/lib/stepSummary.ts`
- Test: `apps/web/src/lib/stepSummary.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// apps/web/src/lib/stepSummary.test.ts
import { describe, it, expect } from 'vitest';
import { stepSummary } from './stepSummary';

const loc = (strategy = 'css', value = '#btn') => [{ strategy, value }];

describe('stepSummary', () => {
  it('navigate 显示 URL', () => {
    expect(stepSummary({ kind: 'navigate', url: 'https://example.com' })).toBe('打开 https://example.com');
  });

  it('click 优先用 intentLocator.contextText', () => {
    expect(stepSummary({ kind: 'click', locator: loc(), intentLocator: { semanticRole: 'button', contextText: '登录' } })).toBe('点击 登录');
  });

  it('click 无 intent 时用首个 locator', () => {
    expect(stepSummary({ kind: 'click', locator: loc('role', 'button') })).toBe('点击 role=button');
  });

  it('fill 固定值', () => {
    expect(stepSummary({ kind: 'fill', locator: loc(), value: 'alice' })).toBe('输入 alice');
  });

  it('fill sensitive 脱敏', () => {
    expect(stepSummary({ kind: 'fill', locator: loc(), value: '__sensitive__', sensitive: true })).toBe('输入 ***');
  });

  it('fill 生成器值显示模式名', () => {
    expect(stepSummary({ kind: 'fill', locator: loc(), value: { mode: 'randomString', length: 8 } })).toBe('输入 (随机字符串)');
  });

  it('select 显示值', () => {
    expect(stepSummary({ kind: 'select', locator: loc(), value: 'SH' })).toBe('选择 SH');
  });

  it('check / hover / waitFor / assertVisible', () => {
    expect(stepSummary({ kind: 'check', locator: loc(), checked: true })).toBe('勾选');
    expect(stepSummary({ kind: 'hover', locator: loc() })).toBe('悬停 css=#btn');
    expect(stepSummary({ kind: 'waitFor', locator: loc() })).toBe('等待元素 css=#btn');
    expect(stepSummary({ kind: 'assertVisible', locator: loc() })).toBe('断言可见 css=#btn');
  });

  it('assertText 按 match 生成', () => {
    expect(stepSummary({ kind: 'assertText', locator: [], target: 'page', match: 'contains', equals: '登录成功' })).toBe('断言文本 包含「登录成功」');
  });

  it('screenshot / upload / switchTab / assertJson', () => {
    expect(stepSummary({ kind: 'screenshot', name: 'shot1' })).toBe('截图 shot1');
    expect(stepSummary({ kind: 'upload', locator: loc(), fileId: 'u-1' })).toBe('上传文件');
    expect(stepSummary({ kind: 'switchTab', tabRef: 't1' })).toBe('切换标签页 t1');
    expect(stepSummary({ kind: 'assertJson', locator: loc(), equals: { a: 1 } })).toBe('断言 JSON');
  });

  it('extract 显示变量名', () => {
    expect(stepSummary({ kind: 'extract', locator: loc(), varName: 'orderId', mode: 'completeValue' })).toBe('提取 → {{orderId}}');
  });

  it('aiStep 显示指令前 40 字', () => {
    const long = 'x'.repeat(50);
    expect(stepSummary({ kind: 'aiStep', instruction: long, compiled: null })).toBe(`AI：${'x'.repeat(39)}…`);
  });

  it('未知类型回退 JSON 片段', () => {
    expect(stepSummary({ kind: 'weird', foo: 'bar' })).toBe('{"kind":"weird","foo":"bar"}'.slice(0, 39) + '…');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @itest/web test
```

Expected: FAIL —— `Cannot find module './stepSummary'`（或等价的模块不存在错误）。

- [ ] **Step 3: 写实现**

```typescript
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
```

- [ ] **Step 4: 跑测试确认全过**

```bash
pnpm --filter @itest/web test
```

Expected: PASS（stepSummary.test.ts 全绿）。若 `@itest/shared` 解析类报错出现（本文件不应 import shared，理论上不会），按「关键背景」里的 alias fallback 处理。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/stepSummary.ts apps/web/src/lib/stepSummary.test.ts
git commit -m "feat(web): human-readable step summary formatter"
```

---

### Task 3: stepValidation 前置校验（TDD，含 shared 运行时冒烟）

**Files:**
- Create: `apps/web/src/lib/stepValidation.ts`
- Test: `apps/web/src/lib/stepValidation.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// apps/web/src/lib/stepValidation.test.ts
import { describe, it, expect } from 'vitest';
import { validateStepEdit } from './stepValidation';

const click = { kind: 'click', locator: [{ strategy: 'css', value: '#btn' }] };

describe('validateStepEdit', () => {
  it('合法 click 通过', () => {
    expect(validateStepEdit({ action: click }).ok).toBe(true);
  });

  it('locator 候选值为空', () => {
    const r = validateStepEdit({ action: { kind: 'click', locator: [{ strategy: 'css', value: '' }] } });
    expect(r.ok).toBe(false);
    expect(r.errors['action.locator.0.value']).toContain('候选 1');
  });

  it('locator 数组为空（click 要求 min(1)）', () => {
    const r = validateStepEdit({ action: { kind: 'click', locator: [] } });
    expect(r.errors['action.locator']).toBeTruthy();
  });

  it('navigate URL 不合法', () => {
    const r = validateStepEdit({ action: { kind: 'navigate', url: 'notaurl' } });
    expect(r.errors['action.url']).toBeTruthy();
  });

  it('delayMs 越界 / 非整数', () => {
    expect(validateStepEdit({ action: click, delayMs: 60001 }).errors.delayMs).toBeTruthy();
    expect(validateStepEdit({ action: click, delayMs: -1 }).errors.delayMs).toBeTruthy();
    expect(validateStepEdit({ action: click, delayMs: 100.5 }).errors.delayMs).toBeTruthy();
    expect(validateStepEdit({ action: click, delayMs: 500 }).ok).toBe(true);
  });

  it('name 超 200 字', () => {
    const r = validateStepEdit({ action: click, name: 'x'.repeat(201) });
    expect(r.errors.name).toBeTruthy();
  });

  it('extract 缺 varName', () => {
    const r = validateStepEdit({ action: { kind: 'extract', locator: click.locator, mode: 'completeValue', varName: '' } });
    expect(r.errors['action.varName']).toBeTruthy();
  });

  it('switchTab 缺 tabRef', () => {
    const r = validateStepEdit({ action: { kind: 'switchTab', tabRef: '' } });
    expect(r.errors['action.tabRef']).toBeTruthy();
  });

  it('组合值总长超 1024 被 zod refine 拦截', () => {
    const fragments = Array.from({ length: 15 }, () => ({ mode: 'randomString', length: 100 }));
    const r = validateStepEdit({ action: { kind: 'fill', locator: click.locator, value: { mode: 'composite', fragments } } });
    expect(r.errors['action.fragments']).toBeTruthy();
  });

  it('敏感 fill 占位值合法（密码重输由抽屉负责）', () => {
    const r = validateStepEdit({ action: { kind: 'fill', locator: click.locator, value: 'newpwd', sensitive: true } });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @itest/web test
```

Expected: FAIL —— 找不到 `./stepValidation`。**注意**：本步同时是 `@itest/shared` 运行时引入的冒烟点；若报 vite/vitest 无法解析 TS 源码包，按「关键背景」alias fallback 修复后重跑。

- [ ] **Step 3: 写实现**

```typescript
// apps/web/src/lib/stepValidation.ts
import { StepAction } from '@itest/shared';

export interface StepEditInput {
  action: unknown;
  name?: string;
  delayMs?: number;
}

export interface StepValidationResult {
  ok: boolean;
  /** key 为字段路径，如 'name' | 'delayMs' | 'action.url' | 'action.locator.0.value' */
  errors: Record<string, string>;
}

/** zod 报错路径 → 中文文案。 */
function messageFor(path: string, raw: string): string {
  if (path === 'name') return '步骤名称最多 200 字';
  if (path === 'delayMs') return '延迟必须是不超过 60000 的非负整数';
  if (path === 'action' || path === 'action.kind') return '操作内容不合法';
  if (path === 'action.locator') return '至少需要一个定位候选';
  const locMatch = /^action\.locator\.(\d+)\.value$/.exec(path);
  if (locMatch) return `定位候选 ${Number(locMatch[1]) + 1} 的值不能为空`;
  if (/^action\.locator\.\d+\.strategy$/.test(path)) return `定位候选的 strategy 不合法`;
  if (path === 'action.url') return 'URL 不合法（需完整 http(s) 地址）';
  if (path === 'action.fileId') return '请绑定上传文件';
  if (path === 'action.varName') return '变量名不能为空';
  if (path === 'action.pattern') return '正则表达式不能为空';
  if (path === 'action.tabRef') return '标签引用不能为空';
  if (path === 'action.instruction') return '指令不能为空';
  if (path === 'action.value') return '填写值不合法';
  if (path === 'action.fragments') return '组合值不合法（至少 1 段，总长 ≤ 1024）';
  return `${path || 'action'}: ${raw}`.slice(0, 120);
}

export function validateStepEdit(input: StepEditInput): StepValidationResult {
  const errors: Record<string, string> = {};

  if (input.name != null && input.name.length > 200) errors.name = messageFor('name', '');

  if (input.delayMs != null) {
    const d = input.delayMs;
    if (!Number.isInteger(d) || d < 0 || d > 60000) errors.delayMs = messageFor('delayMs', '');
  }

  const parsed = StepAction.safeParse(input.action);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      if (errors[path] == null) errors[path] = messageFor(path, issue.message);
    }
  }

  return { ok: Object.keys(errors).length === 0, errors };
}
```

- [ ] **Step 4: 跑测试确认全过**

```bash
pnpm --filter @itest/web test
```

Expected: PASS（stepSummary + stepValidation 两组全绿）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/stepValidation.ts apps/web/src/lib/stepValidation.test.ts
git commit -m "feat(web): pre-save step validation via shared zod schema"
```

---

### Task 4: switchAction 全类型切换模块（TDD）

**Files:**
- Create: `apps/web/src/components/step-form/switchAction.ts`
- Test: `apps/web/src/components/step-form/switchAction.test.ts`

说明：CaseDetail 里的旧 `SWITCHABLE`/`webSwitchAction`（CaseDetail.tsx:31-65）**本任务不动**，Task 7 接抽屉时一并删除。

- [ ] **Step 1: 写失败测试**

```typescript
// apps/web/src/components/step-form/switchAction.test.ts
import { describe, it, expect } from 'vitest';
import { switchAction, kindNeedsLocator } from './switchAction';
import type { StepClip } from '../../stores/stepClipboard';

const clipOf = (action: unknown): StepClip => ({ action, source: 'manual', name: 'n', delayMs: 100 });
const loc = [{ strategy: 'role', value: 'button' }];

describe('switchAction', () => {
  it('click → fill 保留 locator/intentLocator/name/delayMs', () => {
    const out = switchAction(clipOf({ kind: 'click', locator: loc, intentLocator: { semanticRole: 'button', contextText: '登录' } }), 'fill');
    const a = out.action as Record<string, unknown>;
    expect(a.kind).toBe('fill');
    expect(a.locator).toEqual(loc);
    expect(a.intentLocator).toEqual({ semanticRole: 'button', contextText: '登录' });
    expect(out.name).toBe('n');
    expect(out.delayMs).toBe(100);
    expect(a.value).toBe('');
  });

  it('fill → select 保留字符串值', () => {
    const out = switchAction(clipOf({ kind: 'fill', locator: loc, value: 'SH' }), 'select');
    expect((out.action as Record<string, unknown>).value).toBe('SH');
  });

  it('敏感 fill → select 不外带占位值/敏感标记', () => {
    const out = switchAction(clipOf({ kind: 'fill', locator: loc, value: '__sensitive__', sensitive: true }), 'select');
    const a = out.action as Record<string, unknown>;
    expect(a.value).toBe('');
    expect(a.sensitive).toBeUndefined();
  });

  it('navigate → click 补默认 locator 候选', () => {
    const out = switchAction(clipOf({ kind: 'navigate', url: 'https://a.com' }), 'click');
    expect((out.action as Record<string, unknown>).locator).toEqual([{ strategy: 'css', value: '' }]);
  });

  it('click → navigate 丢弃 locator，url 为空串', () => {
    const out = switchAction(clipOf({ kind: 'click', locator: loc }), 'navigate');
    expect(out.action).toEqual({ kind: 'navigate', url: '' });
  });

  it('click → assertText 带默认 target/match', () => {
    const out = switchAction(clipOf({ kind: 'click', locator: loc }), 'assertText');
    expect(out.action).toEqual({ kind: 'assertText', locator: loc, target: 'specifiedElement', match: 'equals', equals: '' });
  });

  it('click → extract 保留 locator', () => {
    const out = switchAction(clipOf({ kind: 'click', locator: loc }), 'extract');
    expect((out.action as Record<string, unknown>).locator).toEqual(loc);
  });

  it('click → aiStep / switchTab / screenshot 无 locator', () => {
    expect(switchAction(clipOf({ kind: 'click', locator: loc }), 'aiStep').action).toEqual({ kind: 'aiStep', instruction: '', compiled: null });
    expect(switchAction(clipOf({ kind: 'click', locator: loc }), 'switchTab').action).toEqual({ kind: 'switchTab', tabRef: '' });
    expect(switchAction(clipOf({ kind: 'click', locator: loc }), 'screenshot').action).toEqual({ kind: 'screenshot', name: '' });
  });

  it('kindNeedsLocator 覆盖 13 种', () => {
    for (const k of ['click', 'hover', 'fill', 'select', 'check', 'waitFor', 'assertVisible', 'assertText', 'assertJson', 'upload', 'extract']) {
      expect(kindNeedsLocator(k)).toBe(true);
    }
    for (const k of ['navigate', 'switchTab', 'screenshot', 'aiStep']) {
      expect(kindNeedsLocator(k)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @itest/web test
```

Expected: FAIL —— 找不到 `./switchAction`。

- [ ] **Step 3: 写实现**

```typescript
// apps/web/src/components/step-form/switchAction.ts
import type { StepClip } from '../../stores/stepClipboard';

export const STEP_KINDS = [
  'navigate', 'click', 'fill', 'select', 'check', 'hover', 'waitFor',
  'assertVisible', 'assertText', 'assertJson', 'extract', 'upload',
  'switchTab', 'screenshot', 'aiStep',
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
  }

  return { action, source: clip.source, name: clip.name, delayMs: clip.delayMs };
}
```

- [ ] **Step 4: 跑测试确认全过**

```bash
pnpm --filter @itest/web test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/step-form/switchAction.ts apps/web/src/components/step-form/switchAction.test.ts
git commit -m "feat(web): full kind switching with field preservation"
```

---

### Task 5: LocatorArrayEditor + FillValueEditor 组件

**Files:**
- Create: `apps/web/src/components/step-form/LocatorArrayEditor.tsx`
- Create: `apps/web/src/components/step-form/FillValueEditor.tsx`

无单测（纯受控 UI）；靠 typecheck + Task 9 手动 QA。

- [ ] **Step 1: 写 LocatorArrayEditor**

```tsx
// apps/web/src/components/step-form/LocatorArrayEditor.tsx
import type { CSSProperties } from 'react';
import type { Locator } from '@itest/shared';

interface Props {
  locators: Locator[];
  onChange: (next: Locator[]) => void;
  /** 以 action.locator 开头的错误，如 { 'action.locator.0.value': '…' } */
  errors?: Record<string, string>;
}

const STRATEGIES: Locator['strategy'][] = ['role', 'text', 'testId', 'css', 'xpath'];

/** locator 有序候选数组编辑器：录制会产生多个候选，顺序即回放优先级。 */
export default function LocatorArrayEditor({ locators, onChange, errors = {} }: Props) {
  const inputStyle: CSSProperties = {
    flex: 1, minWidth: 0, padding: '5px 8px', fontSize: 12,
    border: '1px solid var(--color-glass-border)', borderRadius: 6,
    background: 'var(--color-background-subtle)', color: 'var(--color-foreground)',
  };
  const selectStyle: CSSProperties = { ...inputStyle, flex: '0 0 92px', width: 92 };
  const btnStyle: CSSProperties = {
    background: 'transparent', border: 'none', cursor: 'pointer',
    color: 'var(--color-foreground-muted)', padding: '2px 4px', fontSize: 11,
  };

  const update = (i: number, patch: Partial<Locator>) =>
    onChange(locators.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const remove = (i: number) => onChange(locators.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= locators.length) return;
    const next = [...locators];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {locators.map((l, i) => {
        const err = errors[`action.locator.${i}.value`];
        return (
          <div key={i} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--color-foreground-muted)' }}>{i + 1}</span>
              <select
                style={selectStyle}
                value={l.strategy}
                onChange={(e) => update(i, { strategy: e.target.value as Locator['strategy'] })}
              >
                {STRATEGIES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <input
                style={{ ...inputStyle, ...(err ? { border: '1px solid var(--color-destructive)' } : {}) }}
                value={l.value}
                onChange={(e) => update(i, { value: e.target.value })}
                placeholder="定位值"
              />
              <button type="button" style={btnStyle} title="上移" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button type="button" style={btnStyle} title="下移" onClick={() => move(i, 1)} disabled={i === locators.length - 1}>↓</button>
              <button
                type="button"
                style={{ ...btnStyle, color: 'var(--color-destructive)' }}
                title="删除候选"
                onClick={() => remove(i)}
              >
                ×
              </button>
            </div>
            {err && <span className="text-[11px] pl-5" style={{ color: 'var(--color-destructive)' }}>{err}</span>}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => onChange([...locators, { strategy: 'css', value: '' }])}
        className="text-[11px] px-2 py-1 rounded-[5px] self-start"
        style={{ border: '1px dashed var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-muted)', cursor: 'pointer' }}
      >
        + 添加候选
      </button>
      {errors['action.locator'] && (
        <span className="text-[11px]" style={{ color: 'var(--color-destructive)' }}>{errors['action.locator']}</span>
      )}
    </div>
  );
}
```

注意：`Locator` 是 type-only import，编译后擦除，不引入运行时依赖。

- [ ] **Step 2: 写 FillValueEditor**

从 `StepEditModal.tsx:336-493` 迁移值编辑 UI（固定值/随机字符串/随机数字/时间戳/前缀+时间戳/组合值），改为受控组件。**不含** sensitive 开关与密码输入（由抽屉管理）。

```tsx
// apps/web/src/components/step-form/FillValueEditor.tsx
import { useState, type CSSProperties } from 'react';

type ValueMode = 'fixed' | 'randomString' | 'randomNumber' | 'timestamp' | 'prefixTimestamp' | 'composite';
type DateFormat = 'YYYYMMDD' | 'YYYY-MM-DD' | 'YYYY/MM/DD';

interface FragmentDraft {
  mode: 'fixed' | 'date' | 'randomNumber' | 'randomString' | 'timestamp';
  value?: string;
  format?: DateFormat;
  min?: string;
  max?: string;
  length?: string;
}

interface Props {
  value: unknown;
  onChange: (next: unknown) => void;
  availableVars?: string[];
}

const MODE_LABELS: Record<ValueMode, string> = {
  fixed: '固定值', randomString: '随机字符串', randomNumber: '随机数字',
  timestamp: '时间戳', prefixTimestamp: '前缀+时间戳', composite: '组合值',
};

function draftFromValue(v: unknown): FragmentDraft[] {
  if (v && typeof v === 'object' && (v as { mode?: string }).mode === 'composite') {
    return ((v as { fragments: unknown[] }).fragments ?? []).map((f: unknown) => {
      const o = f as Record<string, unknown>;
      if (o.mode === 'fixed') return { mode: 'fixed' as const, value: String(o.value ?? '') };
      if (o.mode === 'date') return { mode: 'date' as const, format: (o.format as DateFormat) ?? 'YYYYMMDD' };
      if (o.mode === 'randomNumber')
        return { mode: 'randomNumber' as const, min: String(o.min ?? 0), max: String(o.max ?? 999999), length: o.length != null ? String(o.length) : '' };
      if (o.mode === 'randomString') return { mode: 'randomString' as const, length: String(o.length ?? 12) };
      return { mode: 'timestamp' as const };
    });
  }
  return [{ mode: 'fixed', value: '' }];
}

/** fill/select 值编辑器：固定值 / 生成器 / 组合片段。受控组件，draft 只在内部做输入缓冲。 */
export default function FillValueEditor({ value, onChange, availableVars = [] }: Props) {
  const isObj = typeof value === 'object' && value !== null;
  const objMode = isObj ? ((value as { mode?: string }).mode as ValueMode | undefined) : undefined;
  const initialMode: ValueMode = objMode ?? 'fixed';
  const [mode, setMode] = useState<ValueMode>(initialMode);
  const [fixed, setFixed] = useState(isObj ? '' : String(value ?? ''));
  const [genLength, setGenLength] = useState(isObj ? String((value as { length?: number }).length ?? 12) : '12');
  const [genMin, setGenMin] = useState(isObj ? String((value as { min?: number }).min ?? 0) : '0');
  const [genMax, setGenMax] = useState(isObj ? String((value as { max?: number }).max ?? 999999) : '999999');
  const [genPrefix, setGenPrefix] = useState(isObj ? String((value as { prefix?: string }).prefix ?? '') : '');
  const [fragments, setFragments] = useState<FragmentDraft[]>(() => draftFromValue(value));

  const inputStyle: CSSProperties = {
    width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid var(--color-glass-border)',
    borderRadius: 6, background: 'var(--color-background-subtle)', color: 'var(--color-foreground)',
    boxSizing: 'border-box', marginTop: 4,
  };

  /** 片段 → 存储 shape（与 StepEditModal handleSave 的映射一致） */
  const buildFragment = (f: FragmentDraft): Record<string, unknown> => {
    if (f.mode === 'fixed') return { mode: 'fixed', value: f.value ?? '' };
    if (f.mode === 'date') return { mode: 'date', format: f.format ?? 'YYYYMMDD' };
    if (f.mode === 'randomNumber') {
      const out: Record<string, unknown> = { mode: 'randomNumber', min: Number(f.min) || 0, max: Number(f.max) || 999999 };
      if (f.length) out.length = Number(f.length);
      return out;
    }
    if (f.mode === 'randomString') return { mode: 'randomString', length: Number(f.length) || 12 };
    return { mode: 'timestamp' };
  };

  const estLen = fragments.reduce((sum, f) => {
    if (f.mode === 'fixed') return sum + (f.value?.length ?? 0);
    if (f.mode === 'date') return sum + (f.format?.length ?? 8);
    if (f.mode === 'randomNumber') return sum + (f.length ? Number(f.length) : String(Number(f.max) || 999999).length);
    if (f.mode === 'randomString') return sum + (Number(f.length) || 12);
    return sum + 13;
  }, 0);
  const over = estLen > 1024;

  const commitMode = (m: ValueMode) => {
    setMode(m);
    if (m === 'fixed') onChange(fixed);
    else if (m === 'randomString') onChange({ mode: 'randomString', length: Number(genLength) || 12 });
    else if (m === 'randomNumber') onChange({ mode: 'randomNumber', min: Number(genMin) || 0, max: Number(genMax) || 999999 });
    else if (m === 'timestamp') onChange({ mode: 'timestamp' });
    else if (m === 'prefixTimestamp') onChange({ mode: 'prefixTimestamp', prefix: genPrefix });
    else onChange({ mode: 'composite', fragments: fragments.map(buildFragment) });
  };

  const patchFragment = (i: number, patch: Partial<FragmentDraft>) => {
    const next = fragments.map((f, idx) => (idx === i ? { ...f, ...patch } : f));
    setFragments(next);
    if (mode === 'composite') onChange({ mode: 'composite', fragments: next.map(buildFragment) });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1 flex-wrap">
        {(Object.keys(MODE_LABELS) as ValueMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => commitMode(m)}
            style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
              border: '1px solid var(--color-glass-border)',
              background: mode === m ? 'var(--color-accent)' : 'transparent',
              color: mode === m ? '#fff' : 'var(--color-foreground-secondary)',
            }}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      {mode === 'fixed' && (
        <>
          <input
            style={inputStyle}
            value={fixed}
            onChange={(e) => { setFixed(e.target.value); onChange(e.target.value); }}
            placeholder="支持 {{变量名}} 引用"
            list="drawer-available-vars"
          />
          <datalist id="drawer-available-vars">
            {availableVars.map((v) => <option key={v} value={`{{${v}}}`} />)}
          </datalist>
        </>
      )}
      {mode === 'randomString' && (
        <label className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
          长度
          <input style={inputStyle} value={genLength} inputMode="numeric"
            onChange={(e) => { setGenLength(e.target.value); onChange({ mode: 'randomString', length: Number(e.target.value) || 12 }); }} />
        </label>
      )}
      {mode === 'randomNumber' && (
        <div className="flex gap-2">
          <label className="text-[11px] flex-1" style={{ color: 'var(--color-foreground-muted)' }}>最小
            <input style={inputStyle} value={genMin} inputMode="numeric"
              onChange={(e) => { setGenMin(e.target.value); onChange({ mode: 'randomNumber', min: Number(e.target.value) || 0, max: Number(genMax) || 999999 }); }} />
          </label>
          <label className="text-[11px] flex-1" style={{ color: 'var(--color-foreground-muted)' }}>最大
            <input style={inputStyle} value={genMax} inputMode="numeric"
              onChange={(e) => { setGenMax(e.target.value); onChange({ mode: 'randomNumber', min: Number(genMin) || 0, max: Number(e.target.value) || 999999 }); }} />
          </label>
        </div>
      )}
      {mode === 'prefixTimestamp' && (
        <input style={inputStyle} value={genPrefix} placeholder="前缀，如 测试-"
          onChange={(e) => { setGenPrefix(e.target.value); onChange({ mode: 'prefixTimestamp', prefix: e.target.value }); }} />
      )}
      {mode === 'composite' && (
        <div className="flex flex-col gap-2">
          {fragments.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                style={{ ...inputStyle, marginTop: 0, width: 110, flex: '0 0 110px' }}
                value={f.mode}
                onChange={(e) => {
                  const m = e.target.value as FragmentDraft['mode'];
                  const patch: Partial<FragmentDraft> =
                    m === 'fixed' ? { mode: 'fixed', value: '' }
                    : m === 'date' ? { mode: 'date', format: 'YYYYMMDD' }
                    : m === 'randomNumber' ? { mode: 'randomNumber', min: '0', max: '999999', length: '' }
                    : m === 'randomString' ? { mode: 'randomString', length: '12' }
                    : { mode: 'timestamp' };
                  patchFragment(i, patch);
                }}
              >
                <option value="fixed">固定值</option>
                <option value="date">日期</option>
                <option value="randomNumber">随机数字</option>
                <option value="randomString">随机字符串</option>
                <option value="timestamp">时间戳</option>
              </select>
              {f.mode === 'fixed' && (
                <input style={{ ...inputStyle, marginTop: 0, flex: 1, minWidth: 0 }} value={f.value ?? ''}
                  onChange={(e) => patchFragment(i, { value: e.target.value })} />
              )}
              {f.mode === 'date' && (
                <select style={{ ...inputStyle, marginTop: 0, flex: 1 }} value={f.format}
                  onChange={(e) => patchFragment(i, { format: e.target.value as DateFormat })}>
                  <option value="YYYYMMDD">YYYYMMDD</option>
                  <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                  <option value="YYYY/MM/DD">YYYY/MM/DD</option>
                </select>
              )}
              {f.mode === 'randomNumber' && (
                <>
                  <input style={{ ...inputStyle, marginTop: 0, width: 70 }} placeholder="min" inputMode="numeric" value={f.min ?? ''}
                    onChange={(e) => patchFragment(i, { min: e.target.value })} />
                  <input style={{ ...inputStyle, marginTop: 0, width: 70 }} placeholder="max" inputMode="numeric" value={f.max ?? ''}
                    onChange={(e) => patchFragment(i, { max: e.target.value })} />
                  <input style={{ ...inputStyle, marginTop: 0, width: 70 }} placeholder="位数" inputMode="numeric" value={f.length ?? ''}
                    onChange={(e) => patchFragment(i, { length: e.target.value })} />
                </>
              )}
              {f.mode === 'randomString' && (
                <input style={{ ...inputStyle, marginTop: 0, width: 100 }} placeholder="长度" inputMode="numeric" value={f.length ?? ''}
                  onChange={(e) => patchFragment(i, { length: e.target.value })} />
              )}
              {f.mode === 'timestamp' && <span className="text-[11px] flex-1" style={{ color: 'var(--color-foreground-muted)' }}>当前 ms 时间戳</span>}
              <button
                type="button"
                onClick={() => {
                  const next = fragments.filter((_, idx) => idx !== i);
                  setFragments(next);
                  onChange({ mode: 'composite', fragments: next.map(buildFragment) });
                }}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-destructive)', padding: 2 }}
                title="删除片段"
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => {
              const next = [...fragments, { mode: 'fixed', value: '' }];
              setFragments(next);
              onChange({ mode: 'composite', fragments: next.map(buildFragment) });
            }}
            className="text-[11px] px-2 py-1 rounded-[5px] self-start"
            style={{ border: '1px dashed var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-muted)', cursor: 'pointer' }}
          >
            + 添加片段
          </button>
          <p className="text-[11px]" style={{ color: over ? 'var(--color-destructive)' : 'var(--color-foreground-muted)' }}>
            当前长度估算：{estLen} / 1024{over ? ' · 超过上限' : ''}
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: typecheck**

```bash
pnpm --filter @itest/web typecheck
```

Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/step-form/LocatorArrayEditor.tsx apps/web/src/components/step-form/FillValueEditor.tsx
git commit -m "feat(web): locator array and fill value editor components"
```

---

### Task 6: StepEditDrawer 抽屉组件

**Files:**
- Create: `apps/web/src/components/StepEditDrawer.tsx`
- Delete（Task 7 一并删）: `apps/web/src/components/StepEditModal.tsx`

结构：外壳（Dialog + 类型切换 select + name/delayMs）+ 内部表单 `DrawerForm`（`key={kind}` 强制切换类型时重挂载，各类型字段状态从切换后的 action 重新初始化）。各类型字段块从 `StepEditModal.tsx` 迁移，改动点见代码内注释。

- [ ] **Step 1: 写 StepEditDrawer.tsx（完整文件）**

```tsx
// apps/web/src/components/StepEditDrawer.tsx
import { useEffect, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { Locator } from '@itest/shared';
import type { StepClip } from '../stores/stepClipboard';
import { api } from '../api/client';
import { formatBytes, shortDateTime, stepKindLabel } from '../lib/format';
import { validateStepEdit } from '../lib/stepValidation';
import { STEP_KINDS, switchAction, kindNeedsLocator, type StepKind } from './step-form/switchAction';
import LocatorArrayEditor from './step-form/LocatorArrayEditor';
import FillValueEditor from './step-form/FillValueEditor';

interface Props {
  initial: StepClip;
  availableVars?: string[];
  caseId?: string;
  onSave: (next: StepClip) => void;
  onClose: () => void;
}

/** 与服务端 aiStepSplit.splitByNumber 同一行匹配规则（自 StepEditModal 原样迁移）。 */
function countNumberedSegments(text: string): number {
  const re = /^[ \t]*\d+(?:\.[ \t]+|、[ \t]*)(.+)$/;
  return text.split(/\r?\n/).filter((line) => re.test(line)).length;
}

const inputStyle: CSSProperties = {
  width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid var(--color-glass-border)',
  borderRadius: 6, background: 'var(--color-background-subtle)', color: 'var(--color-foreground)',
  boxSizing: 'border-box', marginTop: 4,
};
const labelStyle: CSSProperties = { fontSize: 11, color: 'var(--color-foreground-muted)' };
const errStyle: CSSProperties = { border: '1px solid var(--color-destructive)' };

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <span className="text-[11px]" style={{ color: 'var(--color-destructive)' }}>{msg}</span>;
}

/** 步骤编辑抽屉：外壳管类型切换 + 通用字段；DrawerForm 按 kind 重挂载管差异字段。 */
export default function StepEditDrawer({ initial, availableVars = [], caseId, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<StepClip>(initial);
  // 通用字段放外壳：类型切换（DrawerForm 重挂载）不丢用户已输入的名称/延迟
  const [name, setName] = useState(initial.name ?? '');
  const [delayMs, setDelayMs] = useState(initial.delayMs ? String(initial.delayMs) : '');
  const kind = ((draft.action as { kind?: string })?.kind ?? 'click') as StepKind;

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 60 }} />
        <Dialog.Content
          style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 520, maxWidth: '92vw', zIndex: 61,
            background: 'var(--color-background)', borderLeft: '1px solid var(--color-glass-border)',
            boxShadow: 'var(--shadow-modal, 0 8px 32px rgba(0,0,0,0.18))',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}
          className="drawer-slide-in"
          aria-describedby={undefined}
        >
          <div className="flex items-center gap-3 px-5 py-4 shrink-0" style={{ borderBottom: '1px solid var(--color-glass-border)' }}>
            <Dialog.Title className="text-[14px] font-semibold" style={{ color: 'var(--color-foreground)' }}>
              编辑步骤
            </Dialog.Title>
            <select
              value={kind}
              onChange={(e) => setDraft(switchAction(draft, e.target.value as StepKind))}
              style={{ fontSize: 12, padding: '3px 6px', borderRadius: 6, border: '1px solid var(--color-glass-border)', background: 'var(--color-background-subtle)', color: 'var(--color-foreground)' }}
              title="切换操作类型（兼容字段自动保留）"
            >
              {STEP_KINDS.map((k) => <option key={k} value={k}>{stepKindLabel(k)}</option>)}
            </select>
            <div className="flex-1" />
            <Dialog.Close asChild>
              <button style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', fontSize: 16 }} title="关闭">✕</button>
            </Dialog.Close>
          </div>

          <DrawerForm
            key={kind}
            clip={draft}
            kind={kind}
            name={name}
            delayMs={delayMs}
            onName={setName}
            onDelayMs={setDelayMs}
            availableVars={availableVars}
            caseId={caseId}
            onCancel={onClose}
            onSave={(built) => onSave({ ...built, name: name.trim() || undefined, delayMs: delayMs ? Number(delayMs) : undefined })}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ---------------- DrawerForm：kind 差异字段 + 保存校验 ---------------- */

interface FormProps {
  clip: StepClip;
  kind: StepKind;
  name: string;
  delayMs: string;
  onName: (v: string) => void;
  onDelayMs: (v: string) => void;
  availableVars: string[];
  caseId?: string;
  onCancel: () => void;
  onSave: (built: StepClip) => void;
}

function DrawerForm({ clip, kind, name, delayMs, onName, onDelayMs, availableVars, caseId, onCancel, onSave }: FormProps) {
  const action = clip.action as Record<string, unknown>;
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // locator（13 种类型可编辑）
  const [locators, setLocators] = useState<Locator[]>(() =>
    Array.isArray(action.locator) ? (action.locator as Locator[]) : kindNeedsLocator(kind) ? [{ strategy: 'css', value: '' }] : [],
  );

  // fill 敏感值（自 Modal 迁移：占位 '__sensitive__' 必须重输）
  const [sensitive, setSensitive] = useState(!!(action as { sensitive?: boolean }).sensitive);
  const [pwdDraft, setPwdDraft] = useState('');
  const [fillValue, setFillValue] = useState<unknown>(
    action.sensitive ? '' : action.value ?? '',
  );
  const [selectValue, setSelectValue] = useState(typeof action.value === 'string' ? action.value : '');

  // upload（自 Modal 迁移）
  const [fileId, setFileId] = useState<string | undefined>(action.fileId as string | undefined);
  const [attachments, setAttachments] = useState<Array<{ id: string; originalName: string; size: number; mime: string | null; sha256: string; createdAt: string }>>([]);

  // assertText / assertJson
  const [equalsText, setEqualsText] = useState(
    kind === 'assertJson' ? JSON.stringify(action.equals ?? null, null, 2) : String(action.equals ?? ''),
  );
  const [assertTarget, setAssertTarget] = useState<'specifiedElement' | 'page' | 'errorMessage' | 'url'>(
    (action.target as 'specifiedElement') ?? 'specifiedElement',
  );
  const [assertMatch, setAssertMatch] = useState<'equals' | 'contains' | 'notContains' | 'regex'>(
    (action.match as 'equals') ?? 'equals',
  );

  // extract（自 Modal 迁移，含智能抽取编译）
  const [varName, setVarName] = useState(String(action.varName ?? ''));
  const [extractMode, setExtractMode] = useState<'completeValue' | 'smartExtract' | 'regex'>(
    (action.mode as 'completeValue') ?? 'completeValue',
  );
  const [extractPattern, setExtractPattern] = useState(String(action.pattern ?? ''));
  const [extractGroup, setExtractGroup] = useState(String(action.group ?? '1'));
  const [extractDescription, setExtractDescription] = useState(String(action.description ?? ''));
  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompileErr] = useState('');

  // aiStep / navigate / waitFor / check
  const [instruction, setInstruction] = useState(String(action.instruction ?? ''));
  const [showBoundary, setShowBoundary] = useState(false);
  const [url, setUrl] = useState(String(action.url ?? ''));
  const [timeoutMs, setTimeoutMs] = useState(String(action.timeoutMs ?? ''));
  const [checked, setChecked] = useState(action.checked !== false);

  useEffect(() => {
    if (kind !== 'upload' || !caseId) return;
    let cancelled = false;
    api.attachments.list(caseId).then((rows) => { if (!cancelled) setAttachments(rows); }).catch(() => {});
    return () => { cancelled = true; };
  }, [kind, caseId]);

  /** 构建 action（自 StepEditModal.handleSave 迁移），再走 validateStepEdit。 */
  const handleSave = () => {
    const next: Record<string, unknown> = { ...action };

    if (kindNeedsLocator(kind)) next.locator = locators;
    if (kind === 'fill' || kind === 'select') {
      if (kind === 'fill') {
        if (sensitive) {
          if (!pwdDraft) {
            setFieldErrors({ sensitive: '已加密 — 修改时请输入新密码' });
            return;
          }
          next.value = pwdDraft;
          next.sensitive = true;
        } else {
          next.value = fillValue;
          delete next.sensitive;
        }
      } else {
        next.value = selectValue;
      }
    }
    if (kind === 'upload') next.fileId = fileId ?? '';
    if (kind === 'assertText') {
      next.equals = equalsText;
      next.target = assertTarget;
      next.match = assertMatch;
      if (assertTarget !== 'specifiedElement') next.locator = [];
    }
    if (kind === 'assertJson') {
      try {
        next.equals = JSON.parse(equalsText);
      } catch {
        setFieldErrors({ 'action.equals': '期望值不是合法 JSON' });
        return;
      }
    }
    if (kind === 'extract') {
      next.varName = varName.trim();
      next.mode = extractMode;
      if (extractMode === 'regex') {
        next.pattern = extractPattern.trim();
        next.group = Number(extractGroup) >= 0 ? Number(extractGroup) : 0;
        delete next.description;
      } else if (extractMode === 'smartExtract') {
        if (extractDescription.trim()) next.description = extractDescription.trim();
        else delete next.description;
        if (extractPattern.trim()) {
          next.pattern = extractPattern.trim();
          next.group = Number(extractGroup) >= 0 ? Number(extractGroup) : 0;
        } else {
          delete next.pattern;
          delete next.group;
        }
      } else {
        delete next.pattern;
        delete next.group;
        delete next.description;
      }
    }
    if (kind === 'aiStep') {
      next.instruction = instruction.trim();
      next.compiled = action.compiled ?? null;
    }
    if (kind === 'navigate') next.url = url.trim();
    if (kind === 'waitFor') {
      if (timeoutMs) next.timeoutMs = Number(timeoutMs);
      else delete next.timeoutMs;
    }
    if (kind === 'check') next.checked = checked;
    if (kind === 'switchTab') next.tabRef = String(action.tabRef ?? '');

    const v = validateStepEdit({ action: next, name: name.trim() || undefined, delayMs: delayMs ? Number(delayMs) : undefined });
    if (!v.ok) {
      setFieldErrors(v.errors);
      return;
    }
    onSave({ action: next, source: clip.source });
  };

  const showLocator = kindNeedsLocator(kind) && !(kind === 'assertText' && assertTarget !== 'specifiedElement');

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
        <label style={labelStyle}>
          步骤名称
          <input style={{ ...inputStyle, ...(fieldErrors.name ? errStyle : {}) }} value={name} onChange={(e) => onName(e.target.value)} placeholder="可选" />
          <FieldError msg={fieldErrors.name} />
        </label>
        <label style={labelStyle}>
          执行前等待 (ms)
          <input style={{ ...inputStyle, ...(fieldErrors.delayMs ? errStyle : {}) }} value={delayMs} onChange={(e) => onDelayMs(e.target.value)} placeholder="0" inputMode="numeric" />
          <FieldError msg={fieldErrors.delayMs} />
        </label>

        {showLocator && (
          <div className="flex flex-col gap-1.5">
            <span style={labelStyle}>定位候选（按顺序尝试，录制产生的语义定位优先）</span>
            <LocatorArrayEditor locators={locators} onChange={setLocators} errors={fieldErrors} />
          </div>
        )}

        {(kind === 'fill' || kind === 'select') && (
          <div className="flex flex-col gap-2">
            {kind === 'fill' && (
              <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
                敏感值（密码，加密保存，明文不显示）
              </label>
            )}
            {kind === 'fill' && sensitive ? (
              <div className="flex flex-col gap-1">
                <input
                  type="password"
                  style={{ ...inputStyle, ...(fieldErrors.sensitive ? errStyle : {}) }}
                  placeholder="输入新密码（已加密值不回显）"
                  value={pwdDraft}
                  onChange={(e) => setPwdDraft(e.target.value)}
                />
                <FieldError msg={fieldErrors.sensitive} />
              </div>
            ) : kind === 'fill' ? (
              <FillValueEditor value={fillValue} onChange={setFillValue} availableVars={availableVars} />
            ) : (
              <input style={inputStyle} value={selectValue} onChange={(e) => setSelectValue(e.target.value)} placeholder="下拉选项值" />
            )}
          </div>
        )}

        {kind === 'navigate' && (
          <label style={labelStyle}>
            URL
            <input style={{ ...inputStyle, ...(fieldErrors['action.url'] ? errStyle : {}) }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
            <FieldError msg={fieldErrors['action.url']} />
          </label>
        )}

        {kind === 'waitFor' && (
          <label style={labelStyle}>
            超时 (ms，留空默认 5000)
            <input style={inputStyle} value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} inputMode="numeric" />
          </label>
        )}

        {kind === 'check' && (
          <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            勾选（取消勾选则为取消勾选操作）
          </label>
        )}

        {kind === 'assertText' && (
          <>
            <div className="flex gap-2">
              <label style={{ ...labelStyle, flex: 1 }}>
                断言目标
                <select style={inputStyle} value={assertTarget} onChange={(e) => setAssertTarget(e.target.value as typeof assertTarget)}>
                  <option value="specifiedElement">指定元素（需定位候选）</option>
                  <option value="page">整页文本</option>
                  <option value="errorMessage">错误提示区</option>
                  <option value="url">当前 URL</option>
                </select>
              </label>
              <label style={{ ...labelStyle, flex: 1 }}>
                匹配方式
                <select style={inputStyle} value={assertMatch} onChange={(e) => setAssertMatch(e.target.value as typeof assertMatch)}>
                  <option value="equals">等于（trim）</option>
                  <option value="contains">包含</option>
                  <option value="notContains">不包含</option>
                  <option value="regex">正则匹配</option>
                </select>
              </label>
            </div>
            <label style={labelStyle}>
              期望文本
              <textarea style={{ ...inputStyle, fontFamily: 'inherit' }} rows={3} value={equalsText} onChange={(e) => setEqualsText(e.target.value)} />
            </label>
          </>
        )}

        {kind === 'assertJson' && (
          <label style={labelStyle}>
            期望 JSON（整段深比较）
            <textarea style={{ ...inputStyle, fontFamily: 'monospace', ...(fieldErrors['action.equals'] ? errStyle : {}) }} rows={6} value={equalsText} onChange={(e) => setEqualsText(e.target.value)} />
            <FieldError msg={fieldErrors['action.equals']} />
          </label>
        )}

        {kind === 'extract' && (
          <div className="flex flex-col gap-2">
            <label style={labelStyle}>
              变量名
              <input style={{ ...inputStyle, ...(fieldErrors['action.varName'] ? errStyle : {}) }} value={varName} onChange={(e) => setVarName(e.target.value)} placeholder="后续步骤用 {{变量名}} 引用" />
              <FieldError msg={fieldErrors['action.varName']} />
            </label>
            <label style={labelStyle}>
              抽取方式
              <select style={inputStyle} value={extractMode} onChange={(e) => setExtractMode(e.target.value as typeof extractMode)}>
                <option value="completeValue">完整值（元素文本/input 值）</option>
                <option value="smartExtract">智能抽取（按描述生成正则）</option>
                <option value="regex">正则匹配</option>
              </select>
            </label>
            {extractMode === 'regex' && (
              <div className="flex gap-2">
                <label style={{ ...labelStyle, flex: 3 }}>
                  正则
                  <input style={{ ...inputStyle, fontFamily: 'monospace', ...(fieldErrors['action.pattern'] ? errStyle : {}) }} value={extractPattern} onChange={(e) => setExtractPattern(e.target.value)} placeholder="如 ORD-\d+" />
                  <FieldError msg={fieldErrors['action.pattern']} />
                </label>
                <label style={{ ...labelStyle, flex: 1 }}>
                  捕获组
                  <input style={inputStyle} value={extractGroup} onChange={(e) => setExtractGroup(e.target.value)} inputMode="numeric" placeholder="0" />
                </label>
              </div>
            )}
            {extractMode === 'smartExtract' && (
              <div className="flex flex-col gap-2">
                <label style={labelStyle}>
                  抽取描述（自然语言）
                  <textarea style={{ ...inputStyle, fontFamily: 'inherit' }} rows={2} value={extractDescription} onChange={(e) => setExtractDescription(e.target.value)} placeholder="如：提取订单号" />
                </label>
                <button
                  type="button"
                  onClick={async () => {
                    if (!caseId) { setCompileErr('缺少 caseId，无法编译'); return; }
                    const sampleText = window.prompt('请粘贴一段包含目标片段的样本文本', '');
                    if (!sampleText) return;
                    setCompiling(true);
                    setCompileErr('');
                    try {
                      const r = await api.cases.compileExtract(caseId, { description: extractDescription.trim(), sampleText });
                      if (r.pattern) {
                        setExtractPattern(r.pattern);
                        setExtractGroup(String(r.group ?? 0));
                      } else {
                        setCompileErr(r.error ?? '编译失败');
                      }
                    } catch (err) {
                      setCompileErr((err as Error).message);
                    } finally {
                      setCompiling(false);
                    }
                  }}
                  disabled={compiling}
                  style={{ fontSize: 11, padding: '4px 8px', borderRadius: 5, border: '1px dashed var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-muted)', cursor: compiling ? 'wait' : 'pointer', alignSelf: 'flex-start' }}
                >
                  {compiling ? '编译中…' : '生成正则'}
                </button>
                {compileErr && <p className="text-[11px]" style={{ color: 'var(--color-destructive)' }}>{compileErr}</p>}
                {extractPattern && (
                  <p className="text-[11px] font-mono" style={{ color: 'var(--color-foreground-muted)' }}>
                    已生成正则：{extractPattern}（捕获组 {extractGroup}，保存后回放按正则执行）
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {kind === 'aiStep' && (
          <div className="flex flex-col gap-2">
            <label style={labelStyle}>
              自然语言指令（保存后自动编译）
              <textarea style={{ ...inputStyle, fontFamily: 'inherit' }} rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="可用 #cssSelector 引用页面元素，例: 识别图片 #captchaImg 并输入到 #captchaInput" />
            </label>
            {countNumberedSegments(instruction) >= 2 && (
              <p className="text-[11px]" style={{ color: 'var(--color-accent)' }}>
                检测到 {countNumberedSegments(instruction)} 条编号，保存时将自动拆为 {countNumberedSegments(instruction)} 条独立智能步骤
              </p>
            )}
            <button type="button" onClick={() => setShowBoundary((v) => !v)} style={{ fontSize: 11, padding: '4px 8px', borderRadius: 5, cursor: 'pointer', border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-muted)', alignSelf: 'flex-start' }}>
              {showBoundary ? '收起使用边界提示' : '查看使用边界'}
            </button>
            {showBoundary && (
              <div className="text-[11px] flex flex-col gap-1" style={{ color: 'var(--color-foreground-muted)' }}>
                <p>• 智能步骤适合复杂页面、动态选择、第一条结果等场景。</p>
                <p>• 不建议用于登录、支付、删除审批等高风险路径，也不用于发布准入的关键确定性步骤。</p>
                <p>• 强对抗验证码（滑块、点选、行为验证）不适用；仅适合测试环境中的简单图片验证码。</p>
                <p>• 关键结果请使用文本断言 / JSON 断言，不要把验证全部塞进智能步骤。</p>
              </div>
            )}
          </div>
        )}

        {kind === 'upload' && (
          <div className="flex flex-col gap-2">
            <span style={labelStyle}>绑定回放文件（按 project 隔离，≤ 10 MB）</span>
            <input
              type="file"
              style={{ ...inputStyle, ...(fieldErrors['action.fileId'] ? errStyle : {}) }}
              onChange={async (e) => {
                if (!caseId) return;
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 10 * 1024 * 1024) {
                  setFieldErrors((cur) => ({ ...cur, 'action.fileId': '文件超过 10MB 上限' }));
                  return;
                }
                try {
                  const r = await api.attachments.upload(caseId, f);
                  setFileId(r.id);
                  setFieldErrors((cur) => { const { ['action.fileId']: _, ...rest } = cur; return rest; });
                  api.attachments.list(caseId).then(setAttachments).catch(() => {});
                } catch (err) {
                  setFieldErrors((cur) => ({ ...cur, 'action.fileId': (err as Error).message }));
                }
              }}
            />
            <FieldError msg={fieldErrors['action.fileId']} />
            {attachments.length > 0 && (
              <>
                <span style={labelStyle}>—— 或从本 project 已上传文件选择 ——</span>
                <ul style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--color-glass-border)', borderRadius: 6, padding: 0, margin: 0, listStyle: 'none' }}>
                  {attachments.map((a) => (
                    <li
                      key={a.id}
                      onClick={() => setFileId(a.id)}
                      style={{
                        padding: '6px 8px', cursor: 'pointer',
                        background: fileId === a.id ? 'var(--color-accent)' : 'transparent',
                        color: fileId === a.id ? '#fff' : 'var(--color-foreground-secondary)',
                        fontSize: 11, display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center',
                        borderBottom: '1px solid var(--color-glass-border)',
                      }}
                    >
                      <span className="truncate" style={{ flex: 1 }}>{a.originalName}</span>
                      <span style={{ fontFamily: 'monospace', opacity: 0.7, fontSize: 10 }}>
                        {a.sha256.slice(0, 8)}… · {formatBytes(a.size)} · {shortDateTime(a.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {fileId && (
              <p className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                已绑定 fileId: <code>{fileId.slice(0, 8)}…</code>
                <button type="button" onClick={() => setFileId(undefined)} style={{ marginLeft: 8, background: 'transparent', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 11 }}>
                  更换
                </button>
              </p>
            )}
          </div>
        )}

        {kind === 'switchTab' && (
          <label style={labelStyle}>
            标签引用（tabRef）
            <input style={{ ...inputStyle, ...(fieldErrors['action.tabRef'] ? errStyle : {}) }} defaultValue={String(action.tabRef ?? '')} onChange={(e) => (action.tabRef = e.target.value)} placeholder="录制产生的标签标识" />
            <FieldError msg={fieldErrors['action.tabRef']} />
          </label>
        )}

        {kind === 'screenshot' && (
          <label style={labelStyle}>
            截图名称
            <input style={inputStyle} defaultValue={String(action.name ?? '')} onChange={(e) => (action.name = e.target.value)} placeholder="可选" />
          </label>
        )}
      </div>

      <div className="flex items-center gap-2 justify-end px-5 py-4 shrink-0" style={{ borderTop: '1px solid var(--color-glass-border)' }}>
        <button type="button" onClick={onCancel} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-secondary)', cursor: 'pointer' }}>
          取消
        </button>
        <button type="button" onClick={handleSave} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: 'none', background: 'var(--color-accent)', color: '#fff', cursor: 'pointer' }}>
          保存
        </button>
      </div>
    </div>
  );
}
```

**注意**：`switchTab`/`screenshot` 的输入用 `defaultValue` 直写 `action` 对象（该对象是 draft 的一部分，保存时 `{...action}` 展开已带新值）——这是刻意为之的最小实现；若 review 认为可读性差，可改为局部 state，行为不变。

- [ ] **Step 2: 加滑入动画**

在 `apps/web/src/index.css` 末尾追加：

```css
@keyframes drawer-slide-in {
  from { transform: translateX(24px); opacity: 0.6; }
  to { transform: translateX(0); opacity: 1; }
}
.drawer-slide-in { animation: drawer-slide-in 200ms ease-out; }
```

- [ ] **Step 3: typecheck**

```bash
pnpm --filter @itest/web typecheck
```

Expected: 无错误。若 `@radix-ui/react-dialog` 类型报错，确认 `Dialog.Title` 无 children 警告（Radix 要求 Title 有内容——上面已给「编辑步骤」文本）。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/StepEditDrawer.tsx apps/web/src/index.css
git commit -m "feat(web): step edit drawer with locator editing and kind switching"
```

---

### Task 7: CaseDetail 接入抽屉 + 列表摘要 + 单步复制 + 定位粘贴

**Files:**
- Modify: `apps/web/src/pages/CaseDetail.tsx`
- Delete: `apps/web/src/components/StepEditModal.tsx`

- [ ] **Step 1: 换 import 并删旧切换逻辑**

`CaseDetail.tsx` L19 改为：

```tsx
import StepEditDrawer from '../components/StepEditDrawer';
```

删除 L31-65 整段（`SWITCHABLE` 常量 + `webSwitchAction` 函数）。

- [ ] **Step 2: 加 editingIdx 状态**

在 L84 `const [editing, setEditing] = useState<StepClip | null>(null);` 下加：

```tsx
const [editingIdx, setEditingIdx] = useState(-1);
```

- [ ] **Step 3: 列表行改造（L656-800 区域）**

3a. `<li>`（L658-662）加编辑态高亮，改为：

```tsx
<li
  key={s.id}
  className="flex items-center gap-3 px-3 py-2 rounded-[8px]"
  style={{
    background: 'var(--color-background-subtle)',
    border: `1px solid ${idx === editingIdx ? 'var(--color-accent)' : 'var(--color-glass-border)'}`,
  }}
>
```

3b. 正文（L680-682 的 `<code>{JSON.stringify(s.action)}</code>`）替换为摘要：

```tsx
<span className="text-[12px] flex-1 truncate" style={{ color: 'var(--color-foreground)' }} title={stepSummary(s.action)}>
  <span className="text-[10px] font-semibold" style={{ color: 'var(--color-accent)' }}>
    {stepKindLabel((s.action as { kind?: string }).kind ?? '')}
  </span>{' '}
  {stepSummary(s.action)}
</span>
```

顶部补 import（`stepKindLabel` 已在 L22 从 `../lib/format` 引入，只需新增一行）：

```tsx
import { stepSummary } from '../lib/stepSummary';
```

3c. 删除类型切换 select（L728-745 整个 `<select>…</select>` 块）。

3d. 在「上移」按钮（L746-753）前插入单步复制按钮：

```tsx
<button
  onClick={() => mutateSteps((cur) => {
    const next = [...cur];
    next.splice(idx + 1, 0, { ...toClip(s) });
    return next;
  })}
  disabled={recorder.status === 'recording'}
  title="复制此步骤到下一行"
  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', padding: 2 }}
>
  <Icon name="copy" size={12} />
</button>
```

若 `Icon` 无 `copy` 图标名（查 `apps/web/src/components/Icon.tsx` 的 name 清单），用文字按钮 `⧉` 替代。

- [ ] **Step 4: 粘贴到「最后一个选中步骤之后」**

L589-605 粘贴按钮的 onClick 替换为：

```tsx
onClick={() =>
  mutateSteps((cur) => {
    const selIdx = cur
      .map((_, i) => (selected.has(caseDetail.steps[i]!.id) ? i : -1))
      .filter((i) => i >= 0);
    const at = selIdx.length > 0 ? selIdx[selIdx.length - 1]! : cur.length - 1;
    const next = [...cur];
    next.splice(at + 1, 0, ...clipboard.steps.map((c) => ({ ...c })));
    return next;
  })
}
```

按钮（L604）`粘贴 ({clipboard.steps.length})` 的 title 补位置提示：

```tsx
title={selected.size > 0 ? '插入到最后一个选中步骤之后' : '追加到末尾'}
```

- [ ] **Step 5: 编辑入口换抽屉**

L1031-1058 `{editing && (<StepEditModal …/>)}` 整块替换为：

```tsx
{editing && (
  <StepEditDrawer
    initial={editing}
    availableVars={caseDetail.steps
      .map((s) => (s.action as { kind?: string; varName?: string }).kind === 'extract'
        ? (s.action as { varName: string }).varName
        : undefined)
      .filter((v): v is string => !!v)}
    caseId={id}
    onClose={() => { setEditing(null); setEditingIdx(-1); editingSnapshotRef.current = null; }}
    onSave={(next) => {
      let applied = false;
      mutateSteps((cur) => {
        const i = editingIdxRef.current;
        const prev = editingSnapshotRef.current;
        const curAt = cur[i];
        if (!curAt || !prev || !sameStep(curAt, prev)) return cur;
        applied = true;
        const newCur = [...cur];
        newCur[i] = next;
        return newCur;
      });
      if (!applied) toast('步骤已被修改，请关闭抽屉重试', 'error');
      setEditing(null);
      setEditingIdx(-1);
      editingSnapshotRef.current = null;
    }}
  />
)}
```

行内「编辑」按钮（L779-789）onClick 补 `setEditingIdx(idx)`：

```tsx
onClick={() => {
  editingIdxRef.current = idx;
  setEditingIdx(idx);
  editingSnapshotRef.current = toClip(s);
  setEditing(toClip(s));
}}
```

- [ ] **Step 6: 删除 StepEditModal.tsx**

```bash
git rm apps/web/src/components/StepEditModal.tsx
```

- [ ] **Step 7: typecheck + test**

```bash
pnpm --filter @itest/web typecheck && pnpm --filter @itest/web test
```

Expected: 全过。

- [ ] **Step 8: 浏览器手动验证**

dev server（5173）打开任一用例：
1. 列表显示「点击 登录」式摘要而非 JSON；hover 出全文
2. 点编辑 → 右侧抽屉滑入，该行高亮
3. 改 locator 值 → 保存 → 列表摘要随之变化
4. 抽屉里切换 click → fill → locator 保留；切到 navigate → locator 消失
5. 清空 locator 值 → 保存 → 候选红框 + 中文报错，不提交
6. 单步复制按钮 → 下一行出现副本；Cmd+Z 撤销
7. 勾选两步 → 粘贴 → 插在第二个选中步骤之后

- [ ] **Step 9: Commit**

```bash
git add -A apps/web/src
git commit -m "feat(web): drawer-based step editing with summaries and paste-at-position"
```

---

### Task 8: dnd-kit 拖拽排序

**Files:**
- Create: `apps/web/src/components/step-form/SortableStepRow.tsx`
- Modify: `apps/web/src/pages/CaseDetail.tsx`

- [ ] **Step 1: 写 SortableStepRow**

```tsx
// apps/web/src/components/step-form/SortableStepRow.tsx
import type { ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface Props {
  id: string;
  disabled?: boolean;
  isEditing?: boolean;
  children: ReactNode;
}

/** 可排序行容器：仅左侧手柄可发起拖拽（listeners 只绑在手柄上），行内容仍由父级渲染。 */
export default function SortableStepRow({ id, disabled, isEditing, children }: Props) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled });

  return (
    <li
      ref={setNodeRef}
      className="flex items-center gap-3 px-3 py-2 rounded-[8px]"
      style={{
        background: 'var(--color-background-subtle)',
        border: `1px solid ${isEditing ? 'var(--color-accent)' : 'var(--color-glass-border)'}`,
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging ? { zIndex: 10, opacity: 0.85, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' } : {}),
      }}
    >
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        disabled={disabled}
        title="拖拽排序"
        aria-label="拖拽排序"
        style={{ background: 'transparent', border: 'none', cursor: disabled ? 'default' : 'grab', color: 'var(--color-foreground-muted)', padding: '2px 2px', fontSize: 12, lineHeight: 1, touchAction: 'none' }}
      >
        ⠿
      </button>
      {children}
    </li>
  );
}
```

- [ ] **Step 2: CaseDetail 接 DndContext**

2a. 顶部加 import：

```tsx
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import SortableStepRow from '../components/step-form/SortableStepRow';
```

2b. 组件内（`moveStep` mutation 之后）加：

```tsx
const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

const dragReorder = useMutation({
  mutationFn: (stepIds: string[]) => api.cases.reorderSteps(id!, stepIds),
  onSuccess: () => qc.invalidateQueries({ queryKey: ['case', id] }),
  onError: (e: Error) => {
    toast(e.message, 'error');
    qc.invalidateQueries({ queryKey: ['case', id] });
  },
});

const onDragEnd = (e: DragEndEvent) => {
  if (!caseDetail) return;
  const { active, over } = e;
  if (!over || active.id === over.id) return;
  const oldIdx = caseDetail.steps.findIndex((s) => s.id === active.id);
  const newIdx = caseDetail.steps.findIndex((s) => s.id === over.id);
  if (oldIdx < 0 || newIdx < 0) return;
  // 拖拽走 reorder（保 step id）；撤销快照手动入栈，undo 用 replaceSteps 恢复
  historyRef.current.push(caseDetail.steps.map(toClip));
  if (historyRef.current.length > 20) historyRef.current.shift();
  dragReorder.mutate(arrayMove(caseDetail.steps.map((s) => s.id), oldIdx, newIdx));
};
```

2c. 步骤列表的 `<ol className="flex flex-col gap-2">` 外层包：

```tsx
<DndContext
  sensors={recorder.status === 'recording' ? [] : sensors}
  collisionDetection={closestCenter}
  onDragEnd={onDragEnd}
>
  <SortableContext items={caseDetail.steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
    <ol className="flex flex-col gap-2">
      {/* …原有 map 内容… */}
    </ol>
  </SortableContext>
</DndContext>
```

2d. map 内原 `<li key={s.id} className="…" style={{…}}>` 替换为：

```tsx
<SortableStepRow key={s.id} id={s.id} disabled={recorder.status === 'recording'} isEditing={idx === editingIdx}>
```

删掉原 `<li>` 的 key/className/style（样式已移入 SortableStepRow），行尾 `</li>` 改 `</SortableStepRow>`。

- [ ] **Step 3: typecheck + test**

```bash
pnpm --filter @itest/web typecheck && pnpm --filter @itest/web test
```

Expected: 全过。

- [ ] **Step 4: 浏览器手动验证**

1. 按住 ⠿ 拖第 3 行到第 1 行 → 顺序变化且持久化（刷新后保持）
2. 拖拽后 Cmd+Z → 顺序恢复
3. 录制中手柄不可拖
4. 复选框/按钮点击不触发拖拽（activationConstraint distance 4）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/step-form/SortableStepRow.tsx apps/web/src/pages/CaseDetail.tsx
git commit -m "feat(web): drag-and-drop step reorder with undo support"
```

---

### Task 9: 全量回归 QA

**Files:** 无新文件；发现问题就地修复并单独 commit。

- [ ] **Step 1: 全套检查**

```bash
pnpm --filter @itest/web typecheck && pnpm --filter @itest/web test && pnpm --filter @itest/web lint
```

Expected: 全过（lint 若报既有问题，只修本次改动引入的）。

- [ ] **Step 2: 浏览器回归清单（5173，dev 数据 admin/admin123）**

| # | 场景 | 预期 |
|---|---|---|
| 1 | 敏感 fill 步骤编辑 | 抽屉显示密码框；不输密码保存 → 报「已加密 — 修改时请输入新密码」；输入后保存成功，列表显示 `输入 ***` |
| 2 | upload 步骤 | 上传/选择附件 → 保存成功；不绑文件保存 → fileId 报错 |
| 3 | extract 智能抽取 | 描述+样本 → 生成正则 → 保存 |
| 4 | aiStep 编辑 | 指令可改；列表「AI 编译失败 · 点我重编」按钮仍在且可用 |
| 5 | 多选复制 → 切到另一用例粘贴 | 跨用例粘贴仍插到最后选中后（无选中则末尾） |
| 6 | 录制流程 | 开始/停止录制正常；录制中拖拽/复制/编辑入口禁用 |
| 7 | 撤销 | 编辑/粘贴/拖拽/复制后 Cmd+Z 均可回退 |
| 8 | 执行 | 改过 locator 的步骤能正常回放（runCase 走新 locator） |

- [ ] **Step 3: 修复发现的问题并 commit（如有）**

```bash
git add -A apps/web/src
git commit -m "fix(web): regression fixes from step editing QA"
```

---

## Self-Review 结论

- **Spec 覆盖**：列表可读性（Task 2/7）、完整编辑+locator+类型切换（Task 4/5/6/7）、拖拽+单步复制+定位粘贴（Task 7/8）、校验前置（Task 3/6）——全部有对应任务；明确不做项（内联编辑/redo/后端改动）未越界。
- **占位符**：无 TBD/TODO；所有代码步骤给了完整代码或精确行号迁移指令。
- **类型一致性**：`StepClip`、`StepKind`、`Locator`、`validateStepEdit` 签名在各任务间一致；`switchAction` 的 `kindNeedsLocator` 在 Task 4 定义、Task 6 使用。
- **已知限制（不在本次范围）**：撤销恢复走 replaceSteps 会重新生成 step id 并重加密敏感值（既有行为，非本次引入）；拖拽撤销同样经 replaceSteps（快照无 id，行为一致）。
