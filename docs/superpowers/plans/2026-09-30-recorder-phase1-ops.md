# 录制增强一期：操作类型全覆盖 + 步骤维护 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 录制操作类型补齐（checkbox/select/upload/断言/AI 步骤/变量）+ 步骤维护（编辑/随机值/复制粘贴/撤销），打通 DSL → 采集 → 编译 → 回放的完整链路。

**Architecture:** 三层各自扩展、契约只有 `packages/shared` 的 DSL：shared 定义新 action 与值物化工具；api 负责 AI 步骤编译（保存时）、执行器新分支与 replace-all 步骤接口；recorder 扩展负责 change 事件采集、元素拾取与面板 UI（原生 popup + 独立 panel 窗口）；web 负责步骤维护交互。扩展内 DSL 转换位置：事件步骤由 background.js 的 `toDSL` 转换，面板步骤由 panel 直接产出 DSL。

**Tech Stack:** Turborepo + pnpm workspaces；shared/api/recorder 用 vitest；api 用 Express 5 + Drizzle + zod + playwright-core；recorder 为 MV3 扩展（vanilla JS popup）；web 为 React 18 + zustand + react-query。

**Spec:** `docs/superpowers/specs/2026-09-30-recorder-phase1-ops-design.md`

---

## 文件结构

**shared（契约层）**
- Modify: `packages/shared/src/step-dsl.ts` — 新增 6 种 action + ValueGenerator/FillValue + StepAction 递归 schema
- Create: `packages/shared/src/value-utils.ts` — generator 求值、`{{var}}` 替换、deepEqual
- Modify: `packages/shared/src/index.ts` — 导出新模块

**api（编译 + 执行 + 接口）**
- Modify: `apps/api/src/db/schema.ts` — test_steps 加 `name` / `delayMs`
- Create: `apps/api/drizzle/0001_*.sql` — `pnpm db:generate` 生成（迁移）
- Create: `apps/api/src/agent/aiStepCompile.ts` — AI 步骤编译（单次编译 + 批量就地编译）
- Modify: `apps/api/src/agent/llm-client.ts` — MockClient 加 ai-step 分支
- Modify: `apps/api/src/routes/steps.ts` — replace-all（PUT）、recompile（POST）、append 接编译
- Modify: `apps/api/src/routes/recorder.ts` — finish 落库前编译 aiStep
- Modify: `apps/api/src/execute/cdp.ts` — 新 dispatch 分支 + vars + warning + delayMs
- Modify: `apps/api/src/routes/execute.ts` — 传 delayMs
- Modify: `apps/api/test/*.test.ts` — 更新 test_steps 建表 SQL；新增用例

**recorder（采集 + 面板）**
- Modify: `apps/recorder/modules/recorder-manager.ts` — change 事件、pause、类型扩展
- Create: `apps/recorder/modules/picker.ts` — 元素拾取模式
- Modify: `apps/recorder/background.js` — 面板消息路由、`toDSL` 扩展、**修复录制启动链路**（注入后显式 start）
- Modify: `apps/recorder/content/recorder.js` — runtime 消息接线（start/pause/pick/emit-step）
- Modify: `apps/recorder/popup/popup.html` / `popup.js` / `popup.css` — 状态 + 暂停 + 打开 panel
- Create: `apps/recorder/popup/panel.html` / `panel.js` / `panel.css` — 独立操作窗口（变量/断言/悬浮/AI）

**web（步骤维护）**
- Modify: `apps/web/src/api/client.ts` — replaceSteps / recompileStep；TestStep 加 name/delayMs
- Create: `apps/web/src/stores/stepClipboard.ts` — 跨用例步骤剪贴板
- Create: `apps/web/src/components/StepEditModal.tsx` — 步骤编辑弹窗
- Modify: `apps/web/src/pages/CaseDetail.tsx` — 复制粘贴/撤销/编辑入口/AI 编译失败标记
- Modify: `apps/web/src/pages/ReportDetail.tsx` — warning 展示

---

## Task 1: shared — DSL 扩展

