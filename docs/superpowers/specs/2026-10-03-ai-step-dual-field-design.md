# AI 步骤双字段化：自然语言 + 可执行 DSL 同源管理

日期：2026-10-03
状态：待用户审阅
上游参考：
- `docs/superpowers/specs/2026-10-01-ai-case-creation-design.md`（AI 工作台 / 暂存文档 / 保存事务）
- `docs/superpowers/specs/2026-10-01-ai-step-optimization-design.md`（aiStep 编译 / 视觉识别 / 拆条）
- `docs/superpowers/specs/2026-10-02-step-editing-design.md`（StepEditDrawer）

## 背景与目标

现状里用例步骤里的 aiStep 只存「自然语言指令（`instruction`）」，可执行 DSL `compiled` 在保存到 `test_steps` 时由后端 `compileAiStepsInPlace` 批量生成。问题：

1. **AI 工作台暂存期间看不到 compiled**：用户在右栏只能看到自然语言指令，不知道 LLM 实际会怎么执行；保存前没有预览。
2. **人工 / 录制的 step 没有 compiled**：只有 instruction，保存后回放前必须现编；编辑 instruction 后旧的 compiled 不会自动更新。
3. **单步 assertion 不友好**：现在 step 级 `assertion` 字段（`apps/api/src/pi/workspace.ts` 的 `StagedStep.assertion`）虽然已经在数据流里跑通，但 StepEditDrawer 没有独立编辑入口；用户只能改 instruction。
4. **AI 不被引导产出断言**：当前 prompt 里 LLM 只输出 `kind/action`，不会主动为动作型 step 末尾补 `assertText`。

本期目标：把 aiStep 从「单 instruction 字段」演化为「`{name, action, assertion?, compiled?}` 二元结构」。AI 在工作台暂存阶段就直接产出 compiled 与可选 assertion；StepEditDrawer 给单步 assertion 编辑入口；保存到 DB 路径保留后端兜底编译，已编译 step 短路不再重编。

### 本期范围（YAGNI）

**做**：

- 暂存用例 step 升级为 `{name, action, assertion?, compiled?}` 四元；零迁移（JSONB 缺字段按 null 处理）
- AI 工作台 `upsert_case` 工具接受 `compiled` 参数；prompt 引导 LLM 同时产出 compiled 与可选末尾 `assertText`
- `compileAiStepsInPlace` 增加短路：已 compiled 的 step 跳过 LLM
- StepEditDrawer aiStep 编辑区加可选「断言（可空）」textarea
- `packages/shared/src/step-dsl.ts` 的 `aiStep` 形状加可选 `assertion?: string | null`
- 前端右栏展示 compiled（用 `stepKindLabel` + `stepSummary` 渲染子步列表；null 时显示「未编译，保存时由后端补编译」浅色提示）

**明确不做**：

- AI 工作台单条 step 「重编译」按钮（按用户确认：只在用例详情页步骤列表提供，沿用现有入口）
- 录制器改造（`apps/recorder/popup/panel.js` 维持现状；录后由 `recorder.finish` 触发后端编译）
- 工作台单条 step 「去录制」入口（按用户上一轮答复：维持现状，不引入录制器桥接）
- 强制每条 step 都有 assertion（动作型 step 不强制；LLM 可选补末尾 assertText）
- 多模态视觉识别流程改造（已落地的 `compileAiStepVision` 不动）

### 设计决策（已与用户确认）

| 议题 | 决策 |
|---|---|
| 暂存用例步骤形态 | `{name, action, assertion?, compiled?}` 二元结构 |
| 暂存字段存储 | 扩展现有 `ai_cases.steps` JSONB，零迁移 |
| AI 是否产出 compiled | AI 产出包含 compiled（之前不包含） |
| 人工编辑 aiStep | 不预填 compiled；保存时后端补编译 |
| 单步重编译入口 | 只在用例详情页面步骤列表提供（沿用现状） |
| 单步 assertion | 必加；与 instruction 并列；可空 |
| AI 是否补末尾 assertText | prompt 引导 LLM 主动补（不强制） |
| 录制器 | 维持现状 |

## 架构

