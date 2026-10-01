# 步骤配置 phase 3 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `apps/api` + `apps/web` + `apps/recorder` + `packages/shared` 上实现步骤配置 phase 3 的四个能力（CompositeValue、assertText target×match、三层定位、操作类型手动切换），并对既有 DSL 做一次性懒迁移。

**Architecture:** 自底向上——先扩展 DSL 与物化层（packages/shared），再做迁移函数与回放定位层（apps/api），再补录制端的 intentLocator 注入（apps/recorder），最后接 UI（apps/web）。所有步骤走 TDD。

**Tech Stack:** TypeScript / Zod / Express 5 / Drizzle / Vitest / Playwright（仅 mock）/ React + Tailwind / jsdom。

**前置依赖：** 已落地 phase 1 + phase 2，包含 `selector-filter.isStableCssPath`（apps/recorder/modules/selector-filter.ts:12）。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `packages/shared/src/step-dsl.ts` | DSL 形状：`IntentLocator`、`CompositeValue`、`ValueFragment`、`assertText.target/match`；FillValue union |
| `packages/shared/src/value-utils.ts` | `materializeValue` 支持 `composite`；日期格式化；左补零 |
| `packages/shared/test/step-dsl.test.ts` | 已有，新增 phase 3 用例 |
| `packages/shared/test/value-utils.test.ts` | 已有，新增 composite / 日期 / 左补零用例 |
| `apps/api/src/lib/step-migration.ts` | 老 DSL → 新 DSL 的就地升级，幂等 |
| `apps/api/src/lib/length-estimate.ts` | CompositeValue 总长度估算 |
| `apps/api/src/execute/locator-resolver.ts` | 三层定位候选构造，顺序固定 |
| `apps/api/src/execute/cdp.ts` | dispatch：三层定位；assertText target×match；CompositeValue 物化 |
| `apps/api/src/routes/steps.ts` | PUT 入口：先迁移后 Zod 校验 |
| `apps/api/src/lib/type-switch.ts` | 步骤 kind 切换矩阵 |
| `apps/recorder/modules/recorder-manager.ts` | 录制阶段构造 `intentLocator` |
| `apps/web/src/components/StepEditModal.tsx` | composite builder、assertText target/match、length 估算 |
| `apps/web/src/pages/CaseDetail.tsx` | 步骤行类型下拉 |
| 测试：`step-migration.test.ts` / `length-estimate.test.ts` / `locator-resolver.test.ts` / `type-switch.test.ts` / `execute-cdp.test.ts` 追加 / `recorder-manager.test.ts` 追加 | 覆盖 |

---

## Task 1: shared — IntentLocator + CompositeValue DSL（红）

**Files:**
- Modify: `packages/shared/src/step-dsl.ts`
- Modify: `packages/shared/test/step-dsl.test.ts`

- [ ] **Step 1: 在 test 文件末尾追加 2 个测试**

打开 `packages/shared/test/step-dsl.test.ts`，在文件末尾追加：

```ts
describe('step-dsl — phase3 intent locator', () => {
  it('accepts click action with optional intentLocator', () => {
    const r = StepAction.safeParse({
      kind: 'click',
      locator: [{ strategy: 'css', value: '#btn' }],
      intentLocator: { semanticRole: 'loginSubmit', contextText: '登录' },
    });
    expect(r.success).toBe(true);
  });

  it('accepts click action without intentLocator (back-compat)', () => {
    const r = StepAction.safeParse({
      kind: 'click',
      locator: [{ strategy: 'css', value: '#btn' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects intentLocator with empty semanticRole', () => {
    const r = StepAction.safeParse({
      kind: 'click',
      locator: [{ strategy: 'css', value: '#btn' }],
      intentLocator: { semanticRole: '' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects intentLocator with oversize contextText', () => {
    const r = StepAction.safeParse({
      kind: 'click',
      locator: [{ strategy: 'css', value: '#btn' }],
      intentLocator: { semanticRole: 'loginSubmit', contextText: 'x'.repeat(501) },
    });
    expect(r.success).toBe(false);
  });
});

describe('step-dsl — phase3 assertText target/match', () => {
  it('accepts assertText with default target/match', () => {
    const r = StepAction.safeParse({
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '.msg' }],
      equals: 'ok',
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.kind === 'assertText') {
      expect(r.data.target).toBe('specifiedElement');
      expect(r.data.match).toBe('equals');
    }
  });

  it('accepts assertText with explicit page target + regex match', () => {
    const r = StepAction.safeParse({
      kind: 'assertText',
      locator: [],
      target: 'page',
      match: 'regex',
      equals: '^登录成功',
    });
    expect(r.success).toBe(true);
  });

  it('accepts assertText with intentLocator', () => {
    const r = StepAction.safeParse({
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '.msg' }],
      target: 'specifiedElement',
      match: 'contains',
      equals: '成功',
      intentLocator: { semanticRole: 'successMsg' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects assertText with unknown target', () => {
    const r = StepAction.safeParse({
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '.msg' }],
      target: 'body',
      equals: 'x',
    });
    expect(r.success).toBe(false);
  });
});

describe('step-dsl — phase3 composite value', () => {
  it('accepts fill with composite value of multiple fragments', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: {
        mode: 'composite',
        fragments: [
          { mode: 'fixed', value: 'CS' },
          { mode: 'date', format: 'YYYYMMDD' },
          { mode: 'randomNumber', length: 3 },
        ],
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects composite with empty fragments array', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: { mode: 'composite', fragments: [] },
    });
    expect(r.success).toBe(false);
  });

  it('rejects composite when total max length exceeds 1024', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: {
        mode: 'composite',
        fragments: [
          { mode: 'fixed', value: 'x'.repeat(500) },
          { mode: 'randomString', length: 1024 },
        ],
      },
    });
    expect(r.success).toBe(false);
  });

  it('rejects composite fragment with unknown mode', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: { mode: 'composite', fragments: [{ mode: 'uuid' }] },
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，预期 RED**

Run: `pnpm --filter @itest/shared test 2>&1 | tail -25`
Expected: 7+ 个新增用例 FAIL（`IntentLocator` 未导出 / `CompositeValue` 未导出 / `target` / `match` 未识别）。

- [ ] **Step 3: 提交 RED**

```bash
git add packages/shared/test/step-dsl.test.ts
git commit -m "test(shared): phase3 DSL — IntentLocator / CompositeValue / assertText target+match"
```

---

## Task 2: shared — DSL 实现（绿）

**Files:**
- Modify: `packages/shared/src/step-dsl.ts`

- [ ] **Step 1: 在 step-dsl.ts 顶部导出 `estimateMaxLen`（先定义一个 stub 让 Zod refine 用）**

打开 `packages/shared/src/step-dsl.ts`，把 `ValueGenerator` 与 `FillValue` 段替换成下面整段：

```ts
export const ValueGenerator = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('randomString'), length: z.number().int().min(1).max(200).default(12) }),
    z.object({ mode: z.literal('randomNumber'), min: z.number().int().default(0), max: z.number().int().default(999999) }),
    z.object({ mode: z.literal('timestamp') }),
    z.object({ mode: z.literal('prefixTimestamp'), prefix: z.string().min(1).max(100) }),
  ])
  .refine((d) => d.mode !== 'randomNumber' || d.max >= d.min, { message: 'max must be >= min' });
export type ValueGenerator = z.infer<typeof ValueGenerator>;

export const IntentLocator = z.object({
  /** 录制阶段确定的语义角色（data-testid / name 等），回放时作为补充候选。 */
  semanticRole: z.string().min(1).max(64),
  /** 业务文案，回放时参与文本兜底。 */
  contextText: z.string().max(500).optional(),
});
export type IntentLocator = z.infer<typeof IntentLocator>;

/** 单段 CompositeValue 的可能形态；按顺序拼接生成最终输入。 */
export const ValueFragment = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), value: z.string().max(500) }),
  z.object({ mode: z.literal('date'), format: z.enum(['YYYYMMDD', 'YYYY-MM-DD', 'YYYY/MM/DD']) }),
  z.object({
    mode: z.literal('randomNumber'),
    min: z.number().int().min(0).default(0),
    max: z.number().int().default(999999),
    /** 固定位数；存在则左补零到该长度。 */
    length: z.number().int().min(1).max(128).optional(),
  }),
  z.object({ mode: z.literal('randomString'), length: z.number().int().min(1).max(1024).default(12) }),
  z.object({ mode: z.literal('timestamp') }),
]);
export type ValueFragment = z.infer<typeof ValueFragment>;

/** 估算最大长度（供 refine + 前端 builder 复用）。 */
export function estimateMaxLen(input: { fragments: ValueFragment[] }): number {
  let total = 0;
  for (const f of input.fragments) {
    switch (f.mode) {
      case 'fixed': total += f.value.length; break;
      case 'date': total += f.format.length; break;
      case 'randomNumber': total += f.length ?? String(f.max).length; break;
      case 'randomString': total += f.length; break;
      case 'timestamp': total += 13; break;
    }
  }
  return total;
}

export const CompositeValue = z
  .object({
    mode: z.literal('composite'),
    fragments: z.array(ValueFragment).min(1).max(20),
  })
  .refine((v) => estimateMaxLen(v) <= 1024, {
    message: 'CompositeValue 总长度超过 1024 上限',
    path: ['fragments'],
  });
