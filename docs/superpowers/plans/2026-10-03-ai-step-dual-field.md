# AI Step Dual-Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI-generated case steps carry both natural-language instruction AND compiled DSL side-by-side, with a per-step assertion field. Zero schema migration; AI produces both during staging; save path short-circuits already-compiled steps.

**Architecture:** Extend `StagedStep` shape in workspace.ts with optional `compiled: StepAction[] | null`. Update `upsert_case` tool to accept `compiled`. Update `compileAiStepsInPlace` to short-circuit steps that already have a `compiled` field (including null). Add optional `assertion` field to `aiStep` shape in shared step-dsl. Render compiled list and assertion editor in the right workspace panel and StepEditDrawer.

**Tech Stack:** TypeScript / Express / Drizzle / Zod / Pi agent / React / Vitest

---

## File Structure

**Modify:**
- `packages/shared/src/step-dsl.ts` — add `assertion?: string | null` to aiStep union
- `apps/api/src/lib/step-migration.ts` — add `assertion: undefined` backfill for aiStep
- `apps/api/src/pi/workspace.ts` — add `compiled: StepAction[] | null` to `StagedStep`
- `apps/api/src/pi/tools.ts` — `upsert_case` schema accepts `compiled`; pass through to `StagedStep`
- `apps/api/src/agent/aiStepCompile.ts` — short-circuit `'compiled' in a`; append "末尾 assertText" guidance to SYSTEM/BATCH prompts
- `apps/web/src/features/ai-workspace/WorkspacePanel.tsx` — render `compiled` list per step
- `apps/web/src/components/StepEditDrawer.tsx` — add optional assertion textarea for aiStep

**Test:**
- `packages/shared/test/step-dsl.test.ts` — accept aiStep with assertion; backward compat
- `apps/api/test/step-migration.test.ts` — aiStep gets `assertion: undefined` after migration
- `apps/api/test/aiStepCompile.test.ts` — short-circuit when compiled already present; `null` also short-circuits
- `apps/api/test/ai-workspace-save.test.ts` — pre-compiled staged steps do not invoke LLM during save

---

### Task 1: Add `assertion` field to shared aiStep shape

**Files:**
- Modify: `packages/shared/src/step-dsl.ts:190-194`
- Test: `packages/shared/test/step-dsl.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/test/step-dsl.test.ts` (just after the "aiStep nested" test, around line 145):

```ts
it('accepts aiStep with optional assertion string', () => {
  const r = StepAction.safeParse({
    kind: 'aiStep',
    instruction: '提交订单',
    compiled: null,
    assertion: '页面显示订单提交成功',
  });
  expect(r.success).toBe(true);
});

it('accepts aiStep with assertion = null', () => {
  const r = StepAction.safeParse({
    kind: 'aiStep',
    instruction: '提交订单',
    compiled: null,
    assertion: null,
  });
  expect(r.success).toBe(true);
});

it('accepts aiStep without assertion field (backward compat)', () => {
  const r = StepAction.safeParse({
    kind: 'aiStep',
    instruction: '提交订单',
    compiled: null,
  });
  expect(r.success).toBe(true);
});

it('rejects aiStep with non-string assertion', () => {
  const r = StepAction.safeParse({
    kind: 'aiStep',
    instruction: '提交订单',
    compiled: null,
    assertion: 123,
  });
  expect(r.success).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @itest/shared test -- step-dsl`
Expected: 4 failures (compile error or zod rejection).

- [ ] **Step 3: Modify the schema**

In `packages/shared/src/step-dsl.ts`, replace the aiStep object literal (lines 190-194):

```ts
  z.object({
    kind: z.literal('aiStep'),
    instruction: z.string().max(2000),
    compiled: z.array(z.lazy(() => StepAction)).nullable(),
    /** 可选断言描述；保存到 test_steps.assertion（assertText 形态）。可空。 */
    assertion: z.string().max(2000).nullable().optional(),
  }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @itest/shared test -- step-dsl`
