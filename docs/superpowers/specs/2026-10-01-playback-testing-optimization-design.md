# 回放测试优化 — 设计文档

> Status: Draft · 2026-10-01
> 目标: 参照 CueCast 回放测试指南优化 iTest 的用例回放路径。
> 范围: 后端执行链路 + Web 报告页 + 用例详情页（执行设置区块）。

## 1. 背景与目标

iTest 当前回放走 `playwright-core` 驱动的真实 chromium（`apps/api/src/execute/cdp.ts`），通过三层定位候选（`locator-resolver.ts`）回放步骤，遇到异常时回退到随机 mock 结果（`runCase.ts:60-75`），失败原因仅暴露 `error` 字符串，报告页没有明细模式，Web 端也没有窗口策略/无痕模式开关。

参考 [CueCast 回放测试指南](https://www.icuecast.com/docs/guide/playback)，本次优化目标为:

1. **稳定性**: 点击/填写前对元素做就绪判断 + 自动等待稳定态。
2. **可观测性**: 失败原因归类（枚举 + 人类可读），报告页加明细模式展示命中 Locator。
3. **能力补齐**: 用例级窗口尺寸策略、无痕模式、多标签页宽容匹配。
4. **DOM 降级**: CDP 路径不可用时降级到原生事件 + DOM 操作，不再走随机 mock。
5. **执行前检查**: 记录起始 URL / 登录态 / tab 上下文，便于排障。

## 2. 架构概览

新增/修改模块（仅列出非平凡修改）:

| 文件 | 角色 |
| --- | --- |
| `apps/api/src/execute/stability.ts` (新) | 元素就绪三态判断 + 遮罩检查 + 自动等待 |
| `apps/api/src/execute/failureClassifier.ts` (新) | 异常 → `FailureReason` + `humanMessage` |
| `apps/api/src/execute/preflight.ts` (新) | 执行前 URL/登录态/同源校验，产出 `preflightReport` |
| `apps/api/src/execute/domFallback.ts` (新) | DOM 降级动作：click/fill/check/select/upload |
| `apps/api/src/execute/cdp.ts` (改) | 接入 stability + 失败归类 + DOM 降级 + 命中 Locator 记录 |
| `apps/api/src/execute/runCase.ts` (改) | 增加 preflight、用例级窗口尺寸、incognito、移除随机 mock |
| `apps/api/src/execute/runPlan.ts` (改) | incognito × loginPrepare 互斥校验 |
| `apps/api/src/db/schema.ts` (改) | `test_cases` 增加 `window_strategy/window_width/window_height/incognito`；`reports` 增加 `preflight` |
| `apps/api/drizzle/0008_playback_runtime.sql` (新) | 上述字段迁移 |
| `apps/web/src/pages/ReportDetail.tsx` (改) | 明细模式 Tab + 命中 Locator 列 + 失败原因气泡 |
| `apps/web/src/pages/CaseDetail.tsx` (改) | "执行设置" 区块 |
| `packages/shared/src/playback.ts` (新) | 共享枚举与 DTO 类型 |

数据流（单用例执行）:

```
runCase(caseId)
  ├─ preflight(case) → preflightReport
  ├─ executeCaseReal(steps, ctx{ window, incognito, ... })
  │    └─ for each step:
  │         ├─ stabilityCheck + waitForStable()    ← 仅 click/fill/check/select/upload
  │         ├─ dispatch(action) — 命中 Locator 记入 ctx.hitLocator
  │         └─ on error: failureClassifier.classify(e) → stepResult.failureReason
  ├─ 真实执行失败 → DOM 降级 retry 一次（仅 click/fill/check/select/upload）
  └─ 写入 reports.stepResults（含 failureReason / hitLocator / tabIndex / preflightReport）
```

## 3. 数据模型变更

新增迁移 `0008_playback_runtime.sql`:

```sql
ALTER TABLE "test_cases" ADD COLUMN "window_strategy" varchar(16) NOT NULL DEFAULT 'maximize';
ALTER TABLE "test_cases" ADD COLUMN "window_width" integer;
ALTER TABLE "test_cases" ADD COLUMN "window_height" integer;
ALTER TABLE "test_cases" ADD COLUMN "incognito" boolean NOT NULL DEFAULT false;
ALTER TABLE "reports" ADD COLUMN "preflight" jsonb;
```

迁移策略:
- `window_strategy` 默认 `maximize`，向后兼容。
- `window_width/height` 仅在 `window_strategy='custom'` 时写入。
- `incognito` 默认 `false`。

对应 schema (`apps/api/src/db/schema.ts`) 增字段，并在共享层 (`packages/shared/src/playback.ts`) 导出枚举:

```ts
export const WindowStrategy = z.enum(['maximize', 'current', 'custom']);
export type WindowStrategy = z.infer<typeof WindowStrategy>;
```

## 4. 关键模块设计

### 4.1 `execute/stability.ts`（新）

公开 API:

```ts
export interface StabilityOptions {
  timeoutMs?: number;     // 默认 5000
  pollMs?: number;        // 默认 100
}

export interface StabilityReport {
  ready: boolean;
  reason?: 'disabled' | 'loading' | 'overlay' | 'readonly' | 'hidden';
  source?: string;        // 触发原因的 selector / 属性片段
}

export async function waitForStable(
  page: Page,
  locator: ReturnType<Page['locator']>,
  opts?: StabilityOptions,
): Promise<StabilityReport>;
```

判定规则（顺序短路）:
1. **disabled**: 原生 `disabled`、AntD `aria-busy="true"`、`.ant-btn[disabled]` / `.ant-input[disabled]`、自定义 `data-loading="true"`。
2. **loading**: `.ant-btn-loading` / `.ant-spin` 祖先链 / `[aria-busy="true"]`。
3. **overlay**: 元素 `pointer-events === 'none'`；祖先链上 `.ant-modal-mask` / `.el-overlay` / `[data-mask="true"]`。
4. **readonly**: 原生 `readonly` 或 `aria-readonly="true"`。
5. **hidden**: `display:none` / `visibility:hidden` / 零尺寸（仅在 click/fill 路径上排除）。

实现要点:
- 在 page 上 `evaluate` 一段小脚本，沿 `el.parentElement` 上溯 6 层检测遮罩/loading，避免来回 IPC。
- 命中 `disabled/loading/overlay/readonly` 任一项即抛 `ElementNotStable(reason)`，错误信息附 `source` 片段，方便排障。

### 4.2 `execute/failureClassifier.ts`（新）

```ts
export type FailureReason =
  | 'URLUnreachable'
  | 'NotLoggedIn'
  | 'SlowLoad'
  | 'ElementOccluded'
  | 'PageStructureChanged'
  | 'TestDataMissing'
  | 'AssertionMismatch'
  | 'FixedValueConflict'
  | 'TabMissing'
  | 'AttachmentMissing'
  | 'SecretMissing'
  | 'DisabledTimeout'
  | 'LoadingTimeout'
  | 'OverlayTimeout'
  | 'LocatorAllFailed'
  | 'CDPUnavailable'
  | 'Unknown';

export interface ClassifiedFailure {
  reason: FailureReason;
  humanMessage: string;       // 中文短句
  hint?: string;              // 可选修复提示
}

export function classify(err: unknown, ctx?: { action?: StepAction; page?: Page }): ClassifiedFailure;
```

匹配规则（按信号强度排序）:
- `err.name === 'ElementNotStable'` 且 `err.reason === 'disabled'` → `DisabledTimeout` + "元素被禁用..."
- `err.message` 含 `tab-missing` → `TabMissing`
- `err.message` 含 `assertText failed` → `AssertionMismatch`
- `err.message` 含 `assertJson` → `AssertionMismatch`
- `err.message` 含 `attachment-missing` → `AttachmentMissing`
- `err.message` 含 `secret-missing` → `SecretMissing`
- `err.message` 含 `Timeout` 且 `err.name === 'ElementNotStable'` → 对应 Loading/Overlay/Disabled
- `err.message` 含 `all locator candidates failed` / `count=0` → `LocatorAllFailed`
- 默认 → `Unknown`

未引入修复建议（按用户选项"枚举 + 人类可读"）。

### 4.3 `execute/preflight.ts`（新）

```ts
export interface PreflightReport {
  urlReachable: boolean;
  urlNote?: string;        // 不可达原因
  loggedIn: boolean;       // 启发式：页面不含 '请先登录/未登录/未授权' 等关键字
  sourceOrigin?: string;   // resolvedUrl 的 origin
  currentOrigin?: string;  // 实际 navigate 后的 origin
  originMismatch?: boolean;
  tabsObserved?: number[];
  durationMs: number;
}

export async function preflight(
  page: Page,
  caseRow: { url?: string | null; title: string },
): Promise<PreflightReport>;
```

实现:
- 仅在 `caseRow.url` 非空时尝试一次 `goto({ waitUntil: 'domcontentloaded', timeout: 8000 })`，失败 `urlReachable=false` 但**不抛错**（preflight 不阻断）。
- 登录态判断读取 `document.body.innerText`，匹配 `DEFAULT_KEYWORDS`（复用 `loginPrepare.ts` 的常量）。
- `tabsObserved` 通过 `context.pages().length` 记录，供后续 tab 切换排障。

### 4.4 `execute/domFallback.ts`（新）

仅覆盖五个交互动作；其它动作直接返回失败。

```ts
export type DomFallbackResult =
  | { ok: true }
  | { ok: false; error: string };

export async function domClick(page: Page, locator: Locator[]): Promise<DomFallbackResult>;
export async function domFill(page: Page, locator: Locator[], value: string): Promise<DomFallbackResult>;
export async function domCheck(page: Page, locator: Locator[], checked: boolean): Promise<DomFallbackResult>;
export async function domSelect(page: Page, locator: Locator[], value: string): Promise<DomFallbackResult>;
export async function domUpload(page: Page, locator: Locator[], storedPath: string): Promise<DomFallbackResult>;
```

实现:
- 先用 `locator-resolver.buildCandidates` 选第一个可命中的元素（`count() > 0`）。
- `click` → `el.scrollIntoView()` + `dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`。
- `fill` → 拿到 element 后通过 `HTMLInputElement.prototype` 设置 `value` 并派发 `input` + `change` 事件。
- `check` → toggle `el.checked` 并派发 `change`。
- `select` → 对 `<select>` 设置 `value` + 派发 `change`。
- `upload` → 直接 `setInputFiles`（这步在 DOM 路径上不必要降级，仍走真实 input）。

### 4.5 `execute/cdp.ts` 改造点

1. 在 `executeCaseReal` 启动后立刻调用 `preflight(page, caseRow)`，写入 `results` 的第一条 `preflightReport` 字段（不入 stepResults，避免污染步骤计数）。
2. `dispatch` 路径改造:
   - `click/fill/check/select/upload` 步骤前先 `waitForStable`；抛 `ElementNotStable` 时记 `failureReason` 并**不立即失败**，尝试 DOM 降级一次（仅 click/fill/check/select）。
   - DOM 降级仍失败 → 抛出原 error，由外层归类。
3. 命中 Locator 记录: 在 `tryFirstMatch` 命中候选时把 `{ kind, value }` 写入 `opts.ctx.hitLocator`（最近一次），由 dispatch 写入 stepResult。
4. `switchTab` 失败时，按 URL 模糊匹配现存 tab：
   ```ts
   // 现有：opts.ctx.tabMap.get(action.tabRef) 未命中即抛错
   // 新增：若 tabMap miss 且 context.pages 中存在 url 匹配的 page，记录 warning 后沿用
   ```
5. 替换原有 `throw e` 之外加 `classify(e, { action })` 写入 `stepResult.failureReason + humanMessage`。
6. 失败兜底：CDP 整体抛错时，`runCase` 改为「真实路径失败 → DOM 降级一次整用例」，仍失败才写入 `failureReason: CDPUnavailable` + `humanMessage`。

### 4.6 `execute/runCase.ts` 改造点

- 加载 `caseRow` 时一并读 `window_strategy/window_width/window_height/incognito`，传给 `executeCaseReal`。
- `executeCaseReal` 入参新增 `caseWindow: { strategy, width?, height? }` 与 `incognito: boolean`。
- 移除 `runCase.ts:60-75` 的随机 mock 路径；改写为：真实路径抛错 → DOM 降级一次 → 失败记 `failureReason: CDPUnavailable`。
- 失败/成功的 stepResults 中都写入 `failureReason? / humanMessage? / hitLocator?`。

### 4.7 `execute/runPlan.ts` 改造点

- 在 `runPlanAsync` 进入登录准备阶段前，扫所有 `planCases`，若任一 `incognito=true` 且 `loginPrepareEnabled=true`，立即终止 run，写入 `planRuns.status='failed'` + `summary='incognito 模式与登录准备互斥'` 并 HTTP 422。
- 详情写入 planRunCases 一条 `stepKind='login_prepare', status='failed'` 记录，错误信息带违规 caseId。

### 4.8 浏览器启动参数

- 默认（`windowStrategy='maximize'`）: `chromium.launch({ headless: true })` + `browser.newContext({ viewport: { width: 1280, height: 800 } })`。1280×800 作为 headless 下"最大化"近似值（已与用户对齐）。
- `windowStrategy='current'`: 不传 viewport（用 chromium 默认 1280×720）。
- `windowStrategy='custom'`: `viewport: { width, height }`。
- `incognito=true`: 新建 context 时不注入 `storageState`（与登录准备互斥）。

## 5. 数据流与契约

`executeCaseReal` 返回的 `ExecStepResult[]` 新字段:

```ts
export interface ExecStepResult {
  order: number;
  status: 'passed' | 'failed';
  durationMs: number;
  error?: string;
  screenshot?: string;
  warning?: string;
  // 新增：
  failureReason?: FailureReason;
  humanMessage?: string;
  hitLocator?: { kind: string; value: string };
  tabIndex?: number;
}
```

`reports` 表的 `step_results` 字段保持 `jsonb`，向后兼容：旧报告读取时没有新字段，UI 在明细模式下对这些字段显示 `—`。

preflight 报告通过 `reports.summary` 后追加一行（如 `preflight: urlReachable=false, originMismatch=true`），不破坏既有 summary 解析。

## 6. 错误处理策略

| 错误来源 | 处理 |
| --- | --- |
| 元素 disabled/loading/overlay/readonly | stability 检测抛错 → DOM 降级一次 → 仍失败归类 |
| 元素不可见 | click/fill 前 `waitFor({state:'visible'})` 已存在，不重复 |
| locator 全部失败 | 直接归类 `LocatorAllFailed`，不进入 DOM 降级（DOM 路径也是基于同一组 locator） |
| switchTab 目标已关 | URL 模糊匹配 → warning + 继续 |
| CDP 启动失败 | 进入 DOM 降级路径；仍失败归类 `CDPUnavailable` |
| 登录准备 × incognito | planRun 终止，不进入单用例 |

## 7. 前端改造

### 7.1 `ReportDetail.tsx`

- 顶部 Tab：截图模式（默认） / 明细模式。
- 明细模式表格列：`#` `动作` `步骤名` `目标` `耗时` `命中 Locator` `结果` `失败原因`。
- `命中 Locator` 列：hover 展示完整 `kind + value`；非交互动作显示 `—`。
- `失败原因` 列：标签 + 颜色；hover 弹气泡显示 `humanMessage`；可点击复制到剪贴板。

### 7.2 `CaseDetail.tsx`

新增 "执行设置" 区块（在描述/报告/录制 Tab 之间新位置，或折叠到「设置」抽屉内）:

- 窗口策略（Segmented：`默认最大化` / `当前窗口` / `自定义`）
- 自定义尺寸（仅当选择"自定义"时显示宽高输入）
- 无痕模式开关（Toggle）

提交走现有 `PATCH /api/cases/:id`（需要后端放行新字段）。

## 8. 测试计划

### 8.1 单元测试

- `stability.test.ts`: mock page.evaluate 返回不同 DOM 状态，断言分类正确；超时抛 `ElementNotStable(reason)`。
- `failureClassifier.test.ts`: 多种 error 字符串映射到正确 `FailureReason`。
- `domFallback.test.ts`: 单元测试覆盖 click/fill/check/select 的事件派发序列。

### 8.2 集成测试

- `execute-cdp.test.ts`（扩展）:
  - 用例模拟 disabled 按钮 → 断言 stepResult.failureReason=DisabledTimeout。
  - 用例 CDP 抛错 → 断言进入 DOM 降级路径，且 summary 写入 `CDPUnavailable`。
  - 多 tab 用例关闭其中一个 → 断言按 URL 模糊匹配成功。
- `cases.test.ts`: PATCH 用例时校验 `window_strategy=custom` 必须有 width/height。
- `plans.test.ts`: incognito + loginPrepareEnabled → 422 + `reason: incognito-conflicts-with-login-prepare`。

### 8.3 端到端手动验证

- 真实 chromium 跑一条包含 AntD loading 按钮的用例 → 报告明细模式能看到失败原因。
- 真实 chromium 跑一条含无痕 + 登录准备的 plan → 收到 422 错误。

## 9. 风险与边界

- **风险**: stability 检测在 page.evaluate 中执行祖先链扫描，频繁调用可能成为热点。**缓解**: 仅在 click/fill/check/select/upload 五个交互动作前调用，且默认超时 5s 轮询 100ms 上限 50 次。
- **风险**: DOM 降级路径会绕过真实鼠标事件，可能漏掉某些 hover 效果。**缓解**: 仅在 CDP 路径完全失败时使用一次；保留 warning 让排障能看到"走了 DOM 降级"。
- **边界**: CueCast 提到的 `iframe` 暂不纳入（与现有 iTest 一致）。
- **边界**: 登录准备 × 无痕 互斥以 planRun 终止为强约束；单用例单独执行时仅警告。

## 10. 兼容性与迁移

- Drizzle 迁移默认 `window_strategy='maximize'` / `incognito=false`，旧用例不需改动。
- 旧报告 `step_results` 缺新字段，UI 显示 `—`，不影响现有流程。
- PATCH `/api/cases/:id` 接受新字段，旧调用方不传也合法。
- `packages/shared` 增量导出，无 breaking change。

## 11. 不在本期范围

- AI 自动修复（基于 failureReason 调用 LLM 重写步骤）。
- 跨浏览器（firefox/webkit）。
- 离线用例回放（已落地的截图 + 报告回看足够）。
- iframe 上下文。
- 自定义稳定性等待参数（仅默认 timeout/poll，不开放配置）。