```
浏览器 apps/web
└── AiWorkspacePage 右栏
    └── StagedStep 渲染：
        - instruction（自然语言）
        - compiled（DSL 列表，每条 stepKindLabel + stepSummary）
          缺失时显示「未编译，保存时由后端兜底」
└── CaseDetail / StepEditDrawer
    └── aiStep 编辑区：
        - 自然语言指令 textarea（现状）
        - 断言（可空）textarea ← 新增

服务端 apps/api
└── src/pi/tools.ts (upsert_case)
    └── parameters.steps[].compiled?: StepAction[] | null
        execute 直接落进 ai_cases.steps[].compiled
└── src/agent/aiStepCompile.ts
    └── SYSTEM_PROMPT / BATCH_SYSTEM_PROMPT 追加「末尾 assertText 引导」
    └── compileAiStepsInPlace 增加短路：已 compiled 跳过 LLM
└── src/routes/requirements.ts (ai-workspace/save)
    └── 不变；复用 compileAiStepsInPlace（短路后实际调用更少）
└── src/routes/steps.ts (PUT)
    └── migrateAction 增加 aiStep.assertion 字段保位
└── packages/shared/src/step-dsl.ts
    └── AiStepAction 加可选 assertion: string | null
```

## 数据形状

### 暂存 step 形状升级（`apps/api/src/pi/workspace.ts`）

```ts
export type StagedStep = {
  name: string;
  action: string;
  assertion: string | null;
  /** LLM 编译出的 DSL 步骤；null = 未生成或失败，回放时 AI 即时编译 */
  compiled: StepAction[] | null;
};
```

零 schema 迁移：老数据缺 `compiled` 字段，读端兼容为 `null`。

### DB 落地（test_steps）

不变。`test_steps.action` 仍为 `aiStep`（`{kind:'aiStep', instruction, compiled}`）；`test_steps.assertion` 仍为 `assertText` shape。`step.name` 字段（已有的 nullable 列）保留为前端展示用。

### 客户端共享类型（`packages/shared/src/step-dsl.ts`）

```ts
// aiStep 新增可选 assertion 字段（与 workspace assertion 同语义；保存时落入 test_steps.assertion）
z.object({
  kind: z.literal('aiStep'),
  instruction: z.string().max(2000),
  compiled: z.array(z.lazy(() => StepAction)).nullable(),
  assertion: z.string().max(2000).nullable().optional(),
})
```

向后兼容：老 aiStep 不带 `assertion` 字段，zod 解析通过。

### 工具参数（`apps/api/src/pi/tools.ts` 的 `upsert_case`）

```ts
parameters: Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 4000 }), Type.Null()])),
  priority: Type.Optional(Type.Union([
    Type.Literal('P0'), Type.Literal('P1'), Type.Literal('P2'), Type.Literal('P3'),
  ])),
  steps: Type.Array(Type.Object({
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    action: Type.String({ minLength: 1, maxLength: 2000 }),
    assertion: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
    /** LLM 编译出的 DSL 步骤；缺省或 null 表示未生成 */
    compiled: Type.Optional(Type.Array(Type.Unknown())),
  })),
  scenarioId: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
}),
```

`promptGuidelines` 追加：

```
「请同时为每个 step 产出 compiled：把自然语言指令编译成 DSL 步骤列表，
允许的 kind：navigate / click / fill / hover / waitFor / assertText / assertVisible /
check / select / extract / switchTab / screenshot / upload。
locator 规则：[{strategy, value}] 数组，至少 1 个；strategy ∈ role|text|testId|css|xpath。
如果该 step 跑完后页面应该有可观察结果（例如填表后的成功提示、点击后的列表项出现），
请在 compiled 末尾加一条 assertText：{locator:[{strategy:'text', value:'<片段>'}],
target:'specifiedElement', match:'contains', equals:'<片段>'}。
compiled 整体为 null 表示放弃编译（保存阶段由后端兜底）。」
```

`execute` 落地：把 `v.compiled ?? null` 直接落进 `StagedStep.compiled`，不做二次校验（保存阶段统一 zod 校验）。

## 服务端设计

### `compileAiStepsInPlace` 短路（`apps/api/src/agent/aiStepCompile.ts`）

```ts
for (let i = 0; i < steps.length; i++) {
  const step = steps[i]!;
  const a = step.action as { kind?: string; compiled?: unknown };
  if (a?.kind !== 'aiStep') continue;
  // 短路：已有 compiled（含 null）→ 跳过 LLM。
  // null 等同"AI 已尝试并失败/放弃"，保存阶段不应再编，避免无谓重试。
  if ('compiled' in a) continue;
  // ... 原启发式 + batch + 兜底逻辑不变
}
```