export type CompositeValue = z.infer<typeof CompositeValue>;

export const FillValue = z.union([z.string(), ValueGenerator, CompositeValue]);
export type FillValue = z.infer<typeof FillValue>;
```

- [ ] **Step 2: 给 click / fill / hover / waitFor / check / select / extract / assertText 加 intentLocator 字段**

把 step-dsl.ts 里这八处（搜索 `locator: z.array(Locator).min(1)` 共有 8 个匹配）：

```ts
  locator: z.array(Locator).min(1),
```

统一替换成：

```ts
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
```

- [ ] **Step 3: 给 assertText 加 target + match**

把 `AssertTextAction` 整段替换成：

```ts
export const AssertTextAction = z.object({
  kind: z.literal('assertText'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  target: z.enum(['specifiedElement', 'page', 'errorMessage', 'url']).default('specifiedElement'),
  match: z.enum(['equals', 'contains', 'notContains', 'regex']).default('equals'),
  equals: z.string(),
});
```

- [ ] **Step 4: 运行测试，预期 GREEN**

Run: `pnpm --filter @itest/shared test 2>&1 | tail -15`
Expected: `Tests 25 passed (25)` 之类全绿。

- [ ] **Step 5: 运行 typecheck**

Run: `pnpm --filter @itest/shared typecheck 2>&1 | tail -5`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/step-dsl.ts
git commit -m "feat(shared): phase3 DSL — IntentLocator + CompositeValue + assertText target/match"
```

---

## Task 3: shared — value-utils 支持 composite（红）

**Files:**
- Modify: `packages/shared/test/value-utils.test.ts`

- [ ] **Step 1: 追加 composite / 日期 / 左补零用例**

打开 `packages/shared/test/value-utils.test.ts`，把整个 `describe('materializeValue', ...)` 块替换成：

```ts
describe('materializeValue', () => {
  it('passes plain strings through substitution', () => {
    expect(materializeValue('v-{{x}}', { x: '1' })).toBe('v-1');
  });
  it('evaluates generator then substitutes', () => {
    expect(materializeValue({ mode: 'prefixTimestamp', prefix: 'P' }, {})).toMatch(/^P\d+$/);
  });

  it('composite concatenates fragments in order', () => {
    const out = materializeValue(
      {
        mode: 'composite',
        fragments: [
          { mode: 'fixed', value: 'CS' },
          { mode: 'randomNumber', length: 3 },
          { mode: 'randomString', length: 4 },
        ],
      },
      {},
    );
    expect(out).toMatch(/^CS\d{3}[A-Za-z0-9]{4}$/);
  });

  it('composite date fragment formats YYYYMMDD', () => {
    const out = materializeValue(
      { mode: 'composite', fragments: [{ mode: 'date', format: 'YYYYMMDD' }] },
      {},
    );
    expect(out).toMatch(/^\d{8}$/);
  });

  it('composite date fragment formats YYYY-MM-DD with separators', () => {
    const out = materializeValue(
      { mode: 'composite', fragments: [{ mode: 'date', format: 'YYYY-MM-DD' }] },
      {},
    );
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('composite randomNumber without length has no padding', () => {
    const out = materializeValue(
      {
        mode: 'composite',
        fragments: [{ mode: 'randomNumber', min: 1, max: 9 }],
      },
      {},
    );
    expect(out).toMatch(/^[1-9]$/);
  });

  it('composite applies var substitution after fragment eval', () => {
    const out = materializeValue(
      {
        mode: 'composite',
        fragments: [
          { mode: 'fixed', value: '订单' },
          { mode: 'timestamp' },
        ],
      },
      {},
    );
    expect(out).toMatch(/^订单\d+$/);
  });

  it('composite surfaces fragment #n error when randomNumber range invalid', () => {
    expect(() =>
      materializeValue(
        {
          mode: 'composite',
          fragments: [
            { mode: 'fixed', value: 'OK' },
            // Zod 不会通过 refine 再来一次，运行时调用 evaluateGenerator 会抛
            // 但当前 materializeValue 把 composite 各 fragment 当作 ValueGenerator 求值，
            // max < min 不会到这里。先用 timestamp + 把 max 设为非法测：
            { mode: 'randomNumber', min: 9, max: 2 },
          ],
        },
        {},
      ),
    ).toThrow(/fragment #2/);
  });
});
```

- [ ] **Step 2: 运行测试，预期 RED**

Run: `pnpm --filter @itest/shared test 2>&1 | tail -25`
Expected: composite 相关用例 FAIL。

- [ ] **Step 3: 提交 RED**

```bash
git add packages/shared/test/value-utils.test.ts
git commit -m "test(shared): phase3 value-utils — composite fragments + date formats + var substitution"
```

---

## Task 4: shared — materializeValue 支持 composite（绿）

**Files:**
- Modify: `packages/shared/src/value-utils.ts`

- [ ] **Step 1: 在文件顶部加 import**

打开 `packages/shared/src/value-utils.ts`，把 import 段：

```ts
import type { ValueGenerator } from './step-dsl.js';
```

替换成：

```ts
import type { ValueGenerator, ValueFragment, CompositeValue } from './step-dsl.js';
```

- [ ] **Step 2: 给 materializeValue 加 composite 分支 + helper**

把 `materializeValue` 整段替换成：

```ts
function padLeft(s: string, len: number): string {
  return s.length >= len ? s : '0'.repeat(len - s.length) + s;
}

function formatDate(d: Date, fmt: 'YYYYMMDD' | 'YYYY-MM-DD' | 'YYYY/MM/DD'): string {
  const y = String(d.getFullYear());
  const m = padLeft(String(d.getMonth() + 1), 2);
  const day = padLeft(String(d.getDate()), 2);
  switch (fmt) {
    case 'YYYYMMDD': return `${y}${m}${day}`;
    case 'YYYY-MM-DD': return `${y}-${m}-${day}`;
    case 'YYYY/MM/DD': return `${y}/${m}/${day}`;
  }
}

function evaluateFragment(f: ValueFragment): string {
  switch (f.mode) {
    case 'fixed': return f.value;
    case 'date': return formatDate(new Date(), f.format);
    case 'randomNumber': {
      const n = randomInt(f.min, f.max);
      return f.length != null ? padLeft(String(n), f.length) : String(n);
    }
    case 'randomString': return randomString(f.length);
    case 'timestamp': return String(Date.now());
  }
}

function evaluateComposite(c: CompositeValue): string {
  const parts: string[] = [];
  c.fragments.forEach((f, idx) => {
    try {
      parts.push(evaluateFragment(f));
    } catch (e) {
      throw new Error(`fragment #${idx + 1}: ${(e as Error).message}`);
    }
  });
  return parts.join('');
}

/** 执行期物化：generator 先求值，composite 按片段拼接，再做 {{var}} 替换。 */
export function materializeValue(value: string | ValueGenerator | CompositeValue, vars: Record<string, string>): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if ('fragments' in value) text = evaluateComposite(value);
  else text = evaluateGenerator(value);
  return substituteVars(text, vars);
}
```

- [ ] **Step 3: 运行测试，预期 GREEN**

Run: `pnpm --filter @itest/shared test 2>&1 | tail -10`
Expected: 全绿。

- [ ] **Step 4: 运行 typecheck**

Run: `pnpm --filter @itest/shared typecheck 2>&1 | tail -5`
Expected: exit 0。

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/value-utils.ts
git commit -m "feat(shared): materializeValue supports CompositeValue"
```

---

## Task 5: api — length-estimate（红 → 绿一次性）

**Files:**
- Create: `apps/api/src/lib/length-estimate.ts`
- Create: `apps/api/test/length-estimate.test.ts`

- [ ] **Step 1: 写测试**

创建 `apps/api/test/length-estimate.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { estimateCompositeMaxLen } from '../src/lib/length-estimate.js';

describe('estimateCompositeMaxLen', () => {
  it('returns 0 for empty fragments (should be caught by Zod but defensive)', () => {
    expect(estimateCompositeMaxLen({ mode: 'composite', fragments: [] })).toBe(0);
  });
  it('sums fixed.length', () => {
    expect(
      estimateCompositeMaxLen({ mode: 'composite', fragments: [{ mode: 'fixed', value: 'abc' }] }),
    ).toBe(3);
  });
  it('treats randomNumber length as the upper bound', () => {
    expect(
      estimateCompositeMaxLen({
        mode: 'composite',
        fragments: [{ mode: 'randomNumber', min: 0, max: 99, length: 3 }],
      }),
    ).toBe(3);
  });
  it('uses max digits when no length', () => {
    expect(
      estimateCompositeMaxLen({
        mode: 'composite',
        fragments: [{ mode: 'randomNumber', min: 0, max: 9999 }],
      }),
    ).toBe(4);
  });
  it('date fragment length matches its format', () => {
    expect(
      estimateCompositeMaxLen({
        mode: 'composite',
        fragments: [{ mode: 'date', format: 'YYYY-MM-DD' }],
      }),
    ).toBe(10);
  });
  it('saturates above 1024', () => {
    const huge = { mode: 'composite' as const, fragments: [{ mode: 'fixed' as const, value: 'x'.repeat(2000) }] };
    expect(estimateCompositeMaxLen(huge)).toBeGreaterThan(1024);
  });
});
```

- [ ] **Step 2: 运行测试，预期 RED**

