# 步骤变量系统对齐 CueCast 数据变量指南

日期：2026-10-01
状态：待用户审阅
上游参考：用户提供的 CueCast 数据变量指南（本地 HTML 全文）；既有相关 spec：
- `docs/superpowers/specs/2026-10-01-step-settings-phase3-design.md`（fill/assertText 字段已定型，本期不破坏）
- `docs/superpowers/specs/2026-10-01-file-upload-steps-design.md`（`upload` 步骤的 fileId 校验沿用）

## 背景与目标

iTest 当前 `extract` 步骤能产出变量，但下游步骤既不支持 `{{varName}}` 引用，也不感知变量存在；只有 `fill.value` 在 `materializeValue` 里走了一次替换。这与 CueCast 数据变量指南描述的"页面值→变量→后续步骤引用→回放解析"主流程差距明显。

本期把变量系统对齐到 CueCast 文档描述的最小完整子集：

- DSL 层面：`{{varName}}` 在所有字符串字段都可引用；`extract` 步骤支持完整值 / 智能抽取 / 正则匹配三种模式。
- 校验层面：变量名格式、重复定义、先引用后定义、未定义引用四种错误都在 PUT/POST 时一次性扫描并返回 `variableReport`。
- 执行层面：所有可引用字符串在 dispatch 时统一调用 `substituteVars`；错误信息含"模板原值"。

### YAGNI 范围

**做**：

- `extract` 步骤新增 `mode: 'completeValue' | 'smartExtract' | 'regex'`、`pattern`、`group`、`description`（仅 smartExtract）。
- `fill.value` / `select.value` / `assertText.equals` / `assertJson.equals`（序列化后）/ `navigate.url` / `screenshot.name` / `aiStep.instruction` 的字符串内容统一走 `substituteVars`。
- 变量名格式 `^[A-Za-z_][A-Za-z0-9_]*$`，长度 1–64；`packages/shared` 提供 `validateVariableName`。
- 正则模式安全校验 `safeRegex(pattern)`：编译超 50ms 或匹配 `(a+)+` 类直接 422。
- 服务端 PUT/POST 时扫一遍步骤，返回 `variableReport: { undefined[], duplicates[], forwardRefs[] }`；UI 在 CaseDetail 顶部展示 warning banner。
- `extract` 步骤的 `mode` 字段老数据做懒迁移：无 `mode` 即视为 `completeValue`。

**不做**：

- locator 串（css / xpath / role text）中的变量展开。CueCast 文档明确"变量不适合替代元素定位"，本期不破例。
- 独立 `/cases/:id/preflight` 接口；与 phase 3 一致，把校验挂在已有 PUT/POST 上。
- extract 智能抽取的运行时 LLM 调用。仅在保存时一次编译生成 regex，存到 `pattern`；回放阶段只走 regex 模式。
- 跨用例、跨 project 变量池。仅同用例内顺序变量。
- `assertJson` 期望值字段改成"对象"形态——本期保持 `unknown` 序列化后再 substituteVars，避免破坏 phase 3 决策表。
- DB schema 变更。extract 新字段走 step-migration（懒迁移）。

### 设计决策（已与用户确认）

| 议题 | 决策 |
|---|---|
| 覆盖范围 | 完整对齐 CueCast 变量模型 |
| 抽取方式 | 完整值 / 智能抽取 / 正则三种都加 |
| 定位串引用 | 不展开 |
| 预检接口 | 仅 PUT 校验返回 `variableReport`，不新增独立路由 |
| 智能抽取实现 | 保存时一次 LLM 编译生成 regex；回放阶段按 regex 模式运行 |
| aiStep instruction | 也做 `{{var}}` 替换（运行时按编译后 `compiled[]` 路径不影响） |
| 老 extract 步骤 | 懒迁移，无 `mode` → `completeValue` |

## 架构