变更点：循环顶部增加 `'compiled' in a` 判断；其余逻辑不变。

### LLM 系统 prompt 追加（`apps/api/src/agent/aiStepCompile.ts`）

`SYSTEM_PROMPT` 与 `BATCH_SYSTEM_PROMPT` 末尾追加：

```
「如果该 step 跑完后页面应该有可观察结果（例如填表后的成功提示、点击后的列表项出现），
请在 compiled 末尾补一条 assertText：{locator:[{strategy:'text', value:'<片段>'}],
target:'specifiedElement', match:'contains', equals:'<片段>'}。
不要为 navigate 步骤本身补 assertText（navigate 后的状态由下一条 step 断言）。」
```

注意：与 AI 工作台 prompt 共享同一段引导，但工作台 prompt 强调「整 step 形状含 instruction + compiled」；服务端编译 prompt 强调「仅输出 compiled 数组」。两处文案分工，避免混淆。

### `migrateAction` 增加 aiStep.assertion 保位（`apps/api/src/lib/step-migration.ts`）

```ts
// 已迁移：在 aiStep 末尾追加 assertion 字段（保持字段位置一致）
const aiStepMatch = (kind === 'aiStep');
if (aiStepMatch && !('assertion' in action)) {
  action.assertion = undefined;
}
return action;
```

为何用 `undefined` 而非 `null`：与既有的 `intentLocator` 模式一致（`step-migration.ts:12`）。

### 保存端点（`apps/api/src/routes/requirements.ts`）

不变。`compileAiStepsInPlace` 短路后实际 LLM 调用更少；逻辑透明复用。

### 用例详情页重编译

维持现状：`apps/web/src/pages/CaseDetail.tsx:723-757` 的「AI 编译失败 · 点我重编」按钮，调用 `POST /api/cases/:id/steps/recompile`。本期不变。

### PUT 步骤（`apps/api/src/routes/steps.ts`）

不变。`migrateAction` 自动给老 aiStep 补 `assertion: undefined` 字段位置；前端 PUT 时若带 `assertion`，照常落进 `test_steps.assertion`。

## 前端设计

### 工作台右栏（`apps/web/src/features/ai-workspace/WorkspacePanel.tsx`）

替换现有 step 渲染块（`apps/web/src/features/ai-workspace/WorkspacePanel.tsx:90-108`）：

```
┌─ 步骤 n ──────────────────────────────────┐
│ 名称（首句截断）                            │
│ 指令: <自然语言 instruction>               │
│ 编译:                                       │
│   ▸ navigate → http://…/login              │
│   ▸ fill 用户名                              │
│   ▸ fill 密码                                │
│   ▸ assertText "登录成功"  (末尾断言，浅色)  │
│  ─── 或 ───                                 │
│  ⚠ 未编译，保存时由后端补编译              │
└─────────────────────────────────────────────┘
```

要点：
- `compiled == null` 时显示浅色「未编译，保存时由后端兜底」提示
- `compiled` 数组里每条子步用现有 `stepKindLabel(action.kind)` + `stepSummary(action)` 渲染
- 末尾是 `assertText` 时把 `equals` 单独展示成浅色「断言 <equals>」，与普通子步区分
- assertion 字段（`StagedStep.assertion`，string|null）作为 step 级 description 渲染（与现 renderCase 行为一致）
- 不在工作台提供单条重编译按钮（按用户确认）
- 不在工作台提供单条「去录制」入口（按用户确认）

### StepEditDrawer（`apps/web/src/components/StepEditDrawer.tsx`）

aiStep 编辑区（约 `StepEditDrawer.tsx:529-565`）追加：

```
[ 自然语言指令（保存后自动编译） ]
[ 断言（可空，描述该 step 跑完后页面应显示什么） ]   ← 新增 textarea
```

`useState` 新增 `assertion: string`，初值取 `action.assertion ?? ''`。

`buildAction` 里 aiStep 分支（`StepEditDrawer.tsx:230-233`）追加：

```ts
if (kind === 'aiStep') {
  next.instruction = instruction.trim();
  next.compiled = action.compiled ?? null;
  const a = (assertion ?? '').trim();
  if (a) next.assertion = a;
  else delete next.assertion;
}
```

`handleSave` 不变（Zod 校验放行可选字段）。