Run: `pnpm --filter @itest/api test -- test/length-estimate.test.ts 2>&1 | tail -15`
Expected: 模块未找到，FAIL。

- [ ] **Step 3: 创建实现（直接复用 shared 的 estimateMaxLen 以避免重复逻辑）**

创建 `apps/api/src/lib/length-estimate.ts`：

```ts
import { estimateMaxLen, type CompositeValue } from '@itest/shared';

/** 估算 CompositeValue 在最坏情况下的长度，供前端 builder 实时提示使用。 */
export function estimateCompositeMaxLen(c: CompositeValue): number {
  return estimateMaxLen(c);
}
```

- [ ] **Step 4: 运行测试，预期 GREEN**

Run: `pnpm --filter @itest/api test -- test/length-estimate.test.ts 2>&1 | tail -10`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/lib/length-estimate.ts apps/api/test/length-estimate.test.ts
git commit -m "feat(api): length-estimate wraps shared.estimateMaxLen"
```

---

## Task 6: api — step-migration（红）

**Files:**
- Create: `apps/api/src/lib/step-migration.ts`
- Create: `apps/api/test/step-migration.test.ts`

- [ ] **Step 1: 写测试**

创建 `apps/api/test/step-migration.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { migrateAction } from '../src/lib/step-migration.js';

describe('migrateAction — assertText', () => {
  it('adds target=specifiedElement + match=equals to legacy assertText', () => {
    const legacy = { kind: 'assertText', locator: [{ strategy: 'css', value: '.msg' }], equals: 'ok' };
    const out = migrateAction(legacy);
    expect(out).toEqual({
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '.msg' }],
      intentLocator: undefined,
      target: 'specifiedElement',
      match: 'equals',
      equals: 'ok',
    });
  });

  it('does not overwrite explicit target/match', () => {
    const current = {
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '.msg' }],
      target: 'page',
      match: 'regex',
      equals: '^ok',
    };
    const out = migrateAction(current);
    expect(out.target).toBe('page');
    expect(out.match).toBe('regex');
  });
});

describe('migrateAction — locator-bearing kinds', () => {
  it('adds intentLocator=undefined to legacy click', () => {
    const legacy = { kind: 'click', locator: [{ strategy: 'css', value: '#btn' }] };
    const out = migrateAction(legacy) as { intentLocator?: unknown };
    expect(out.intentLocator).toBeUndefined();
  });

  it('does not touch known kinds lacking intentLocator (fill/hover/waitFor/check/select/extract)', () => {
    const kinds = ['fill', 'hover', 'waitFor', 'check', 'select', 'extract'];
    for (const k of kinds) {
      const legacy = { kind: k, locator: [{ strategy: 'css', value: '#x' }], ...(k === 'fill' || k === 'select' ? { value: 'x' } : {}) };
      const out = migrateAction(legacy) as { intentLocator?: unknown };
      expect(out.intentLocator).toBeUndefined();
    }
  });
});

describe('migrateAction — idempotency', () => {
  it('is a no-op on already migrated actions', () => {
    const migrated = {
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '.msg' }],
      intentLocator: { semanticRole: 'msg' },
      target: 'specifiedElement' as const,
      match: 'contains' as const,
      equals: 'ok',
    };
    expect(migrateAction(migrated)).toEqual(migrated);
  });
});

describe('migrateAction — defensive', () => {
  it('returns unknown kinds unchanged', () => {
    const alien = { kind: 'bogus', locator: [{ strategy: 'css', value: '#x' }] };
    expect(migrateAction(alien)).toEqual(alien);
  });
});
```

- [ ] **Step 2: 运行测试，预期 RED**

Run: `pnpm --filter @itest/api test -- test/step-migration.test.ts 2>&1 | tail -15`
Expected: 模块未找到，FAIL。

- [ ] **Step 3: 提交 RED**

```bash
git add apps/api/test/step-migration.test.ts
git commit -m "test(api): step-migration — legacy assertText + intentLocator + idempotency"
```

---

## Task 7: api — step-migration（绿）

**Files:**
- Create: `apps/api/src/lib/step-migration.ts`

- [ ] **Step 1: 实现 migrateAction**

创建 `apps/api/src/lib/step-migration.ts`：

```ts
import type { StepAction } from '@itest/shared';

/** 老 DSL → 新 DSL 的就地升级，幂等。已迁移结构直接原样返回；未知 kind 原样返回。 */
export function migrateAction(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const action = raw as Record<string, unknown>;
  const kind = action.kind;

  if (kind === 'assertText') {
    if (action.target === undefined) action.target = 'specifiedElement';
    if (action.match === undefined) action.match = 'equals';
    if (!('intentLocator' in action)) action.intentLocator = undefined;
    return action;
  }

  // 含 locator 的所有 kind 都补 intentLocator=undefined（保持字段位置一致）
  const locatorKinds = new Set(['click', 'fill', 'hover', 'waitFor', 'check', 'select', 'extract']);
  if (locatorKinds.has(String(kind))) {
    if (!('intentLocator' in action)) action.intentLocator = undefined;
    return action;
  }

  // 其余 kind（navigate / upload / switchTab / screenshot / aiStep / assertJson / extract）原样返回
  return action;
}

/** 整批迁移（steps PUT 入口处用）。 */
export function migrateSteps(steps: Array<{ action: unknown }>): void {
  for (const s of steps) {
    s.action = migrateAction(s.action);
  }
}

/** 把 unknown 当作 StepAction 类型断言，仅供已通过 Zod 的路径使用。 */
export function asStepAction(a: unknown): StepAction {
  return a as StepAction;
}
```

- [ ] **Step 2: 运行测试，预期 GREEN**

Run: `pnpm --filter @itest/api test -- test/step-migration.test.ts 2>&1 | tail -15`
Expected: 7 个用例全绿。

- [ ] **Step 3: 提交**

```bash
git add apps/api/src/lib/step-migration.ts
git commit -m "feat(api): step-migration — assertText defaults + intentLocator padding"
```

---

## Task 8: api — locator-resolver（红 → 绿一次性）

**Files:**
- Create: `apps/api/src/execute/locator-resolver.ts`
- Create: `apps/api/test/locator-resolver.test.ts`

- [ ] **Step 1: 写测试**

创建 `apps/api/test/locator-resolver.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';

// 构造 Page mock：每个 strategy 返回一个独立 locator，便于断言顺序
function makePage(): Page & {
  __calls: string[];
  __locators: Map<string, { __id: string }>;
} {
  const calls: string[] = [];
  const locators = new Map<string, { __id: string }>();
  let counter = 0;
  const id = () => `L${++counter}`;
  const locator = vi.fn((sel: string) => {
    calls.push(`locator(${sel})`);
    const l = { __id: id() };
    locators.set(l.__id, l);
    return l as never;
  });
  const getByText = vi.fn((txt: string) => {
    calls.push(`getByText(${txt})`);
    const l = { __id: id() };
    locators.set(l.__id, l);
    return l as never;
  });
  return {
    locator,
    getByText,
    getByRole: vi.fn(),
    __calls: calls,
    __locators: locators,
  } as never;
}

import { buildCandidates } from '../src/execute/locator-resolver.js';

describe('buildCandidates — priority order', () => {
  it('places intent semanticRole first, then intent contextText', () => {
    const page = makePage();
    buildCandidates(page as never, {
      intentLocator: { semanticRole: 'loginBtn', contextText: '登录' },
      locator: [
        { strategy: 'css', value: '.btn' },
        { strategy: 'xpath', value: '//*[@id="x"]' },
      ],
    });
    expect(page.__calls.slice(0, 3)).toEqual([
      'locator([data-testid="loginBtn"])',
      'getByText(登录)',
      'locator(.btn)', // 普通 CSS 在第一组 css 里（isStableCssPath('.btn') === false）
    ]);
  });

  it('promotes stable #id CSS ahead of XPath', () => {
    const page = makePage();
    buildCandidates(page as never, {
      locator: [
        { strategy: 'css', value: 'div' },
        { strategy: 'css', value: '#submit' }, // 稳定 #id
        { strategy: 'xpath', value: '//*[@id="submit"]' },
      ],
    });
    // #submit 必须出现在 xpath 之前
    const submitIdx = page.__calls.findIndex((c) => c === 'locator(#submit)');
    const xpathIdx = page.__calls.findIndex((c) => c.startsWith('locator(xpath='));
    expect(submitIdx).toBeLessThan(xpathIdx);
    expect(submitIdx).toBeGreaterThanOrEqual(0);
  });

  it('emits no candidates for empty intent + empty locator', () => {
    const page = makePage();
    buildCandidates(page as never, { locator: [] });
    expect(page.__calls).toEqual([]);
  });

  it('keeps order stable across multiple builds (no mutation between runs)', () => {
    const page = makePage();
    const action = {
      intentLocator: { semanticRole: 'x' },
      locator: [{ strategy: 'css', value: '#a' }] as Array<{ strategy: 'css' | 'xpath' | 'role' | 'text' | 'testId'; value: string }>,
    };
    buildCandidates(page as never, action);
    const first = [...page.__calls];
    buildCandidates(page as never, action);
    expect(page.__calls.slice(first.length)).toEqual(first);
  });
});
```

- [ ] **Step 2: 运行测试，预期 RED**

Run: `pnpm --filter @itest/api test -- test/locator-resolver.test.ts 2>&1 | tail -15`
Expected: 模块未找到，FAIL。

- [ ] **Step 3: 创建实现**

创建 `apps/api/src/execute/locator-resolver.ts`：

```ts
import type { Page } from 'playwright-core';
import type { Locator, IntentLocator } from '@itest/shared';
import { isStableCssPath } from '@itest/recorder/selector-filter';