```
┌────────────────────────────────────────────────────────────────┐
│                       packages/shared                          │
│  variable.ts (新)                                              │
│   - VAR_NAME_RE / validateVariableName                        │
│   - VAR_RE  / collectVarRefs(text)                             │
│   - substituteVars(text, vars)        (从 value-utils 搬过来) │
│   - safeRegex(pattern) -> { ok, reason? }                      │
│  step-dsl.ts (改)                                              │
│   - ExtractAction 加 mode/pattern/group/description 字段      │
│   - .refine(...) 调用 safeRegex / validateVariableName         │
│  value-utils.ts (改)                                           │
│   - materializeValue 委托 variable.substituteVars              │
└────────────────────────────────┬───────────────────────────────┘
                                 │
┌────────────────────────────────▼───────────────────────────────┐
│                          apps/api                              │
│  lib/variable-report.ts (新)                                   │
│   - buildVariableReport(steps) -> { undefined, duplicates,    │
│                                      forwardRefs, regexIssues }│
│  routes/steps.ts (改)                                          │
│   - POST/PUT 增加 variableReport 字段                         │
│   - extract 步骤懒迁移 (mode default completeValue)            │
│  execute/cdp.ts (改)                                           │
│   - dispatch 入口加 ctx.vars；各 case 统一走 substituteVars    │
│   - extract: 按 mode 分派完整值 / regex                        │
│   - 错误信息含 {{var}} 模板与替换前/后值                       │
└────────────────────────────────┬───────────────────────────────┘
                                 │
┌────────────────────────────────▼───────────────────────────────┐
│                          apps/web                              │
│  StepEditModal.tsx (改)                                        │
│   - extract mode 切换 UI: completeValue / smartExtract / regex │
│   - regex 输入 + group + 实时测试按钮（纯前端 validate）       │
│   - smartExtract 多行 description + "生成正则"按钮（提交时   │
│     POST /cases/:id/steps/recompile 风格新增一条 /extract/compile) │
│  CaseDetail.tsx (改)                                           │
│   - 顶部渲染 variableReport warning banner                    │
│   - extract 步骤徽章显示抽取方式                               │
│  ReportDetail.tsx (改)                                         │
│   - 失败信息含 {{var}} 时高亮原始模板与本次运行值              │
└────────────────────────────────────────────────────────────────┘
```

## 数据形状

### DSL 新字段（`packages/shared/src/step-dsl.ts`）

```ts
export const ExtractMode = z.enum(['completeValue', 'smartExtract', 'regex']);
export type ExtractMode = z.infer<typeof ExtractMode>;

export const ExtractAction = z.object({
  kind: z.literal('extract'),
  locator: z.array(Locator).min(1),
  varName: z.string().min(1).max(64),
  mode: ExtractMode.default('completeValue'),
  /** regex 模式必填；smartExtract 模式由后端一次编译后写入。 */
  pattern: z.string().min(1).max(500).optional(),
  /** regex 模式下的捕获组 1-based；缺省取整个 match。 */
  group: z.number().int().min(0).max(10).optional(),
  /** smartExtract 模式用户输入的自然语言描述，仅 UI 展示，不参与回放。 */
  description: z.string().max(500).optional(),
}).refine(
  (a) => a.mode !== 'regex' || (a.pattern && a.pattern.length > 0),
  { message: 'regex 模式必须填写 pattern', path: ['pattern'] },
);
```

`fill.value` 的字符串 / `select.value` / `assertText.equals` / `screenshot.name` / `navigate.url` / `aiStep.instruction` / `assertJson` 期望值序列化串都允许 `{{var}}`，不做额外 DSL 改动，仅在 dispatch 阶段调用 `substituteVars`。

### 共享辅助（`packages/shared/src/variable.ts`，新）

```ts
export const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function validateVariableName(name: string): { ok: boolean; reason?: string };

/** 从一段字符串里抠出所有 {{name}} 引用，去重返回。 */
export function collectVarRefs(text: string): string[];

/**
 * 把 {{name}} 替换为 vars[name]。未定义变量保留模板原值并把 name 计入 missing，
 * 让上层一次性报告。永不抛错。
 */
export function substituteVars(
  text: string,
  vars: Record<string, string>,
): { value: string; missing: string[] };

/** 正则安全校验：编译耗时 > 50ms 或命中嵌套量词黑名单即拒。 */
export function safeRegex(pattern: string): { ok: true } | { ok: false; reason: string };
```

`value-utils.ts` 现存的 `substituteVars` 改名后挪过来；老 `materializeValue` 调用点改为 `variable.substituteVars`。

### 回放报告（`apps/api/src/lib/variable-report.ts`，新）

```ts
export interface VariableReport {
  undefined: Array<{ stepOrder: number; field: string; name: string }>;
  duplicates: Array<{ name: string; definedAt: number[] }>;
  forwardRefs: Array<{ stepOrder: number; field: string; name: string }>;
  regexIssues: Array<{ stepOrder: number; reason: string }>;
}

export function buildVariableReport(steps: StepAction[]): VariableReport;
```

**扫描规则**

1. 遍历 `steps`，按 `order` 升序；遇到 `extract` 步骤记入 `defined[name] = max(defined[name], order)`。
2. 同一 case 内 `extract.varName` 重复 → `duplicates`。
3. 任意步骤字符串字段含 `{{name}}` 且 `name` 未在 defined → `undefined`；若 `name` 已在 order 更大的 step 定义 → `forwardRefs`。
4. `extract.mode === 'regex'` 时 `safeRegex(pattern)` 失败 → `regexIssues`。

