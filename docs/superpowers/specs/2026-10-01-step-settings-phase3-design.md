# 步骤配置 phase 3：组合值 + 断言增强 + 三层定位 + 类型切换

日期：2026-10-01
状态：待用户审阅
上游参考：`docs/superpowers/specs/2026-09-30-recorder-phase2-design.md`（已落地）；用户提供的 CueCast 步骤配置文档全文（本地 HTML）

## 背景与目标

phase 2 把录制扩展到了「模式 / 多标签页 / 组件识别 / 密码加密 / 上传回放」。CueCast 步骤配置文档描述的另一些能力尚未落到 iTest：组合值（多种片段按顺序拼接）、assertText 目标+匹配方式、三层定位优先级（intent → 稳定 #id CSS → XPath → 普通 CSS）、操作类型手动切换。本期把这一组能力一次性补齐，并对既有 DSL 做一次破坏性升级。

### 本期范围（YAGNI）

**做**：

- `CompositeValue`：fill 步骤的 value 新增一种 fragment 数组模式，按顺序拼接固定值 / 日期 / 随机数字 / 随机字符串 / 时间戳；总长度上限 1024。
- `assertText` 增强：新增 `target`（specifiedElement / page / errorMessage / url）与 `match`（equals / contains / notContains / regex）；默认 `specifiedElement × equals`。
- 三层定位：每个含 locator 的步骤新增可选 `intentLocator`（semanticRole + contextText），回放时按 intent → 稳定 #id CSS → XPath → 普通 CSS 顺序尝试；不引入新解析算法，复用现有 selector-core 输出。
- 操作类型手动切换：每行步骤新增类型下拉，允许 click↔hover、click↔assertText、fill↔select、waitFor↔assertVisible 互转；非法转换保留原 action。
- DSL 一次性迁移：steps PUT 校验时把老 action 就地升级成新结构；DB schema 不变。

**明确不做**：

- assertJson 改造（CueCast 文档只是顺带一句；现有 `deepEqual` 已覆盖键顺序/空白语义，足够）。
- iframe 上下文切换（phase 2 已声明边界外）。
- semanticRole → CSS 的查表解析（不引入新算法，semanticRole 仅作为回放时的 `data-testid` 候选补充）。
- 多用户协作、迁移版本号（DB 列不动，不引入 schema_version）。
- 启动时批量迁移（懒迁移，PUT 时升级；避免长事务与上线风险）。

### 设计决策（已与用户确认）

| 议题 | 决策 |
|---|---|
| `intentLocator` 是否可选 | 可选（`IntentLocator.optional()`），录制阶段尝试生成 |
| assertText 迁移默认 match | 老 `equals` 字段保留为 `match: 'equals'`，不强行升 contains |
| intentLocator 回放语义 | 不引入新解析表，仅作为补充候选参与查找 |
| 三层定位中间失败 | 不记录中间截图 |
| errorMessage 找不到 | 直接报错，不回落到 page |
| assertJson 改造 | 不动 |
| CompositeValue 长度上限 | 硬上限 1024 |
| 实时长度估算 UI | 保留，带进度提示 |
| `randomNumber.length` | 保留作为可选字段；存在则左补零 |
| 类型切换是否 confirm | 不弹确认，依赖现有 undo |
| 迁移触发时机 | 懒迁移，仅在 steps PUT 时升级 |

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         apps/web                                │
│  StepEditModal (扩展)         CaseDetail (类型切换下拉)        │
│  - composite builder          - 类型徽章 + 切换菜单            │
│  - assert target/match        - 调用 replaceSteps              │
│  - length estimate                                              │
└─────────────────┬────────────────────────────┬─────────────────┘
                  │  PUT /cases/:id/steps       │
                  │  (Zod 校验 + 迁移)           │
┌─────────────────▼────────────────────────────▼─────────────────┐
│                         apps/api                                │
│  steps.ts (Zod + migration)   step-migration.ts                │
│  execute/cdp.ts                                                │
│  - dispatch 三层定位路径                                        │
│  - assertText: target × match                                   │
│  - CompositeValue materialize                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 数据形状

### DSL 新字段（`packages/shared/src/step-dsl.ts`）

```ts
export const IntentLocator = z.object({
  /** 录制阶段确定的语义角色，复用 selector-core 输出的 data-testid / name */
  semanticRole: z.string().min(1).max(64),
  /** 业务文案，回放时参与文本兜底 */
  contextText: z.string().max(500).optional(),
});

const ValueFragment = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), value: z.string().max(500) }),
  z.object({ mode: z.literal('date'), format: z.enum(['YYYYMMDD', 'YYYY-MM-DD', 'YYYY/MM/DD']) }),
  z.object({ mode: z.literal('randomNumber'),
             min: z.number().int().min(0).default(0),
             max: z.number().int().default(999999),
             length: z.number().int().min(1).max(128).optional() }),
  z.object({ mode: z.literal('randomString'), length: z.number().int().min(8).max(1024).default(12) }),
  z.object({ mode: z.literal('timestamp') }),
]);

export const CompositeValue = z.object({
  mode: z.literal('composite'),
  fragments: z.array(ValueFragment).min(1).max(20),
}).refine((v) => estimateMaxLen(v) <= 1024, { message: 'CompositeValue 总长度超过 1024 上限' });

export const FillValue = z.union([z.string(), ValueGenerator, CompositeValue]);

export const ClickAction = z.object({
  kind: z.literal('click'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
});
// fill / hover / waitFor / check / select / extract 同 ClickAction 形状

export const AssertTextAction = z.object({
  kind: z.literal('assertText'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  target: z.enum(['specifiedElement', 'page', 'errorMessage', 'url']).default('specifiedElement'),
  match: z.enum(['equals', 'contains', 'notContains', 'regex']).default('equals'),
  equals: z.string(),
});
```