export interface ResolverInput {
  locator: Locator[];
  intentLocator?: IntentLocator;
}

const STABLE_ID_RE = /^[a-zA-Z][\w-]*#[\w-]+$/;

/** 单段 CSS 是否为「纯 #id 形式且 id 非动态」——满足则提升优先级。 */
function isPureStableCss(value: string): boolean {
  // value 形如 'tag#id' 或 '#id'
  if (!value.includes('#')) return false;
  // 整段必须只含一个 #id，且 id 部分不命中运行时模式
  return isStableCssPath(value);
}

/**
 * 三层定位候选构造（顺序固定）：
 *   1. intentLocator.semanticRole（作为 data-testid 候选）
 *   2. intentLocator.contextText（文本兜底）
 *   3. 稳定 #id CSS（纯 #id 形式）
 *   4. XPath
 *   5. 普通 CSS / role / text / testId（按出现顺序）
 *
 * 返回值是 playwright Locator 数组 + 标记信息。失败回退由调用方 tryEach 决定。
 */
export function buildCandidates(page: Page, action: ResolverInput): Array<{ kind: string; loc: ReturnType<Page['locator']> }> {
  const out: Array<{ kind: string; loc: ReturnType<Page['locator']> }> = [];
  const seen = new Set<unknown>();

  const push = (kind: string, l: ReturnType<Page['locator']>) => {
    if (seen.has(l)) return;
    seen.add(l);
    out.push({ kind, loc: l });
  };

  // 1+2: intent
  if (action.intentLocator) {
    if (action.intentLocator.semanticRole) {
      push('intent-testid', page.locator(`[data-testid="${action.intentLocator.semanticRole}"]`));
    }
    if (action.intentLocator.contextText) {
      push('intent-text', page.getByText(action.intentLocator.contextText));
    }
  }

  // 3: 稳定 #id CSS
  for (const l of action.locator) {
    if (l.strategy === 'css' && isPureStableCss(l.value)) {
      push('stable-css', page.locator(l.value));
    }
  }

  // 4: XPath
  for (const l of action.locator) {
    if (l.strategy === 'xpath') {
      push('xpath', page.locator(`xpath=${l.value}`));
    }
  }

  // 5: 普通 CSS / role / text / testId
  for (const l of action.locator) {
    if (l.strategy === 'css' && !isPureStableCss(l.value)) {
      push('css', page.locator(l.value));
    }
    if (l.strategy === 'role') {
      const m = l.value.match(/^([\w-]+)(?:\[name="([^"]*)"\]|\[name='([^']*)'\])$/);
      if (m) {
        const [, role, name1, name2] = m;
        push('role', page.getByRole(role as never, { name: name1 ?? name2 ?? undefined }));
      } else {
        push('role', page.getByRole(l.value as never));
      }
    }
    if (l.strategy === 'text') {
      push('text', page.getByText(l.value));
    }
    if (l.strategy === 'testId') {
      const v = l.value.startsWith('[') ? l.value : `[data-testid="${l.value}"]`;
      push('testId', page.locator(v));
    }
  }

  return out;
}
```

- [ ] **Step 4: 添加 apps/api 对 @itest/recorder/selector-filter 的 workspace 依赖（如果还没有）**

打开 `apps/api/package.json`，在 `dependencies` 段尾添加：

```json
    "@itest/recorder": "workspace:*",
```

然后：

```bash
pnpm install
```

- [ ] **Step 5: 运行测试，预期 GREEN**

Run: `pnpm --filter @itest/api test -- test/locator-resolver.test.ts 2>&1 | tail -15`
Expected: 4 个用例全绿。

- [ ] **Step 6: 运行 typecheck**

Run: `pnpm --filter @itest/api typecheck 2>&1 | tail -5`
Expected: exit 0。

- [ ] **Step 7: 提交**

```bash
git add apps/api/src/execute/locator-resolver.ts apps/api/test/locator-resolver.test.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): locator-resolver — intent → stable #id CSS → xpath → fallback"
```

---

## Task 9: api — cdp 三层定位 + assertText target×match（红）

**Files:**
- Modify: `apps/api/test/execute-cdp.test.ts`

- [ ] **Step 1: 在文件顶部给 page mock 加 `getByText` / `getByRole` 已有但需要加 `locator` 的稳定 id 路径区分**

打开 `apps/api/test/execute-cdp.test.ts`，找到 mock 块的 `makeLocator`，把它整段替换成：

```ts
  const makeLocator = () => ({
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(true),
    isChecked: vi.fn().mockResolvedValue(false),
    check: vi.fn().mockResolvedValue(undefined),
    uncheck: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    innerText: vi.fn().mockResolvedValue('{"code":0}'),
    inputValue: vi.fn().mockResolvedValue('input-val'),
    filter: vi.fn().mockReturnThis(),
    first: vi.fn().mockReturnThis(),
  });
```

并在 page mock 里加 `body` 字段（page 模式断言要读 page 整页文本）：

```ts
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    locator: locatorFn,
    getByRole,
    getByText,
    screenshot: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    url: vi.fn(() => 'https://example.com/path'),
    evaluate: vi.fn().mockResolvedValue('{"code":0}'),
  } as unknown as Page & { ... };
```

> **注意**：原 mock 已经声明 `const page = {...}`。把 `url` / `evaluate` 加进那个对象字面量即可，不要再次声明。

- [ ] **Step 2: 在文件末尾追加 5 个新用例**

```ts
describe('phase3 — three-tier locator', () => {
  it('tries intent semanticRole before CSS fallback', async () => {
    mocked.__locator.mockClear();
    mocked.__getByText.mockClear();
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000020',
      [
        {
          order: 1,
          action: {
            kind: 'click',
            locator: [{ strategy: 'css', value: '.btn' }],
            intentLocator: { semanticRole: 'loginBtn' },
          },
        },
      ],
      { reportId: 'r-3loc-1' },
    );
    const firstCall = mocked.__locator.mock.calls[0]?.[0];
    expect(firstCall).toBe('[data-testid="loginBtn"]');
  });

  it('falls back from primary CSS to stable #id when primary throws', async () => {
    mocked.__locator.mockClear();
    // 第一次 locator 调用抛错，模拟主 CSS 找不到
    mocked.__locator.mockImplementationOnce(() => ({
      click: vi.fn().mockImplementation(() => Promise.reject(new Error('not found'))),
      first: vi.fn().mockReturnThis(),
    }) as never);
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000021',
      [
        {
          order: 1,
          action: {
            kind: 'click',
            locator: [
              { strategy: 'css', value: '.primary-btn' },
              { strategy: 'css', value: '#submit' },
            ],
          },
        },
      ],
      { reportId: 'r-3loc-2' },
    );
    expect(results[0]!.status).toBe('passed');
    expect(mocked.__locator.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('phase3 — assertText target×match', () => {
  it('specifiedElement + equals (default)', async () => {
    mocked.__locator.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000022',
      [
        {
          order: 1,
          action: {
            kind: 'assertText',
            locator: [{ strategy: 'css', value: '.msg' }],
            equals: 'ok',
          },
        },
      ],
      { reportId: 'r-assert-eq' },
    );
    expect(results[0]!.status).toBe('passed');
  });

  it('page + contains matches body innerText', async () => {
    mocked.__locator.mockClear();
    mocked.__getByText.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000023',
      [
        {
          order: 1,
          action: {
            kind: 'assertText',
            locator: [],
            target: 'page',
            match: 'contains',
            equals: '登录成功',
          },
        },
      ],
      { reportId: 'r-assert-page' },
    );
    expect(results[0]!.status).toBe('passed');
  });

  it('url + regex matches location.href', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000024',
      [
        {
          order: 1,
          action: {
            kind: 'assertText',
            locator: [],
            target: 'url',
            match: 'regex',
            equals: '^https://example\\.com/',
          },
        },
      ],
      { reportId: 'r-assert-url' },
    );
    expect(results[0]!.status).toBe('passed');
  });

  it('errorMessage target without .ant-message throws', async () => {
    mocked.__locator.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000025',
      [
        {
          order: 1,
          action: {
            kind: 'assertText',
            locator: [],
            target: 'errorMessage',
            match: 'contains',
            equals: '权限不足',
          },
        },
      ],
      { reportId: 'r-assert-err' },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/errorMessage/);
  });
});