字段路径标注（`field`）：`fill.value` / `select.value` / `assertText.equals` / `assertJson.equals` / `navigate.url` / `screenshot.name` / `aiStep.instruction`。

### 服务端变更

**`apps/api/src/routes/steps.ts`**

- POST `/:caseId/steps`：在 `compileAiStepsInPlace` 之前做 `step-migration`（懒迁移老 extract → 新结构）；返回体增加 `variableReport` 字段。
- PUT `/:caseId/steps`：同上加 `variableReport`。
- 新增 `POST /:caseId/steps/extract/compile`：body `{ description: string, sampleText: string }`，返回 `{ pattern: string }`（走现有 LLM 调用通道，复用 `aiStepCompile` 的 prompt 模板）。

**`apps/api/src/execute/cdp.ts`**

- `DispatchOpts.vars` 已是 `Record<string, string>`；现有 `materializeValue` 改为调 `variable.substituteVars`。
- 各 `case` 入口对可替换字符串统一：
  ```ts
  const { value, missing } = substituteVars(raw, opts.vars);
  if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]}}} (模板="${raw}", 当前值=未定义)`);
  ```
- `extract` 步骤按 `mode` 分派：
  - `completeValue`：现有逻辑（先 inputValue 后 innerText）。
  - `regex`：`safeCompiled = new RegExp(pattern, 'g')`；若含捕获组取 `match[group]`，否则取 `match[0]`；失败抛 `extract-missing: pattern=... var=...`。
  - `smartExtract`：保存阶段已编译为 `regex` 模式；回放阶段同样走 regex（说明：`mode` 字段保留以便 UI 标注"智能抽取"）。
- 错误信息格式：`{ errorTemplate: raw, resolved: raw.replace(...) }` 一并塞进 `ExecStepResult`，ReportDetail 据此高亮。

### 前端变更

**`apps/web/src/components/StepEditModal.tsx`**

- `extract` 步骤面板加：
  - mode 下拉（completeValue / smartExtract / regex）。
  - regex 模式下显示 pattern 输入框 + group 输入框 + "测试"按钮（前端 `safeRegex` + 拿当前 sampleText 跑一次预览）。
  - smartExtract 模式下显示 description 多行文本 + "生成正则"按钮 → 调 `/cases/:id/steps/extract/compile`；成功后自动写入 pattern 并切到 regex 模式（保留 `description` 字段）。
  - 变量名输入加正则校验提示（不阻塞；保存时服务端兜底）。

**`apps/web/src/pages/CaseDetail.tsx`**

- PUT 完成后拿到 `variableReport`；按 undefined > regexIssues > forwardRefs > duplicates 顺序渲染顶部 banner（紫罗兰玻璃风格），每条提示点跳转对应步骤。

**`apps/web/src/pages/ReportDetail.tsx`**

- 失败步骤展示 `errorTemplate`（若有）作为灰色代码块；与 `resolved` 并列。

### 录制侧

- 不变。recorder-manager 仍只生成 `kind: 'extract' + varName` 的最小步骤；mode 由用户在 StepEditModal 后续补充；服务端懒迁移兜底。

## 测试策略

**单元（`packages/shared/test/variable.test.ts`，新）**

- `validateVariableName`：合法名 / 空 / 首字符数字 / 长度越界 / 含中文。
- `collectVarRefs`：单引用 / 多引用 / 嵌套场景 / 空白容忍。
- `substituteVars`：全替换 / 未定义保留 / 多次同一变量 / 含 `{{` 但非合法名。
- `safeRegex`：合法 / 编译超时 / 嵌套量词黑名单。

**集成（`apps/api/test/variable-report.test.ts`，新）**

- extract 步骤两次同名 var → duplicates 命中。
- step3 引用 step5 extract 变量 → forwardRefs 命中。
- step4 引用未定义变量 → undefined 命中。
- extract regex 模式 pattern `(a+)+$` → regexIssues 命中。
- 老 extract 步骤（无 mode）PUT 后落库变为 `mode: 'completeValue'`。

**回放（`apps/api/test/execute-cdp-extract.test.ts`，新）**

- `completeValue` 模式读取 inputValue。
- `regex` 模式按 group 截取。
- smartExtract 模式实际等价 regex（仅在 mode 字段上区分）。
- 引用未定义变量抛错且错误信息含 `{{var}}`。

**前端**

- 不加单测；用 `apps/web` 现有的冒烟流程 + 手动 UI 检查。

## 不在本期

- locator 串变量展开、跨用例变量池、独立 preflight API、运行时 LLM 智能抽取、CueCast 文档中提到的"截图步骤也支持变量替换"我们已在范围内但单测覆盖率有限。
- 历史执行报告中的变量快照回放；本期只保证新执行报告含模板原值。
