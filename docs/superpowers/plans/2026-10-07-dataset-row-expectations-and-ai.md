# 数据集 v2：行级预期 + AI 助手可用性 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** expectedOutcome 支持 `{{列名}}` 按数据行物化后交 vision 判定；AI 助手能看数据集结构、绑定/解绑、写步骤时拿到变量体检反馈。

**Architecture:** 全部在既有模块内做增量：variable-report 加 initialVars 参数；cdp vision 块做模板替换并把物化文本落 visionAssert；manage_cases 加 list_datasets + get 带 dataset 结构；stage_case_op patch 加 datasetId（校验已在 svc.updateCase 免费获得）+ 步骤 op 响应附带前瞻变量体检。

**Tech Stack:** apps/api（Express 5 + drizzle + zod + vitest）、apps/web（React + react-query，strict TS）。

**Spec:** docs/superpowers/specs/2026-10-07-dataset-row-expectations-and-ai-design.md

**约定：** 直接提交 main；绝不 `git add -A`；提交信息中文 conventional 风格。工作树若有无关改动不得带入提交。

---

### Task 1: buildVariableReport 支持初始变量 + steps 路由按 compiled 扁平化

**Files:**
- Modify: `apps/api/src/lib/variable-report.ts`
- Modify: `apps/api/src/routes/steps.ts`（PUT /:caseId/steps 替换路由 :159-243 与 append 路由 :38 附近）
- Test: `apps/api/test/variable-report.test.ts`（已存在，追加用例）
- Test: `apps/api/test/datasets.test.ts`（追加集成用例）

- [ ] **Step 1: 写失败测试（单元）** — variable-report.test.ts 追加：

```ts
describe('initialVars（数据集列作为初始变量）', () => {
  it('初始变量不报 undefined/forwardRefs', () => {
    const report = buildVariableReport([ex('token'), fillAction('{{username}}'), fillAction('{{token}}')], ['username']);
    expect(report.undefined).toEqual([]);
    expect(report.forwardRefs).toEqual([]);
  });
  it('extract 覆盖同名列不报 duplicates（运行时后写生效，合法）', () => {
    const report = buildVariableReport([ex('username'), fillAction('{{username}}')], ['username']);
    expect(report.duplicates).toEqual([]);
  });
  it('不在初始变量里的引用仍报 undefined', () => {
    const report = buildVariableReport([fillAction('{{nope}}')], ['username']);
    expect(report.undefined).toEqual([{ stepOrder: 0, field: 'fill.value', name: 'nope' }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `cd apps/api && pnpm vitest run test/variable-report.test.ts`，期望新用例 FAIL（签名不识别第二参也行，断言不符即算）。

- [ ] **Step 3: 实现** — variable-report.ts：

签名改 `export function buildVariableReport(steps: StepAction[], initialVars?: string[]): VariableReport`。函数开头（`const definedOrder = new Map...` 之后）：

```ts
  // 初始变量（绑定数据集的列）：视为步骤 0 前已定义（order=-1）。
  // 只消灭 undefined/forwardRefs 误报；不参与 duplicates —— extract 覆盖同名初始变量属合法运行时语义（后写生效），
  // 且 definedOrder 保留 -1：对它的前向引用用初始值，不算 forward。
  for (const name of initialVars ?? []) definedOrder.set(name, -1);
```

extract 注册处（原 :79-84）改为只在「已有定义且是 extract（order>=0）」时记 duplicate：

```ts
    const prev = definedOrder.get(name);
    if (prev !== undefined && prev >= 0) {
      const arr = duplicates.get(name) ?? [prev];
      arr.push(i);
      duplicates.set(name, arr);
    } else if (prev === undefined) {
      definedOrder.set(name, i);
    }
    // prev === -1（初始变量）：保留 -1，不记 duplicate