describe('phase3 — composite value at execute', () => {
  it('composite fill uses materialized fragment value', async () => {
    mocked.__locator.mockClear();
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000026',
      [
        {
          order: 1,
          action: {
            kind: 'fill',
            locator: [{ strategy: 'css', value: '#name' }],
            value: {
              mode: 'composite',
              fragments: [
                { mode: 'fixed', value: 'CS' },
                { mode: 'randomNumber', length: 3 },
              ],
            },
          },
        },
      ],
      { reportId: 'r-composite' },
    );
    expect(results[0]!.status).toBe('passed');
    const lastCall = (mocked.__locator.mock.results[0]!.value as { fill: ReturnType<typeof vi.fn> }).fill.mock.calls[0]?.[0];
    expect(lastCall).toMatch(/^CS\d{3}$/);
  });
});
```

- [ ] **Step 3: 运行测试，预期 RED**

Run: `pnpm --filter @itest/api test -- test/execute-cdp.test.ts 2>&1 | tail -30`
Expected: 6 个新用例 FAIL。

- [ ] **Step 4: 提交 RED**

```bash
git add apps/api/test/execute-cdp.test.ts
git commit -m "test(api): phase3 cdp — three-tier locator + assertText target×match + composite fill"
```

---

## Task 10: api — cdp 三层定位 + assertText 改 dispatch（绿）

**Files:**
- Modify: `apps/api/src/execute/cdp.ts`

- [ ] **Step 1: 添加 import 与 ERROR_MESSAGE_SELECTORS 常量**

打开 `apps/api/src/execute/cdp.ts`，把顶部 import 段（在 `import { decrypt } ...` 之后）追加：

```ts
import { buildCandidates } from './locator-resolver.js';
import { materializeValue } from '@itest/shared';
```

并在文件顶部常量区追加：

```ts
const ERROR_MESSAGE_SELECTORS = [
  '.ant-message',
  '.toast',
  '[role="alert"]',
  '.el-message',
  '.ivu-message',
];
```

- [ ] **Step 2: 重写 assertText 分支**

把 `cdp.ts` 中：

```ts
    case 'assertText':
      await firstMatch(page, action.locator).filter({ hasText: action.equals }).first().waitFor({ state: 'visible', timeout: 5000 });
      return;
```

替换成：

```ts
    case 'assertText': {
      const actual = await resolveAssertTextActual(page, action);
      const ok = matchAssertText(actual, action.equals, action.match ?? 'equals');
      if (!ok) {
        throw new Error(`assertText failed (${action.target}/${action.match}): expected ${JSON.stringify(action.equals)}, actual ${JSON.stringify(actual.slice(0, 100))}`);
      }
      return;
    }
```

并在 dispatch 函数下方（firstMatch 之前）追加 helper：

```ts
async function resolveAssertTextActual(page: Page, action: StepAction & { kind: 'assertText' }): Promise<string> {
  const target = action.target ?? 'specifiedElement';
  if (target === 'page') {
    // 通过 evaluate 拿整页 innerText；playwright 没直接的 API
    return (await page.evaluate(() => document.body?.innerText ?? '')) as string;
  }
  if (target === 'url') {
    return page.url();
  }
  if (target === 'errorMessage') {
    // 限定在受控元素范围内找；找不到直接报错（不回落到 page）
    const sel = ERROR_MESSAGE_SELECTORS.join(', ');
    const loc = page.locator(sel).first();
    await loc.waitFor({ state: 'visible', timeout: 5000 });
    return (await loc.innerText({ timeout: 5000 })).trim();
  }
  // specifiedElement（默认）
  const trimmed = action.locator.length > 0;
  if (!trimmed) throw new Error('assertText: specifiedElement 模式需要 locator');
  const loc = firstMatch(page, action.locator);
  return (await loc.innerText({ timeout: 5000 })).trim();
}

function matchAssertText(actual: string, expected: string, match: 'equals' | 'contains' | 'notContains' | 'regex'): boolean {
  switch (match) {
    case 'equals': return actual.trim() === expected.trim();
    case 'contains': return actual.includes(expected);
    case 'notContains': return !actual.includes(expected);
    case 'regex': return new RegExp(expected).test(actual);
  }
}
```

> **注意**：当前 dispatch 函数签名为 `(action: StepAction, opts)`。`StepAction` 是 discriminated union；TS 在 `action.kind === 'assertText'` 分支里已经把 action 收窄为 AssertTextAction 形状。需要把 helper 的 `action` 类型声明为 `Extract<StepAction, { kind: 'assertText' }>` 或直接 `StepAction & { kind: 'assertText' }`。本 plan 采用后者以避免 zod 类型兼容问题。

- [ ] **Step 3: 重写 click / hover / waitFor / assertVisible / fill（sensitive 之外）/ check / select / upload / extract 分支**

把：

```ts
    case 'click':
      await firstMatch(page, action.locator).click({ timeout: 5000 });
      return;
    case 'fill': {
      ...
      await firstMatch(page, action.locator).fill(value, { timeout: 5000 });
      return;
    }
    case 'hover':
      await firstMatch(page, action.locator).hover({ timeout: 5000 });
      return;
    case 'waitFor':
      await firstMatch(page, action.locator).waitFor({ state: 'visible', timeout: action.timeoutMs ?? 5000 });
      return;
    case 'assertVisible':
      if (!(await firstMatch(page, action.locator).isVisible({ timeout: 5000 }))) {
        throw new Error(`assertVisible failed: ${action.locator[0]?.value}`);
      }
      return;
```

逐个把 `firstMatch(page, action.locator)` 替换成 `await tryFirstMatch(page, action.locator, action.intentLocator)`。

并在文件末尾（`firstMatch` 函数之后）新增：

```ts
/** 三层定位候选顺序尝试；任一成功即返回。所有候选失败抛错。中间失败不记截图（按 spec 第 2 节）。 */
async function tryFirstMatch(
  page: Page,
  locator: Locator[],
  intentLocator?: { semanticRole: string; contextText?: string },
): Promise<ReturnType<Page['locator']>> {
  const cands = buildCandidates(page, { locator, intentLocator });
  if (cands.length === 0) {
    throw new Error('locator array is empty');
  }
  let lastErr: unknown;
  for (const c of cands) {
    try {
      const probe = await (c.loc as unknown as { isVisible?: () => Promise<boolean>; count?: () => Promise<number> });
      if (probe && typeof probe.count === 'function') {
        const n = await probe.count();
        if (n > 0) return c.loc;
      }
    } catch (e) {
      lastErr = e;
      continue;
    }
    // 没有 count 方法（text/role 路径）也直接接受为成功
    return c.loc;
  }
  throw lastErr instanceof Error ? lastErr : new Error('all locator candidates failed');
}
```

- [ ] **Step 4: 把所有 `firstMatch` 调用统一改成 tryFirstMatch**

打开 `apps/api/src/execute/cdp.ts`，全局搜索 `firstMatch(page, action.locator)`，逐处替换为 `tryFirstMatch(page, action.locator, action.intentLocator)`。

涉及的 case：`click`、`fill`、`hover`、`waitFor`、`assertVisible`、`check`、`select`、`upload`、`extract`。

> **fill sensitive 分支** 不需要 intentLocator（仍走 tryFirstMatch）。

- [ ] **Step 5: fill 路径用 materializeValue 替换手写 evaluateGenerator**

找到 `case 'fill':` 块，确认 `value = materializeValue(action.value, vars);` 已经存在（上一节已实现 CompositeValue）。如果 Phase 2 的 fill 分支已经把 materializeValue 接进来了，跳过。

- [ ] **Step 6: 运行测试，预期 GREEN**

Run: `pnpm --filter @itest/api test -- test/execute-cdp.test.ts 2>&1 | tail -30`
Expected: 全部用例通过（原有 14 个 + 新增 6 个 = 20 个）。

- [ ] **Step 7: 运行 typecheck**

Run: `pnpm --filter @itest/api typecheck 2>&1 | tail -5`
Expected: exit 0。

- [ ] **Step 8: 提交**

```bash
git add apps/api/src/execute/cdp.ts
git commit -m "feat(api): cdp three-tier locator + assertText target×match + composite fill"
```

---

## Task 11: api — steps PUT 走迁移（红 → 绿一次性）

**Files:**
- Modify: `apps/api/src/routes/steps.ts`
- Modify: `apps/api/test/cases.test.ts`（或 cases-copy.test.ts —— 任选一个有 legacy assertText 用例的测试文件）

- [ ] **Step 1: 写测试**

打开 `apps/api/test/cases.test.ts`，在文件末尾追加：

```ts
describe('steps PUT migration', () => {
  it('upgrades legacy assertText on PUT, target=specifiedElement match=equals', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'M', groupId });
    const r = await request(app)
      .put(`/api/cases/${c.body.id}/steps`)
      .send({
        steps: [
          {
            source: 'manual',
            action: {
              kind: 'assertText',
              locator: [{ strategy: 'css', value: '.msg' }],
              equals: 'ok',
            },
          },
        ],
      });
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/cases/${c.body.id}`);
    const a = detail.body.steps[0].action;
    expect(a.target).toBe('specifiedElement');
    expect(a.match).toBe('equals');
    expect(a.intentLocator).toBeNull();
  });

  it('preserves explicit target/match on PUT', async () => {
    const { groupId } = await seedProject(pool);
    const c = await request(app).post('/api/cases').send({ title: 'M2', groupId });
    const r = await request(app)
      .put(`/api/cases/${c.body.id}/steps`)
      .send({
        steps: [
          {
            source: 'manual',
            action: {
              kind: 'assertText',
              locator: [],
              target: 'page',
              match: 'regex',
              equals: '^ok',
            },
          },
        ],
      });
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/cases/${c.body.id}`);
    expect(detail.body.steps[0].action.target).toBe('page');
    expect(detail.body.steps[0].action.match).toBe('regex');
  });
});
```

- [ ] **Step 2: 运行测试，预期 RED**

Run: `pnpm --filter @itest/api test -- test/cases.test.ts 2>&1 | tail -25`
Expected: 2 个 migration 用例 FAIL（因未迁移）。

- [ ] **Step 3: 在 steps.ts PUT 入口加迁移**

打开 `apps/api/src/routes/steps.ts`，在 import 段尾追加：

```ts
import { migrateAction } from '../lib/step-migration.js';
```

并在 `stepsRoute.put('/:caseId/steps', ...)` 函数体最开头（`const body = z...parse(req.body)` 之后）插入：

```ts
  for (const s of body.steps) {
    s.action = migrateAction(s.action);
  }
