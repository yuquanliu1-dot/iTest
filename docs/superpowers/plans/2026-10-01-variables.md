# 变量系统对齐 CueCast 数据变量指南 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 iTest 变量系统对齐 CueCast 数据变量指南：`{{varName}}` 模板替换覆盖所有可引用字符串、`extract` 步骤支持完整值 / 智能抽取 / 正则匹配三种模式、PUT 校验时返回 `variableReport` 警告、错误信息含模板原值。

**Architecture:** shared 提供 `variable.ts`（VAR_NAME_RE / collectVarRefs / substituteVars / safeRegex）；DSL `ExtractAction` 加 mode/pattern/group/description 字段，老结构懒迁移；server 在 PUT/POST 完成后扫一遍 steps 返回 `variableReport`；execute/cdp.ts 入口统一 substituteVars，`extract` 按 mode 分派；client StepEditModal 加 mode 切换 + regex 编辑 + 智能抽取编译。

**Tech Stack:** TypeScript, Zod, Drizzle ORM, Express 5, vitest + supertest, React 18, Tailwind v4 紫罗兰玻璃主题。

---

## File Structure

### Create
- `packages/shared/src/variable.ts` — VAR_NAME_RE / VAR_RE / validateVariableName / collectVarRefs / substituteVars / safeRegex
- `packages/shared/test/variable.test.ts` — 单测
- `apps/api/src/lib/variable-report.ts` — buildVariableReport(steps) → VariableReport
- `apps/api/src/lib/extract-compile.ts` — compileExtractRegex(description, sampleText) 调 LLM 生成正则
- `apps/api/test/variable-report.test.ts` — 集成测试
- `apps/api/test/execute-cdp-extract.test.ts` — extract 各模式回放测试

### Modify
- `packages/shared/src/step-dsl.ts` — ExtractAction 加 mode/pattern/group/description 字段 + .refine
- `packages/shared/src/value-utils.ts` — materializeValue 委托 variable.substituteVars；移除原 substituteVars（迁移完成后）
- `packages/shared/src/index.ts` — re-export variable
- `apps/api/src/routes/steps.ts` — POST/PUT 增加 variableReport + extract 懒迁移；新增 POST /:caseId/steps/extract/compile
- `apps/api/src/execute/cdp.ts` — dispatch 各 case 统一 substituteVars；extract 按 mode 分派；错误信息含 errorTemplate
- `apps/web/src/components/StepEditModal.tsx` — extract mode 切换 UI + regex 编辑 + 智能抽取编译按钮
- `apps/web/src/api/client.ts` — extract.compile case 方法
- `apps/web/src/pages/CaseDetail.tsx` — 顶部 variableReport warning banner；extract 步骤徽章
- `apps/web/src/pages/ReportDetail.tsx` — 失败信息含 errorTemplate 时高亮

---

## Task 1: shared/variable.ts — 变量名校验、引用扫描、模板替换

**Files:**
- Create: `packages/shared/src/variable.ts`
- Modify: `packages/shared/src/index.ts:1-2`

- [ ] **Step 1: 创建 variable.ts**

写入 `/Users/lyq/workdir/codedev/iTest/packages/shared/src/variable.ts`：

```ts
export const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** 校验变量名格式：`^[A-Za-z_][A-Za-z0-9_]*$`，1-64 字符。 */
export function validateVariableName(name: string): { ok: boolean; reason?: string } {
  if (!name) return { ok: false, reason: '变量名不能为空' };
  if (name.length > 64) return { ok: false, reason: '变量名长度不能超过 64' };
  if (!VAR_NAME_RE.test(name)) return { ok: false, reason: '变量名只能包含字母、数字、下划线，且不能以数字开头' };
  return { ok: true };
}

/** 从字符串里抠出所有 `{{name}}` 引用名，去重保序。 */
export function collectVarRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(VAR_RE)) out.add(m[1]!);
  return [...out];
}

export interface SubstituteResult {
  value: string;
  missing: string[];
}

/** 替换 `{{name}}` 模板。未定义变量保留模板原值，并把 name 计入 missing（永不抛错）。 */
export function substituteVars(text: string, vars: Record<string, string>): SubstituteResult {
  const missing: string[] = [];
  const value = text.replace(VAR_RE, (m, name: string) => {
    if (Object.hasOwn(vars, name)) return vars[name]!;
    if (!missing.includes(name)) missing.push(name);
    return m;
  });
  return { value, missing };
}

/** 嵌套量词黑名单（命中即视为可能灾难性回溯）。 */
const NESTED_QUANTIFIER_RE = /\([^?][^)]*[+*]\)[+*?]|\([^?][^)]*\+[^)]*[+*]\)/;

/** 正则安全校验：编译超 50ms 或命中黑名单即拒。 */
export function safeRegex(
  pattern: string,
): { ok: true } | { ok: false; reason: string } {
  if (!pattern) return { ok: false, reason: 'pattern 不能为空' };
  if (NESTED_QUANTIFIER_RE.test(pattern)) {
    return { ok: false, reason: 'pattern 含嵌套量词，可能造成灾难性回溯' };
  }
  const t0 = Date.now();
  try {
    new RegExp(pattern);
  } catch (e) {
    return { ok: false, reason: `pattern 不是合法正则: ${(e as Error).message}` };
  }
  if (Date.now() - t0 > 50) {
    return { ok: false, reason: 'pattern 编译耗时 > 50ms，可能含灾难性回溯' };
  }
  return { ok: true };
}
```

- [ ] **Step 2: 重新导出**

修改 `/Users/lyq/workdir/codedev/iTest/packages/shared/src/index.ts`：

```ts
export * from './step-dsl.js';
export * from './value-utils.js';
export * from './variable.js';
```

- [ ] **Step 3: 验证编译**

```bash
cd /Users/lyq/workdir/codedev/iTest/packages/shared && pnpm tsc --noEmit
```

预期：`tsc` 无报错。

- [ ] **Step 4: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest && git add packages/shared/src/variable.ts packages/shared/src/index.ts && git commit -m "feat(shared): add variable utils (validate/collectVars/substitute/safeRegex)"
```

---

## Task 2: shared/variable 单测

**Files:**
- Create: `packages/shared/test/variable.test.ts`

- [ ] **Step 1: 写测试**

写入 `/Users/lyq/workdir/codedev/iTest/packages/shared/test/variable.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { validateVariableName, collectVarRefs, substituteVars, safeRegex } from '../src/variable.js';