视觉风格：与 instruction textarea 一致（rows=2，相同 placeholder「例: 页面显示订单提交成功」）。

### 客户端共享类型同步

`packages/shared/src/step-dsl.ts` 同步加 `assertion` 可选字段。前端 import 共享类型即可，无需本地重复定义。

## 错误处理

| 场景 | 行为 |
|---|---|
| LLM 在 `upsert_case` 漏填 compiled | execute 端把缺省视为 null；保存时后端 compileAiStepsInPlace 兜底 |
| LLM 产出 compiled 含非法 kind（zod 拒绝） | 保存阶段 `compileAiStepsInPlace` 重编覆盖；否则保留 null |
| `compileAiStepsInPlace` 短路已 compiled | 跳过 LLM；保留原 compiled（含 null） |
| 用户改 instruction 后保存 | 旧 compiled 保留；UI 提示「instruction 已修改，compiled 可能与新 instruction 不匹配」 |
| assertion 字段含非法值 | Zod 校验失败 → 422 |
| 视觉占位符 instruction 仍未编译 | 走原 `compileAiStepVision` 路径（不变） |

## 测试

### API（vitest）

- `apps/api/test/pi-tools.test.ts`（新建）：`upsert_case` 接受 compiled 字段并落进 staged step；缺省时为 null
- `apps/api/test/ai-workspace-save.test.ts`：暂存 step 含 compiled → 保存到 DB 时 mock provider 调用计数 = 0（短路生效）
- `apps/api/test/aiStepCompile.test.ts`：增加「已 compiled 的 step 不调 LLM」用例（断言 mock provider 未被调用）；末尾 assertText 引导 prompt 文本断言（不入 LLM 调用，只校验 prompt 拼接）
- `apps/api/test/migration.test.ts`：增加「老 aiStep 无 assertion 字段经 migrateAction 后含 `assertion: undefined`」
- `apps/api/test/step-dsl-shared.test.ts`（如不存在则新建）：aiStep 形状加可选 assertion 后，老 aiStep 数据 zod 解析通过

### Web（typecheck + lint + 手动）

- 工作台右栏 mock LLM 工作金路径：右栏展示 instruction + compiled 子步列表 + 末尾 assertText
- StepEditDrawer 编辑 assertion → 保存 → test_steps.assertion 落库
- 改 instruction 后保存 → 旧 compiled 保留；UI 提示
- compiled == null 时右栏展示「未编译，保存时由后端补编译」浅色提示

### 回归

api 套件全量（含已知 plans.test 1 个 pre-existing 失败）。

## 风险与回退

| 风险 | 回退 |
|---|---|
| AI 产出 compiled 与实际 DSL 不一致（zod 拒绝率上升） | execute 端兜底为 null；保存路径 LLM 兜底；短期观察 |
| 工作台 step 形状升级影响老用户暂存数据 | 读端兼容（缺 compiled 视为 null） |
| LLM 在 compiled 末尾补 assertText 过度（每条动作都断言） | prompt 限制「不要为 navigate 步骤本身补 assertText」；用户可在工作台删除多余 step |
| 改 instruction 后旧 compiled 与新 instruction 不匹配 | UI 加不匹配提示；用户可点详情页「重新编译」按钮 |
| migrateAction 给 aiStep 加 assertion 字段影响 zod 输出长度 | zod 输出是对象，字段数变化不影响下游消费；测试覆盖 |

## 自审记录

- **Spec 覆盖**：
  - 数据形状升级 → workspace.ts StagedStep + step-dsl.ts
  - AI 工具接受 compiled → pi/tools.ts upsert_case
  - LLM prompt 引导末尾 assertText → aiStepCompile.ts SYSTEM/BATCH
  - compileAiStepsInPlace 短路 → aiStepCompile.ts 循环顶部
  - migrateAction 保位 → step-migration.ts aiStep 分支
  - StepEditDrawer 编辑 assertion → StepEditDrawer.tsx aiStep 分支
  - 右栏展示 compiled → WorkspacePanel.tsx 替换 step 渲染
- **占位扫描**：无 TBD；每条设计变更点都有文件路径
- **类型一致性**：`StagedStep.compiled`、`StepAction[]`、`test_steps.action.compiled` 三处形状一致（均为 `StepAction[] | null`）
- **范围确认**：单 spec，不引入新表 / 新端点 / 新工具；零 schema 迁移；与用户确认的 YAGNI 边界一致