### 一次性迁移规则（`apps/api/src/lib/step-migration.ts`，PUT 时调用）

| 老结构 | 新结构 |
|---|---|
| 缺 `intentLocator` | 不补（optional） |
| `assertText` 缺 `target` / `match` | `target: 'specifiedElement'`, `match: 'equals'` |
| `FillValue` 是 `string \| ValueGenerator` | 不动；只是 union 多一个 CompositeValue 分支 |
| 已是新结构 | 幂等，直接返回 |
| 未知 kind | 不升级，原样保留 |

## 组件 / 模块拆分

| 文件 | 职责 |
|---|---|
| `packages/shared/src/step-dsl.ts` | DSL 形状：新增 `IntentLocator` / `CompositeValue` / `assertText` target+match；FillValue union |
| `packages/shared/src/value-utils.ts` | `materializeValue` 新增 CompositeValue 分支；日期格式化；左补零 |
| `apps/api/src/lib/step-migration.ts` | 老 DSL → 新 DSL 的就地升级，幂等 |
| `apps/api/src/execute/locator-resolver.ts` | 三层定位候选构造，顺序固定 |
| `apps/api/src/execute/cdp.ts` | dispatch：三层定位；assertText target×match；CompositeValue 物化 |
| `apps/recorder/modules/recorder-manager.ts` | 录制阶段构造 `intentLocator`（复用 selector-core 输出） |
| `apps/web/src/components/StepEditModal.tsx` | composite builder UI、assertText target/match 选择器、length 估算 |
| `apps/web/src/pages/CaseDetail.tsx` | 步骤行类型下拉，触发 `replaceSteps` |
| `apps/api/src/routes/steps.ts` | PUT 入口：先迁移后 Zod 校验；COMPOSITE 上限 1024 由 Zod 拒绝 |
| `apps/api/test/step-migration.test.ts` | 单元测试迁移规则与幂等性 |
| `apps/api/test/value-composite.test.ts` | CompositeValue 物化与边界 |
| `apps/api/test/locator-resolver.test.ts` | 三层定位候选顺序 |
| `apps/api/test/execute-cdp.test.ts` | 补 4 个 assertText 用例（page+contains / specifiedElement+equals / errorMessage+contains / url+regex）+ 三层定位主 CSS 失败回退 |

## 数据流

**录制：**

```
用户操作
   ↓
recorder-manager → intentLocator { semanticRole, contextText }
   ↓
WS push → API → test_steps.action 落库
```

**回放：**

```
test_steps.action
   ↓ step-migration (lazy, idempotent)
新结构 action
   ↓ Zod validate
dispatch(action, opts)
   ↓
locator-resolver.buildCandidates → 顺序尝试
   ↓
playwright 执行 + step 截图
```

## 错误处理

| 场景 | 行为 |
|---|---|
| CompositeValue 总长 > 1024 | Zod `refine` 拒绝；前端 builder 实时算长度，超过即禁用保存按钮 |
| 单 fragment 失败（max < min 等）| 物化时抛 `fragment #n: ...`，错误带上片段序号 |
| 类型切换非法 | 保留原 action，toast「不支持的类型切换」 |
| 类型切换语义破坏（assertText → click 丢 equals 语义地位）| 不弹确认，靠 undo 恢复 |
| errorMessage 找不到目标 | 直接抛错，不回落到 page |
| 三层定位全部失败 | 抛错沿用 phase 2 `locator array is empty` 或 `waitFor` 超时 |

## 测试策略

- **单元（packages/shared）**：CompositeValue Zod refine、materializeValue 各分支、随机数 length 左补零。
- **单元（apps/api）**：
  - `step-migration.test.ts`：老→新、幂等、未知 kind 保留。
  - `locator-resolver.test.ts`：候选顺序、stable #id 提升、intentLocator 优先。
  - `value-composite.test.ts`：拼接顺序、空 fragments、超长失败、fragment #n 错误。
  - `execute-cdp.test.ts`：4 个 assertText 用例 + 三层定位回退用例。
- **Web UI**：暂不写组件测试；`api/cases.put` 端到端覆盖。

## 文档

- `apps/web/src/components/StepEditModal.tsx`：UI 文案同步 CueCast 文档（输入值含义表、动态输入值表）。
- 不写独立用户文档；StepEditModal 内的提示文本已经覆盖。

## 风险与回退

| 风险 | 回退 |
|---|---|
| 三层定位把原本能跑的步骤弄错 | candidate 顺序确定；executor 单测覆盖「主 CSS 失败回退」场景 |
| 一次性迁移破坏老用例 | 迁移在 PUT 时升级，不主动批量改；DB schema 不动；迁移函数幂等 |
| CompositeValue 上限太紧 | 上限 1024 与 CueCast 一致；后续若用户要更多可调 |
| 类型切换后语义丢失 | undo 快照在 20 步以内都能恢复 |