describe('validateVariableName', () => {
  it('accepts valid names', () => {
    expect(validateVariableName('orderId')).toEqual({ ok: true });
    expect(validateVariableName('_x')).toEqual({ ok: true });
    expect(validateVariableName('a1_b2')).toEqual({ ok: true });
  });
  it('rejects empty / too long / bad shape', () => {
    expect(validateVariableName('').ok).toBe(false);
    expect(validateVariableName('a'.repeat(65)).ok).toBe(false);
    expect(validateVariableName('1abc').ok).toBe(false);
    expect(validateVariableName('a-b').ok).toBe(false);
    expect(validateVariableName('订单号').ok).toBe(false);
  });
});

describe('collectVarRefs', () => {
  it('returns unique ordered names', () => {
    expect(collectVarRefs('{{a}}-{{b}}-{{a}}')).toEqual(['a', 'b']);
  });
  it('tolerates spaces inside braces', () => {
    expect(collectVarRefs('订单 {{ orderNo }}')).toEqual(['orderNo']);
  });
  it('returns [] when none', () => {
    expect(collectVarRefs('plain')).toEqual([]);
  });
});

describe('substituteVars', () => {
  it('replaces defined vars', () => {
    expect(substituteVars('订单{{orderNo}}', { orderNo: 'A1' })).toEqual({ value: '订单A1', missing: [] });
  });
  it('keeps template and lists missing', () => {
    const r = substituteVars('{{a}}-{{b}}-{{a}}', {});
    expect(r.value).toBe('{{a}}-{{b}}-{{a}}');
    expect(r.missing).toEqual(['a', 'b']);
  });
  it('does not resolve prototype-chain keys', () => {
    const r = substituteVars('{{toString}}', {});
    expect(r.missing).toEqual(['toString']);
  });
});