```

- [ ] **Step 4: 单元测试通过。**

- [ ] **Step 5: 写失败测试（集成）** — datasets.test.ts 追加（沿用该文件既有的 project/case/dataset 构造 helper）：建含列 username(非敏感) 的数据集 → 建用例并 PATCH 绑定 → `PUT /cases/:id/steps` 全量替换，步骤含 `fill {{username}}` 与 `extract token` + 后续 `fill {{token}}` → 断言响应 `variableReport.undefined` 为空数组（v1 下 {{username}} 会被误报）。再断言一条**不在**数据集列里的 `{{ghost}}` 仍出现于 undefined。同时覆盖多动作 compiled：某步 `compiled:[{kind:'waitFor',...},{kind:'assertText', equals:'订单{{orderNo}}', ...}]`（orderNo 未定义）→ 断言 undefined 里有 `assertText.equals` 的 orderNo（v1 只扫 action=compiled[0]，扫不到）。

- [ ] **Step 6: 跑集成测试确认失败。**

- [ ] **Step 7: 实现 steps.ts** — PUT /:caseId/steps（替换路由）：

`exists` 查询后加数据集列装载：

```ts
  let initialVars: string[] | undefined;
  if (exists[0]!.datasetId) {
    const ds = (await db.select({ columns: datasets.columns }).from(datasets)
      .where(eq(datasets.id, exists[0]!.datasetId)).limit(1))[0];
    if (ds) initialVars = ds.columns.map((c) => c.name);
  }
```

替换 :232-236 的体检输入（compiled 是 source of truth，全量扁平化）：

```ts
  // 2026-10-07：体检输入按 compiled 全量扁平化（多动作链里第 2+ 个动作的 {{var}} 也要扫）；
  // 老数据无 compiled 时回退 action（须有 kind 且 locator 非空）。占位（compiled 空数组）自然跳过。
  const actionsForReport = body.steps.flatMap((s): StepAction[] => {
    if (Array.isArray(s.compiled)) {
      return s.compiled.filter((c): c is StepAction => !!((c as { kind?: string }).kind));
    }
    const a = s.action as { kind?: string; locator?: unknown[] } | undefined;
    return a?.kind && (a.locator?.length ?? 0) > 0 ? [a as StepAction] : [];
  });
  const variableReport = buildVariableReport(actionsForReport, initialVars);
```

import 增加 `datasets`（../db/schema.js）。append 路由（POST，:46 附近）：同样按 caseId 查 `datasetId → columns` 传入第二参（append 的 action 扁平化保持现状不动）；注意 append 路由现有 case 存在性/可见性校验方式，按其风格取 case 行。

- [ ] **Step 8: 全部测试通过**（variable-report + datasets + 既有 steps/cases 相关）。

- [ ] **Step 9: Commit** — `fix(api): 变量体检认识数据集列并按 compiled 全量扁平化`

---

### Task 2: expectedOutcome 行级模板（vision 替换 + 报告可见 + web 提示）

**Files:**
- Modify: `apps/api/src/execute/cdp.ts`（:67 类型、:772-817 vision 块）
- Modify: `apps/web/src/pages/ReportDetail.tsx`（visionAssert 展示处）
- Modify: `apps/web/src/pages/CaseDetail.tsx`（:748-750 提示行）
- Maybe: `apps/web/src/api/client.ts`（visionAssert 类型若有定义处加 `expected?: string`）
- Test: `apps/api/test/expected-outcome.test.ts`（新建）

- [ ] **Step 1: 写失败测试** — 新建 test/expected-outcome.test.ts：

```ts
import { describe, it, expect } from 'vitest';
import { materializeExpectedOutcome } from '../src/execute/cdp.js';