Expected: all 4 new tests pass; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/step-dsl.ts packages/shared/test/step-dsl.test.ts
git commit -m "feat(shared): aiStep accepts optional assertion field"
```

---

### Task 2: migrateAction backfills `assertion: undefined` for aiStep

**Files:**
- Modify: `apps/api/src/lib/step-migration.ts:23-32`
- Test: `apps/api/test/step-migration.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/step-migration.test.ts`:

```ts
describe('migrateAction — aiStep assertion field', () => {
  it('adds assertion=undefined to legacy aiStep without assertion', () => {
    const legacy = { kind: 'aiStep', instruction: '提交订单', compiled: null };
    const out = migrateAction(legacy) as { assertion?: unknown };
    expect(out.assertion).toBeUndefined();
  });

  it('does not overwrite existing assertion', () => {
    const cur = { kind: 'aiStep', instruction: 'x', compiled: null, assertion: '页面显示成功' };
    const out = migrateAction(cur) as { assertion?: string };
    expect(out.assertion).toBe('页面显示成功');
  });

  it('does not touch non-aiStep kinds', () => {
    const click = { kind: 'click', locator: [{ strategy: 'css', value: '#btn' }] };
    const out = migrateAction(click) as { assertion?: unknown };
    expect('assertion' in out).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @itest/api test -- step-migration`
Expected: 3 failures.

- [ ] **Step 3: Modify migrateAction**

In `apps/api/src/lib/step-migration.ts`, after the `locatorKinds` block (around line 28), before the `// 其余 kind` comment, add:

```ts
  if (kind === 'aiStep') {
    if (!('assertion' in action)) action.assertion = undefined;
    return action;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @itest/api test -- step-migration`
Expected: 3 new tests pass; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/step-migration.ts apps/api/test/step-migration.test.ts
git commit -m "feat(api): migrateAction backfills aiStep assertion field"
```

---

### Task 3: Extend `StagedStep` with `compiled` field

**Files:**
- Modify: `apps/api/src/pi/workspace.ts:7-9`

- [ ] **Step 1: Write the failing test**

Append a new test file `apps/api/test/workspace-staged.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { StagedStep } from '../src/pi/workspace.js';

describe('StagedStep shape', () => {
  it('accepts compiled = StepAction[] | null in addition to action', () => {
    const step: StagedStep = {
      name: 'step1',
      action: '点击提交',
      assertion: null,
      compiled: [{ kind: 'click', locator: [{ strategy: 'text', value: '提交' }] }],
    };
    expect(step.compiled).toHaveLength(1);
  });

  it('compiled is optional in shape (backward compat with old staged data)', () => {
    const oldShape: Partial<StagedStep> = {
      name: 'step1',
      action: '点击提交',
      assertion: null,
    };
    expect(oldShape.compiled).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @itest/api test -- workspace-staged`
Expected: compile error because `compiled` is not in `StagedStep`.

- [ ] **Step 3: Extend StagedStep type**

In `apps/api/src/pi/workspace.ts`, replace the `StagedStep` type:

```ts
export type StagedStep = {
  name: string;
  action: string;
  assertion: string | null;
  /** LLM 编译出的 DSL 步骤；null = 未生成或失败，回放时 AI 即时编译。缺省视作 null（向后兼容）。 */
  compiled?: import('@itest/shared').StepAction[] | null;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @itest/api test -- workspace-staged`
Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/workspace.ts apps/api/test/workspace-staged.test.ts
git commit -m "feat(pi): StagedStep accepts optional compiled field"
```

---

### Task 4: `upsert_case` tool accepts `compiled` parameter

**Files:**
- Modify: `apps/api/src/pi/tools.ts` (the `upsert_case` tool definition + executor)
- Test: extend `apps/api/test/ai-workspace-save.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/ai-workspace-save.test.ts` (the `upsertCase` is the public API used by the tool executor — test the underlying behavior end-to-end):

```ts
it('upsertCase persists compiled field into staged step', async () => {
  const ws = await import('../src/pi/workspace.js');
  const { projectId } = await seedProject(pool);
  const r = await pool.query(
    `INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`,
    [projectId],
  );
  const rid = r.rows[0]!.id as string;
  await ws.upsertCase(rid, null, {
    id: 'c1',
    title: 'T',
    description: null,
    priority: 'P0',
    steps: [
      {
        name: 's1',
        action: '点击提交',
        assertion: null,
        compiled: [{ kind: 'click', locator: [{ strategy: 'text', value: '提交' }] }],
      },
    ],
  });
  const doc = await ws.loadDoc(rid);
  expect(doc.looseCases[0]!.steps[0]!.compiled).toEqual([
    { kind: 'click', locator: [{ strategy: 'text', value: '提交' }] },
  ]);
});

it('upsertCase defaults missing compiled to null', async () => {
  const ws = await import('../src/pi/workspace.js');
  const { projectId } = await seedProject(pool);
  const r = await pool.query(
    `INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`,
    [projectId],
  );
  const rid = r.rows[0]!.id as string;
  await ws.upsertCase(rid, null, {
    id: 'c1',
    title: 'T',
    description: null,
    priority: 'P0',
    steps: [{ name: 's1', action: '点击提交', assertion: null }],
  });
  const doc = await ws.loadDoc(rid);
  expect(doc.looseCases[0]!.steps[0]!.compiled).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @itest/api test -- ai-workspace-save -t 'upsertCase persists compiled field'`
Expected: failure because the executor drops `compiled` and loadDoc normalizes missing field to null.

- [ ] **Step 3: Update `upsert_case` schema + executor**

In `apps/api/src/pi/tools.ts`, find the `upsert_case` tool. Update the `steps` element schema:

```ts
steps: Type.Array(Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  action: Type.String({ minLength: 1, maxLength: 2000 }),
  assertion: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** LLM 编译出的 DSL 步骤；缺省或 null 表示未生成。 */
  compiled: Type.Optional(Type.Array(Type.Unknown())),
})),
```

Update the `execute` function: in the `steps` mapping, add `compiled: s.compiled ?? null`:

```ts
const steps = v.steps.map((s) => {
  const name = (s.name && s.name.trim().length > 0)
    ? s.name
    : (s.action.split(/[，。！？,.!?\n]/, 1)[0]?.trim() ?? s.action.slice(0, 24)).slice(0, 200);
  return {
    name,
    action: s.action,
    assertion: s.assertion ?? null,
    compiled: s.compiled ?? null,
  };
});
```

- [ ] **Step 4: Update `loadDoc` to normalize missing `compiled`**

In `apps/api/src/pi/workspace.ts`, find the loop that builds `StagedCase` (around lines 65-80). Update the `c` object:

```ts
const c: StagedCase = {
  id: row.id,
  title: row.title,
  description: row.description,
  priority: row.priority as Priority,
  steps: (row.steps as unknown as StagedStep[]).map((s) => ({
    name: s.name,
    action: s.action,
    assertion: s.assertion ?? null,
    compiled: s.compiled ?? null,
  })),
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @itest/api test -- ai-workspace-save`
Expected: both new tests pass; all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pi/workspace.ts apps/api/src/pi/tools.ts apps/api/test/ai-workspace-save.test.ts
git commit -m "feat(pi): upsert_case tool accepts compiled field"
```

---

### Task 5: `compileAiStepsInPlace` short-circuits pre-compiled steps

**Files:**
- Modify: `apps/api/src/agent/aiStepCompile.ts:247-280` (the loop in `compileAiStepsInPlace`)
- Test: `apps/api/test/aiStepCompile.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/aiStepCompile.test.ts`:

```ts
describe('compileAiStepsInPlace — short-circuit pre-compiled', () => {
  it('does not call LLM for steps that already have compiled array', async () => {
    let calls = 0;
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => {
        calls++;
        return { kind: 'json', value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] }, provider: 'openai', vision: false };
      },
    };
    const pre = [{ kind: 'click', locator: [{ strategy: 'text', value: 'A' }] }];
    const steps = [
      { action: { kind: 'aiStep', instruction: '点击 A', compiled: pre } },
      { action: { kind: 'aiStep', instruction: '点击 B', compiled: pre } },
    ];
    const failed = await compileAiStepsInPlace(steps, client);
    expect(failed).toEqual([]);
    expect(calls).toBe(0);
    expect((steps[0]!.action as { compiled: unknown }).compiled).toBe(pre);
    expect((steps[1]!.action as { compiled: unknown }).compiled).toBe(pre);
  });

  it('does not call LLM for steps with compiled=null (AI tried, gave up)', async () => {
    let calls = 0;
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => {
        calls++;
        return { kind: 'json', value: { steps: [] }, provider: 'openai', vision: false };
      },
    };
    const steps = [
      { action: { kind: 'aiStep', instruction: '任意指令', compiled: null } },
    ];
    const failed = await compileAiStepsInPlace(steps, client);
    expect(failed).toEqual([0]);
    expect(calls).toBe(0);
    expect((steps[0]!.action as { compiled: unknown }).compiled).toBeNull();
  });

  it('mixed batch: pre-compiled skipped, un-compiled invoked', async () => {
    let calls = 0;
    const client: LLMClient = {
      provider: 'openai',
      complete: async () => {
        calls++;
        return { kind: 'json', value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] }, provider: 'openai', vision: false };
      },
    };
    const pre = [{ kind: 'click', locator: [{ strategy: 'text', value: 'A' }] }];
    const steps = [
      { action: { kind: 'aiStep', instruction: '点击 A', compiled: pre } },
      { action: { kind: 'aiStep', instruction: '点击 B', /* no compiled */ } },
    ];
    await compileAiStepsInPlace(steps, client);
    expect(calls).toBe(1);
    expect((steps[0]!.action as { compiled: unknown }).compiled).toBe(pre);
    expect((steps[1]!.action as { compiled: unknown }).compiled).toEqual([
      { kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @itest/api test -- aiStepCompile -t 'short-circuit'`
Expected: 3 failures (LLM gets called for pre-compiled steps).

- [ ] **Step 3: Modify `compileAiStepsInPlace` loop**

In `apps/api/src/agent/aiStepCompile.ts`, inside `compileAiStepsInPlace` (around line 247), the loop opens with:

```ts
for (let i = 0; i < steps.length; i++) {
  const step = steps[i]!;
  const a = step.action as { kind?: string; instruction?: string; compiled?: unknown };
  if (a?.kind !== 'aiStep') continue;
```

Change it to:

```ts
for (let i = 0; i < steps.length; i++) {
  const step = steps[i]!;
  const a = step.action as { kind?: string; instruction?: string; compiled?: unknown };
  if (a?.kind !== 'aiStep') continue;
  // 短路：已有 compiled（含 null）→ 跳过 LLM。
  // null 等同"AI 已尝试并失败/放弃"，保存阶段不应再编，避免无谓重试。
  if ('compiled' in a) continue;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @itest/api test -- aiStepCompile`
Expected: all 3 new tests pass; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/aiStepCompile.ts apps/api/test/aiStepCompile.test.ts
git commit -m "feat(api): compileAiStepsInPlace short-circuits pre-compiled steps"
```

---

### Task 6: Add "末尾 assertText" guidance to LLM prompts

**Files:**
- Modify: `apps/api/src/agent/aiStepCompile.ts` (`SYSTEM_PROMPT` and `BATCH_SYSTEM_PROMPT`)

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/aiStepCompile.test.ts`:

```ts
describe('compileAiStep — prompt includes 末尾 assertText guidance', () => {
  it('user message contains trailing-assertText hint', async () => {
    let captured = '';
    const client: LLMClient = {
      provider: 'openai',
      complete: async (req) => {
        captured = req.userMessage;
        return { kind: 'json', value: { steps: [{ kind: 'click', locator: [{ strategy: 'text', value: 'X' }] }] }, provider: 'openai', vision: false };
      },
    };
    await compileAiStep('点击提交', {}, client);
    expect(captured).toMatch(/末尾.*assertText|断言|assertText/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @itest/api test -- aiStepCompile -t 'trailing-assertText'`
Expected: failure — current prompt doesn't contain that hint.

- [ ] **Step 3: Append prompt guidance**

In `apps/api/src/agent/aiStepCompile.ts`, append to `SYSTEM_PROMPT` (just before the closing backtick, after `不要输出 aiStep kind。`):

```ts

末尾 assertText 引导：如果该 step 跑完后页面应该有可观察结果（例如填表后的成功提示、点击后的列表项出现），
请在 compiled 末尾补一条 assertText：{locator:[{strategy:'text', value:'<片段>'}],
target:'specifiedElement', match:'contains', equals:'<片段>'}。
不要为 navigate 步骤本身补 assertText（navigate 后的状态由下一条 step 断言）。`
```

Do the same for `BATCH_SYSTEM_PROMPT` (it includes `SYSTEM_PROMPT` already via interpolation, so the new guidance flows in automatically — no change needed).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @itest/api test -- aiStepCompile`
Expected: new test passes; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agent/aiStepCompile.ts apps/api/test/aiStepCompile.test.ts
git commit -m "feat(api): LLM prompt guides trailing assertText in compiled"
```

---

### Task 7: Save path does not invoke LLM for pre-compiled staged steps

**Files:**
- Modify: (covered by Tasks 4-5)
- Test: extend `apps/api/test/ai-workspace-save.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/ai-workspace-save.test.ts`:

```ts
it('save does NOT invoke LLM when staged step already has compiled array', async () => {
  const llmMod = await import('../src/agent/llmSettings.js');
  let calls = 0;
  const mockClient = {
    provider: 'openai' as const,
    complete: async () => {
      calls++;
      return { kind: 'json' as const, value: { steps: [{ kind: 'waitFor', locator: [{ strategy: 'role', value: 'main' }] }] }, provider: 'openai' as const, vision: false };
    },
  };
  llmMod.__setLlmClientForTest({ config: { provider: 'openai', apiKey: 'k', model: 'm' }, client: mockClient });
  try {
    const ws = await import('../src/pi/workspace.js');
    const { projectId, groupId } = await seedProject(pool);
    const r = await pool.query(
      `INSERT INTO requirements(title, content, project_id) VALUES ('r','c',$1) RETURNING id`,
      [projectId],
    );
    const rid = r.rows[0]!.id as string;
    await ws.upsertScenario(rid, {
      id: 's1', title: 'S', description: null, cases: [
        {
          id: 'c1', title: 'C1', description: 'd', priority: 'P0',
          steps: [
            {
              name: 's1',
              action: '点击提交',
              assertion: null,
              compiled: [{ kind: 'click', locator: [{ strategy: 'text', value: '提交' }] }],
            },
          ],
        },
      ],
    });
    const saved = await request(app)
      .post(`/api/requirements/${rid}/ai-workspace/save`)
      .send({ groupId, scenarioIds: ['s1'], caseIds: ['c1'] });
    expect(saved.status).toBe(200);
    expect(calls).toBe(0); // 短路生效，未调 LLM
    const steps = await pool.query(
      `SELECT action FROM test_steps WHERE case_id = (SELECT id FROM test_cases WHERE requirement_id = $1 LIMIT 1)`,
      [rid],
    );
    const a = steps.rows[0]!.action as { kind: string; compiled: unknown };
    expect(a.kind).toBe('aiStep');
    expect(a.compiled).toEqual([{ kind: 'click', locator: [{ strategy: 'text', value: '提交' }] }]);
  } finally {
    llmMod.__setLlmClientForTest(null);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @itest/api test -- ai-workspace-save -t 'save does NOT invoke LLM'`
Expected: failure — `calls > 0`.

- [ ] **Step 3: No code change required**

The save path already calls `compileAiStepsInPlace`. Task 5 already added the short-circuit; this test only verifies the integrated behavior.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @itest/api test -- ai-workspace-save`
Expected: new test passes (because of Task 5 short-circuit).

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/ai-workspace-save.test.ts
git commit -m "test(api): save path skips LLM when staged step already compiled"
```

---

### Task 8: WorkspacePanel renders compiled list per step

**Files:**
- Modify: `apps/web/src/features/ai-workspace/WorkspacePanel.tsx:99-106`
- Test: (manual via browser; web has no unit test for WorkspacePanel — verify by mock LLM run)

- [ ] **Step 1: Update imports**

At top of `apps/web/src/features/ai-workspace/WorkspacePanel.tsx`, add:

```ts
import { stepKindLabel, stepSummary } from '../../lib/format';
```

(If `stepKindLabel` / `stepSummary` are exported from a different module in this codebase, verify with: `grep -rn 'export.*stepKindLabel\|export.*stepSummary' apps/web/src/lib` — typically `apps/web/src/lib/stepSummary.ts` and `apps/web/src/lib/format.ts`.)

- [ ] **Step 2: Replace step rendering block**

Replace the `<ol>` block at `WorkspacePanel.tsx:98-107`:

```tsx
              <ol className="mt-1 ml-4 list-decimal">
                {s.steps.map((s, i) => (
                  <li key={i} className="mb-0.5">
                    <span>{s.action}</span>
                    {s.assertion && (
                      <span style={{ color: 'var(--color-foreground-muted)' }}> —— 断言：{s.assertion}</span>
                    )}
                  </li>
                ))}
              </ol>
```

with:

```tsx
              <ol className="mt-1 ml-4 list-decimal">
                {s.steps.map((step, i) => (
                  <li key={i} className="mb-1">
                    <div>{step.action}</div>
                    {step.assertion && (
                      <div className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                        断言：{step.assertion}
                      </div>
                    )}
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
                      编译：
                      {step.compiled == null ? (
                        <span style={{ color: 'var(--color-warning-text, #92400e)' }}>未编译，保存时由后端补编译</span>
                      ) : (
                        <ol className="ml-4 list-decimal">
                          {step.compiled.map((sub, j) => (
                            <li key={j}>
                              <span style={{ color: 'var(--color-accent)' }}>{stepKindLabel(sub.kind)}</span>{' '}
                              {stepSummary(sub)}
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @itest/web typecheck`
Expected: 0 errors. (If the types of `s.compiled` are not visible, ensure `StagedStep` is imported from the correct shared location — the web app should already have this type flowing from the API.)

- [ ] **Step 4: Manual smoke test**

1. Start dev server: `pnpm dev`
2. Open AI workspace for a requirement
3. With mock LLM, generate a case whose steps include `compiled` (use inspect_page tool to seed compiled)
4. Verify right panel shows instruction + per-step compiled sub-step list

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/ai-workspace/WorkspacePanel.tsx
git commit -m "feat(web): WorkspacePanel renders compiled DSL per staged step"
```

---

### Task 9: StepEditDrawer adds optional assertion textarea for aiStep

**Files:**
- Modify: `apps/web/src/components/StepEditDrawer.tsx:529-565`

- [ ] **Step 1: Add state for assertion**

In `apps/web/src/components/StepEditDrawer.tsx`, find the aiStep state block around line 160:

```ts
  // aiStep / navigate / waitFor / check / switchTab / screenshot
  const [instruction, setInstruction] = useState(String(action.instruction ?? ''));
```

Insert after:

```ts
  const [assertion, setAssertion] = useState(String(action.assertion ?? ''));
```

- [ ] **Step 2: Wire assertion into buildAction**

In `buildAction` (around line 230), replace the `if (kind === 'aiStep')` block:

```ts
    if (kind === 'aiStep') {
      next.instruction = instruction.trim();
      next.compiled = action.compiled ?? null;
      const a = assertion.trim();
      if (a) next.assertion = a;
      else delete next.assertion;
    }
```

- [ ] **Step 3: Add the textarea UI**

In the aiStep JSX block (around line 529-565), add after the `<FieldError>` line for instruction:

```tsx
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
              <span>断言（可空，描述该 step 跑完后页面应显示什么）</span>
              <textarea
                className="input-base input-xs"
                rows={2}
                value={assertion}
                onChange={(e) => setAssertion(e.target.value)}
                placeholder="例: 页面显示订单提交成功"
              />
            </label>
```

- [ ] **Step 4: Type-check**

Run: `pnpm --filter @itest/web typecheck`
Expected: 0 errors.

- [ ] **Step 5: Manual smoke test**

1. Open any case in CaseDetail
2. Edit a step whose kind is aiStep
3. Verify a second textarea "断言（可空…）" is visible
4. Fill in "页面显示成功" and save
5. Verify `test_steps.assertion` is set in DB: `SELECT assertion FROM test_steps WHERE id = ...`

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/StepEditDrawer.tsx
git commit -m "feat(web): StepEditDrawer adds optional assertion textarea for aiStep"
```

---

### Task 10: Final regression and lint

**Files:** none

- [ ] **Step 1: Run all api tests**

Run: `pnpm --filter @itest/api test`
Expected: all pass except the known pre-existing plans.test failure (not in scope of this work).

- [ ] **Step 2: Run shared tests**

Run: `pnpm --filter @itest/shared test`
Expected: all pass.

- [ ] **Step 3: Lint web**

Run: `pnpm --filter @itest/web lint`
Expected: 0 errors.

- [ ] **Step 4: Build check**

Run: `pnpm --filter @itest/web build` (or `typecheck` if build is heavy)
Expected: 0 errors.

- [ ] **Step 5: Final commit if any cleanup**

```bash
git status
# If there are unrelated changes, revert them; only commit if there is something to add.
```

---

## Self-Review

**Spec coverage:**
- 暂存 step 升级为 `{name, action, assertion?, compiled?}` → Task 3, Task 4
- AI 工作台 `upsert_case` 工具接受 `compiled` → Task 4
- `compileAiStepsInPlace` 短路 → Task 5
- StepEditDrawer 单步 assertion 编辑 → Task 9
- `packages/shared` aiStep 加可选 `assertion` → Task 1
- 工作台右栏展示 compiled → Task 8
- LLM prompt 引导末尾 assertText → Task 6
- 保存到 DB 路径零 LLM 调用（短路生效）→ Task 7

**Placeholder scan:** No TBD / TODO / "implement later" — every code block is filled.

**Type consistency:**
- `StagedStep.compiled` is `StepAction[] | null | undefined` (Task 3) — loadDoc normalizes to `StepAction[] | null` (Task 4 step 4) — matches `StepAction.compiled: StepAction[] | null` shape in shared (Task 1).
- `upsert_case` executor maps `s.compiled ?? null` into the same field on `StagedStep` (Task 4 step 3).
- `compileAiStepsInPlace` checks `'compiled' in a` (Task 5) — works for both `null` and array values, and the schema's optional default is `undefined` which does NOT have the key — so undefined steps still go to LLM. Verified against all 3 new short-circuit tests.
- `StepEditDrawer` reads `action.assertion ?? ''` for backward compat (Task 9 step 1).