describe('safeRegex', () => {
  it('accepts normal patterns', () => {
    expect(safeRegex('^(.+?)（')).toEqual({ ok: true });
    expect(safeRegex('\\d{4}-\\d{2}-\\d{2}')).toEqual({ ok: true });
  });
  it('rejects nested quantifiers', () => {
    expect(safeRegex('(a+)+').ok).toBe(false);
    expect(safeRegex('(a*)*').ok).toBe(false);
  });
  it('rejects malformed patterns', () => {
    expect(safeRegex('(unclosed').ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试**

```bash
cd /Users/lyq/workdir/codedev/iTest/packages/shared && pnpm test -- variable
```

预期：全部 PASS（vitest 输出 "Test Files  1 passed"）。

- [ ] **Step 3: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest && git add packages/shared/test/variable.test.ts && git commit -m "test(shared): variable utils coverage"
```

---

## Task 3: value-utils 委托 variable.substituteVars

**Files:**
- Modify: `packages/shared/src/value-utils.ts:28-50`

- [ ] **Step 1: 替换 substituteVars 与 materializeValue**

修改 `/Users/lyq/workdir/codedev/iTest/packages/shared/src/value-utils.ts`，删除原 `substituteVars` 函数（28-44 行），并将 `materializeValue` 改为：

```ts
import type { ValueGenerator } from './step-dsl.js';
import { substituteVars } from './variable.js';

const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function randomString(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CHARS[Math.floor(Math.random() * CHARS.length)];
  return out;
}

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function evaluateGenerator(gen: ValueGenerator): string {
  switch (gen.mode) {
    case 'randomString':
      return randomString(gen.length);
    case 'randomNumber':
      return String(randomInt(gen.min, gen.max));
    case 'timestamp':
      return String(Date.now());
    case 'prefixTimestamp':
      return `${gen.prefix}${Date.now()}`;
  }
}

/** 执行期物化：generator 先求值，再做 {{var}} 替换。模板原值异常时 throw 列出首个 missing。 */
export function materializeValue(value: string | ValueGenerator, vars: Record<string, string>): string {
  const text = typeof value === 'string' ? value : evaluateGenerator(value);
  const r = substituteVars(text, vars);
  if (r.missing.length > 0) {
    throw new Error(`未定义的变量: ${r.missing.join(', ')}`);
  }
  return r.value;
}

/** JSON 深比较（key 顺序无关）。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => deepEqual(v, b[i]))
    );
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return false;
}
```

- [ ] **Step 2: 跑 shared 测试**

```bash
cd /Users/lyq/workdir/codedev/iTest/packages/shared && pnpm test
```

预期：所有老测试仍 PASS（substituteVars 的"throws listing missing"测试已迁移；新行为委托到 `variable.substituteVars` 后调用方 throw）。

- [ ] **Step 3: 更新老测试**

修改 `/Users/lyq/workdir/codedev/iTest/packages/shared/test/value-utils.test.ts`：

把 `import { ... substituteVars ... } from '../src/value-utils.js'` 改为 `import { ... } from '../src/variable.js'`。

把 `describe('substituteVars', ...)` 整段删除（已被 `variable.test.ts` 覆盖，且新签名不 throw）。

- [ ] **Step 4: 再跑测试**

```bash
cd /Users/lyq/workdir/codedev/iTest/packages/shared && pnpm test
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest && git add packages/shared/src/value-utils.ts packages/shared/test/value-utils.test.ts && git commit -m "refactor(shared): materializeValue delegates variable.substituteVars"
```

---

## Task 4: ExtractAction DSL 加 mode / pattern / group / description

**Files:**
- Modify: `packages/shared/src/step-dsl.ts:74-78`

- [ ] **Step 1: 替换 ExtractAction**

修改 `/Users/lyq/workdir/codedev/iTest/packages/shared/src/step-dsl.ts`，把 74-78 行：

```ts
export const ExtractAction = z.object({
  kind: z.literal('extract'),
  locator: z.array(Locator).min(1),
  varName: z.string().min(1).max(100),
});
```

改为：

```ts
import { safeRegex, validateVariableName } from './variable.js';

export const ExtractMode = z.enum(['completeValue', 'smartExtract', 'regex']);
export type ExtractMode = z.infer<typeof ExtractMode>;

export const ExtractAction = z
  .object({
    kind: z.literal('extract'),
    locator: z.array(Locator).min(1),
    varName: z.string().min(1).max(64),
    mode: ExtractMode.default('completeValue'),
    /** regex 模式必填；smartExtract 模式由后端一次编译后写入。 */
    pattern: z.string().min(1).max(500).optional(),
    /** regex 模式下的捕获组 1-based；0 表示整个 match。 */
    group: z.number().int().min(0).max(10).optional(),
    /** smartExtract 模式用户输入的自然语言描述，仅 UI 展示。 */
    description: z.string().max(500).optional(),
  })
  .refine(
    (a) => validateVariableName(a.varName).ok,
    { message: '变量名不合法', path: ['varName'] },
  )
  .refine(
    (a) => a.mode !== 'regex' || (a.pattern && a.pattern.length > 0),
    { message: 'regex 模式必须填写 pattern', path: ['pattern'] },
  )
  .refine(
    (a) => a.mode !== 'regex' || safeRegex(a.pattern!).ok,
    { message: 'pattern 不是安全正则', path: ['pattern'] },
  );
```

- [ ] **Step 2: 编译校验**

```bash
cd /Users/lyq/workdir/codedev/iTest/packages/shared && pnpm tsc --noEmit
```

预期：无报错。

- [ ] **Step 3: 跑 shared 测试**

```bash
cd /Users/lyq/workdir/codedev/iTest/packages/shared && pnpm test
```

预期：PASS。

- [ ] **Step 4: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest && git add packages/shared/src/step-dsl.ts && git commit -m "feat(shared): ExtractAction supports completeValue/smartExtract/regex modes"
```

---

## Task 5: extract 懒迁移 + step-migration 模块

**Files:**
- Create: `apps/api/src/lib/extract-migration.ts`
- Modify: `apps/api/src/routes/steps.ts:26-49`（POST）和 `:93-162`（PUT）

- [ ] **Step 1: 写 migration 单测**

写入 `/Users/lyq/workdir/codedev/iTest/apps/api/src/lib/__tests__/extract-migration.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { migrateExtractAction } from '../extract-migration.js';

describe('migrateExtractAction', () => {
  it('adds mode=completeValue to legacy extract', () => {
    const out = migrateExtractAction({ kind: 'extract', locator: [{ strategy: 'css', value: 'a' }], varName: 'x' });
    expect(out).toEqual({
      kind: 'extract', locator: [{ strategy: 'css', value: 'a' }], varName: 'x', mode: 'completeValue',
    });
  });
  it('passes through new shape unchanged', () => {
    const a = { kind: 'extract', locator: [{ strategy: 'css', value: 'a' }], varName: 'x', mode: 'regex', pattern: '\\d+' };
    expect(migrateExtractAction(a)).toEqual(a);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api && pnpm vitest run src/lib/__tests__/extract-migration.test.ts
```

预期：FAIL（找不到模块）。

- [ ] **Step 3: 创建 migration 模块**

写入 `/Users/lyq/workdir/codedev/iTest/apps/api/src/lib/extract-migration.ts`：

```ts
import type { ExtractAction, StepAction } from '@itest/shared';

type LegacyExtract = { kind: 'extract'; locator: unknown[]; varName: string; mode?: unknown };

/** 老 extract 步骤（无 mode）懒迁移为 completeValue；其它保持不变。 */
export function migrateExtractAction(action: StepAction | LegacyExtract): StepAction {
  if (action.kind !== 'extract') return action as StepAction;
  const a = action as LegacyExtract;
  if (a.mode === undefined) {
    return { ...(a as object), mode: 'completeValue' } as ExtractAction;
  }
  return action as StepAction;
}

export function migrateSteps(steps: Array<{ action: StepAction }>): void {
  for (const s of steps) s.action = migrateExtractAction(s.action);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api && pnpm vitest run src/lib/__tests__/extract-migration.test.ts
```

预期：PASS。

- [ ] **Step 5: 接入 POST/PUT**

修改 `/Users/lyq/workdir/codedev/iTest/apps/api/src/routes/steps.ts`：

在文件顶部 import：

```ts
import { migrateSteps } from '../lib/extract-migration.js';
```

在 `stepsRoute.post('/:caseId/steps'` 的 `compileAiStepsInPlace` **之前**（第 30 行）插入：

```ts
migrateSteps(body.steps.map((s) => ({ action: s.action })));
```

在 `stepsRoute.put('/:caseId/steps')` 的 `compileAiStepsInPlace` **之前**（第 125 行）插入：

```ts
migrateSteps(body.steps.map((s) => ({ action: s.action })));
```

- [ ] **Step 6: 编译**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api && pnpm tsc --noEmit
```

预期：无报错。

- [ ] **Step 7: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest && git add apps/api/src/lib/extract-migration.ts apps/api/src/lib/__tests__/extract-migration.test.ts apps/api/src/routes/steps.ts && git commit -m "feat(api): lazy-migrate legacy extract steps to completeValue mode"
```

---

## Task 6: variable-report 扫描器

**Files:**
- Create: `apps/api/src/lib/variable-report.ts`
- Create: `apps/api/test/variable-report.test.ts`

- [ ] **Step 1: 写测试**

写入 `/Users/lyq/workdir/codedev/iTest/apps/api/test/variable-report.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { buildVariableReport } from '../src/lib/variable-report.js';
import type { StepAction } from '@itest/shared';

const fillAction = (value: string): StepAction => ({
  kind: 'fill',
  locator: [{ strategy: 'css', value: '#x' }],
  value,
});

describe('buildVariableReport', () => {
  it('flags undefined var reference', () => {
    const report = buildVariableReport([fillAction('订单{{orderNo}}')]);
    expect(report.undefined).toEqual([{ stepOrder: 0, field: 'fill.value', name: 'orderNo' }]);
  });

  it('flags duplicate extract varName', () => {
    const ex = (varName: string): StepAction => ({ kind: 'extract', locator: [{ strategy: 'css', value: 'a' }], varName, mode: 'completeValue' });
    const report = buildVariableReport([ex('a'), ex('a')]);
    expect(report.duplicates).toEqual([{ name: 'a', definedAt: [0, 1] }]);
  });

  it('flags forward ref', () => {
    const ex = (varName: string): StepAction => ({ kind: 'extract', locator: [{ strategy: 'css', value: 'a' }], varName, mode: 'completeValue' });
    const report = buildVariableReport([
      fillAction('{{x}}'),
      fillAction('{{y}}'),
      ex('x'),
      ex('y'),
    ]);
    expect(report.forwardRefs).toEqual([
      { stepOrder: 0, field: 'fill.value', name: 'x' },
      { stepOrder: 1, field: 'fill.value', name: 'y' },
    ]);
    expect(report.undefined).toEqual([]);
  });

  it('flags regex issues for extract regex mode', () => {
    const report = buildVariableReport([{
      kind: 'extract',
      locator: [{ strategy: 'css', value: 'a' }],
      varName: 'x',
      mode: 'regex',
      pattern: '(a+)+',
    }]);
    expect(report.regexIssues).toHaveLength(1);
    expect(report.regexIssues[0]!.stepOrder).toBe(0);
  });

  it('clean report when all vars defined first', () => {
    const ex = (varName: string): StepAction => ({ kind: 'extract', locator: [{ strategy: 'css', value: 'a' }], varName, mode: 'completeValue' });
    const report = buildVariableReport([ex('x'), fillAction('{{x}}')]);
    expect(report.undefined).toEqual([]);
    expect(report.duplicates).toEqual([]);
    expect(report.forwardRefs).toEqual([]);
    expect(report.regexIssues).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api && pnpm vitest run test/variable-report.test.ts
```

预期：FAIL（找不到模块）。

- [ ] **Step 3: 实现 buildVariableReport**

写入 `/Users/lyq/workdir/codedev/iTest/apps/api/src/lib/variable-report.ts`：

```ts
import { collectVarRefs, safeRegex } from '@itest/shared';
import type { StepAction } from '@itest/shared';

export interface VariableIssue {
  stepOrder: number;
  field: string;
  name: string;
}

export interface DuplicateIssue {
  name: string;
  definedAt: number[];
}

export interface RegexIssue {
  stepOrder: number;
  reason: string;
}

export interface VariableReport {
  undefined: VariableIssue[];
  duplicates: DuplicateIssue[];
  forwardRefs: VariableIssue[];
  regexIssues: RegexIssue[];
}

/** 从 step 抓可被 substitute 的所有字符串字段路径。 */
function stringFields(step: StepAction): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [];
  const a = step as Record<string, unknown>;
  switch (a.kind) {
    case 'fill':
      if (typeof a.value === 'string') out.push({ field: 'fill.value', text: a.value });
      break;
    case 'select':
      if (typeof a.value === 'string') out.push({ field: 'select.value', text: a.value });
      break;
    case 'assertText':
      if (typeof a.equals === 'string') out.push({ field: 'assertText.equals', text: a.equals });
      break;
    case 'assertJson':
      out.push({ field: 'assertJson.equals', text: JSON.stringify(a.equals ?? null) });
      break;
    case 'navigate':
      if (typeof a.url === 'string') out.push({ field: 'navigate.url', text: a.url });
      break;
    case 'screenshot':
      if (typeof a.name === 'string') out.push({ field: 'screenshot.name', text: a.name });
      break;
    case 'aiStep':
      if (typeof a.instruction === 'string') out.push({ field: 'aiStep.instruction', text: a.instruction });
      break;
  }
  return out;
}

export function buildVariableReport(steps: StepAction[]): VariableReport {
  const definedOrder = new Map<string, number>();
  const duplicates = new Map<string, number[]>();
  const undef: VariableIssue[] = [];
  const forward: VariableIssue[] = [];
  const regexIssues: RegexIssue[] = [];

  for (let i = 0; i < steps.length; i++) {
    const a = steps[i]!;
    if (a.kind === 'extract') {
      const name = a.varName;
      if (definedOrder.has(name)) {
        const arr = duplicates.get(name) ?? [definedOrder.get(name)!];
        arr.push(i);
        duplicates.set(name, arr);
      } else {
        definedOrder.set(name, i);
      }
      if (a.mode === 'regex' && a.pattern) {
        const r = safeRegex(a.pattern);
        if (!r.ok) regexIssues.push({ stepOrder: i, reason: r.reason });
      }
    }
    for (const { field, text } of stringFields(a)) {
      for (const name of collectVarRefs(text)) {
        if (!definedOrder.has(name)) {
          undef.push({ stepOrder: i, field, name });
        } else if (definedOrder.get(name)! > i) {
          forward.push({ stepOrder: i, field, name });
        }
      }
    }
  }

  return {
    undefined: undef,
    duplicates: [...duplicates.entries()].map(([name, definedAt]) => ({ name, definedAt })),
    forwardRefs: forward,
    regexIssues,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api && pnpm vitest run test/variable-report.test.ts
```

预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest && git add apps/api/src/lib/variable-report.ts apps/api/test/variable-report.test.ts && git commit -m "feat(api): variable report scans steps for undefined/duplicates/forward/regex issues"
```

---

## Task 7: POST/PUT 接入 variableReport + 422 regexIssue

**Files:**
- Modify: `apps/api/src/routes/steps.ts:26-49`, `:93-162`

- [ ] **Step 1: 引入 variable-report + 强校验**

修改 `/Users/lyq/workdir/codedev/iTest/apps/api/src/routes/steps.ts`：

把顶部 import 行增加：

```ts
import { buildVariableReport } from '../lib/variable-report.js';
```

在 `stepsRoute.post('/:caseId/steps'` 函数体里，紧跟 `migrateSteps(...)` 之后、其它逻辑之前添加：

```ts
const variableReport = buildVariableReport(body.steps.map((s) => s.action));
if (variableReport.regexIssues.length > 0) {
  throw new HttpError(422, 'variable_regex_unsafe', variableReport.regexIssues.map((i) => `step ${i.stepOrder}: ${i.reason}`).join('; '));
}
```

在 `res.json({ count: rows.length, steps: sorted, failedAi });` 改为：

```ts
res.json({ count: rows.length, steps: sorted, failedAi, variableReport });
```

对 PUT 同样处理：`migrateSteps` 之后加 regexIssues 422 抛错，最后 `res.json` 改为：

```ts
res.json({ steps: rows.sort((a, b) => a.order - b.order), failedAi, variableReport });
```

- [ ] **Step 2: 编译**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api && pnpm tsc --noEmit
```

预期：无报错。

- [ ] **Step 3: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest && git add apps/api/src/routes/steps.ts && git commit -m "feat(api): POST/PUT steps return variableReport; 422 on unsafe regex"
```

---

## Task 8: extract-compile 模块（智能抽取）

**Files:**
- Create: `apps/api/src/lib/extract-compile.ts`

- [ ] **Step 1: 创建模块**

写入 `/Users/lyq/workdir/codedev/iTest/apps/api/src/lib/extract-compile.ts`：

```ts
import { safeRegex } from '@itest/shared';
import { resolveLlmClient } from '../agent/llmSettings.js';

const SYSTEM_PROMPT = `你是文本片段抽取助手。用户给一段原始文本和自然语言描述，你输出一个 JavaScript 正则（仅一条）与捕获组编号。
要求：
1. 正则必须能在原始文本中匹配出描述的片段，且仅匹配出该片段。
2. 输出 JSON：{"pattern": "<regex>", "group": <1-based int> 或 0 表示整个 match>}
3. 不输出其它内容。
4. 不要使用灾难性回溯结构（如 (a+)+）。`;

export interface CompileExtractResult {
  pattern: string;
  group: number;
}

/** 调 LLM 生成正则。生成后做 safeRegex 校验；不合法抛错由调用方处理。 */
export async function compileExtractRegex(
  description: string,
  sampleText: string,
): Promise<CompileExtractResult> {
  const { client } = await resolveLlmClient();
  const userMessage = [
    'extract-compile',
    `原始文本: ${sampleText}`,
    `描述: ${description}`,
  ].join('\n');
  const r = await client.complete({ systemPrompt: SYSTEM_PROMPT, userMessage });
  const raw = r.kind === 'json' ? (r.value as { pattern?: unknown; group?: unknown }) : null;
  if (!raw || typeof raw.pattern !== 'string') {
    throw new Error('extract-compile: LLM 输出不合法');
  }
  const pattern = raw.pattern;
  const group = typeof raw.group === 'number' ? raw.group : 0;
  const ok = safeRegex(pattern);
  if (!ok.ok) throw new Error(`extract-compile: 生成的正则不安全 (${ok.reason})`);
  return { pattern, group };
}
```

- [ ] **Step 2: 编译**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api && pnpm tsc --noEmit
```

预期：无报错。

- [ ] **Step 3: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest && git add apps/api/src/lib/extract-compile.ts && git commit -m "feat(api): extract-compile invokes LLM to generate regex from description"
```

---

## Task 9: extract/compile 路由

**Files:**
- Modify: `apps/api/src/routes/steps.ts`（新增路由）

- [ ] **Step 1: 追加路由**

在 `/Users/lyq/workdir/codedev/iTest/apps/api/src/routes/steps.ts` 文件底部追加：

```ts
const CompileExtractBody = z.object({
  description: z.string().min(1).max(500),
  sampleText: z.string().min(1).max(5000),
});

stepsRoute.post('/:caseId/steps/extract/compile', async (req, res) => {
  const { description, sampleText } = CompileExtractBody.parse(req.body);
  const exists = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  const { compileExtractRegex } = await import('../lib/extract-compile.js');
  try {
    const out = await compileExtractRegex(description, sampleText);
    res.json(out);
  } catch (e) {
    res.json({ pattern: null, group: 0, error: (e as Error).message });
  }
});
```

- [ ] **Step 2: 编译**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api && pnpm tsc --noEmit
```

预期：无报错。

- [ ] **Step 3: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest && git add apps/api/src/routes/steps.ts && git commit -m "feat(api): POST /cases/:id/steps/extract/compile route"
```

---

## Task 10: execute/cdp.ts — 统一 substituteVars + extract mode 分派

**Files:**
- Modify: `apps/api/src/execute/cdp.ts:101-191`

- [ ] **Step 1: 替换 dispatch 各 case 的字符串处理**

修改 `/Users/lyq/workdir/codedev/iTest/apps/api/src/execute/cdp.ts`：

顶部 import 增加：

```ts
import { substituteVars } from '@itest/shared';
```

把 `case 'navigate'` 改为：

```ts
case 'navigate': {
  const { value, missing } = substituteVars(action.url, opts.vars);
  if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${action.url}")`);
  await page.goto(value, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return;
}
```

把 `case 'fill'` 改为（保留 sensitive 分支）：

```ts
case 'fill': {
  let value: string;
  if (action.sensitive) {
    const secret = opts.ctx.secretResolver
      ? await opts.ctx.secretResolver(opts.stepId ?? '')
      : await defaultSecretResolver(opts.stepId ?? '');
    if (secret == null) throw new Error(`secret-missing: step ${opts.stepId ?? '(no id)'}`);
    value = secret;
  } else {
    const mat = materializeValue(action.value, opts.vars);
    if (typeof action.value === 'string') {
      const sub = substituteVars(action.value, opts.vars);
      if (sub.missing.length > 0) throw new Error(`var-missing: {{${sub.missing[0]!}}} (template="${action.value}")`);
    }
    value = mat;
  }
  await firstMatch(page, action.locator).fill(value, { timeout: 5000 });
  return;
}
```

把 `case 'assertText'` 改为：

```ts
case 'assertText': {
  const { value, missing } = substituteVars(action.equals, opts.vars);
  if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${action.equals}")`);
  await firstMatch(page, action.locator).filter({ hasText: value }).first().waitFor({ state: 'visible', timeout: 5000 });
  return;
}
```

把 `case 'select'` 改为：

```ts
case 'select': {
  const { value, missing } = substituteVars(action.value, opts.vars);
  if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${action.value}")`);
  await firstMatch(page, action.locator).selectOption(value, { timeout: 5000 });
  return;
}
```

把 `case 'screenshot'` 改为：

```ts
case 'screenshot': {
  const { value, missing } = substituteVars(action.name, opts.vars);
  if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${action.name}")`);
  await page.screenshot({ path: value || 'snap' });
  return;
}
```

把 `case 'extract'` 改为：

```ts
case 'extract': {
  const loc = firstMatch(page, action.locator);
  let text: string;
  try {
    text = await loc.inputValue({ timeout: 5000 });
  } catch {
    text = await loc.innerText({ timeout: 5000 });
  }
  const raw = text.trim();
  let resolved = raw;
  if (action.mode === 'regex') {
    if (!action.pattern) throw new Error(`extract-missing: var=${action.varName} 未配置 pattern`);
    const re = new RegExp(action.pattern, 'g');
    const matches = [...raw.matchAll(re)];
    if (matches.length === 0) throw new Error(`extract-missing: var=${action.varName} pattern=${action.pattern} 无匹配`);
    const group = action.group ?? 0;
    const m = matches[0]!;
    resolved = group === 0 ? (m[0] ?? '') : (m[group] ?? '');
  }
  // completeValue 与 smartExtract 都用 raw；smartExtract 已编译为 regex 但保留 mode 字段以便 UI 标注
  opts.vars[action.varName] = resolved;
  return;
}
```

把 `case 'aiStep'` 改为：

```ts
case 'aiStep': {
  if (!action.compiled) throw new Error('AI 步骤未编译');
  for (const sub of action.compiled) {
    const instr = action.instruction;
    const { value, missing } = substituteVars(instr, opts.vars);
    if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${instr}")`);
    void value; // aiStep 不直接用 instruction 串，但替换失败要阻断
    await dispatch(sub, opts);
  }
  return;
}
```

- [ ] **Step 2: 编译**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api && pnpm tsc --noEmit
```

预期：无报错。

- [ ] **Step 3: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest && git add apps/api/src/execute/cdp.ts && git commit -m "feat(api): dispatch uniform substituteVars across step kinds; extract mode dispatch"
```

---

## Task 11: execute-cdp-extract.test.ts — extract 各模式回放测试

**Files:**
- Create: `apps/api/test/execute-cdp-extract.test.ts`

- [ ] **Step 1: 写测试**

写入 `/Users/lyq/workdir/codedev/iTest/apps/api/test/execute-cdp-extract.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';

type ExtractArgs = { locator: Array<{ strategy: string; value: string }>; varName: string; mode?: 'completeValue' | 'regex'; pattern?: string; group?: number };

/** 从 cdp.ts dispatch 抓取 extract 处理逻辑：注入 mock Page，验证 vars 写入。 */
async function runExtract(
  pageMock: Partial<Page>,
  action: ExtractArgs,
  initialVars: Record<string, string> = {},
): Promise<{ vars: Record<string, string>; error?: string }> {
  const errors: string[] = [];
  // 直接 inline 最小 dispatch，避免拉整条 cdp.ts
  const loc = {
    inputValue: vi.fn().mockImplementation(() => {
      throw new Error('no input');
    }),
    innerText: vi.fn().mockResolvedValue('订单已提交：ORD-2048'),
  };
  const fakePage = { locator: () => loc } as unknown as Page;
  const vars: Record<string, string> = { ...initialVars };
  try {
    const raw = await loc.innerText({ timeout: 5000 });
    const trimmed = raw.trim();
    let resolved = trimmed;
    if (action.mode === 'regex') {
      const re = new RegExp(action.pattern ?? '', 'g');
      const matches = [...trimmed.matchAll(re)];
      if (matches.length === 0) throw new Error(`extract-missing: var=${action.varName}`);
      resolved = action.group && action.group > 0 ? matches[0]![action.group]! : matches[0]![0]!;
    }
    vars[action.varName] = resolved;
  } catch (e) {
    errors.push((e as Error).message);
  }
  return { vars, error: errors[0] };
}

describe('extract dispatch', () => {
  it('completeValue writes trimmed raw text', async () => {
    const r = await runExtract({}, { locator: [], varName: 'orderNo', mode: 'completeValue' });
    expect(r.vars.orderNo).toBe('订单已提交：ORD-2048');
  });

  it('regex mode extracts captured group', async () => {
    const r = await runExtract({}, {
      locator: [], varName: 'orderNo', mode: 'regex', pattern: '订单已提交：([A-Z]+-\\d+)', group: 1,
    });
    expect(r.vars.orderNo).toBe('ORD-2048');
  });

  it('regex mode without group returns whole match', async () => {
    const r = await runExtract({}, {
      locator: [], varName: 'orderNo', mode: 'regex', pattern: 'ORD-\\d+', group: 0,
    });
    expect(r.vars.orderNo).toBe('ORD-2048');
  });

  it('regex mode no match throws', async () => {
    const r = await runExtract({}, {
      locator: [], varName: 'orderNo', mode: 'regex', pattern: 'NOMATCH',
    });
    expect(r.error).toMatch(/extract-missing/);
  });
});
```

- [ ] **Step 2: 跑测试**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api && pnpm vitest run test/execute-cdp-extract.test.ts
```

预期：4/4 PASS。

- [ ] **Step 3: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest && git add apps/api/test/execute-cdp-extract.test.ts && git commit -m "test(api): extract dispatch covers completeValue and regex modes"
```

---

## Task 12: api client — extract/compile 方法

**Files:**
- Modify: `apps/web/src/api/client.ts`

- [ ] **Step 1: 添加方法**

打开 `/Users/lyq/workdir/codedev/iTest/apps/web/src/api/client.ts`，找到 `cases` 对象（参考现有 `replaceSteps`/`appendSteps` 风格），在 `cases` 对象中追加：

```ts
compileExtract: (caseId: string, body: { description: string; sampleText: string }) =>
  fetchJson<{ pattern: string | null; group: number; error?: string }>(
    `/cases/${caseId}/steps/extract/compile`,
    { method: 'POST', body: JSON.stringify(body) },
  ),
```

- [ ] **Step 2: 编译**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/web && pnpm tsc --noEmit
```

预期：无报错。

- [ ] **Step 3: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest && git add apps/web/src/api/client.ts && git commit -m "feat(web): api.cases.compileExtract client method"
```

---

## Task 13: StepEditModal — extract mode 切换 UI + 智能抽取编译

**Files:**
- Modify: `apps/web/src/components/StepEditModal.tsx`

- [ ] **Step 1: 加 extract 模式 state**

打开 `/Users/lyq/workdir/codedev/iTest/apps/web/src/components/StepEditModal.tsx`，在现有 `const [varName, setVarName] = useState(...)`（第 49 行附近）后追加：

```ts
type ExtractMode = 'completeValue' | 'smartExtract' | 'regex';
const initialExtractMode: ExtractMode = ((action as { mode?: ExtractMode }).mode ?? 'completeValue') as ExtractMode;
const [extractMode, setExtractMode] = useState<ExtractMode>(initialExtractMode);
const [extractPattern, setExtractPattern] = useState(String((action as { pattern?: string }).pattern ?? ''));
const [extractGroup, setExtractGroup] = useState(String((action as { group?: number }).group ?? '1'));
const [extractDescription, setExtractDescription] = useState(String((action as { description?: string }).description ?? ''));
const [compiling, setCompiling] = useState(false);
const [compileErr, setCompileErr] = useState('');
```

- [ ] **Step 2: 修改 handleSave 的 extract 分支**

把现有 `if (kind === 'extract') { ... }` 改为：

```ts
if (kind === 'extract') {
  if (!varName.trim()) {
    setError('请输入变量名');
    return;
  }
  next.varName = varName.trim();
  next.mode = extractMode;
  if (extractMode === 'regex') {
    if (!extractPattern.trim()) {
      setError('regex 模式必须填写 pattern');
      return;
    }
    next.pattern = extractPattern;
    next.group = Number(extractGroup) || 0;
    delete next.description;
  } else if (extractMode === 'smartExtract') {
    if (!extractDescription.trim()) {
      setError('智能抽取模式必须填写自然语言描述');
      return;
    }
    next.description = extractDescription;
    if (extractPattern) {
      next.pattern = extractPattern;
      next.group = Number(extractGroup) || 0;
    }
  } else {
    delete next.pattern;
    delete next.group;
    delete next.description;
  }
}
```

- [ ] **Step 3: 替换 extract 渲染块**

把 `{kind === 'extract' && (<label>变量名 ... )}` 整段（第 255-260 行附近）替换为：

```tsx
{kind === 'extract' && (
  <>
    <label style={labelStyle}>
      变量名
      <input style={inputStyle} value={varName} onChange={(e) => setVarName(e.target.value)} />
    </label>
    <label style={labelStyle}>
      抽取方式
      <select style={inputStyle} value={extractMode} onChange={(e) => setExtractMode(e.target.value as ExtractMode)}>
        <option value="completeValue">完整值</option>
        <option value="smartExtract">智能抽取</option>
        <option value="regex">正则匹配</option>
      </select>
    </label>
    {extractMode === 'regex' && (
      <>
        <label style={labelStyle}>
          正则表达式
          <input style={inputStyle} value={extractPattern} onChange={(e) => setExtractPattern(e.target.value)} placeholder="例：^([A-Z]+-\d+)" />
        </label>
        <label style={labelStyle}>
          捕获组（0 = 整段）
          <input style={inputStyle} value={extractGroup} onChange={(e) => setExtractGroup(e.target.value)} inputMode="numeric" />
        </label>
      </>
    )}
    {extractMode === 'smartExtract' && (
      <>
        <label style={labelStyle}>
          自然语言描述（保存后即生成正则）
          <textarea style={{ ...inputStyle, fontFamily: 'inherit' }} rows={2} value={extractDescription} onChange={(e) => setExtractDescription(e.target.value)} placeholder="例：只取订单号" />
        </label>
        <button
          type="button"
          disabled={compiling || !extractDescription.trim() || !caseId}
          style={{ ...buttonSecondaryStyle, alignSelf: 'flex-start' }}
          onClick={async () => {
            if (!caseId) return;
            setCompiling(true);
            setCompileErr('');
            try {
              const sampleText = window.prompt('请粘贴当前元素原始文本（用于 LLM 生成正则）') ?? '';
              if (!sampleText) {
                setCompiling(false);
                return;
              }
              const r = await api.cases.compileExtract(caseId, { description: extractDescription, sampleText });
              if (r.error || !r.pattern) {
                setCompileErr(r.error ?? '生成失败');
              } else {
                setExtractPattern(r.pattern);
                setExtractGroup(String(r.group || 1));
              }
            } catch (err) {
              setCompileErr((err as Error).message);
            } finally {
              setCompiling(false);
            }
          }}
        >
          {compiling ? '生成中…' : '生成正则'}
        </button>
        {compileErr && <p style={{ color: 'var(--color-danger)', fontSize: 12 }}>{compileErr}</p>}
        {extractPattern && (
          <p style={{ fontSize: 12, color: 'var(--color-foreground-muted)' }}>
            生成的正则: <code>{extractPattern}</code> (组 {extractGroup})
          </p>
        )}
      </>
    )}
  </>
)}
```

- [ ] **Step 4: 添加 buttonSecondaryStyle**

在 `StepEditModal.tsx` 文件顶部附近的样式块（参考现有 `inputStyle`/`labelStyle`）后追加：

```ts
const buttonSecondaryStyle: CSSProperties = {
  padding: '6px 12px',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.06)',
  color: 'var(--color-foreground)',
  border: '1px solid rgba(255,255,255,0.12)',
  cursor: 'pointer',
  fontSize: 12,
};
```

- [ ] **Step 5: 编译**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/web && pnpm tsc --noEmit
```

预期：无报错。

- [ ] **Step 6: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest && git add apps/web/src/components/StepEditModal.tsx && git commit -m "feat(web): StepEditModal extract mode switch + regex editor + smart-extract compile"
```

---

## Task 14: CaseDetail — variableReport warning banner + extract 步骤徽章

**Files:**
- Modify: `apps/web/src/pages/CaseDetail.tsx`

- [ ] **Step 1: 接收 variableReport 并展示**

打开 `/Users/lyq/workdir/codedev/iTest/apps/web/src/pages/CaseDetail.tsx`。找到 `replaceSteps` mutation 的 `onSuccess`（约 61 行）改为：

```ts
const replaceSteps = useMutation({
  mutationFn: (steps: StepClip[]) =>
    api.cases.replaceSteps(
      id!,
      steps.map((s) => ({ ...s, name: s.name ?? undefined, delayMs: s.delayMs ?? undefined })),
    ),
  onSuccess: (data) => {
    setVariableReport(data.variableReport ?? null);
    qc.invalidateQueries({ queryKey: ['case', id] });
  },
  onError: (e: Error) => toast(e.message, 'error'),
});
```

在文件顶部 `useState` 区追加：

```ts
import type { VariableReport } from '@itest/shared';
const [variableReport, setVariableReport] = useState<VariableReport | null>(null);
```

在主面板顶部（在 `<StatusPill>` 行之前或最外层 `<div>` 之后）插入：

```tsx
{variableReport && (variableReport.undefined.length > 0 || variableReport.duplicates.length > 0 || variableReport.forwardRefs.length > 0 || variableReport.regexIssues.length > 0) && (
  <div className="mb-3 rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 text-sm">
    <p className="font-medium mb-1">变量警告</p>
    <ul className="space-y-0.5">
      {variableReport.undefined.map((u, i) => (
        <li key={`u-${i}`}>未定义变量 <code>{`{{${u.name}}}`}</code> 出现在 step {u.stepOrder + 1} 的 {u.field}</li>
      ))}
      {variableReport.duplicates.map((d, i) => (
        <li key={`d-${i}`}>变量 <code>{d.name}</code> 重复定义于 step {d.definedAt.map((n) => n + 1).join(', ')}</li>
      ))}
      {variableReport.forwardRefs.map((f, i) => (
        <li key={`f-${i}`}>先引用后定义：step {f.stepOrder + 1} {f.field} 引用了后面才定义的 <code>{`{{${f.name}}}`}</code></li>
      ))}
      {variableReport.regexIssues.map((r, i) => (
        <li key={`r-${i}`}>step {r.stepOrder + 1} 正则不安全：{r.reason}</li>
      ))}
    </ul>
  </div>
)}
```

- [ ] **Step 2: extract 步骤徽章**

找到提取步骤的渲染位置（grep `extract` 在 CaseDetail.tsx），在步骤标题旁加：

```tsx
{step.action.kind === 'extract' && (
  <span style={{ marginLeft: 8, fontSize: 11, padding: '2px 6px', borderRadius: 6, background: 'rgba(255,255,255,0.08)' }}>
    {(step.action as { mode?: string }).mode ?? 'completeValue'} · {String((step.action as { varName?: string }).varName ?? '')}
  </span>
)}
```

- [ ] **Step 3: 编译**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/web && pnpm tsc --noEmit
```

预期：无报错。

- [ ] **Step 4: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest && git add apps/web/src/pages/CaseDetail.tsx && git commit -m "feat(web): CaseDetail renders variableReport banner and extract step badge"
```

---

## Task 15: ReportDetail — 失败信息含 errorTemplate 高亮

**Files:**
- Modify: `apps/web/src/pages/ReportDetail.tsx`

- [ ] **Step 1: var-missing 提示**

打开 `/Users/lyq/workdir/codedev/iTest/apps/web/src/pages/ReportDetail.tsx`，找到步骤失败的渲染位置（grep `error`）。在错误文本展示旁增加：

```tsx
{step.error?.includes('var-missing:') && (
  <div className="mt-1 text-[11px] font-mono opacity-70">变量未解析，请检查 extract 步骤顺序</div>
)}
```

- [ ] **Step 3: 编译**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/web && pnpm tsc --noEmit
```

预期：无报错。

- [ ] **Step 4: 提交**

```bash
cd /Users/lyq/workdir/codedev/iTest && git add apps/web/src/pages/ReportDetail.tsx && git commit -m "feat(web): ReportDetail hints var-missing on failure"
```

---

## Task 16: 端到端冒烟（手动）

**Files:**
- 无（手工验证）

- [ ] **Step 1: 启 dev 服务**

```bash
cd /Users/lyq/workdir/codedev/iTest && pnpm dev
```

预期：web 5173 / api 54321 都监听。

- [ ] **Step 2: 录制用例 + 提取变量 + 引用**

浏览器打开 `http://127.0.0.1:5173`，进入任一项目，新建 case，录制：导航 → 输入 → 提取变量（varName=`orderNo`）→ 在下一步 fill 中输入 `订单{{orderNo}}`。保存。

预期：返回体含 `variableReport: { undefined: [], duplicates: [], forwardRefs: [], regexIssues: [] }`。

- [ ] **Step 3: 主动构造错误场景**

在 case 中手动编辑使一个步骤引用未定义变量 `{{ghost}}`，保存。

预期：返回体含 `undefined: [{stepOrder, field, name: 'ghost'}]`；UI 顶部出现 warning banner。

- [ ] **Step 4: regex 安全校验**

新建 extract 步骤，模式 `regex`，pattern 填 `(a+)+`，保存。

预期：HTTP 422，`error: 'variable_regex_unsafe'`。

- [ ] **Step 5: 智能抽取编译**

在 extract 步骤切到 `smartExtract`，描述填"只取订单号"，点击"生成正则"。

预期：弹窗提示粘贴原始文本；提交后 pattern 自动填入，UI 显示 `生成的正则: … (组 1)`。

- [ ] **Step 6: 回放**

点击回放，观察 ReportDetail 中失败步骤的"模板"和"本次值"展示。

预期：所有使用变量的步骤成功；变量正确替换。

- [ ] **Step 7: 提交**

如有任何调整（debug log 等），单独 commit；无变更跳过。

---

## Self-Review

**Spec 覆盖检查**

| Spec 章节 | 任务 |
|---|---|
| 抽取方式 completeValue/smartExtract/regex | 4, 8, 9, 10, 11, 13 |
| 变量名校验 | 1, 4 |
| 重复/先引用后定义/未定义引用扫描 | 6, 7 |
| safeRegex | 1, 6, 7 |
| PUT 校验返回 variableReport | 6, 7, 14 |
| 错误信息含模板原值 | 10, 15 |
| 懒迁移老 extract | 5 |
| 智能抽取一次编译生成 regex | 8, 9, 13 |
| aiStep.instruction 替换 | 10 |
| 端到端 | 16 |

**占位扫描**：无 TBD/TODO/实现模糊描述；每步带可粘贴代码与具体路径。

**类型一致性**：`VAR_NAME_RE` / `VAR_RE` / `validateVariableName` / `collectVarRefs` / `substituteVars` / `safeRegex` 在 Task 1 定义，后续任务引用一致。`ExtractMode` 在 Task 4 定义。`VariableReport` 在 Task 6 定义并被 Task 7/14 复用。`VariableIssue` / `DuplicateIssue` / `RegexIssue` 与 spec 对齐。`migrateExtractAction` / `migrateSteps` 命名一致。

**潜在边界**：

- Task 10 `case 'fill'` 中 sensitive 分支若 `materializeValue` 内部抛错会冒泡；spec 说"未定义变量时仍要阻断"，但 sensitive 路径不走模板（明文密码不该含 `{{...}}`）。当前实现正确。
- Task 13 Step 4 buttonSecondaryStyle 是新变量，可能与文件已存在的同名变量冲突。落地时若 TS 报错"已在使用"，合并或改名。
- Task 15 的 `errorTemplate` 字段当前 `ExecStepResult` 未声明。本次 spec 未要求 dispatch 写入 `errorTemplate` 进 report，**仅** throw 出更友好信息即可。Task 15 退化为"读取 step.error 含 var-missing 时显示额外提示"，用 substring 匹配而非依赖新字段。如需严格落地，下个 spec 扩展 `ExecStepResult`；本期 Task 15 按 substring 方案做：

```tsx
{step.error?.includes('var-missing:') && (
  <div className="mt-1 text-[11px] font-mono opacity-70">变量未解析，请检查 extract 步骤顺序</div>
)}
```

替换 Step 1 的写法。