describe('materializeExpectedOutcome（行级预期物化）', () => {
  it('替换数据集列变量', () => {
    expect(materializeExpectedOutcome('提交后页面应：{{预期结果}}', { 预期结果: '登录框出现红色提示' }))
      .toBe('提交后页面应：登录框出现红色提示');
  });
  it('替换 extract 变量（未绑数据集同样受益）', () => {
    expect(materializeExpectedOutcome('订单号 {{orderNo}} 已显示', { orderNo: 'A123' })).toBe('订单号 A123 已显示');
  });
  it('未定义变量保留字面量（诚实失败）', () => {
    expect(materializeExpectedOutcome('应显示 {{ghost}}', {})).toBe('应显示 {{ghost}}');
  });
});
```

- [ ] **Step 2: 确认失败**（函数不存在）。

- [ ] **Step 3: 实现 cdp.ts** — substituteVars 已 import（:13）。新增导出（放 vision 块附近）：

```ts
/** 行级预期物化：expectedOutcome 模板按当次运行最终 vars（数据集初始变量 + extract）替换后交 vision 判定。
 *  missing 保留字面量 —— vision 大概率不匹配 → 该行失败且报告可见原因，诚实失败优于静默跳过。 */
export function materializeExpectedOutcome(text: string, vars: Record<string, string>): string {
  return substituteVars(text, vars).value;
}
```

:67 类型改为 `visionAssert?: { passed: boolean; reason: string; screenshot?: string; expected?: string };`

vision 块（:772 起）：进入 `if` 后先物化，judge 与两处 visionAssert 都带 `expected`：

```ts
    const expectedForJudge = materializeExpectedOutcome(ctx.expectedOutcome, vars);
    ...
    const verdict = await judgeCaseOutcome({ expectedOutcome: expectedForJudge, ... });  // 原其余实参不变
    ...
    visionAssert: { passed: false, reason: verdict.reason, screenshot: visionScreenshotPath, expected: expectedForJudge },
    ...
    if (last) last.visionAssert = { passed: true, reason: verdict.reason, screenshot: visionScreenshotPath, expected: expectedForJudge };
```

（确认 `vars` 在 runStepsInContext 作用域可用 —— :134 等 dispatch 处同源。）

- [ ] **Step 4: 单元测试通过。**

- [ ] **Step 5: web** — ReportDetail.tsx 找到 visionAssert 渲染块（grep `visionAssert`），在 reason 展示旁追加（有值才显示）：

```tsx
{va.expected && (
  <div className="text-[11px] font-mono" style={{ color: 'var(--muted-foreground)' }}>
    判定预期（按本行数据物化）：{va.expected}
  </div>
)}
```

CaseDetail.tsx :748-750 第二个 hint span 改为：

```tsx
<span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
  留空则跳过用例级 vision 判定,用例成败只看所有步骤是否全部执行成功。
  {datasetId && '支持 '}
  {datasetId && <code className="font-mono">{'{{列名}}'}</code>}
  {datasetId && ' 引用数据集列（与前置 extract 变量），每行按行值替换后再判定；预期列不要标敏感。'}
</span>
```

- [ ] **Step 6: `cd apps/web && pnpm exec tsc --noEmit` 通过。**

- [ ] **Step 7: Commit** — `feat(api,web): expectedOutcome 支持数据集行级模板并落报告可见`

---

### Task 3: manage_cases list_datasets + get 带数据集结构

**Files:**
- Modify: `apps/api/src/pi/space/tools/cases.ts`
- Test: `apps/api/test/space-tools-cases.test.ts`（沿用既有 manage_cases 测试模式）

- [ ] **Step 1: 写失败测试** — space-tools-cases.test.ts 追加：项目建数据集（含敏感列，经 service 或 HTTP）→ `manage_cases action=list_datasets` 返回含列名/敏感标记/rowCount/enabledRowCount，且**输出 JSON 里不出现任何行值**；`action=get` 用例（已绑定）返回含 `dataset: {name, columns:[{name,sensitive}], enabledRowCount}`，同样无行值。

- [ ] **Step 2: 确认失败**（list_datasets unknown action / get 无 dataset 字段）。

- [ ] **Step 3: 实现** — tools/cases.ts：

Actions zod 联合与 Type.Union 各加 `list_datasets`；description 追加 `| list_datasets(项目数据集结构:列名/敏感标记/行数;敏感值永不出库)`。execute switch 加：

```ts
            case 'list_datasets': {
              const { listDatasets } = await import('../../../services/datasets.service.js');
              const rows = await listDatasets(ctx.projectId);
              return {
                ok: true,
                data: JSON.stringify(rows.map(({ projectId: _pid, updatedAt: _u, ...rest }) => rest), null, 2),
              };
            }