**Files:**
- Modify: `packages/shared/src/step-dsl.ts`
- Test: `packages/shared/test/step-dsl.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `packages/shared/test/step-dsl.test.ts`）

```ts
describe('step-dsl — phase1 new kinds', () => {
  it('accepts check action', () => {
    const r = StepAction.safeParse({
      kind: 'check',
      locator: [{ strategy: 'role', value: 'checkbox[name="同意"]' }],
      checked: true,
    });
    expect(r.success).toBe(true);
  });

  it('accepts select action', () => {
    const r = StepAction.safeParse({
      kind: 'select',
      locator: [{ strategy: 'css', value: 'select' }],
      value: 'cn',
    });
    expect(r.success).toBe(true);
  });

  it('accepts upload action without fileName', () => {
    const r = StepAction.safeParse({
      kind: 'upload',
      locator: [{ strategy: 'css', value: 'input[type=file]' }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts assertJson action', () => {
    const r = StepAction.safeParse({
      kind: 'assertJson',
      locator: [{ strategy: 'css', value: 'pre' }],
      equals: { code: 0 },
    });
    expect(r.success).toBe(true);
  });

  it('accepts extract action', () => {
    const r = StepAction.safeParse({
      kind: 'extract',
      locator: [{ strategy: 'css', value: '.order-no' }],
      varName: 'orderNo',
    });
    expect(r.success).toBe(true);
  });

  it('accepts aiStep with compiled steps', () => {
    const r = StepAction.safeParse({
      kind: 'aiStep',
      instruction: '关闭弹窗',
      compiled: [{ kind: 'assertVisible', locator: [{ strategy: 'role', value: 'main' }] }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts aiStep with compiled = null', () => {
    const r = StepAction.safeParse({ kind: 'aiStep', instruction: 'x', compiled: null });
    expect(r.success).toBe(true);
  });

  it('rejects extract without varName', () => {
    const r = StepAction.safeParse({
      kind: 'extract',
      locator: [{ strategy: 'css', value: '.x' }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts fill with generator value', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: { mode: 'prefixTimestamp', prefix: '测试-' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects fill with unknown generator mode', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'css', value: '#name' }],
      value: { mode: 'uuid' },
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/shared test`
Expected: 新用例全部 FAIL（新 kind 不被识别）

- [ ] **Step 3: 实现**（修改 `packages/shared/src/step-dsl.ts`）

在 `FillAction` 之前加：

```ts
export const ValueGenerator = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('randomString'), length: z.number().int().min(1).max(200).default(12) }),
  z.object({ mode: z.literal('randomNumber'), min: z.number().int().default(0), max: z.number().int().default(999999) }),
  z.object({ mode: z.literal('timestamp') }),
  z.object({ mode: z.literal('prefixTimestamp'), prefix: z.string().min(1).max(100) }),
]);
export type ValueGenerator = z.infer<typeof ValueGenerator>;

export const FillValue = z.union([z.string(), ValueGenerator]);
export type FillValue = z.infer<typeof FillValue>;
```

`FillAction` 的 `value: z.string()` 改为 `value: FillValue`。

在 `ScreenshotAction` 之后、`StepAction` 定义处，替换整个 `StepAction` 区块为：

```ts
export const CheckAction = z.object({
  kind: z.literal('check'),
  locator: z.array(Locator).min(1),
  checked: z.boolean(),
});
export const SelectAction = z.object({
  kind: z.literal('select'),
  locator: z.array(Locator).min(1),
  value: z.string().min(1),
});
export const UploadAction = z.object({
  kind: z.literal('upload'),
  locator: z.array(Locator).min(1),
  fileName: z.string().optional(),
});
export const AssertJsonAction = z.object({
  kind: z.literal('assertJson'),
  locator: z.array(Locator).min(1),
  equals: z.unknown(),
});
export const ExtractAction = z.object({
  kind: z.literal('extract'),
  locator: z.array(Locator).min(1),
  varName: z.string().min(1).max(100),
});

export type StepAction =
  | z.infer<typeof NavigateAction>
  | z.infer<typeof ClickAction>
  | z.infer<typeof FillAction>
  | z.infer<typeof HoverAction>
  | z.infer<typeof WaitForAction>
  | z.infer<typeof AssertTextAction>
  | z.infer<typeof AssertVisibleAction>
  | z.infer<typeof ScreenshotAction>
  | z.infer<typeof CheckAction>
  | z.infer<typeof SelectAction>
  | z.infer<typeof UploadAction>
  | z.infer<typeof AssertJsonAction>
  | z.infer<typeof ExtractAction>
  | { kind: 'aiStep'; instruction: string; compiled: StepAction[] | null };

export const StepAction: z.ZodType<StepAction> = z.discriminatedUnion('kind', [
  NavigateAction,
  ClickAction,
  FillAction,
  HoverAction,
  WaitForAction,
  AssertTextAction,
  AssertVisibleAction,
  ScreenshotAction,
  CheckAction,
  SelectAction,
  UploadAction,
  AssertJsonAction,
  ExtractAction,
  z.object({
    kind: z.literal('aiStep'),
    instruction: z.string().min(1),
    compiled: z.array(z.lazy(() => StepAction)).nullable(),
  }),
]) as z.ZodType<StepAction>;
```

注意：旧的 `export const StepAction = z.discriminatedUnion(...)` 和 `export type StepAction = z.infer<...>` 两行都要删掉，由上面区块替代。

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm --filter @itest/shared test && pnpm --filter @itest/shared typecheck`
Expected: PASS（注意：api 引用 FillAction.value 为 string 的地方此刻会 typecheck 报错，属预期，Task 6 修）

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/step-dsl.ts packages/shared/test/step-dsl.test.ts
git commit -m "feat(shared): phase1 DSL — check/select/upload/assertJson/extract/aiStep + value generators"
```

---

## Task 2: shared — 值物化工具

**Files:**
- Create: `packages/shared/src/value-utils.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/value-utils.test.ts`

- [ ] **Step 1: 写失败测试**（新建 `packages/shared/test/value-utils.test.ts`）

```ts
import { describe, it, expect } from 'vitest';
import { evaluateGenerator, substituteVars, materializeValue, deepEqual } from '../src/value-utils.js';

describe('evaluateGenerator', () => {
  it('randomString returns requested length', () => {
    expect(evaluateGenerator({ mode: 'randomString', length: 8 })).toHaveLength(8);
  });
  it('randomNumber is within [min, max]', () => {
    const n = Number(evaluateGenerator({ mode: 'randomNumber', min: 10, max: 20 }));
    expect(n).toBeGreaterThanOrEqual(10);
    expect(n).toBeLessThanOrEqual(20);
  });
  it('timestamp returns current ms as string', () => {
    const before = Date.now();
    const n = Number(evaluateGenerator({ mode: 'timestamp' }));
    expect(n).toBeGreaterThanOrEqual(before);
  });
  it('prefixTimestamp prepends prefix', () => {
    expect(evaluateGenerator({ mode: 'prefixTimestamp', prefix: 'T-' })).toMatch(/^T-\d+$/);
  });
});

describe('substituteVars', () => {
  it('replaces defined vars', () => {
    expect(substituteVars('订单{{orderNo}}', { orderNo: 'A123' })).toBe('订单A123');
  });
  it('throws listing missing vars', () => {
    expect(() => substituteVars('{{a}}-{{b}}-{{a}}', {})).toThrow(/a, b/);
  });
  it('leaves text without templates untouched', () => {
    expect(substituteVars('plain', {})).toBe('plain');
  });
});

describe('materializeValue', () => {
  it('passes plain strings through substitution', () => {
    expect(materializeValue('v-{{x}}', { x: '1' })).toBe('v-1');
  });
  it('evaluates generator then substitutes', () => {
    expect(materializeValue({ mode: 'prefixTimestamp', prefix: 'P' }, {})).toMatch(/^P\d+$/);
  });
});

describe('deepEqual', () => {
  it('compares objects regardless of key order', () => {
    expect(deepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
  });
  it('rejects mismatched values', () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1], [1, 2])).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/shared test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**（新建 `packages/shared/src/value-utils.ts`）

```ts
import type { ValueGenerator } from './step-dsl.js';

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

const VAR_RE = /\{\{(\w+)\}\}/g;

/** 替换 {{var}} 模板；未定义变量抛错并列出缺失变量名。 */
export function substituteVars(text: string, vars: Record<string, string>): string {
  const missing: string[] = [];
  const out = text.replace(VAR_RE, (m, name: string) => {
    if (!(name in vars)) {
      missing.push(name);
      return m;
    }
    return vars[name]!;
  });
  if (missing.length > 0) {
    throw new Error(`未定义的变量: ${[...new Set(missing)].join(', ')}`);
  }
  return out;
}

/** 执行期物化：generator 先求值，再做 {{var}} 替换。 */
export function materializeValue(value: string | ValueGenerator, vars: Record<string, string>): string {
  const text = typeof value === 'string' ? value : evaluateGenerator(value);
  return substituteVars(text, vars);
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

`packages/shared/src/index.ts` 末尾追加：

```ts
export * from './value-utils.js';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/shared test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/value-utils.ts packages/shared/src/index.ts packages/shared/test/value-utils.test.ts
git commit -m "feat(shared): value materialization — generators, {{var}} substitution, deepEqual"
```

---

## Task 3: api — test_steps 加 name / delay_ms 列

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0001_*.sql`（db:generate 产出）

- [ ] **Step 1: 改 schema**（`apps/api/src/db/schema.ts`，`testSteps` 表内 `order` 行之后加两行）

```ts
  name: varchar('name', { length: 200 }),
  delayMs: integer('delay_ms'),
```

文件顶部 drizzle-orm/pg-core 的 import 里补 `integer`。

- [ ] **Step 2: 生成迁移**

Run: `pnpm --filter @itest/api db:generate`
Expected: `apps/api/drizzle/` 下新增 `0001_*.sql`，内容为 `ALTER TABLE "test_steps" ADD COLUMN "name" varchar(200);` 与 `ADD COLUMN "delay_ms" integer;`。把生成文件名记下来。

- [ ] **Step 3: 验证**

Run: `pnpm --filter @itest/api typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/
git commit -m "feat(api): test_steps add name and delay_ms columns"
```

---

## Task 4: api — AI 步骤编译模块

**Files:**
- Create: `apps/api/src/agent/aiStepCompile.ts`
- Modify: `apps/api/src/agent/llm-client.ts`（MockClient 加分支）
- Test: `apps/api/test/aiStepCompile.test.ts`

- [ ] **Step 1: 写失败测试**（新建 `apps/api/test/aiStepCompile.test.ts`）

```ts
import { describe, it, expect } from 'vitest';
import { compileAiStep, compileAiStepsInPlace } from '../src/agent/aiStepCompile.js';
import type { LLMClient } from '../src/agent/llm-client.js';

const fakeClient = (outputs: { steps?: unknown }[]): LLMClient => ({
  provider: 'mock',
  complete: async () => {
    const v = outputs.shift();
    return v ? { kind: 'json', value: v as Record<string, unknown> } : { kind: 'text', value: '' };
  },
});

describe('compileAiStep', () => {
  it('returns parsed steps on valid LLM output', async () => {
    const client = fakeClient([
      { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] },
    ]);
    const out = await compileAiStep('等待主区域出现', {}, client);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('waitFor');
  });

  it('retries once with hint when first output is invalid, then succeeds', async () => {
    const client = fakeClient([
      { steps: [{ kind: 'fly-to-moon' }] },
      { steps: [{ kind: 'assertVisible', locator: [{ strategy: 'role', value: 'main' }] }] },
    ]);
    const out = await compileAiStep('x', {}, client);
    expect(out[0]!.kind).toBe('assertVisible');
  });

  it('drops invalid items but keeps valid ones', async () => {
    const client = fakeClient([
      { steps: [{ kind: 'bogus' }, { kind: 'click', locator: [{ strategy: 'text', value: 'OK' }] }] },
    ]);
    const out = await compileAiStep('x', {}, client);
    expect(out.map((s) => s.kind)).toEqual(['click']);
  });

  it('throws after two invalid attempts', async () => {
    const client = fakeClient([{ steps: 'nope' }, { steps: 'nope' }]);
    await expect(compileAiStep('x', {}, client)).rejects.toThrow(/编译失败/);
  });
});

describe('compileAiStepsInPlace', () => {
  it('compiles aiStep actions in place and reports failed indices', async () => {
    let calls = 0;
    const client: LLMClient = {
      provider: 'mock',
      complete: async () => {
        calls++;
        if (calls === 1) return { kind: 'json', value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] } };
        return { kind: 'text', value: 'garbage' };
      },
    };
    const steps = [
      { action: { kind: 'aiStep', instruction: 'ok', compiled: null } },
      { action: { kind: 'aiStep', instruction: 'bad', compiled: null } },
      { action: { kind: 'click', locator: [{ strategy: 'text', value: 'OK' }] } },
    ];
    const failed = await compileAiStepsInPlace(steps, client);
    expect(failed).toEqual([1]);
    expect((steps[0]!.action as { compiled: unknown[] }).compiled).toHaveLength(1);
    expect((steps[1]!.action as { compiled: unknown }).compiled).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/api test -- aiStepCompile`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**（新建 `apps/api/src/agent/aiStepCompile.ts`）

```ts
import { StepAction, type StepAction as StepActionType } from '@itest/shared';
import { resolveLlmClient } from './llmSettings.js';
import type { LLMClient } from './llm-client.js';

const SYSTEM_PROMPT = `你是测试自动化步骤编译器。把用户的自然语言操作指令编译为具体的 JSON 步骤数组。
只输出 JSON：{"steps": [...]}，不要输出其他内容。
每个步骤形如 {"kind": "...", ...}，允许的 kind：
navigate {url} | click {locator} | fill {locator, value} | hover {locator} |
waitFor {locator, timeoutMs?} | assertText {locator, equals} | assertVisible {locator} |
check {locator, checked} | select {locator, value} | extract {locator, varName}。
locator 是 [{"strategy": "role|text|testId|css|xpath", "value": "..."}] 数组，优先使用 role 和 text。
不要输出 aiStep kind。`;

/**
 * 把一条自然语言指令编译为具体 DSL 步骤。
 * LLM 输出经 zod 校验，全部不合法时带提示重试一次；仍失败则抛错（调用方决定容错策略）。
 */
export async function compileAiStep(
  instruction: string,
  ctx: { url?: string } = {},
  client?: LLMClient,
): Promise<StepActionType[]> {
  const llm = client ?? (await resolveLlmClient()).client;
  const attempt = async (hint: string): Promise<StepActionType[]> => {
    const userMessage = [
      'ai-step',
      ctx.url ? `页面 URL: ${ctx.url}` : '',
      `指令: ${instruction}`,
      hint,
    ].filter(Boolean).join('\n');
    const r = await llm.complete({ systemPrompt: SYSTEM_PROMPT, userMessage });
    const raw = r.kind === 'json' ? (r.value as { steps?: unknown }).steps : undefined;
    if (!Array.isArray(raw)) return [];
    const out: StepActionType[] = [];
    for (const item of raw) {
      const p = StepAction.safeParse(item);
      if (p.success && p.data.kind !== 'aiStep') out.push(p.data);
    }
    return out;
  };
  const first = await attempt('');
  if (first.length > 0) return first;
  const second = await attempt('上一次输出不合法：请只输出纯 JSON {"steps":[...]}，kind 必须从允许列表中取。');
  if (second.length > 0) return second;
  throw new Error(`AI 步骤编译失败: ${instruction.slice(0, 50)}`);
}

/** 就地编译步骤数组里的 aiStep；返回编译失败的 index 列表。不抛错、不阻塞保存。 */
export async function compileAiStepsInPlace(
  steps: Array<{ action: unknown; url?: string }>,
  client?: LLMClient,
): Promise<number[]> {
  const failed: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i]!.action as { kind?: string; instruction?: string; compiled?: unknown };
    if (a?.kind !== 'aiStep') continue;
    try {
      a.compiled = await compileAiStep(a.instruction ?? '', { url: steps[i]!.url }, client);
    } catch {
      a.compiled = null;
      failed.push(i);
    }
  }
  return failed;
}
```

`apps/api/src/agent/llm-client.ts` 的 `MockClient.complete` 里，在 `requirement` 判断**之前**加：

```ts
    if (userMessage.includes('ai-step')) {
      return {
        kind: 'json',
        value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] },
      };
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/api test -- aiStepCompile && pnpm --filter @itest/api typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/aiStepCompile.ts apps/api/src/agent/llm-client.ts apps/api/test/aiStepCompile.test.ts
git commit -m "feat(api): compile aiStep natural-language instructions to DSL at save time"
```

---

## Task 5: api — 步骤接口（replace-all / recompile / append 接编译）

**Files:**
- Modify: `apps/api/src/routes/steps.ts`
- Modify: `apps/api/src/routes/recorder.ts`
- Modify: `apps/api/test/cases.test.ts`（建表 SQL + 新用例；其余用到 test_steps 的测试文件同步加列）

- [ ] **Step 1: 更新测试建表 SQL**——所有 `apps/api/test/*.test.ts` 里 `CREATE TABLE test_steps` 语句，在 `action jsonb NOT NULL` 后追加：

```sql
name varchar(200), delay_ms integer
```

（用 `grep -rn "CREATE TABLE test_steps" apps/api/test` 找全；至少 `cases.test.ts`、`workflow.test.ts`、`agentRuns.test.ts`、`execute-cdp.test.ts` 若建表则需同步。）

- [ ] **Step 2: 写失败测试**（追加到 `apps/api/test/cases.test.ts` 的 describe 内）

```ts
  it('PUT /api/cases/:id/steps replaces all steps with name/delayMs', async () => {
    const c = await request(app).post('/api/cases').send({ title: 'R' });
    await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [{ order: 1, source: 'agent', action: { kind: 'navigate', url: 'https://a.com' } }],
    });
    const r = await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        { action: { kind: 'click', locator: [{ strategy: 'text', value: 'Go' }] }, source: 'recorder', name: '点 Go', delayMs: 500 },
        { action: { kind: 'fill', locator: [{ strategy: 'css', value: '#x' }], value: 'v' }, source: 'manual' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.steps).toHaveLength(2);
    expect(r.body.steps[0].order).toBe(1);
    expect(r.body.steps[0].name).toBe('点 Go');
    expect(r.body.steps[0].delayMs).toBe(500);
    expect(r.body.steps[1].name).toBeNull();
    const g = await request(app).get(`/api/cases/${c.body.id}`);
    expect(g.body.steps).toHaveLength(2);
  });

  it('PUT /api/cases/:id/steps compiles aiStep actions via mock LLM', async () => {
    const c = await request(app).post('/api/cases').send({ title: 'AI' });
    const r = await request(app).put(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        { action: { kind: 'aiStep', instruction: '等待主区域', compiled: null }, source: 'manual' },
      ],
    });
    expect(r.status).toBe(200);
    const compiled = r.body.steps[0].action.compiled;
    expect(Array.isArray(compiled)).toBe(true);
    expect(compiled[0].kind).toBe('waitFor');
  });

  it('PUT /api/cases/:id/steps allows empty array (clear all)', async () => {
    const c = await request(app).post('/api/cases').send({ title: 'E' });
    const r = await request(app).put(`/api/cases/${c.body.id}/steps`).send({ steps: [] });
    expect(r.status).toBe(200);
    expect(r.body.steps).toHaveLength(0);
  });

  it('POST /api/cases/:id/steps/recompile returns compiled or null', async () => {
    const c = await request(app).post('/api/cases').send({ title: 'RC' });
    const ok = await request(app).post(`/api/cases/${c.body.id}/steps/recompile`).send({ instruction: '关闭弹窗' });
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.compiled)).toBe(true);
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @itest/api test -- cases`
Expected: 新用例 FAIL（404/无路由）

- [ ] **Step 4: 实现 routes/steps.ts**

顶部 import 区加：

```ts
import { compileAiStep, compileAiStepsInPlace } from '../agent/aiStepCompile.js';
```

`stepsRoute.post('/:caseId/steps', ...)` 的 insert 之前，在 `const rows = await db` 前插入编译调用，并把响应改为带 `failedAi`：

```ts
  const failedAi = await compileAiStepsInPlace(body.steps.map((s) => ({ action: s.action })));
```

响应改为：

```ts
  res.json({ count: rows.length, steps: sorted, failedAi });
```

在文件末尾追加两个路由：

```ts
/** 全量替换步骤（步骤维护/粘贴/撤销的统一写入口）。aiStep 保存前自动编译。 */
stepsRoute.put('/:caseId/steps', async (req, res) => {
  const body = z
    .object({
      steps: z.array(
        z.object({
          action: StepAction,
          source: z.enum(['agent', 'recorder', 'manual']).default('manual'),
          name: z.string().max(200).optional(),
          delayMs: z.number().int().nonnegative().max(60000).optional(),
        }),
      ),
    })
    .parse(req.body);
  const exists = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  await compileAiStepsInPlace(body.steps.map((s) => ({ action: s.action })));
  await db.delete(testSteps).where(eq(testSteps.caseId, req.params.caseId));
  const rows = await db
    .insert(testSteps)
    .values(
      body.steps.map((s, i) => ({
        caseId: req.params.caseId,
        order: i + 1,
        source: s.source,
        action: s.action as object,
        name: s.name ?? null,
        delayMs: s.delayMs ?? null,
      })),
    )
    .returning();
  res.json({ steps: rows.sort((a, b) => a.order - b.order) });
});

/** 单独编译一条 AI 指令（步骤编辑页「重新编译」）。失败返回 compiled: null，不抛错。 */
stepsRoute.post('/:caseId/steps/recompile', async (req, res) => {
  const { instruction } = z.object({ instruction: z.string().min(1) }).parse(req.body);
  const exists = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  try {
    res.json({ compiled: await compileAiStep(instruction) });
  } catch {
    res.json({ compiled: null });
  }
});
```

- [ ] **Step 5: 实现 routes/recorder.ts finish 编译**

`recorderRoute.post('/sessions/:id/finish')` 的 for 循环之前加：

```ts
  await compileAiStepsInPlace(
    session.steps.map((s) => {
      const item = s as { action: unknown; url?: string };
      return { action: item.action, url: item.url };
    }),
  );
```

import 区加 `import { compileAiStepsInPlace } from '../agent/aiStepCompile.js';`。响应保持 `{ inserted }` 不变（编译失败静默置 compiled=null，与 replace-all 一致）。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @itest/api test && pnpm --filter @itest/api typecheck`
Expected: 全 PASS（api 测试需要 Docker；TESTCONTAINERS_RYUK_DISABLED 已固化）

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/steps.ts apps/api/src/routes/recorder.ts apps/api/test/
git commit -m "feat(api): steps replace-all + aiStep recompile; compile aiStep on append/finish"
```

---

## Task 6: api — 执行器新分支

**Files:**
- Modify: `apps/api/src/execute/cdp.ts`
- Modify: `apps/api/src/routes/execute.ts`
- Modify: `apps/api/test/execute-cdp.test.ts`

- [ ] **Step 1: 更新 mock + 写失败测试**（`apps/api/test/execute-cdp.test.ts`）

把 `makeLocator` 替换为：

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

`__page` 上加 `waitForTimeout: vi.fn().mockResolvedValue(undefined)`（page 对象字面量里加）。

追加测试（describe 内）：

```ts
  it('check action performs check only when state differs', async () => {
    mocked.__page.waitForTimeout.mockClear();
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, action: { kind: 'check', locator: [{ strategy: 'css', value: '#cb' }], checked: true } }],
      { reportId: 'r-check' },
    );
    const loc = (mocked.__page.locator as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(loc.check).toHaveBeenCalled();
    expect(loc.uncheck).not.toHaveBeenCalled();
    expect(loc.isChecked).toHaveBeenCalled();
  });

  it('select action forwards materialized value to selectOption', async () => {
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, action: { kind: 'select', locator: [{ strategy: 'css', value: 'select' }], value: 'cn' } }],
      { reportId: 'r-select' },
    );
    const loc = (mocked.__page.locator as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(loc.selectOption).toHaveBeenCalledWith('cn', expect.objectContaining({ timeout: 5000 }));
  });

  it('upload action skips with warning (P5 binds real files)', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, action: { kind: 'upload', locator: [{ strategy: 'css', value: 'input[type=file]' }] } }],
      { reportId: 'r-upload' },
    );
    expect(results[0]!.status).toBe('passed');
    expect(results[0]!.warning).toMatch(/待绑定回放文件/);
  });

  it('extract action stores element value into vars for later fill', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [
        { order: 1, action: { kind: 'extract', locator: [{ strategy: 'css', value: '#no' }], varName: 'orderNo' } },
        { order: 2, action: { kind: 'fill', locator: [{ strategy: 'css', value: '#f' }], value: '{{orderNo}}' } },
      ],
      { reportId: 'r-extract' },
    );
    expect(results.every((r) => r.status === 'passed')).toBe(true);
    const loc = (mocked.__page.locator as ReturnType<typeof vi.fn>).mock.results[1]!.value;
    expect(loc.fill).toHaveBeenCalledWith('input-val', expect.anything());
  });

  it('unresolved {{var}} fails the step with missing var name', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, action: { kind: 'fill', locator: [{ strategy: 'css', value: '#f' }], value: '{{nope}}' } }],
      { reportId: 'r-var' },
    );
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toMatch(/nope/);
  });

  it('assertJson deep-compares parsed element text', async () => {
    const results = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, action: { kind: 'assertJson', locator: [{ strategy: 'css', value: 'pre' }], equals: { code: 0 } } }],
      { reportId: 'r-json' },
    );
    expect(results[0]!.status).toBe('passed');
  });

  it('uncompiled aiStep fails with clear error; compiled aiStep runs substeps', async () => {
    const bad = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, action: { kind: 'aiStep', instruction: 'x', compiled: null } }],
      { reportId: 'r-ai-bad' },
    );
    expect(bad[0]!.status).toBe('failed');
    expect(bad[0]!.error).toMatch(/未编译/);

    const good = await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [
        {
          order: 1,
          action: {
            kind: 'aiStep',
            instruction: 'x',
            compiled: [{ kind: 'assertVisible', locator: [{ strategy: 'role', value: 'main' }] }],
          },
        },
      ],
      { reportId: 'r-ai-good' },
    );
    expect(good[0]!.status).toBe('passed');
  });

  it('applies delayMs via page.waitForTimeout before dispatch', async () => {
    mocked.__page.waitForTimeout.mockClear();
    await executeCaseReal(
      '00000000-0000-0000-0000-000000000001',
      [{ order: 1, delayMs: 300, action: { kind: 'navigate', url: 'https://example.com' } }],
      { reportId: 'r-delay' },
    );
    expect(mocked.__page.waitForTimeout).toHaveBeenCalledWith(300);
  });
```

注意：'{{c}}' select 用例里 vars 没有 c——select 用 `materializeValue`，会抛「未定义变量」导致失败。把该用例 value 直接写 `'cn'`，断言 `toHaveBeenCalledWith('cn', ...)`。（已按此写。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/api test -- execute-cdp`
Expected: 新用例 FAIL（`delayMs` 不被识别、新 kind 走到 default 无分支/TS 报错）

- [ ] **Step 3: 实现 cdp.ts**

import 区加 `import { deepEqual, materializeValue } from '@itest/shared';`（与现有 `import type { StepAction, Locator } from '@itest/shared';` 合并为一行具名导入）。

`ExecStepResult` 加字段：

```ts
  warning?: string;
```

`ExecContext` 不变。`DispatchOpts` 改为：

```ts
interface DispatchOpts {
  page: Page;
  vars: Record<string, string>;
}
```

`dispatch` 函数整体替换为：

```ts
/** 执行单步；返回 warning 文本（无则 undefined）。失败抛错由调用方记 failed。 */
async function dispatch(action: StepAction, opts: DispatchOpts): Promise<string | undefined> {
  const { page, vars } = opts;
  switch (action.kind) {
    case 'navigate':
      await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return;
    case 'click':
      await firstMatch(page, action.locator).click({ timeout: 5000 });
      return;
    case 'fill':
      await firstMatch(page, action.locator).fill(materializeValue(action.value, vars), { timeout: 5000 });
      return;
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
    case 'assertText':
      await firstMatch(page, action.locator).filter({ hasText: action.equals }).first().waitFor({ state: 'visible', timeout: 5000 });
      return;
    case 'assertJson': {
      const text = (await firstMatch(page, action.locator).innerText({ timeout: 5000 })).trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`assertJson: 元素文本不是合法 JSON: ${text.slice(0, 100)}`);
      }
      if (!deepEqual(parsed, action.equals)) {
        throw new Error(`assertJson 深比较失败: 实际 ${text.slice(0, 100)}`);
      }
      return;
    }
    case 'screenshot':
      await page.screenshot({ path: action.name || 'snap' });
      return;
    case 'check': {
      const loc = firstMatch(page, action.locator);
      const current = await loc.isChecked({ timeout: 5000 });
      if (current !== action.checked) {
        if (action.checked) await loc.check({ timeout: 5000 });
        else await loc.uncheck({ timeout: 5000 });
      }
      return;
    }
    case 'select':
      await firstMatch(page, action.locator).selectOption(materializeValue(action.value, vars), { timeout: 5000 });
      return;
    case 'upload':
      // P5 才支持绑定回放文件；P1 记录 warning 并跳过，不算失败。
      return '待绑定回放文件（后续版本支持），本次跳过';
    case 'extract': {
      const loc = firstMatch(page, action.locator);
      let text: string;
      try {
        text = await loc.inputValue({ timeout: 5000 });
      } catch {
        text = await loc.innerText({ timeout: 5000 });
      }
      vars[action.varName] = text.trim();
      return;
    }
    case 'aiStep': {
      if (!action.compiled) throw new Error('AI 步骤未编译');
      for (const sub of action.compiled) {
        await dispatch(sub, opts);
      }
      return;
    }
  }
}
```

`executeCaseReal`：签名 steps 类型改：

```ts
  steps: Array<{ order: number; action: unknown; delayMs?: number | null }>,
```

函数体内 `const results` 声明之后、`if (targetUrl)` 之前加 `const vars: Record<string, string> = {};`。循环内 try 中改为：

```ts
        if (step.delayMs) await page.waitForTimeout(step.delayMs);
        const warning = await dispatch(step.action as StepAction, { page, vars });
        const screenshot = await writeStepScreenshot(ctx.reportId, i + 1, page);
        results.push({
          order: step.order,
          status: 'passed',
          durationMs: Date.now() - started,
          warning,
          screenshot,
        });
```

- [ ] **Step 4: execute.ts 传 delayMs**

`apps/api/src/routes/execute.ts` 中 `executeCaseReal` 调用的 steps 映射改为：

```ts
      steps.map((s) => ({ order: s.order, action: s.action, delayMs: s.delayMs })),
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `pnpm --filter @itest/api test && pnpm --filter @itest/api typecheck`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/execute/cdp.ts apps/api/src/routes/execute.ts apps/api/test/execute-cdp.test.ts
git commit -m "feat(api): executor phase1 — check/select/upload-warn/assertJson/extract/aiStep, vars, delayMs, warnings"
```

---

## Task 7: recorder — change 事件 + 暂停

**Files:**
- Modify: `apps/recorder/modules/recorder-manager.ts`
- Test: `apps/recorder/test/recorder-manager.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `apps/recorder/test/recorder-manager.test.ts`）

```ts
describe('recorder-manager — phase1 change events + pause', () => {
  function setup() {
    const mgr = new RecorderManager();
    const captured: RecordedStep[] = [];
    mgr.start((s) => captured.push(s));
    return { mgr, captured };
  }

  it('checkbox change emits check step with target state', () => {
    const { captured } = setup();
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    document.body.appendChild(cb);
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.type).toBe('check');
    expect(captured[0]!.checked).toBe(false);
    cb.remove();
  });

  it('checkbox does not emit fill from input event', () => {
    const { captured } = setup();
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    document.body.appendChild(cb);
    cb.dispatchEvent(new Event('input', { bubbles: true }));
    expect(captured.filter((s) => s.type === 'fill')).toHaveLength(0);
    cb.remove();
  });

  it('file input emits upload step with file name, no fill', () => {
    const { captured } = setup();
    const f = document.createElement('input');
    f.type = 'file';
    document.body.appendChild(f);
    Object.defineProperty(f, 'files', { value: [{ name: 'report.xlsx' }], configurable: true });
    f.dispatchEvent(new Event('change', { bubbles: true }));
    f.dispatchEvent(new Event('input', { bubbles: true }));
    const upload = captured.find((s) => s.type === 'upload');
    expect(upload?.value).toBe('report.xlsx');
    expect(captured.filter((s) => s.type === 'fill')).toHaveLength(0);
    f.remove();
  });

  it('select change emits select step with selected value', () => {
    const { captured } = setup();
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="cn">中文</option><option value="en" selected>EN</option>';
    document.body.appendChild(sel);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const step = captured.find((s) => s.type === 'select');
    expect(step?.value).toBe('en');
    sel.remove();
  });

  it('paused manager emits nothing', () => {
    const { mgr, captured } = setup();
    mgr.setPaused(true);
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(captured).toHaveLength(0);
    mgr.setPaused(false);
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(captured).toHaveLength(1);
    btn.remove();
  });
});
```

文件顶部 import 补 `RecordedStep` 类型（若尚未导入）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/recorder test`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现**（`apps/recorder/modules/recorder-manager.ts` 整文件替换）

```ts
import { generateLocators, type Locator } from './selector-core.js';

export type RecordedStepType = 'click' | 'fill' | 'hover' | 'check' | 'select' | 'upload';

export interface RecordedStep {
  type: RecordedStepType;
  target: Locator[];
  /** fill/select 的值；upload 的文件名 */
  value?: string;
  /** check 的目标状态 */
  checked?: boolean;
  url: string;
  timestamp: number;
}

type StepHandler = (step: RecordedStep) => void;

/**
 * 浏览器端录制协调器：
 *  - click / input / change / mouseover 事件被捕获并生成多候选 locator。
 *  - change 细分：checkbox → check（带目标状态），select → select（带选中值），file → upload（只记文件名）。
 *  - 200ms 内的重复 click 去重（双击是用户意图但不应产生 2 个 click 步骤）。
 *  - 当 input 事件触发时，跳过紧随其后的 mouseover，避免「键入即 hover」噪声。
 *  - 输入框上 hover 不被发射（hover-when-input 抑制）；checkbox/file 的 input 不产 fill。
 *  - setPaused(true) 期间所有事件被忽略（录制面板「暂停」/元素拾取期间使用）。
 */
export class RecorderManager {
  private active = false;
  private paused = false;
  private handler: StepHandler | null = null;
  private listeners: Array<{ el: EventTarget; type: string; fn: EventListener }> = [];
  private lastClick: { signature: string; at: number } | null = null;
  private lastInputAt: number | null = null;
  private static DEDUP_WINDOW_MS = 200;
  private static HOVER_SUPPRESS_AFTER_INPUT_MS = 300;

  start(handler: StepHandler) {
    this.active = true;
    this.paused = false;
    this.handler = handler;
    this.lastClick = null;
    this.lastInputAt = null;
    this.attachListeners();
  }

  stop() {
    this.active = false;
    this.paused = false;
    this.handler = null;
    this.detachListeners();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
  }

  isPaused() {
    return this.paused;
  }

  private canRecord() {
    return this.active && !this.paused;
  }

  private attachListeners() {
    const onClick = (e: Event) => {
      if (!this.canRecord()) return;
      const target = e.target as Element;
      if (!target) return;
      const locs = generateLocators(target);
      const sig = locs.map((l) => `${l.strategy}:${l.value}`).join('|');
      const now = Date.now();
      if (this.lastClick && this.lastClick.signature === sig && now - this.lastClick.at < RecorderManager.DEDUP_WINDOW_MS) {
        this.lastClick.at = now;
        return;
      }
      this.lastClick = { signature: sig, at: now };
      this.handler?.({
        type: 'click',
        target: locs,
        url: location.href,
        timestamp: now,
      });
    };
    const onInput = (e: Event) => {
      if (!this.canRecord()) return;
      const target = e.target as HTMLInputElement;
      if (!target) return;
      // checkbox 由 change 事件产出 check 步骤；file 由 change 产出 upload 步骤。
      if (target.type === 'checkbox' || target.type === 'file') return;
      this.lastInputAt = Date.now();
      this.handler?.({
        type: 'fill',
        target: generateLocators(target),
        value: target.value,
        url: location.href,
        timestamp: Date.now(),
      });
    };
    const onChange = (e: Event) => {
      if (!this.canRecord()) return;
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      if (!target) return;
      const now = Date.now();
      if (target instanceof HTMLInputElement && target.type === 'checkbox') {
        this.handler?.({
          type: 'check',
          target: generateLocators(target),
          checked: target.checked,
          url: location.href,
          timestamp: now,
        });
        return;
      }
      if (target instanceof HTMLInputElement && target.type === 'file') {
        this.handler?.({
          type: 'upload',
          target: generateLocators(target),
          value: target.files?.[0]?.name ?? '',
          url: location.href,
          timestamp: now,
        });
        return;
      }
      if (target instanceof HTMLSelectElement) {
        this.handler?.({
          type: 'select',
          target: generateLocators(target),
          value: target.value,
          url: location.href,
          timestamp: now,
        });
      }
    };
    const onMouseOver = (e: Event) => {
      if (!this.canRecord()) return;
      const target = e.target as Element;
      if (!target) return;
      const sinceInput = this.lastInputAt !== null ? Date.now() - this.lastInputAt : Infinity;
      if (sinceInput < RecorderManager.HOVER_SUPPRESS_AFTER_INPUT_MS) return;
      const tag = (target.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      this.handler?.({
        type: 'hover',
        target: generateLocators(target),
        url: location.href,
        timestamp: Date.now(),
      });
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('mouseover', onMouseOver, true);
    this.listeners.push(
      { el: document, type: 'click', fn: onClick },
      { el: document, type: 'input', fn: onInput },
      { el: document, type: 'change', fn: onChange },
      { el: document, type: 'mouseover', fn: onMouseOver },
    );
  }

  private detachListeners() {
    for (const l of this.listeners) {
      l.el.removeEventListener(l.type, l.fn, true);
    }
    this.listeners = [];
  }

  isActive() {
    return this.active;
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm --filter @itest/recorder test && pnpm --filter @itest/recorder typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/recorder/modules/recorder-manager.ts apps/recorder/test/recorder-manager.test.ts
git commit -m "feat(recorder): change events (check/select/upload) + pause support"
```

---

## Task 8: recorder — 元素拾取模块

**Files:**
- Create: `apps/recorder/modules/picker.ts`
- Test: `apps/recorder/test/picker.test.ts`

- [ ] **Step 1: 写失败测试**（新建 `apps/recorder/test/picker.test.ts`）

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ElementPicker, type PickResult } from '../modules/picker.js';

describe('ElementPicker', () => {
  let picker: ElementPicker;

  beforeEach(() => {
    document.body.innerHTML = '';
    picker = new ElementPicker();
  });

  it('click returns locators and text snapshot', () => {
    const btn = document.createElement('button');
    btn.textContent = '提交订单';
    document.body.appendChild(btn);
    let result: PickResult | null = null;
    picker.start((r) => {
      result = r;
    });
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(result).not.toBeNull();
    expect(result!.text).toBe('提交订单');
    expect(result!.locators.length).toBeGreaterThan(0);
    expect(result!.locators[0]!.strategy).toBe('role');
  });

  it('input element reports its value as inputValue', () => {
    const input = document.createElement('input');
    input.value = 'A-123';
    document.body.appendChild(input);
    let result: PickResult | null = null;
    picker.start((r) => {
      result = r;
    });
    input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(result!.inputValue).toBe('A-123');
    expect(result!.tagName).toBe('input');
  });

  it('Escape cancels with null and cleans up listeners', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    let called = 0;
    picker.start(() => {
      called++;
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(called).toBe(1);
    // 再次点击不应再触发（监听器已移除，且回调收的是 null）
    const r: (PickResult | null)[] = [];
    // 重新 start 一个 picker 验证前一个已停止：直接再 start 新的即可，这里验证 stop() 幂等
    picker.stop();
    expect(called).toBe(1);
  });

  it('does not start twice', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const results: (PickResult | null)[] = [];
    picker.start((r) => results.push(r));
    picker.start((r) => results.push(r)); // 第二次调用应被忽略
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(results).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/recorder test -- picker`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**（新建 `apps/recorder/modules/picker.ts`）

```ts
import { generateLocators, type Locator } from './selector-core.js';

export interface PickResult {
  locators: Locator[];
  /** 元素可见文本快照（截断 500 字符） */
  text: string;
  /** input/textarea 的当前值，其他元素为空串 */
  inputValue: string;
  tagName: string;
  /** 元素 id / name 属性，用于变量名建议 */
  id: string;
  nameAttr: string;
}

/**
 * 元素拾取模式：高亮 hover 目标，点击选定，Esc 取消。
 * 使用方（content script）负责在拾取期间暂停普通录制。
 * 取消时回调收到 null；stop() 强制停止（录制终止时）不回调。
 */
export class ElementPicker {
  private active = false;
  private highlighted: HTMLElement | null = null;
  private onMove?: (e: MouseEvent) => void;
  private onClick?: (e: MouseEvent) => void;
  private onKey?: (e: KeyboardEvent) => void;

  private teardown() {
    if (this.onMove) document.removeEventListener('mousemove', this.onMove, true);
    if (this.onClick) document.removeEventListener('click', this.onClick, true);
    if (this.onKey) document.removeEventListener('keydown', this.onKey, true);
    this.onMove = this.onClick = this.onKey = undefined;
    if (this.highlighted) {
      this.highlighted.style.outline = '';
      this.highlighted = null;
    }
    this.active = false;
  }

  start(onDone: (result: PickResult | null) => void): void {
    if (this.active) return;
    this.active = true;

    this.onMove = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || el === this.highlighted) return;
      if (this.highlighted) this.highlighted.style.outline = '';
      this.highlighted = el;
      el.style.outline = '2px solid #7c3aed';
    };

    this.onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target as HTMLElement;
      const text = (el.innerText ?? el.textContent ?? '').trim().slice(0, 500);
      const inputValue =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : '';
      const locators = generateLocators(el);
      const id = el.id ?? '';
      const nameAttr = el.getAttribute('name') ?? '';
      this.teardown();
      onDone({ locators, text, inputValue, tagName: el.tagName.toLowerCase(), id, nameAttr });
    };

    this.onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      this.teardown();
      onDone(null);
    };

    document.addEventListener('mousemove', this.onMove, true);
    document.addEventListener('click', this.onClick, true);
    document.addEventListener('keydown', this.onKey, true);
  }

  /** 强制停止（录制停止时调用）。未激活时无操作。 */
  stop(): void {
    if (!this.active) return;
    this.teardown();
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm --filter @itest/recorder test && pnpm --filter @itest/recorder typecheck`
Expected: PASS

- [ ] **Step 5: 重新编译扩展产物**

Run: `pnpm --filter @itest/recorder build`
Expected: `modules/*.js` 更新（tsc 产物与 .ts 同目录）

- [ ] **Step 6: Commit**

```bash
git add apps/recorder/modules/picker.ts apps/recorder/modules/picker.js apps/recorder/test/picker.test.ts
git commit -m "feat(recorder): element picker mode for panel-driven steps"
```

---

## Task 9: recorder — background 消息路由 + 启动链路修复

**Files:**
- Modify: `apps/recorder/background.js`

背景（为什么改）：当前 `content/recorder.js` 只在收到 window `start-recording` 消息时才 `manager.start()`，但该消息只会在中台页面（localhost）被 postMessage——background 新开的录制 tab 永远收不到，**外部页面上录制从未真正启动**。本任务注入完成后由 background 显式发 `{type:'start'}` 修复。

- [ ] **Step 1: 整文件替换 `apps/recorder/background.js`**

```js
let ws = null;
let recordingTabId = null;
let paused = false;

function toDSL(step) {
  if (step.type === 'check') return { kind: 'check', locator: step.target, checked: !!step.checked };
  if (step.type === 'select') return { kind: 'select', locator: step.target, value: step.value ?? '' };
  if (step.type === 'upload') {
    const dsl = { kind: 'upload', locator: step.target };
    if (step.value) dsl.fileName = step.value;
    return dsl;
  }
  const dsl = { kind: step.type, locator: step.target };
  if (dsl.kind === 'fill') dsl.value = step.value ?? '';
  return dsl;
}

function attachTabInjector() {
  const onUpdated = (tabId, changeInfo) => {
    if (tabId !== recordingTabId || changeInfo.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.scripting
      .executeScript({ target: { tabId }, files: ['content/recorder.js'] })
      // 修复启动链路：新 tab 里没有任何 ita-web window 消息源，注入完成后由 background 显式启动采集。
      .then(() => chrome.tabs.sendMessage(tabId, { type: 'start' }))
      .catch(() => {});
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start' && msg.session) {
    const { wsUrl, sessionId, token } = msg.session;
    ws = new WebSocket(`${wsUrl}?sessionId=${sessionId}&token=${token}`);
    ws.onopen = () => {
      sendResponse({ ok: true });
      attachTabInjector();
      chrome.tabs.create({ url: msg.targetUrl }, (tab) => {
        recordingTabId = tab.id;
      });
    };
    ws.onerror = () => sendResponse({ ok: false, error: 'ws failed' });
    return true;
  }
  if (msg.type === 'step' && ws && ws.readyState === 1) {
    // 事件步骤：msg.step 是 RecordedStep，需转换；面板步骤：msg.dsl 已是 DSL。
    const dsl = msg.dsl ?? toDSL(msg.step);
    const url = msg.step?.url ?? msg.url ?? null;
    ws.send(JSON.stringify({ type: 'step', step: { action: dsl, url } }));
  }
  if (msg.type === 'stop') {
    const stopTab = () => {
      if (recordingTabId !== null) {
        chrome.tabs.sendMessage(recordingTabId, { type: 'stop' });
        recordingTabId = null;
        paused = false;
      }
    };
    const sock = ws;
    ws = null;
    if (sock && sock.readyState === 1) {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        stopTab();
        sendResponse({ ok: true });
      };
      sock.onclose = () => done();
      sock.send(JSON.stringify({ type: 'finish' }));
      setTimeout(() => {
        try { sock.close(); } catch { /* already closed */ }
        done();
      }, 3000);
    } else {
      stopTab();
      sendResponse({ ok: true });
    }
    return true;
  }
  // —— 录制面板（popup / panel 窗口）消息 ——
  if (msg.type === 'get-state') {
    sendResponse({ recording: recordingTabId !== null, paused });
    return;
  }
  if (msg.type === 'pause' || msg.type === 'resume') {
    paused = msg.type === 'pause';
    if (recordingTabId !== null) chrome.tabs.sendMessage(recordingTabId, { type: msg.type });
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'pick' || msg.type === 'emit-step') {
    if (recordingTabId === null) {
      sendResponse({ ok: false, error: '当前没有录制中的标签页' });
      return;
    }
    chrome.tabs.sendMessage(recordingTabId, msg, (resp) => {
      sendResponse(resp ?? { ok: false });
    });
    return true;
  }
  return false;
});
```

- [ ] **Step 2: 验证扩展可加载**

Run: `pnpm --filter @itest/recorder build && pnpm --filter @itest/recorder test`
Expected: 构建 + 测试 PASS。手动验证：Chrome `chrome://extensions/` 重新加载 `apps/recorder/`，从中台发起录制，确认新 tab 里点击会产生步骤（修复生效）。

- [ ] **Step 3: Commit**

```bash
git add apps/recorder/background.js
git commit -m "fix(recorder): start capture in opened tab via background message; route panel msgs"
```

---

## Task 10: recorder — content/recorder.js 接线

**Files:**
- Modify: `apps/recorder/content/recorder.js`

- [ ] **Step 1: 整文件替换**

```js
(async () => {
  const src = chrome.runtime.getURL('modules/recorder-manager.js');
  const mod = await import(src);
  const manager = new mod.RecorderManager();

  const pickerMod = await import(chrome.runtime.getURL('modules/picker.js'));
  const picker = new pickerMod.ElementPicker();

  const sendStep = (step) => chrome.runtime.sendMessage({ type: 'step', step });
  const startCapture = () => manager.start(sendStep);

  window.addEventListener('message', (e) => {
    if (e.data?.source !== 'ita-web') return;
    if (e.data.type === 'start-recording') {
      startCapture();
    } else if (e.data.type === 'stop-recording') {
      manager.stop();
      picker.stop();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'stop') {
      manager.stop();
      picker.stop();
    } else if (msg?.type === 'start') {
      // background 注入后显式启动（外部录制页没有 ita-web window 消息源）
      startCapture();
    } else if (msg?.type === 'pause') {
      manager.setPaused(true);
    } else if (msg?.type === 'resume') {
      manager.setPaused(false);
    } else if (msg?.type === 'pick') {
      // 面板发起的元素拾取：拾取期间暂停普通录制
      manager.setPaused(true);
      picker.start((result) => {
        manager.setPaused(false);
        sendResponse(result ?? { canceled: true });
      });
      return true;
    } else if (msg?.type === 'emit-step') {
      // 面板生成的步骤（extract/assertText/assertJson/hover/aiStep）直接以 DSL 上送
      chrome.runtime.sendMessage({ type: 'step', dsl: msg.dsl, url: location.href });
      sendResponse({ ok: true });
    }
  });
})();
```

- [ ] **Step 2: 构建验证**

Run: `pnpm --filter @itest/recorder build && pnpm --filter @itest/recorder test`
Expected: PASS（content 脚本是静态 js，无单测；验证语法 + 既有测试不回退）

- [ ] **Step 3: Commit**

```bash
git add apps/recorder/content/recorder.js
git commit -m "feat(recorder): wire runtime messages — pause/pick/emit-step; start via background"
```

---

## Task 11: recorder — popup 与 panel 窗口

**Files:**
- Modify: `apps/recorder/popup/popup.html`
- Modify: `apps/recorder/popup/popup.js`
- Modify: `apps/recorder/popup/popup.css`
- Create: `apps/recorder/popup/panel.html`
- Create: `apps/recorder/popup/panel.js`
- Create: `apps/recorder/popup/panel.css`

背景（为什么用独立窗口）：browser action popup 在用户点击页面时立即关闭，无法完成「点按钮 → 到页面点元素 → 回 popup 填表单」的往返。`chrome.windows.create({type:'popup'})` 打开的窗口不抢焦点、保持打开，作为录制面板载体。

- [ ] **Step 1: popup.html 整文件替换**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="popup.css" />
  </head>
  <body>
    <div class="container">
      <h1>iTest Recorder</h1>
      <p id="status" class="hint">检查录制状态...</p>
      <button id="open">打开中台</button>
      <hr />
      <button id="pause" disabled>暂停录制</button>
      <hr />
      <p class="hint">以下操作会打开一个小窗口，在窗口里完成配置：</p>
      <button class="panel-btn" data-mode="variable" disabled>保存变量</button>
      <button class="panel-btn" data-mode="assert" disabled>添加断言</button>
      <button class="panel-btn" data-mode="hover" disabled>记录悬浮</button>
      <button class="panel-btn" data-mode="ai" disabled>AI 自然语言步骤</button>
    </div>
    <script src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 2: popup.js 整文件替换**

```js
const statusEl = document.getElementById('status');
const pauseBtn = document.getElementById('pause');
const panelBtns = document.querySelectorAll('.panel-btn');

document.getElementById('open').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://127.0.0.1:5173/' });
});

function openPanel(mode) {
  chrome.windows.create({
    url: chrome.runtime.getURL(`popup/panel.html?mode=${mode}`),
    type: 'popup',
    width: 380,
    height: mode === 'assert' ? 460 : mode === 'ai' ? 300 : 240,
  });
}

panelBtns.forEach((btn) => {
  btn.addEventListener('click', () => openPanel(btn.dataset.mode));
});

pauseBtn.addEventListener('click', () => {
  const next = pauseBtn.dataset.paused === 'true' ? 'resume' : 'pause';
  chrome.runtime.sendMessage({ type: next }, render);
});

function render(state) {
  const { recording, paused } = state ?? { recording: false, paused: false };
  statusEl.textContent = recording ? (paused ? '已暂停' : '录制中') : '未在录制（从中台用例详情页发起）';
  pauseBtn.disabled = !recording;
  pauseBtn.dataset.paused = String(paused);
  pauseBtn.textContent = paused ? '继续录制' : '暂停录制';
  panelBtns.forEach((b) => (b.disabled = !recording));
}

chrome.runtime.sendMessage({ type: 'get-state' }, render);
```

- [ ] **Step 3: popup.css 整文件替换**

```css
body { margin: 0; font-family: -apple-system, 'PingFang SC', sans-serif; }
.container { width: 240px; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
h1 { font-size: 13px; margin: 0 0 4px; }
.hint { font-size: 11px; color: #888; margin: 0 0 4px; }
hr { width: 100%; border: none; border-top: 1px solid #eee; margin: 4px 0; }
button {
  padding: 6px 10px; font-size: 12px; border: 1px solid #d0d0d0; border-radius: 6px;
  background: #fff; cursor: pointer; text-align: left;
}
button:hover:not(:disabled) { background: #f5f3ff; border-color: #7c3aed; }
button:disabled { opacity: 0.4; cursor: default; }
```

- [ ] **Step 4: panel.html 新建**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="panel.css" />
  </head>
  <body>
    <div class="container">
      <h1 id="title">录制面板</h1>
      <p id="status" class="hint">...</p>
      <div id="form" class="hidden">
        <label id="field1-label"></label>
        <input id="field1" type="text" />
        <label id="field2-label" class="hidden"></label>
        <textarea id="field2" class="hidden" rows="6"></textarea>
        <button id="submit">确定</button>
      </div>
      <button id="close" class="hidden">关闭窗口</button>
    </div>
    <script src="panel.js"></script>
  </body>
</html>
```

- [ ] **Step 5: panel.js 新建**

```js
const mode = new URLSearchParams(location.search).get('mode') ?? 'ai';
const statusEl = document.getElementById('status');
const form = document.getElementById('form');
const closeBtn = document.getElementById('close');
const field1 = document.getElementById('field1');
const field2 = document.getElementById('field2');
const field2Label = document.getElementById('field2-label');

const TITLES = {
  variable: '保存变量',
  assert: '添加断言',
  hover: '记录悬浮',
  ai: 'AI 自然语言步骤',
};
document.getElementById('title').textContent = TITLES[mode] ?? '录制面板';

closeBtn.addEventListener('click', () => window.close());

function emit(dsl) {
  chrome.runtime.sendMessage({ type: 'emit-step', dsl }, (resp) => {
    if (resp?.ok) {
      statusEl.textContent = '已生成步骤 ✓';
      form.classList.add('hidden');
      closeBtn.classList.remove('hidden');
    } else {
      statusEl.textContent = `失败: ${resp?.error ?? '未知错误'}`;
    }
  });
}

function showForm(html) {
  statusEl.textContent = html.hint;
  document.getElementById('field1-label').textContent = html.label1;
  field1.value = html.value1 ?? '';
  if (html.label2) {
    field2Label.textContent = html.label2;
    field2Label.classList.remove('hidden');
    field2.classList.remove('hidden');
    field2.value = html.value2 ?? '';
  }
  form.classList.remove('hidden');
  document.getElementById('submit').onclick = html.onSubmit;
}

function suggestVarName(r) {
  const raw = r.id || r.nameAttr || '';
  if (!raw) return '';
  return raw.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
}

if (mode === 'ai') {
  showForm({
    hint: '描述要执行的操作，保存用例时会编译成具体步骤：',
    label1: '指令',
    value1: '',
    onSubmit: () => {
      const instruction = field1.value.trim();
      if (!instruction) {
        statusEl.textContent = '请输入指令';
        return;
      }
      emit({ kind: 'aiStep', instruction, compiled: null });
    },
  });
} else {
  statusEl.textContent = '请在页面中点击目标元素（Esc 取消）...';
  chrome.runtime.sendMessage({ type: 'pick' }, (r) => {
    if (!r || r.ok === false) {
      statusEl.textContent = `无法拾取: ${r?.error ?? '扩展未在录制中'}`;
      closeBtn.classList.remove('hidden');
      return;
    }
    if (r.canceled) {
      statusEl.textContent = '已取消';
      closeBtn.classList.remove('hidden');
      return;
    }
    if (mode === 'hover') {
      emit({ kind: 'hover', locator: r.locators });
      return;
    }
    if (mode === 'variable') {
      showForm({
        hint: `元素文本: ${r.text.slice(0, 60) || r.inputValue.slice(0, 60) || '（空）'}`,
        label1: '变量名',
        value1: suggestVarName(r),
        onSubmit: () => {
          const varName = field1.value.trim();
          if (!varName) {
            statusEl.textContent = '请输入变量名';
            return;
          }
          emit({ kind: 'extract', locator: r.locators, varName });
        },
      });
      return;
    }
    if (mode === 'assert') {
      showForm({
        hint: '选择断言类型并填写期望值：',
        label1: '断言类型（text / json）',
        value1: 'text',
        label2: '期望值（默认已填入元素当前文本）',
        value2: r.text || r.inputValue,
        onSubmit: () => {
          const type = field1.value.trim();
          const expected = field2.value;
          if (type === 'json') {
            let parsed;
            try {
              parsed = JSON.parse(expected);
            } catch {
              statusEl.textContent = '期望值不是合法 JSON';
              return;
            }
            emit({ kind: 'assertJson', locator: r.locators, equals: parsed });
          } else {
            emit({ kind: 'assertText', locator: r.locators, equals: expected });
          }
        },
      });
    }
  });
}
```

- [ ] **Step 6: panel.css 新建**

```css
body { margin: 0; font-family: -apple-system, 'PingFang SC', sans-serif; }
.container { padding: 14px; display: flex; flex-direction: column; gap: 8px; }
h1 { font-size: 13px; margin: 0; }
.hint { font-size: 11px; color: #888; margin: 0; }
.hidden { display: none; }
label { font-size: 11px; color: #555; }
input, textarea {
  padding: 6px 8px; font-size: 12px; border: 1px solid #d0d0d0; border-radius: 6px; width: 100%;
  box-sizing: border-box; font-family: inherit;
}
button {
  padding: 6px 10px; font-size: 12px; border: 1px solid #7c3aed; border-radius: 6px;
  background: #7c3aed; color: #fff; cursor: pointer;
}
```

- [ ] **Step 7: 手动验证**

重新加载扩展（chrome://extensions/），发起录制后点击扩展图标：应显示「录制中」、暂停按钮可用、四个面板按钮可点击并打开对应小窗口；点「记录悬浮」后在页面点元素，窗口显示「已生成步骤 ✓」。（此步骤无法自动化，记录在 PR 描述。）

- [ ] **Step 8: Commit**

```bash
git add apps/recorder/popup/
git commit -m "feat(recorder): recording panel — pause/variable/assert/hover/AI via popup windows"
```

---

## Task 12: web — api client + 剪贴板 store

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Create: `apps/web/src/stores/stepClipboard.ts`

- [ ] **Step 1: api client 修改**

`apps/web/src/api/client.ts` 的 `cases` 对象里、`deleteStep` 之后加：

```ts
    replaceSteps: (
      id: string,
      steps: Array<{ action: unknown; source: string; name?: string; delayMs?: number }>,
    ) =>
      request<{ steps: TestStep[] }>(`/cases/${id}/steps`, {
        method: 'PUT',
        body: JSON.stringify({ steps }),
      }),
    recompileStep: (id: string, instruction: string) =>
      request<{ compiled: unknown[] | null }>(`/cases/${id}/steps/recompile`, {
        method: 'POST',
        body: JSON.stringify({ instruction }),
      }),
```

`TestStep` 接口改为：

```ts
export interface TestStep {
  id: string;
  order: number;
  source: string;
  action: unknown;
  name?: string | null;
  delayMs?: number | null;
}
```

- [ ] **Step 2: 新建剪贴板 store**（`apps/web/src/stores/stepClipboard.ts`）

```ts
import { create } from 'zustand';

export interface StepClip {
  action: unknown;
  source: string;
  name?: string;
  delayMs?: number;
}

interface StepClipboardState {
  steps: StepClip[];
  setSteps: (steps: StepClip[]) => void;
}

/** 跨用例步骤剪贴板：复制后可粘贴到任意用例。 */
export const useStepClipboard = create<StepClipboardState>((set) => ({
  steps: [],
  setSteps: (steps) => set({ steps }),
}));
```

- [ ] **Step 3: typecheck + lint**

Run: `pnpm --filter @itest/web typecheck && pnpm --filter @itest/web lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/stores/stepClipboard.ts
git commit -m "feat(web): steps replace/recompile api client + cross-case step clipboard store"
```

---

## Task 13: web — 步骤编辑弹窗组件

**Files:**
- Create: `apps/web/src/components/StepEditModal.tsx`

- [ ] **Step 1: 新建组件**（完整文件）

```tsx
import { useState, useEffect, type CSSProperties } from 'react';
import type { StepClip } from '../stores/stepClipboard';

interface Props {
  initial: StepClip;
  /** 用例中已定义的变量名（extract 步骤产出），用于 fill 值的引用提示 */
  availableVars?: string[];
  onSave: (next: StepClip) => void;
  onClose: () => void;
}

type ValueMode = 'fixed' | 'randomString' | 'randomNumber' | 'timestamp' | 'prefixTimestamp';

/** 步骤编辑弹窗：名称/等待时间 + 按 action.kind 分派的值编辑。 */
export default function StepEditModal({ initial, availableVars = [], onSave, onClose }: Props) {
  const action = initial.action as Record<string, unknown>;
  const kind = action.kind as string;

  const [name, setName] = useState(initial.name ?? '');
  const [delayMs, setDelayMs] = useState(initial.delayMs ? String(initial.delayMs) : '');

  // fill/select 值编辑
  const rawValue = (action.value ?? '') as string | Record<string, unknown>;
  const isGenerator = typeof rawValue === 'object';
  const [valueMode, setValueMode] = useState<ValueMode>(
    isGenerator ? ((rawValue as { mode: string }).mode as ValueMode) : 'fixed',
  );
  const [fixedValue, setFixedValue] = useState(isGenerator ? '' : (rawValue as string));
  const [genLength, setGenLength] = useState(isGenerator ? String((rawValue as { length?: number }).length ?? 12) : '12');
  const [genMin, setGenMin] = useState(isGenerator ? String((rawValue as { min?: number }).min ?? 0) : '0');
  const [genMax, setGenMax] = useState(isGenerator ? String((rawValue as { max?: number }).max ?? 999999) : '999999');
  const [genPrefix, setGenPrefix] = useState(isGenerator ? String((rawValue as { prefix?: string }).prefix ?? '') : '');

  // assertText/assertJson
  const [equalsText, setEqualsText] = useState(
    kind === 'assertJson' ? JSON.stringify(action.equals ?? null, null, 2) : String(action.equals ?? ''),
  );
  // extract
  const [varName, setVarName] = useState(String(action.varName ?? ''));
  // aiStep
  const [instruction, setInstruction] = useState(String(action.instruction ?? ''));
  // navigate
  const [url, setUrl] = useState(String(action.url ?? ''));
  // waitFor
  const [timeoutMs, setTimeoutMs] = useState(String(action.timeoutMs ?? ''));
  // check
  const [checked, setChecked] = useState(action.checked !== false);

  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const buildValue = (): string | Record<string, unknown> => {
    switch (valueMode) {
      case 'fixed':
        return fixedValue;
      case 'randomString':
        return { mode: 'randomString', length: Number(genLength) || 12 };
      case 'randomNumber':
        return { mode: 'randomNumber', min: Number(genMin) || 0, max: Number(genMax) || 999999 };
      case 'timestamp':
        return { mode: 'timestamp' };
      case 'prefixTimestamp':
        return { mode: 'prefixTimestamp', prefix: genPrefix };
    }
  };

  const handleSave = () => {
    const next: Record<string, unknown> = { ...action };
    if (kind === 'fill' || kind === 'select') next.value = buildValue();
    if (kind === 'assertText') next.equals = equalsText;
    if (kind === 'assertJson') {
      try {
        next.equals = JSON.parse(equalsText);
      } catch {
        setError('期望值不是合法 JSON');
        return;
      }
    }
    if (kind === 'extract') {
      if (!varName.trim()) {
        setError('请输入变量名');
        return;
      }
      next.varName = varName.trim();
    }
    if (kind === 'aiStep') {
      if (!instruction.trim()) {
        setError('请输入指令');
        return;
      }
      next.instruction = instruction.trim();
      next.compiled = action.compiled ?? null;
    }
    if (kind === 'navigate') next.url = url;
    if (kind === 'waitFor') {
      if (timeoutMs) next.timeoutMs = Number(timeoutMs);
      else delete next.timeoutMs;
    }
    if (kind === 'check') next.checked = checked;
    onSave({
      action: next,
      source: initial.source,
      name: name.trim() || undefined,
      delayMs: delayMs ? Number(delayMs) : undefined,
    });
  };

  const inputStyle: CSSProperties = {
    width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid var(--color-glass-border)',
    borderRadius: 6, background: 'var(--color-background-subtle)', color: 'var(--color-foreground)',
    boxSizing: 'border-box', marginTop: 4,
  };
  const labelStyle: CSSProperties = { fontSize: 11, color: 'var(--color-foreground-muted)' };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)', zIndex: 50 }}
      onClick={onClose}
    >
      <div
        className="glass-card rounded-[12px] p-5 w-[420px] max-h-[80vh] overflow-y-auto"
        style={{ background: 'var(--color-background)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[14px] font-semibold mb-4" style={{ color: 'var(--color-foreground)' }}>
          编辑步骤 <span className="font-mono text-[11px]">({kind})</span>
        </h2>

        <div className="flex flex-col gap-3">
          <label style={labelStyle}>
            步骤名称
            <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="可选" />
          </label>
          <label style={labelStyle}>
            执行前等待 (ms)
            <input style={inputStyle} value={delayMs} onChange={(e) => setDelayMs(e.target.value)} placeholder="0" inputMode="numeric" />
          </label>

          {(kind === 'fill' || kind === 'select') && (
            <div className="flex flex-col gap-2">
              <span style={labelStyle}>值</span>
              <div className="flex gap-1 flex-wrap">
                {(['fixed', 'randomString', 'randomNumber', 'timestamp', 'prefixTimestamp'] as ValueMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setValueMode(m)}
                    style={{
                      fontSize: 11, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
                      border: '1px solid var(--color-glass-border)',
                      background: valueMode === m ? 'var(--color-accent)' : 'transparent',
                      color: valueMode === m ? '#fff' : 'var(--color-foreground-secondary)',
                    }}
                  >
                    {{ fixed: '固定值', randomString: '随机字符串', randomNumber: '随机数字', timestamp: '时间戳', prefixTimestamp: '前缀+时间戳' }[m]}
                  </button>
                ))}
              </div>
              {valueMode === 'fixed' && (
                <>
                  <input style={inputStyle} value={fixedValue} onChange={(e) => setFixedValue(e.target.value)} placeholder="支持 {{变量名}} 引用" list="available-vars" />
                  <datalist id="available-vars">
                    {availableVars.map((v) => (
                      <option key={v} value={`{{${v}}}`} />
                    ))}
                  </datalist>
                </>
              )}
              {valueMode === 'randomString' && (
                <label style={labelStyle}>长度<input style={inputStyle} value={genLength} onChange={(e) => setGenLength(e.target.value)} inputMode="numeric" /></label>
              )}
              {valueMode === 'randomNumber' && (
                <div className="flex gap-2">
                  <label style={{ ...labelStyle, flex: 1 }}>最小<input style={inputStyle} value={genMin} onChange={(e) => setGenMin(e.target.value)} inputMode="numeric" /></label>
                  <label style={{ ...labelStyle, flex: 1 }}>最大<input style={inputStyle} value={genMax} onChange={(e) => setGenMax(e.target.value)} inputMode="numeric" /></label>
                </div>
              )}
              {valueMode === 'prefixTimestamp' && (
                <input style={inputStyle} value={genPrefix} onChange={(e) => setGenPrefix(e.target.value)} placeholder="前缀，如 测试-" />
              )}
            </div>
          )}

          {kind === 'assertText' && (
            <label style={labelStyle}>
              期望文本
              <textarea style={{ ...inputStyle, fontFamily: 'inherit' }} rows={3} value={equalsText} onChange={(e) => setEqualsText(e.target.value)} />
            </label>
          )}
          {kind === 'assertJson' && (
            <label style={labelStyle}>
              期望 JSON（整段深比较）
              <textarea style={{ ...inputStyle, fontFamily: 'monospace' }} rows={6} value={equalsText} onChange={(e) => setEqualsText(e.target.value)} />
            </label>
          )}
          {kind === 'extract' && (
            <label style={labelStyle}>
              变量名
              <input style={inputStyle} value={varName} onChange={(e) => setVarName(e.target.value)} />
            </label>
          )}
          {kind === 'aiStep' && (
            <label style={labelStyle}>
              自然语言指令（保存后自动编译）
              <textarea style={{ ...inputStyle, fontFamily: 'inherit' }} rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
            </label>
          )}
          {kind === 'navigate' && (
            <label style={labelStyle}>
              URL
              <input style={inputStyle} value={url} onChange={(e) => setUrl(e.target.value)} />
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
          {kind === 'upload' && (
            <p style={labelStyle}>文件上传步骤：回放文件绑定将在后续版本支持。</p>
          )}

          {error && <p className="text-[12px]" style={{ color: 'var(--color-destructive)' }}>{error}</p>}

          <div className="flex gap-2 justify-end mt-2">
            <button onClick={onClose} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-secondary)', cursor: 'pointer' }}>
              取消
            </button>
            <button onClick={handleSave} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: 'none', background: 'var(--color-accent)', color: '#fff', cursor: 'pointer' }}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck + lint**

Run: `pnpm --filter @itest/web typecheck && pnpm --filter @itest/web lint`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/StepEditModal.tsx
git commit -m "feat(web): step edit modal — name/delay/value generators/assert values"
```

---

## Task 14: web — CaseDetail 步骤维护集成

**Files:**
- Modify: `apps/web/src/pages/CaseDetail.tsx`

- [ ] **Step 1: 集成修改**（在现有 `CaseDetail.tsx` 基础上做以下修改）

1) import 区追加：

```tsx
import { useStepClipboard, type StepClip } from '../stores/stepClipboard';
import StepEditModal from '../components/StepEditModal';
```

2) 组件内、`sessionRef` 声明之后追加：

```tsx
  const clipboard = useStepClipboard();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<StepClip | null>(null);
  const historyRef = useRef<StepClip[][]>([]);

  const toClip = (s: (typeof caseDetail.steps)[number]): StepClip => ({
    action: s.action,
    source: s.source,
    name: s.name ?? undefined,
    delayMs: s.delayMs ?? undefined,
  });

  const replaceSteps = useMutation({
    mutationFn: (steps: StepClip[]) => api.cases.replaceSteps(id!, steps),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['case', id] }),
    onError: (e: Error) => toast(e.message, 'error'),
  });

  /** 所有步骤变更统一入口：先记撤销快照，再全量替换。 */
  const mutateSteps = (updater: (steps: StepClip[]) => StepClip[]) => {
    if (!caseDetail) return;
    const current = caseDetail.steps.map(toClip);
    historyRef.current.push(current);
    if (historyRef.current.length > 20) historyRef.current.shift();
    replaceSteps.mutate(updater(current));
  };

  const undo = () => {
    const snapshot = historyRef.current.pop();
    if (!snapshot) {
      toast('没有可撤销的操作', 'info');
      return;
    }
    replaceSteps.mutate(snapshot);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

3) 「步骤 (N)」标题行（`<div className="text-[11px] ...">步骤 ({caseDetail.steps.length})</div>` 那个 div）替换为带操作按钮的版本：

```tsx
                <div className="flex items-center gap-2 mb-3">
                  <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>
                    步骤 ({caseDetail.steps.length})
                  </div>
                  <div className="flex-1" />
                  <button
                    onClick={() => {
                      const clips = caseDetail.steps.filter((s) => selected.has(s.id)).map(toClip);
                      if (clips.length === 0) {
                        toast('先勾选要复制的步骤', 'info');
                        return;
                      }
                      clipboard.setSteps(clips);
                      toast(`已复制 ${clips.length} 个步骤`, 'success');
                    }}
                    disabled={selected.size === 0}
                    className="text-[11px] px-2 py-1 rounded-[6px]"
                    style={{ border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-secondary)', cursor: selected.size === 0 ? 'default' : 'pointer', opacity: selected.size === 0 ? 0.4 : 1 }}
                  >
                    复制选中 ({selected.size})
                  </button>
                  <button
                    onClick={() =>
                      mutateSteps((cur) => {
                        const afterIdx =
                          selected.size === 1 ? cur.findIndex((_, i) => caseDetail.steps[i]!.id === [...selected][0]) : cur.length - 1;
                        const at = afterIdx < 0 ? cur.length - 1 : afterIdx;
                        const next = [...cur];
                        next.splice(at + 1, 0, ...clipboard.steps.map((c) => ({ ...c })));
                        return next;
                      })
                    }
                    disabled={clipboard.steps.length === 0}
                    className="text-[11px] px-2 py-1 rounded-[6px]"
                    style={{ border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-secondary)', cursor: clipboard.steps.length === 0 ? 'default' : 'pointer', opacity: clipboard.steps.length === 0 ? 0.4 : 1 }}
                  >
                    粘贴 ({clipboard.steps.length})
                  </button>
                  <button
                    onClick={undo}
                    disabled={historyRef.current.length === 0}
                    className="text-[11px] px-2 py-1 rounded-[6px]"
                    style={{ border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-secondary)', cursor: 'pointer', opacity: historyRef.current.length === 0 ? 0.4 : 1 }}
                  >
                    撤销
                  </button>
                </div>
```

注意：粘贴目标逻辑——恰好选中 1 步时插到该步之后，否则插到末尾。

4) 步骤 `<li>` 内部，source badge 之前加勾选框；操作按钮组（上移/下移/删除）里加「编辑」按钮。li 开头改为：

```tsx
                      <li
                        key={s.id}
                        className="flex items-center gap-3 px-3 py-2 rounded-[8px]"
                        style={{ background: 'var(--color-background-subtle)', border: '1px solid var(--color-glass-border)' }}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(s.id)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(s.id);
                            else next.delete(s.id);
                            setSelected(next);
                          }}
                          style={{ accentColor: 'var(--color-accent)' }}
                        />
```

操作按钮组（`chevronDown` 按钮之后、`删除` 按钮之前）加：

```tsx
                          <button
                            onClick={() => setEditing(toClip(s))}
                            title="编辑"
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', padding: 2 }}
                          >
                            <Icon name="pencil" size={12} />
                          </button>
```

5) `{kind === 'aiStep' && compiled === null}` 的失败标记：在 `<code>` 展示之后、操作按钮组之前加（条件渲染）：

```tsx
                        {(s.action as { kind?: string; compiled?: unknown[] | null }).kind === 'aiStep' &&
                          (s.action as { compiled?: unknown[] | null }).compiled == null && (
                            <button
                              onClick={() => {
                                const instruction = (s.action as { instruction?: string }).instruction ?? '';
                                api.cases
                                  .recompileStep(id!, instruction)
                                  .then((r) => {
                                    if (!r.compiled) {
                                      toast('重新编译失败', 'error');
                                      return;
                                    }
                                    mutateSteps((cur) =>
                                      cur.map((c, i) =>
                                        i === caseDetail.steps.findIndex((x) => x.id === s.id)
                                          ? { ...c, action: { ...(c.action as object), compiled: r.compiled } }
                                          : c,
                                      ),
                                    );
                                    toast('编译成功', 'success');
                                  })
                                  .catch((e: Error) => toast(e.message, 'error'));
                              }}
                              className="text-[10px] px-2 py-0.5 rounded-full shrink-0"
                              style={{ border: '1px solid #b45309', color: '#b45309', background: 'transparent', cursor: 'pointer' }}
                            >
                              AI 编译失败 · 点我重编
                            </button>
                          )}
```

6) 组件 return 的最外层 `</div>` 之前（`recording` tab 内容之后、右栏之后——即最外层 flex 容器结束前）加弹窗渲染：

```tsx
      {editing && (
        <StepEditModal
          initial={editing}
          availableVars={caseDetail.steps
            .map((s) => (s.action as { kind?: string; varName?: string }).kind === 'extract'
              ? (s.action as { varName: string }).varName
              : undefined)
            .filter((v): v is string => !!v)}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            mutateSteps((cur) => cur.map((c, i) => (i === editingIdxRef.current ? next : c)));
            setEditing(null);
          }}
        />
      )}
```

由于 `StepClip` 不含步骤 id，打开编辑时需要锁定索引。将第 4 步的编辑按钮 onClick 改为：

```tsx
                            onClick={() => {
                              editingIdxRef.current = idx;
                              setEditing(toClip(s));
                            }}
```

并在 state 声明区加 `const editingIdxRef = useRef<number>(-1);`。onSave 相应简化为：

```tsx
          onSave={(next) => {
            mutateSteps((cur) => cur.map((c, i) => (i === editingIdxRef.current ? next : c)));
            setEditing(null);
          }}
```

（删除第 6 步初稿里 findIndex 的复杂逻辑，用 editingIdxRef 即可。）

- [ ] **Step 2: typecheck + lint**

Run: `pnpm --filter @itest/web typecheck && pnpm --filter @itest/web lint`
Expected: PASS

- [ ] **Step 3: 手动验证**

`pnpm dev` 起全栈后：编辑步骤名称/等待/生成器值、勾选复制粘贴、Ctrl+Z 撤销、AI 编译失败标记与重编。（无法自动化，记录在 PR。）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/CaseDetail.tsx
git commit -m "feat(web): step maintenance — edit modal, copy/paste, undo, aiStep recompile badge"
```

---

## Task 15: web — ReportDetail warning 展示

**Files:**
- Modify: `apps/web/src/pages/ReportDetail.tsx`

- [ ] **Step 1: 修改**

`StepResult` 接口加 `warning?: string;`（第 9-15 行区域）。

`{s.error && (...)}` 块之后追加：

```tsx
                        {s.warning && (
                          <div className="text-[12px] mt-1" style={{ color: '#b45309' }}>
                            ⚠ {s.warning}
                          </div>
                        )}
```

- [ ] **Step 2: typecheck + lint + 全仓验证**

Run: `pnpm verify`
Expected: 全 PASS（lint + typecheck + test 全仓）

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/ReportDetail.tsx
git commit -m "feat(web): show executor warnings in report detail"
```

---

## Task 16: README 与手动 E2E 验收

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README 更新**

「MVP 范围 → ✅ 已实现」清单里「Chrome 扩展录制（点击 / 输入 / hover…）」一条扩写为：

```markdown
- Chrome 扩展录制（点击 / 输入 / 悬浮 / 复选框 / 原生下拉 / 文件上传步骤 / 文本与 JSON 断言 / AI 自然语言步骤 / 变量保存，stop flush 握手防漏步骤）
```

新增「已知边界」小节（放在「MVP 范围」之后）：

```markdown
## 已知边界（后续版本）

- 组件库下拉（Ant Design / Element / iView Select）：当前录成普通点击序列，组件识别在后续版本增强
- 文件上传步骤：录制只记文件名，回放为空操作并提示，绑定回放文件在后续版本支持
- 密码输入：明文存储与展示，加密存储在后续版本支持
- 多标签页录制、录制模式（追加/从这里开始）：后续版本
```

「核心流程」第 4 条扩写为：

```markdown
4. 用例详情页：「▶ 录制补充」（需 Chrome 扩展）、「AI 补充步骤」、「▶ 执行」；步骤可编辑（名称/等待/随机值）、复制粘贴（跨用例）、撤销、AI 步骤失败重编
```

- [ ] **Step 2: 手动 E2E 验收清单**（逐项执行并在 PR 描述勾选）

1. `pnpm dev` 起全栈；`pnpm --filter @itest/recorder build` 后重新加载扩展
2. 新建用例 → 录制的目标 URL 填 `https://www.w3schools.com/html/tryit.asp?filename=tryhtml_checkbox` 之类含 checkbox/select 的页面（或本地测试页）
3. 录制：点 checkbox、选下拉、输入文本（含 `{{var}}` 暂不测）、暂停后继续、面板添加文本断言 + JSON 断言 + 保存变量 + AI 步骤
4. 停止录制 → 用例详情确认步骤写入；AI 步骤显示编译结果（mock provider 下 compiled 非空）
5. 编辑一步：改随机值生成器 → 执行 → 报告中该步 passed 且值随机
6. 勾选两步复制 → 粘贴到另一用例 → 撤销（Ctrl+Z）→ 恢复
7. 执行用例 → 报告逐步截图正常；上传步骤（如录到）显示黄色 warning

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: phase1 recorder capabilities + known boundaries"
```