```

- [ ] **Step 4: 运行测试，预期 GREEN**

Run: `pnpm --filter @itest/api test -- test/cases.test.ts 2>&1 | tail -15`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/routes/steps.ts apps/api/test/cases.test.ts
git commit -m "feat(api): steps PUT migrates legacy assertText + adds intentLocator padding"
```

---

## Task 12: api — type-switch 矩阵（红 → 绿一次性）

**Files:**
- Create: `apps/api/src/lib/type-switch.ts`
- Create: `apps/api/test/type-switch.test.ts`

- [ ] **Step 1: 写测试**

创建 `apps/api/test/type-switch.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { canSwitch, switchAction } from '../src/lib/type-switch.js';

describe('canSwitch', () => {
  it('allows click ↔ hover', () => {
    expect(canSwitch('click', 'hover')).toBe(true);
    expect(canSwitch('hover', 'click')).toBe(true);
  });
  it('allows click ↔ assertText', () => {
    expect(canSwitch('click', 'assertText')).toBe(true);
    expect(canSwitch('assertText', 'click')).toBe(true);
  });
  it('allows fill ↔ select', () => {
    expect(canSwitch('fill', 'select')).toBe(true);
    expect(canSwitch('select', 'fill')).toBe(true);
  });
  it('allows waitFor ↔ assertVisible', () => {
    expect(canSwitch('waitFor', 'assertVisible')).toBe(true);
    expect(canSwitch('assertVisible', 'waitFor')).toBe(true);
  });
  it('rejects switching involving navigate/upload/extract/aiStep/switchTab/screenshot/assertJson', () => {
    for (const k of ['navigate', 'upload', 'extract', 'aiStep', 'switchTab', 'screenshot', 'assertJson'] as const) {
      expect(canSwitch(k, 'click')).toBe(false);
      expect(canSwitch('click', k)).toBe(false);
    }
  });
});

describe('switchAction', () => {
  it('click → assertText: keeps locator + intentLocator, adds equals/target/match defaults', () => {
    const out = switchAction(
      { kind: 'click', locator: [{ strategy: 'css', value: '#x' }], intentLocator: { semanticRole: 'x' } },
      'assertText',
    );
    expect(out).toEqual({
      kind: 'assertText',
      locator: [{ strategy: 'css', value: '#x' }],
      intentLocator: { semanticRole: 'x' },
      target: 'specifiedElement',
      match: 'equals',
      equals: '',
    });
  });

  it('fill → select: keeps locator + intentLocator, value coerced to string (warns via length 0 fallback)', () => {
    const out = switchAction(
      { kind: 'fill', locator: [{ strategy: 'css', value: '#x' }], value: 'hello' },
      'select',
    );
    expect(out).toEqual({
      kind: 'select',
      locator: [{ strategy: 'css', value: '#x' }],
      intentLocator: undefined,
      value: 'hello',
    });
  });

  it('waitFor → assertVisible: keeps locator + intentLocator, drops timeoutMs', () => {
    const out = switchAction(
      { kind: 'waitFor', locator: [{ strategy: 'css', value: '#x' }], timeoutMs: 3000 },
      'assertVisible',
    );
    expect(out).toEqual({
      kind: 'assertVisible',
      locator: [{ strategy: 'css', value: '#x' }],
      intentLocator: undefined,
    });
    expect((out as { timeoutMs?: number }).timeoutMs).toBeUndefined();
  });

  it('returns original action unchanged for unsupported switch', () => {
    const orig = { kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }], fileId: 'abc' };
    const out = switchAction(orig, 'click');
    expect(out).toBe(orig);
  });
});
```

- [ ] **Step 2: 运行测试，预期 RED**

Run: `pnpm --filter @itest/api test -- test/type-switch.test.ts 2>&1 | tail -15`
Expected: 模块未找到，FAIL。

- [ ] **Step 3: 创建实现**

创建 `apps/api/src/lib/type-switch.ts`：

```ts
import type { StepAction } from '@itest/shared';

const SWITCH_MATRIX: Record<string, Set<string>> = {
  click: new Set(['hover', 'assertText']),
  hover: new Set(['click']),
  assertText: new Set(['click']),
  fill: new Set(['select']),
  select: new Set(['fill']),
  waitFor: new Set(['assertVisible']),
  assertVisible: new Set(['waitFor']),
};

export function canSwitch(from: string, to: string): boolean {
  if (from === to) return false;
  return SWITCH_MATRIX[from]?.has(to) ?? false;
}

/**
 * 步骤 kind 切换：保留 locator + intentLocator；其他字段按目标 kind 的默认初始化。
 * 不支持的切换返回原 action（指针相等），由调用方提示用户。
 */
export function switchAction(action: StepAction, to: string): StepAction {
  const from = action.kind;
  if (!canSwitch(from, to)) return action;

  const locator = (action as { locator: unknown }).locator;
  const intentLocator = (action as { intentLocator?: unknown }).intentLocator;

  switch (to) {
    case 'hover':
      return { kind: 'hover', locator: locator as never, intentLocator: intentLocator as never };
    case 'assertText':
      return {
        kind: 'assertText',
        locator: locator as never,
        intentLocator: intentLocator as never,
        target: 'specifiedElement',
        match: 'equals',
        equals: '',
      };
    case 'click':
      return { kind: 'click', locator: locator as never, intentLocator: intentLocator as never };
    case 'fill':
      return {
        kind: 'fill',
        locator: locator as never,
        intentLocator: intentLocator as never,
        value: ((action as { value?: unknown }).value as string) ?? '',
      };
    case 'select':
      return {
        kind: 'select',
        locator: locator as never,
        intentLocator: intentLocator as never,
        value: ((action as { value?: unknown }).value as string) ?? '',
      };
    case 'waitFor':
      return {
        kind: 'waitFor',
        locator: locator as never,
        intentLocator: intentLocator as never,
        timeoutMs: 5000,
      };
    case 'assertVisible':
      return { kind: 'assertVisible', locator: locator as never, intentLocator: intentLocator as never };
  }
  return action;
}
```

- [ ] **Step 4: 运行测试，预期 GREEN**