```

`get` 分支返回前 enrich（db/datasets import 按文件现有风格补）：

```ts
              let dataset: { id: string; name: string; columns: Array<{ name: string; sensitive: boolean }>; enabledRowCount: number } | null = null;
              if (detail.datasetId) {
                const ds = (await db.select().from(datasets).where(eq(datasets.id, detail.datasetId)).limit(1))[0];
                if (ds) dataset = { id: ds.id, name: ds.name, columns: ds.columns, enabledRowCount: ds.rows.filter((r) => !r.disabled).length };
              }
              return { ok: true, data: JSON.stringify({ ...detail, dataset }, null, 2) };
```

（先确认 getCaseDetail 返回体已含 datasetId —— HTTP GET /cases/:id 前端已读 caseDetail.datasetId，应已含；若不含则在其 select 里补上并在计划报告注明。）

promptGuidelines 追加一条：

```
'数据集列名即回放初始变量 {{列名}}：看项目数据集结构用 list_datasets（仅结构，敏感值永不可见）；看某用例可用变量用 get 返回的 dataset.columns。行间差异（输入值/断言文本/预期描述）应写成 {{var}}，让每行数据驱动出不同验证。绑定/解绑走 stage_case_op update_case(patch.datasetId)。',
```

- [ ] **Step 4: 测试通过。**

- [ ] **Step 5: Commit** — `feat(api): manage_cases 新增 list_datasets 并在 get 中返回绑定数据集结构`

---

### Task 4: stage_case_op 支持 datasetId + 步骤 op 前瞻变量体检

**Files:**
- Modify: `apps/api/src/pi/space/tools/case-ops-tools.ts`
- Test: `apps/api/test/space-tools-cases.test.ts`（或既有 stage op 测试所在文件，先 grep `applyCaseOp|stage_case_op` in test/）

- [ ] **Step 1: 写失败测试** — 三组：
  1. `stage_case_op update_case patch.datasetId=<本项目数据集>` 暂存成功 → `applyCaseOp` 落库 → 用例 datasetId 已绑定；patch.datasetId=null → 解绑。
  2. 跨项目数据集 id → applyCaseOp 抛 `dataset_project_mismatch`（HttpError 400；校验来自 svc.updateCase :198-202，免费）。
  3. `insert_step`（compiled fill `{{username}}`，用例已绑定含 username 列的数据集）→ 响应 data 含 `变量体检:通过`；compiled fill `{{ghost}}` → data 含 `变量体检:` 且提到 ghost。update_step 同理一条。

- [ ] **Step 2: 确认失败**（datasetId 被 zod 剥掉 / 无体检行）。

- [ ] **Step 3: 实现** — case-ops-tools.ts：

`UpdateCasePatchShape` 加 `datasetId: z.string().uuid().nullable().optional(),`；Type.Object `patch` 加 `datasetId: Type.Optional(Type.Union([Type.String(), Type.Null()]))`。

新增前瞻体检（文件内 helper；buildVariableReport/db/datasets import 补齐）：

```ts
/** 步骤写 op 的前瞻变量体检：按 op 虚拟应用后的全量 compiled 动作计算（含绑定数据集列作为初始变量），
 *  以文本附在暂存响应里给 AI 自校验 —— 写完 {{var}} 立刻知道有没有写错，而不是回放才发现。 */