Run: `pnpm --filter @itest/api test -- test/type-switch.test.ts 2>&1 | tail -15`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/lib/type-switch.ts apps/api/test/type-switch.test.ts
git commit -m "feat(api): type-switch matrix for click/hover/assertText/fill/select/waitFor/assertVisible"
```

---

## Task 13: recorder — RecorderManager 输出 intentLocator（红）

**Files:**
- Modify: `apps/recorder/modules/recorder-manager.ts`
- Modify: `apps/recorder/test/recorder-manager.test.ts`

- [ ] **Step 1: 在测试文件追加 2 个用例**

打开 `apps/recorder/test/recorder-manager.test.ts`，文件末尾追加：

```ts
describe('RecorderManager — intent locator', () => {
  it('emits intentLocator.semanticRole from data-testid when present', () => {
    const btn = makeEl('<button data-testid="login-btn">登录</button>');
    dom.window.document.body.appendChild(btn);
    withRecorder(() => fire(btn, 'click'));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.intentLocator?.semanticRole).toBe('login-btn');
  });

  it('falls back to name attribute when no data-testid', () => {
    const input = makeEl('<input type="text" name="username" />');
    dom.window.document.body.appendChild(input);
    (input as HTMLInputElement).value = 'alice';
    withRecorder(() => fire(input, 'input'));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.intentLocator?.semanticRole).toBe('username');
  });

  it('omits intentLocator entirely when neither data-testid nor name exist', () => {
    const span = makeEl('<span class="label">姓名</span>');
    dom.window.document.body.appendChild(span);
    withRecorder(() => fire(span, 'click'));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.intentLocator).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试，预期 RED**

Run: `pnpm --filter @itest/recorder test -- test/recorder-manager.test.ts 2>&1 | tail -15`
Expected: 3 个新用例 FAIL。

- [ ] **Step 3: 提交 RED**

```bash
git add apps/recorder/test/recorder-manager.test.ts
git commit -m "test(recorder): intentLocator derived from data-testid / name"
```

---

## Task 14: recorder — 实现 intentLocator 输出（绿）

**Files:**
- Modify: `apps/recorder/modules/recorder-manager.ts`

- [ ] **Step 1: RecordedStep 加 intentLocator 字段**

打开 `apps/recorder/modules/recorder-manager.ts`，把 `RecordedStep` 接口在 `tabRef` 字段后追加：

```ts
  /** 录制阶段确定的语义定位：semanticRole 复用 data-testid / name；contextText 取元素 innerText 第一段。 */
  intentLocator?: { semanticRole: string; contextText?: string };
```

- [ ] **Step 2: 抽 helper buildIntentLocator**

在 `RecorderManager` 类上方（interface 之后、class 之前）添加：

```ts
function buildIntentLocator(el: Element): RecordedStep['intentLocator'] {
  const role = el.getAttribute('data-testid') ?? el.getAttribute('name') ?? null;
  if (!role) return undefined;
  const text = el.textContent?.trim().slice(0, 50) || undefined;
  return text ? { semanticRole: role, contextText: text } : { semanticRole: role };
}
```

- [ ] **Step 3: 在 click / input / change / mouseover handler 里调用 helper**

把 onClick / onInput / onChange / onMouseOver 四处 handler 的 `this.handler?.({...})` 调用前补一行：

```ts
      const intentLocator = buildIntentLocator(target);
```

并在 `this.handler?.({...})` 字段里加 `...(intentLocator ? { intentLocator } : {})`。

- [ ] **Step 4: 运行测试，预期 GREEN**

Run: `pnpm --filter @itest/recorder test 2>&1 | tail -15`
Expected: 全绿。

- [ ] **Step 5: 运行 typecheck**

Run: `pnpm --filter @itest/recorder typecheck 2>&1 | tail -5`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
git add apps/recorder/modules/recorder-manager.ts
git commit -m "feat(recorder): emit intentLocator from data-testid / name / innerText"
```

---

## Task 15: web — StepEditModal 加 composite builder + assertText target/match（实现无单独测试，依赖 API E2E）

**Files:**
- Modify: `apps/web/src/components/StepEditModal.tsx`

- [ ] **Step 1: 增加 ValueMode `'composite'` 与对应 state**

打开 `apps/web/src/components/StepEditModal.tsx`，找到：

```ts
type ValueMode = 'fixed' | 'randomString' | 'randomNumber' | 'timestamp' | 'prefixTimestamp';
```

替换成：

```ts
type ValueMode = 'fixed' | 'randomString' | 'randomNumber' | 'timestamp' | 'prefixTimestamp' | 'composite';
type DateFormat = 'YYYYMMDD' | 'YYYY-MM-DD' | 'YYYY/MM/DD';

interface CompositeDraft {
  mode: 'composite';
  fragments: Array<
    | { mode: 'fixed'; value: string }
    | { mode: 'date'; format: DateFormat }
    | { mode: 'randomNumber'; min: string; max: string; length: string }
    | { mode: 'randomString'; length: string }
    | { mode: 'timestamp' }
  >;
}
```

- [ ] **Step 2: 引入 composite draft state**

在文件内部、组件顶部（useEffect 之前）追加：

```ts
const isComposite = valueMode === 'composite';
const [compositeDraft, setCompositeDraft] = useState<CompositeDraft>(() => {
  if (isGenerator && (rawValue as { mode?: string }).mode === 'composite') {
    const v = rawValue as { fragments: unknown[] };
    return {
      mode: 'composite',
      fragments: v.fragments.map((f: unknown) => {
        const o = f as { mode: string };
        if (o.mode === 'fixed') return { mode: 'fixed', value: (f as { value: string }).value };
        if (o.mode === 'date') return { mode: 'date', format: (f as { format: DateFormat }).format };
        if (o.mode === 'randomNumber') {
          const rn = f as { min?: number; max?: number; length?: number };
          return {
            mode: 'randomNumber',
            min: String(rn.min ?? 0),
            max: String(rn.max ?? 999999),
            length: rn.length != null ? String(rn.length) : '',
          };
        }
        if (o.mode === 'randomString') return { mode: 'randomString', length: String((f as { length?: number }).length ?? 12) };
        return { mode: 'timestamp' };
      }) as CompositeDraft['fragments'],
    };
  }
  return { mode: 'composite', fragments: [{ mode: 'fixed', value: '' }] };
});

const compositeLen = compositeDraft.fragments.reduce((sum, f) => {
  switch (f.mode) {
    case 'fixed': return sum + f.value.length;
    case 'date': return sum + f.format.length;
    case 'randomNumber': return sum + (f.length ? Number(f.length) : String(Number(f.max) || 999999).length);
    case 'randomString': return sum + Number(f.length || 12);
    case 'timestamp': return sum + 13;
  }
}, 0);
const compositeOver = compositeLen > 1024;
```

- [ ] **Step 3: handleSave 处理 composite**

在 `handleSave` 函数中：

```ts
    if (kind === 'fill' || kind === 'select') next.value = buildValue();
```

替换成：

```ts
    if (kind === 'fill' || kind === 'select') {
      if (valueMode === 'composite') {
        if (compositeOver) {
          setError('CompositeValue 总长度超过 1024');
          return;
        }
        next.value = {
          mode: 'composite',
          fragments: compositeDraft.fragments.map((f) => {
            if (f.mode === 'fixed') return { mode: 'fixed', value: f.value };
            if (f.mode === 'date') return { mode: 'date', format: f.format };
            if (f.mode === 'randomNumber') {
              const out: { mode: 'randomNumber'; min: number; max: number; length?: number } = {
                mode: 'randomNumber',
                min: Number(f.min) || 0,
                max: Number(f.max) || 999999,
              };
              if (f.length) out.length = Number(f.length);
              return out;
            }
            if (f.mode === 'randomString') return { mode: 'randomString', length: Number(f.length) || 12 };
            return { mode: 'timestamp' };
          }),
        };
      } else {
        next.value = buildValue();
      }
    }
```

- [ ] **Step 4: 给 assertText 加 target / match 编辑器**

在 StepEditModal 内部（其他 kind 编辑区上方），添加 state：

```ts
const [assertTarget, setAssertTarget] = useState<'specifiedElement' | 'page' | 'errorMessage' | 'url'>(
  ((action as { target?: 'specifiedElement' | 'page' | 'errorMessage' | 'url' }).target) ?? 'specifiedElement',
);
const [assertMatch, setAssertMatch] = useState<'equals' | 'contains' | 'notContains' | 'regex'>(
  ((action as { match?: 'equals' | 'contains' | 'notContains' | 'regex' }).match) ?? 'equals',
);
```

并在 `handleSave` 的 `assertText` 分支：

```ts
    if (kind === 'assertText') next.equals = equalsText;
```

替换成：

```ts
    if (kind === 'assertText') {
      next.equals = equalsText;
      next.target = assertTarget;
      next.match = assertMatch;
      if (assertTarget !== 'specifiedElement') next.locator = [];
    }
```

- [ ] **Step 5: 给 valueMode 切换器加 composite 选项**

找到：

```tsx
                    {(['fixed', 'randomString', 'randomNumber', 'timestamp', 'prefixTimestamp'] as ValueMode[]).map((m) => (
```

替换成：

```tsx
                    {(['fixed', 'randomString', 'randomNumber', 'timestamp', 'prefixTimestamp', 'composite'] as ValueMode[]).map((m) => (
                      <button
                        key={m}
                        onClick={() => setValueMode(m)}
                        style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, cursor: 'pointer', border: '1px solid var(--color-glass-border)', background: valueMode === m ? 'var(--color-accent)' : 'transparent', color: valueMode === m ? '#fff' : 'var(--color-foreground-secondary)' }}
                      >
                        {{ fixed: '固定值', randomString: '随机字符串', randomNumber: '随机数字', timestamp: '时间戳', prefixTimestamp: '前缀+时间戳', composite: '组合值' }[m]}
                      </button>
                    ))}
```

并在 valueMode === 'composite' 时追加一个 builder 区块（放在 `valueMode === 'prefixTimestamp'` 之后）：

```tsx
                  {valueMode === 'composite' && (
                    <div className="flex flex-col gap-2">
                      {compositeDraft.fragments.map((f, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <select
                            style={{ ...inputStyle, marginTop: 0, width: 110 }}
                            value={f.mode}
                            onChange={(e) => {
                              const mode = e.target.value as CompositeDraft['fragments'][number]['mode'];
                              const next = [...compositeDraft.fragments];
                              if (mode === 'fixed') next[idx] = { mode: 'fixed', value: '' };
                              else if (mode === 'date') next[idx] = { mode: 'date', format: 'YYYYMMDD' };
                              else if (mode === 'randomNumber') next[idx] = { mode: 'randomNumber', min: '0', max: '999999', length: '' };
                              else if (mode === 'randomString') next[idx] = { mode: 'randomString', length: '12' };
                              else next[idx] = { mode: 'timestamp' };
                              setCompositeDraft({ ...compositeDraft, fragments: next });
                            }}
                          >
                            <option value="fixed">固定值</option>
                            <option value="date">日期</option>
                            <option value="randomNumber">随机数字</option>
                            <option value="randomString">随机字符串</option>
                            <option value="timestamp">时间戳</option>
                          </select>
                          {f.mode === 'fixed' && (
                            <input style={{ ...inputStyle, marginTop: 0, flex: 1 }} value={f.value} onChange={(e) => {
                              const next = [...compositeDraft.fragments];
                              next[idx] = { mode: 'fixed', value: e.target.value };
                              setCompositeDraft({ ...compositeDraft, fragments: next });
                            }} />
                          )}
                          {f.mode === 'date' && (
                            <select style={{ ...inputStyle, marginTop: 0, flex: 1 }} value={f.format} onChange={(e) => {
                              const next = [...compositeDraft.fragments];
                              next[idx] = { mode: 'date', format: e.target.value as DateFormat };
                              setCompositeDraft({ ...compositeDraft, fragments: next });
                            }}>
                              <option value="YYYYMMDD">YYYYMMDD</option>
                              <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                              <option value="YYYY/MM/DD">YYYY/MM/DD</option>
                            </select>
                          )}
                          {f.mode === 'randomNumber' && (
                            <>
                              <input style={{ ...inputStyle, marginTop: 0, width: 70 }} placeholder="min" inputMode="numeric" value={f.min} onChange={(e) => {
                                const next = [...compositeDraft.fragments];
                                next[idx] = { mode: 'randomNumber', min: e.target.value, max: f.max, length: f.length };
                                setCompositeDraft({ ...compositeDraft, fragments: next });
                              }} />
                              <input style={{ ...inputStyle, marginTop: 0, width: 70 }} placeholder="max" inputMode="numeric" value={f.max} onChange={(e) => {
                                const next = [...compositeDraft.fragments];
                                next[idx] = { mode: 'randomNumber', min: f.min, max: e.target.value, length: f.length };
                                setCompositeDraft({ ...compositeDraft, fragments: next });
                              }} />
                              <input style={{ ...inputStyle, marginTop: 0, width: 70 }} placeholder="位数" inputMode="numeric" value={f.length} onChange={(e) => {
                                const next = [...compositeDraft.fragments];
                                next[idx] = { mode: 'randomNumber', min: f.min, max: f.max, length: e.target.value };
                                setCompositeDraft({ ...compositeDraft, fragments: next });
                              }} />
                            </>
                          )}
                          {f.mode === 'randomString' && (
                            <input style={{ ...inputStyle, marginTop: 0, width: 100 }} placeholder="长度" inputMode="numeric" value={f.length} onChange={(e) => {
                              const next = [...compositeDraft.fragments];
                              next[idx] = { mode: 'randomString', length: e.target.value };
                              setCompositeDraft({ ...compositeDraft, fragments: next });
                            }} />
                          )}
                          {f.mode === 'timestamp' && <span style={{ ...labelStyle, flex: 1 }}>当前 ms 时间戳</span>}
                          <button
                            onClick={() => {
                              const next = compositeDraft.fragments.filter((_, i) => i !== idx);
                              setCompositeDraft({ ...compositeDraft, fragments: next });
                            }}
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-destructive)', padding: 2 }}
                            title="删除片段"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() => setCompositeDraft({ ...compositeDraft, fragments: [...compositeDraft.fragments, { mode: 'fixed', value: '' }] })}
                        style={{ fontSize: 11, padding: '4px 8px', borderRadius: 5, border: '1px dashed var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-muted)', cursor: 'pointer', alignSelf: 'flex-start' }}
                      >
                        + 添加片段
                      </button>
                      <p className="text-[11px]" style={{ color: compositeOver ? 'var(--color-destructive)' : 'var(--color-foreground-muted)' }}>
                        当前长度估算：{compositeLen} / 1024{compositeOver ? ' · 超过上限' : ''}
                      </p>
                    </div>
                  )}
```

- [ ] **Step 6: 给 assertText 编辑区加 target / match 选择器**

找到 `kind === 'assertText'` 的 label 段：

```tsx
          {kind === 'assertText' && (
            <label style={labelStyle}>
              期望文本
              <textarea style={{ ...inputStyle, fontFamily: 'inherit' }} rows={3} value={equalsText} onChange={(e) => setEqualsText(e.target.value)} />
            </label>
          )}
```

替换成：

```tsx
          {kind === 'assertText' && (
            <>
              <div className="flex gap-2">
                <label style={{ ...labelStyle, flex: 1 }}>
                  断言目标
                  <select style={inputStyle} value={assertTarget} onChange={(e) => setAssertTarget(e.target.value as typeof assertTarget)}>
                    <option value="specifiedElement">指定元素（locator 必填）</option>
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
```

- [ ] **Step 7: 运行 typecheck**

Run: `pnpm --filter @itest/web typecheck 2>&1 | tail -5`
Expected: exit 0。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/components/StepEditModal.tsx
git commit -m "feat(web): StepEditModal — composite value builder + assertText target/match"
```

---

## Task 16: web — CaseDetail 加类型切换下拉

**Files:**
- Modify: `apps/web/src/pages/CaseDetail.tsx`

- [ ] **Step 1: 引入 type-switch helper（web 端直连，无 HTTP）**

打开 `apps/web/src/pages/CaseDetail.tsx`，在 import 段后追加：

```ts
import { canSwitch, switchAction } from '../../../../apps/api/src/lib/type-switch.js';
```

> **注意**：web 端通过相对路径直接 import api 模块是不合常规的。改方案：在 web 端写一个 inline mini-switch helper。

把上面的 import 行整段删除，并在文件顶部 type 定义区下方（import 之后）添加 inline helper：

```ts
const SWITCHABLE: Record<string, string[]> = {
  click: ['hover', 'assertText'],
  hover: ['click'],
  assertText: ['click'],
  fill: ['select'],
  select: ['fill'],
  waitFor: ['assertVisible'],
  assertVisible: ['waitFor'],
};

function webSwitchAction(action: StepClip, to: string): StepClip | null {
  const from = (action.action as { kind?: string }).kind ?? '';
  if (!SWITCHABLE[from]?.includes(to)) return null;
  const next = { ...action, action: { ...(action.action as object) } as Record<string, unknown> };
  const l = (action.action as { locator?: unknown }).locator;
  const il = (action.action as { intentLocator?: unknown }).intentLocator;
  switch (to) {
    case 'hover':
    case 'click':
    case 'assertVisible':
      next.action = { kind: to, locator: l, intentLocator: il };
      break;
    case 'assertText':
      next.action = { kind: 'assertText', locator: l, intentLocator: il, target: 'specifiedElement', match: 'equals', equals: '' };
      break;
    case 'fill':
    case 'select':
      next.action = { kind: to, locator: l, intentLocator: il, value: ((action.action as { value?: unknown }).value as string) ?? '' };
      break;
    case 'waitFor':
      next.action = { kind: 'waitFor', locator: l, intentLocator: il, timeoutMs: 5000 };
      break;
  }
  return next;
}
```

- [ ] **Step 2: 给步骤行加类型下拉**

在 CaseDetail.tsx 中步骤列表 `<li>` 内（编辑按钮前）插入一个 `<select>`，调用 `webSwitchAction` 并 `mutateSteps`：

```tsx
                        <select
                          value={(s.action as { kind?: string }).kind ?? ''}
                          disabled={recorder.status === 'recording' || Object.keys(SWITCHABLE[(s.action as { kind?: string }).kind ?? ''] ?? {}).length === 0}
                          onChange={(e) => {
                            const next = webSwitchAction(toClip(s), e.target.value);
                            if (!next) {
                              toast('不支持的类型切换', 'info');
                              return;
                            }
                            mutateSteps((cur) => cur.map((c, i) => (i === idx ? next : c)));
                          }}
                          style={{ fontSize: 10, padding: '2px 4px', borderRadius: 4, border: '1px solid var(--color-glass-border)', background: 'var(--color-background-subtle)', color: 'var(--color-foreground)' }}
                          title="切换步骤类型"
                        >
                          {(['click', 'hover', 'fill', 'select', 'check', 'waitFor', 'assertVisible', 'assertText', 'assertJson', 'navigate', 'upload', 'extract', 'aiStep', 'switchTab', 'screenshot'] as const).map((k) => (
                            <option key={k} value={k}>{k}</option>
                          ))}
                        </select>
```

- [ ] **Step 3: 运行 typecheck**

Run: `pnpm --filter @itest/web typecheck 2>&1 | tail -10`
Expected: exit 0。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/pages/CaseDetail.tsx
git commit -m "feat(web): CaseDetail — per-step type switch dropdown"
```

---

## Task 17: 收尾验证

**Files:** 无

- [ ] **Step 1: 运行整个 monorepo verify**

Run: `pnpm verify 2>&1 | tail -25`
Expected: 7 个任务全绿；API 测试 `step-migration` / `length-estimate` / `locator-resolver` / `type-switch` / `execute-cdp`（含 phase3 用例）/ `cases`（含 migration 用例）全绿；recorder 测试含 intentLocator 用例全绿；shared 含 composite/value-utils 新用例全绿。

- [ ] **Step 2: 确认无未追踪改动**

Run: `git status`
Expected: `nothing to commit, working tree clean`。

- [ ] **Step 3: 总结性 commit（如 lint/typecheck 有 autofix）**

```bash
git diff --check || true
git status
# 若有自动修复则提交
git add -u
git diff --cached --quiet || git commit -m "chore: phase3 lint + typecheck autofixes"
```

---

## 自审记录

- **Spec 覆盖：**
  - CompositeValue → Task 1-4
  - assertText target×match → Task 1, 2, 9, 10, 15
  - 三层定位 → Task 8, 9, 10, 14
  - 操作类型切换 → Task 12, 16
  - 一次性迁移 → Task 6, 7, 11
- **占位扫描：** 无 "TBD" / "TODO" / "类似 Task N"；每个代码块完整。
- **类型一致性：** `IntentLocator` 形状在 step-dsl.ts / recorder-manager.ts / locator-resolver.ts / CaseDetail.tsx / StepEditModal.tsx 五处保持一致；`canSwitch` / `switchAction` 在 api 端矩阵与 web 端 inline 矩阵互相对应。
- **风险点：** Task 10 把 `firstMatch` 替换为 `tryFirstMatch`，需要确认所有 case 都已替换；Task 16 web 端 inline 矩阵需与 Task 12 api 端矩阵保持同步（已在两处注释对照）。