async function prospectiveVarNote(
  before: Awaited<ReturnType<typeof svc.getCaseDetail>> | null,
  v: Extract<StageCaseOpInput, { action: 'insert_step' | 'update_step' }>,
): Promise<string> {
  if (!before) return '';
  const steps = [...before.steps];
  if (v.action === 'update_step') {
    const i = steps.findIndex((s) => s.id === v.stepId);
    if (i >= 0) steps[i] = { ...steps[i]!, compiled: v.compiled === undefined ? steps[i]!.compiled : v.compiled } as (typeof steps)[number];
  } else {
    const at = v.afterOrder !== undefined ? steps.findIndex((s) => s.order === v.afterOrder) + 1 : steps.length;
    const maxOrder = steps.reduce((m, s) => Math.max(m, s.order), 0);
    steps.splice(at, 0, { id: 'staged', order: maxOrder + 1, instruction: v.instruction, compiled: v.compiled ?? [] } as unknown as (typeof steps)[number]);
  }
  const actions = steps.flatMap((s): StepAction[] => {
    const c = s.compiled as unknown[] | null | undefined;
    return Array.isArray(c) ? c.filter((a): a is StepAction => !!((a as { kind?: string }).kind)) : [];
  });
  let initialVars: string[] | undefined;
  const dsId = (before as { datasetId?: string | null }).datasetId;
  if (dsId) {
    const ds = (await db.select({ columns: datasets.columns }).from(datasets).where(eq(datasets.id, dsId)).limit(1))[0];
    if (ds) initialVars = ds.columns.map((c) => c.name);
  }
  const report = buildVariableReport(actions, initialVars);
  const notes = [
    ...report.undefined.map((x) => `引用未定义变量 {{${x.name}}}(${x.field})`),
    ...report.forwardRefs.map((x) => `前向引用 {{${x.name}}}`),
    ...report.invalidNames.map((x) => `变量名 ${x.name} 不合法`),
  ];
  return notes.length > 0 ? `变量体检:${notes.join(';')}` : '变量体检:通过';
}
```

execute 里 insert_step/update_step 暂存成功后的返回改为：

```ts
        const varNote = await prospectiveVarNote(before, v).catch(() => '');
        return { ok: true, data: `已暂存修改「${summary}」(草稿 ${doc.localId})；用户在 StagePanel 勾选 → 落库。${varNote ? `\n${varNote}` : ''}` };
```

（仅这两个 action；其余分支返回原样。update_case 的 datasetId 落库链路：applyCaseOp → svc.updateCase，校验免费，无代码改动。）

STAGE_CASE_OP_GUIDELINES 追加：

```
'用例绑定/解绑数据集走 update_case(patch.datasetId)（跨项目数据集会被拒绝）；数据集列名即回放初始变量 {{列名}}，insert_step/update_step 响应会附「变量体检」反馈，引用未定义变量时请修正 compiled 或先确认数据集列名（manage_cases list_datasets / get）。',
```

- [ ] **Step 4: 测试通过。**

- [ ] **Step 5: Commit** — `feat(api): stage_case_op 支持绑定数据集并给步骤写操作附带变量体检反馈`

---

### Task 5: 回归 + 浏览器抽查

- [ ] **Step 1:** `cd apps/api && pnpm vitest run`（预存失败仅限 workflow.test.ts / envContext.test.ts / recorder-route.test.ts；其余全绿）。
- [ ] **Step 2:** `cd apps/web && pnpm exec tsc --noEmit`。
- [ ] **Step 3:** 浏览器（dev 已在 5173/54321 运行）：用例绑定数据集后「用例预期」下方出现 `{{列名}}` 提示；AI 助手页发起一条含「列出本项目数据集」的对话验证 list_datasets 真实可用（若 LLM 不可用则以测试覆盖为准并注明）。
- [ ] **Step 4:** 必要修复与最终提交。
