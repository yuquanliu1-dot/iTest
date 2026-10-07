# iTest 移动端测试支持 设计稿

**日期**：2026-10-07
**状态**：设计稿，待用户审阅
**目标**：参考 `../e2e` 项目的移动端方案，给 iTest 增加「移动端测试」全链路支持：DSL/数据模型 → 执行引擎（agent-device） → web 内嵌设备预览与点选录制 → 报告/AI 助手/计划/dataset 适配。MVP 范围：**仅模拟器/虚拟机**（macOS 上的 iOS Simulator + Android Emulator；其它 OS 的 Android Emulator）。

参考：`/Users/lyq/workdir/codedev/e2e/docs/mobile.mdx` 与 `packages/mobile/README.md`。架构形态参考其 `engine()` 抽象与 `agent-device` 选型，但 DSL、schema、报告/AI 全部沿用 iTest 现有结构，不引入 `e2e` 本身的 TS 测试框架。

---

## 1. 背景与目标

iTest 当前仅支持 **Web 浏览器**回放（`apps/api/src/execute/cdp.ts` + `playwright-core` + Chrome 扩展录制）。MVP 在 README 中明确「移动端适配」不在范围内。

`../e2e`（TesterArmy 的 agentic testing 框架）已把移动端做到底：iOS Simulator / Android Emulator / 真机 / 设备云都通过同一个 `mobile()` engine + `agent-device` 跑通，统一在 `screen / expect / agent / device / app` 抽象后驱动。本设计以它为参考，但**只搬架构思想、不搬整套 e2e**：

- **搬**：engine 抽象（Engine interface 按 platform 路由）、设备 fixture（device = 权限/外观/网络/位置等原子管理）、重定向（app.bundleId / appPath / launchArgs 替代 url）、tap/swipe/longPress/doubleTap 等 mobile-only action、accessibility 定位（accessibilityId / label / predicate）、录制器改成「web 内嵌设备预览 + 点选」而非 Chrome 扩展。
- **不搬**：`e2e` 自己的 TS 测试 runner / BDD / agent 框架（iTest 已有自己的 aiTask + pi-agent + SSE agent 流）/ `mobileTools` 工具包（iTest 已有 aiTask 自然语言步骤生成）。

### 目标

1. case 可标注 `platform: 'web' | 'mobile'` 与 mobile 元数据（`platform`、`deviceName` 或 `deviceId`、`appRef={bundleId, appPath? , launchArgs?}`）。
2. 同一份 `StepAction` DSL 能被 web engine（playwright-core / chromium）与 mobile engine（agent-device）分别回放。
3. 在 web 应用里嵌一台模拟器/虚拟机实时画面 + accessibility 树点选生成 mobile step（取代 Chrome 扩展的移动端版）。
4. 报告、AI 助手、计划、dataset 全部感知 platform：报告 header 标明平台/设备；计划支持同构 web + mobile 多路并行；dataset 列对 mobile 同样生效；AI 助手 case2script / 自愈能识别 mobile 语义。
5. mobile 用例可选导出为 e2e `.e2e.ts` 形式（不打包到 MVP 必交付，但 schema/导出器入口预留）。

### 不做

- 真机（USB 连接 iPhone/Android 设备）。agent-device 支持，但本设计不接，避免 XCTest 签名 / adb USB 授权带来的环境复杂度。
- 云设备（EAS / 第三方 device farm）。agent-device 抽象 `DeviceProvider`，本设计预留 hook 但不实现。
- Expo dev client / `--initialUrl` / dev-server 启动命令（仅 bundleId + appPath + launchArgs；Expo 单独生态留给二期）。
- 屏幕录制 / 视频 artifact 优化（iTest 报告本就逐步截图，mobile 沿用截图，**不**导出 mp4）。
- 多 mobile 设备池并发（计划级 workers=1 起；并发只走「web + mobile 同计划并行」一种形态）。

---

## 2. 选型与依赖

| 维度 | 选型 | 备注 |
|---|---|---|
| 设备驱动 | `agent-device`（callstack 开源，e2e 引用） | 抽象 iOS/Android 设备单元 + daemon 进程，提供 tap / type / swipe / snapshot / setAppearance / setNetwork 等。 |
| iOS 通信 | `xcrun simctl` + WebDriverAgent 由 agent-device daemon 内部管理 | 不直接调 `xcrun`，避免锁死在某个 Xcode 版本。 |
| Android 通信 | `adb`（系统 PATH） + agent-device daemon | `adb` 由 Android SDK 提供；要求 ANDROID_SDK_ROOT 或 ANDROID_HOME 落到本机 Android SDK。 |
| 设备预览 | Web 端 `<iframe>` / `<img>` 嵌入 agent-device 提供的 `viewerUrl` | e2e 文档里写「session daemon 的 `viewerUrl`」可作为快照或视频流；iTest 直接展示并叠点选层。 |
| 移动端 DSL 形态 | 复用 `packages/shared/src/step-dsl.ts`，**新增** mobile-only action 子类型（`tap / longPress / doubleTap / swipe / setAppearance / setNetwork / setLocation / home / appOpen / appBack / appRestart`） + 定位策略扩展（`accessibilityId / label / predicate`） | 不另开 DSL 文件，与浏览器定位并列；kind 走 discriminated union。 |
| 数据库 schema | 走 `drizzle-kit generate` 生成同步迁移（沿用项目惯例） | 不走 `db push`。 |
| 后端架构 | Engine interface（apps/api/src/execute/engine.ts） + WebEngine（cdp.ts 包一层）+ MobileEngine（agent-device 包装） | runCase 按 platform 路由，路径改动最小。 |

新增 npm 依赖：
- `apps/api`：`agent-device`（^与 e2e 引用同版本）— 仅 dev/runtime，不是 devDependency。
- `apps/web`：无新增依赖（iframe + 点选层用 React + Tailwind）。

`agent-device` 启动失败（未安装 Xcode 模拟器 / 未装 Android SDK）→ 启动 mobile 用例时直接落 `EngineUnavailable` failed report，**不**改 web 路径；UI 在「执行」按钮旁显示「设备未就绪」红字 tooltip。

---

## 3. 仓库结构

新增/改动如下：

```
iTest/
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── execute/
│   │       │   ├── engine.ts                 ★ 新增：Engine interface + RunCtx + ExecResult
│   │       │   ├── webEngine.ts              ★ 新增：把 executeCaseReal 包成 WebEngine
│   │       │   ├── mobileEngine.ts           ★ 新增：MobileEngine（agent-device 封装）
│   │       │   ├── agentDeviceClient.ts      ★ 新增：agent-device SDK 进程/spawn/协议封装
│   │       │   ├── deviceSnapshot.ts         ★ 新增：把 agent-device snapshot 转 Locator 候选
│   │       │   ├── cdp.ts                    改动：抽出 dispatch + executeCaseReal 为函数导出
│   │       │   └── runCase.ts                改动：按 platform 路由到对应 engine
│   │       ├── services/
│   │       │   └── deviceTargets.service.ts  ★ 新增：device_targets CRUD（项目级）
│   │       └── routes/
│   │           └── deviceTargets.ts          ★ 新增：REST 路由
│   └── web/
│       └── src/
│           ├── features/
│           │   └── mobile-recorder/          ★ 新增：iframe + 点选层组件
│           ├── pages/
│           │   ├── CaseDetail.tsx            改动：case 元数据加 platform/appRef，录制器根据 platform 切换
│           │   └── DeviceTargetsPage.tsx     ★ 新增：项目级设备目标 CRUD
│           └── api/
│               └── deviceTargets.ts          ★ 新增：API client
├── packages/
│   └── shared/
│       └── src/
│           └── step-dsl.ts                   改动：增 mobile action + LocatorStrategy
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-10-07-mobile-testing-design.md  ★ 本文档
```

不引入新 monorepo 包（`packages/executor` 之类）。理由：iTest 已经共享 step DSL，`engine.ts` 仅作为 `apps/api` 内部实现，与 `packages/shared` 形态不冲突；让 web 包不必反向依赖 backend 内部抽象。

---

## 4. 数据模型

新增两张表、扩展三张表。所有变更走 `drizzle-kit generate` 出 migration，**禁止 push**。

### 4.1 `test_cases` 扩展

新增列（nullable，向后兼容；现有 web 用例全部 `platform='web'` 默认）：

```ts
platform: varchar('platform', { length: 16 }).notNull().default('web'), // 'web' | 'mobile'
mobileOs: varchar('mobile_os', { length: 16 }),                         // 'ios' | 'android'（platform='mobile' 必填）
mobileDeviceTargetId: uuid('mobile_device_target_id').references(() => deviceTargets.id, { onDelete: 'set null' }),
appRef: jsonb('app_ref').$type<{ bundleId: string; appPath?: string; launchArgs?: string[] } | null>(),
```

- `appRef.bundleId`：必填（mobile case 必填；web case 忽略）。
- `appRef.appPath`：可选，提供时引擎先 installApp 再 open。
- `appRef.launchArgs`：每次 `appOpen` 都带，agent-device 文档语义一致。
- `url` / `defaultUrl` 列对 mobile 无意义但保留（mobile case `url=null`）。mobile case 不需要 environment（`defaultEnvId` 允许 null）。

### 4.2 `reports` 扩展

```ts
platform: varchar('platform', { length: 16 }).notNull().default('web'),
mobileOs: varchar('mobile_os', { length: 16 }),
deviceName: varchar('device_name', { length: 128 }),     // 'iPhone 17 Pro Simulator' / 'Pixel_7_API_34'
deviceTargetId: uuid('device_target_id').references(() => deviceTargets.id, { onDelete: 'set null' }),
```

落库时机：`runCase` 解析出 platform 后在 report insert 时一并写入；web report 维持 `platform='web'` 不感知列。

### 4.3 `test_steps` 扩展

```ts
mobileOs: varchar('mobile_os', { length: 16 }),          // null 表示 web（默认）；mobile step 必填
```

`compiled[i].kind` 自然区分 web/mobile；该列只用于 UI 在 step list 上渲染 platform badge 与录制器过滤，避免回放点把 web step 误送 mobile engine。

### 4.4 `device_targets` 新表

```ts
deviceTargets = pgTable('device_targets', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 128 }).notNull(),               // 'iPhone 17 Pro (Sim)'
  mobileOs: varchar('mobile_os', { length: 16 }).notNull(),       // 'ios' | 'android'
  deviceRef: varchar('device_ref', { length: 128 }).notNull(),    // 名称/UDID/serial
  appBundleId: varchar('app_bundle_id', { length: 256 }),         // 可选默认 bundle
  appPath: text('app_path'),                                      // 可选默认 .app/.apk 路径（项目相对/绝对）
  launchArgs: jsonb('launch_args').$type<string[]>().default([]),
  createdAt / updatedAt,
}, (t) => ({
  uniqByProjectName: uniqueIndex('uq_device_target_project_name').on(t.projectId, t.name),
}));
```

- **项目级**作用域：与 project 一对一可空外键；project 删除时级联清；一个 device target 可被多个 case 复用（mobile 用例执行时选 target）。
- mobileOs='ios' 时 `deviceRef` 解析为 simulator name 或 UDID；'android' 时为 emulator name 或 adb serial。agent-device daemon 协议与 e2e 一致。

### 4.5 `plan_cases` 扩展（计划级并发）

```ts
targetOverride: jsonb('target_override').$type<{ deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null>(),
```

`runPlan` 同 plan 可混合 web + mobile case，按各自 platform/engine 派发；`workers` 控制 platform case 的并发上限（本 MVP 仍 `workers=1`，mobile case 与 web case 串行）。

---

## 5. Step DSL 扩展

`packages/shared/src/step-dsl.ts` 增项：

### 5.1 `LocatorStrategy` 增 mobile 策略

```ts
export const LocatorStrategy = z.enum([
  'role', 'text', 'testId', 'css', 'xpath',         // web
  'accessibilityId', 'label', 'predicate',          // mobile-only
]);
```

- `accessibilityId`：iOS `accessibilityIdentifier`、Android `resource-id`；agent-device `getByTestId` 的语义等价。
- `label`：iOS `accessibilityLabel`、Android `content-desc`。
- `predicate`：iOS `NSPredicate`、Android `UiSelector` 风格的原始字符串，由 agent-device 解析。
- Web 回放路径在 `buildCandidates` 里把这三种直接标 `unsupportedOnPlatform`，避免误用。

### 5.2 新增 mobile action（全部进 `StepAction` discriminated union）

```ts
export const TapAction = z.object({
  kind: z.literal('tap'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  /** 双击 / 长按时填；默认 tap */
  doubleTap: z.boolean().optional(),
  longPressMs: z.number().int().min(100).max(5000).optional(),
});
export const SwipeAction = z.object({
  kind: z.literal('swipe'),
  from: z.array(Locator).min(1),     // 起点节点（agent-device 取 bounds 中心）
  to: z.array(Locator).min(1),       // 终点节点
  /** swipe 持续时长（ms）；移动端 swipe gesture 通常 300ms */
  durationMs: z.number().int().min(50).max(3000).default(300),
});
export const SetAppearanceAction = z.object({
  kind: z.literal('setAppearance'),
  mode: z.enum(['light', 'dark']),
});
export const SetNetworkAction = z.object({
  kind: z.literal('setNetwork'),
  state: z.enum(['online', 'offline', 'airplane']),
});
export const SetLocationAction = z.object({
  kind: z.literal('setLocation'),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export const AppOpenAction = z.object({
  kind: z.literal('appOpen'),
  /** 为 null 时用 caseRow.appRef.bundleId */
  bundleId: z.string().optional(),
});
export const AppBackAction = z.object({ kind: z.literal('appBack') });
export const AppRestartAction = z.object({ kind: z.literal('appRestart') });
export const HomeAction = z.object({ kind: z.literal('home') });
```

`click` / `fill` / `check` / `select` / `assertText` / `assertVisible` / `screenshot` / `waitFor` / `extract` 等 web action **复用**，但 dispatcher 按 platform 路由：mobile 路径下：

- `click` → `tap(doubleTap=false)`
- `fill` → 清空 + `pressSequentially`（agent-device 的 `fill`）
- `assertText` → `expect(...).toHaveText(...)`；支持 `text=android.widget.TextView` 等价文本节点
- `screenshot` → 走 mobile path（详见 §7）
- `extract` / `select` / `check` 不支持时落 `UnsupportedOnPlatform` 失败步

mobile-only action 在 web engine dispatcher 中直接抛 `wrong-platform` 错误，UI 上禁用生成。

### 5.3 `IntentLocator` 不动

web 的 `semanticRole / contextText` 在 mobile 仍然适用（accessibility label / name 与 web 的 aria-label 接近；mobile 录制时 `deriveSemantic` 也填这两字段）。

---

## 6. 执行引擎（Engine interface）

新增 `apps/api/src/execute/engine.ts`：

```ts
import type { ExecStepResult, ExecContext, CaseWindow } from './cdp.js';

export interface EngineInput {
  caseId: string;
  caseTitle: string;
  caseUrl: string | null;
  expectedOutcome: string | null;
  steps: { order: number; assertion: unknown; delayMs: number | null; id: string; tabRef: string | null;
            componentKind: string | null; sensitive: boolean; compiled: unknown[] | null | undefined; mobileOs?: string | null }[];
  envCtx?: import('./envContext.js').EnvCtx;          // web only）
  initialVars?: Record<string, string>;
  sensitiveVarKeys?: string[];
  rowPlan?: { rowIndex: number; snapshot: unknown; vars: Record<string, string>; sensitiveVarKeys: string[] };
  reportId: string;
  projectId: string | undefined;
  caseWindow: CaseWindow;                            // web only，mobile 忽略
  incognito: boolean;                                // web only，mobile 忽略
  appRef?: { bundleId: string; appPath?: string; launchArgs?: string[] } | null;
  deviceTargetId?: string;                           // mobile only
}

export interface Engine {
  /** 平台 id：'web' | 'mobile' */
  readonly platform: 'web' | 'mobile';
  /** 执行完整用例；返回 stepResults + preflight 报告（移动端不实现 preflight） */
  execute(input: EngineInput, targetUrl?: string, preflightSink?: (r: unknown) => void): Promise<ExecStepResult[]>;
  /** 准备资源（启动浏览器/设备 daemon），失败抛 EngineUnavailable */
  prepare(input: EngineInput): Promise<void>;
  /** 释放资源；幂等 */
  release(input: EngineInput): Promise<void>;
}
```

实现：

- `WebEngine`：`cdp.ts` 当前 `executeCaseReal` / `executeCaseInBrowser` / `dispatch` 整套迁入；cdp.ts 仅保留 `dispatch` 导出。`runCase.ts` 改 import `WebEngine.execute`。
- `MobileEngine`：基于 `agent-device` SDK。`prepare` 启动 daemon + acquire device（按 deviceTargetId 解析 agent-device session）；`execute` 按 step 循环调 agent-device client（详见 §7）。完成后 `release` 释放。

`runCase` 主流程不变：

1. 读 caseRow.platform / mobileOs / deviceTargetId / appRef。
2. 选 engine：`platform === 'web'` → WebEngine；`mobile` → MobileEngine。
3. 调用 `engine.prepare`；失败 → 写 EngineUnavailable failed report（保持现在的 CDPUnavailable 形态）。
4. 调用 `engine.execute`；捕错同样转 failed report。
5. `finally` 调 `engine.release`。

不变量：

- WebEngine 路径零行为变化（除 dispatch 从 cdp.ts 顶层 export 改为从 webEngine export）。
- runCase / runPlan / dataset 任何路径都先判 platform 再路由。

---

## 7. MobileEngine 实现（基于 agent-device）

agent-device SDK 的 protocol（e2e 文档与 README 共述）：

- spawn 一个 daemon 进程（stdio / TCP），暴露 snapshot / tap / swipe / setAppearance / setNetwork / appOpen / setLocation 等命令。
- 一个 session 同时驱动一台设备；iOS device pool 由 session 区分。
- 返回每条命令的 redacted screenshot（敏感输入框黑底覆盖）+ accessibility tree snapshot。

iTest MobileEngine 关键点：

1. **daemon lifecycle**：`prepare` 起一个 per-report daemon（沿用 e2e 的「One daemon per run」模式，复用一个 session 直到 report 结束）。`agent-device` spawn 失败 → `EngineUnavailable`。
2. **appOpen**：如果 `appRef.appPath` 存在，先 `device.installApp(appPath)` 再 `device.openApp(bundleId)`；之后每条 AppOpen / AppBack / AppRestart 按命令调。
3. **step → 命令映射**（独立列表，原文档数字标号统一 1/2/3/4）：
   - `tap`：直接 snapshot bounds → 算中心点 → agent-device `tap({x, y, doubleTap, longPressMs})`
   - `swipe`：from/to bounds 中心 → agent-device `swipe({fromX, fromY, toX, toY, durationMs})`
   - `fill`：agent-device `screen.getByLabel(...).fill(value)` 或 `screen.getByTestId(...).fill(...)`；sensitive 走 `type_secret`
   - `assertText`：agent-device `expect(...).toHaveText(...)`；target=page 时 fallback 到当前 screen fullText
   - `assertVisible`：`expect(...).toBeVisible()`
   - `screenshot`：每步执行完自动产生 redacted screenshot（agent-device 内置），路径落到 `apps/api/screenshots/<reportId>/<stepOrder>.png`，与 web 路径一致
   - `setAppearance / setNetwork / setLocation / home / appBack / appRestart`：直接转发命令
4. **error propagation**：每条 step 出错转 `ExecStepResult`（`failureReason='MobileStepFailed'`，humanMessage=agent-device 原始 message；字段 `screenshot` 指向 redacted screenshot 路径）。**不**抛到 caller；caller 永远收齐所有 stepResults。
5. **vision 终态判定**：移动端复用 `expectedOutcome`：mobile 执行完最后一步后，若 `expectedOutcome` 非空，调一次 `expect(currentScreen).toMatchScreenshot(expectedOutcome)`（agent-device 不支持 vision，**改**为「最后一帧 redacted screenshot + LLM vision」—— 复用 cdp.ts 的 vision 逻辑：`apps/api/src/execute/visionAssert.ts` 抽出共用函数；web 与 mobile 共用 visionAssert 调用）。
6. **dataset rowPlan**：mobile 路径下 dataset 与 web 等价；`loadDatasetForRun` 不改。

不变量：

- agent-device 任何命令失败都带原生 message + hint，不包成 iTest 自己的文案（保留调试可读性）。
- screenshot 文件名约定：`<reportId>/<stepOrder>.png`（web 现已用 `0.png / 1.png / …`；mobile 沿用，避免 reports 页 viewer 路径分支）。
- agent-device daemon 输出语言英文；failureReason 仍用 iTest 枚举（新增 `EngineUnavailable / MobileUnsupportedCapability`）。

---

## 8. 移动端录制器（web 内嵌预览 + 点选）

不引入新的 Chrome 扩展。新增 `apps/web/src/features/mobile-recorder/`。

### 8.1 设备预览源

agent-device daemon 在 acquire 阶段返回 `viewerUrl`（HTTP(s) 流；e2e 文档描述）。web 端 `iframe src=viewerUrl` 内嵌。iframe 不带 cookie，可信区为 `localhost`。

> 注意：e2e 文档里 `viewerUrl` 是 daemon 暴露的 screencast 或 screenshot 流；agent-device 实际协议可能为单图刷新（poll）或 MJPEG。本设计**仅假设** iframe 能加载（具体协议待实现时由 agent-device SDK 决定）。

### 8.2 点选流程

录制器核心是一个 React 组件 `<MobileRecorder target={deviceTarget} caseId={caseId}>`：

1. 进入 case 详情 → 「录制补充」按钮：根据 `caseRow.platform` 显示「录制 Web」或「录制 Mobile」。Mobile 路径下弹出 modal，内含：
   - 顶部 toolbar：设备选择下拉（项目 device_targets）、「启动 / 关闭 daemon」按钮、「清屏」「Home」「App Back」按钮。
   - 中央 iframe（viewerUrl）。
   - 右侧 accessibility tree panel：每 500ms 通过 agent-device `snapshot` 拉一次（轻量），列在右侧树；树节点显示 label / accessibilityId / role（iOS Button → 「button」）。
   - 步骤编辑抽屉（沿用现有 web 的 step drawer）：从右侧树点选节点即把 accessibilityId / label / role 生成 step，kind 默认 tap；同时与 web 录制器一样支持「AI 自然语言」按钮（看 aiTask），把 aiTask 接到 mobile 当前 snapshot 上。
2. 提交：与 web 录制器走同一 `finish()` 流程（POST `/recorder/finish`），把生成的 steps 写入 `test_steps`（`mobileOs='ios'|'android'` 落库）。

### 8.3 不变量

- web 录制器（Chrome 扩展）零变化。
- mobile 录制只产生 mobile-only action 与 mobile 定位（accessibilityId / label / predicate）；不污染 web 路径。
- agent-device 任何 snapshot / tap 命令的鉴权走 iTest 当前 recorder session 模式（与现有 ws.ts 一致；mobile 录制器沿用 `apps/api/src/recorder/ws.ts` 的 token 协议）。

---

## 9. 报告 / AI 助手 / 计划 / dataset 适配

### 9.1 报告

- ReportDetail header 标注 platform / deviceName：「📱 iPhone 17 Pro Simulator · iOS」。
- step list 渲染时按 `compiled[i].kind` 分组渲染；mobile action 显示 bounds 截图缩略图（agent-device 自动产出）+ 当前 accessibility tree 摘要。
- visionAssert 字段对 mobile 同样生效（共用 visionAssert）。

### 9.2 AI 助手（case2script / 自愈）

- `apps/api/src/agent/prompts/step-dsl-spec.ts` 增 mobile context：「platform=mobile 时优先 accessibilityId / label，回避 css 修饰符」。
- 「AI 补充步骤」按钮在 mobile case 时仍生成 step，但 step kind 默认 tap，且在生成的 step 里加 `mobileOs='ios'|'android'`。
- 自愈（aiTask）支持 mobile：system prompt 增「snapshot 是 accessibility tree；坐标取 bounds.center」。
- 自然语言指令支持 tap/swipe 关键词（"swipe up"、"long press the save button"）。

### 9.3 计划（runPlan）

- plan_cases 增 `targetOverride`（deviceTargetId 可覆盖 case 级）。runPlan 按 caseRow.platform 分派到 webEngine / mobileEngine。`workers` 控制并发上限；MVP 默认 `workers=1`，mobile case 与 web case 串行。
- planRun header 显示「web 1 / mobile 2 / total 3」进度。

### 9.4 dataset

- `loadDatasetForRun` / `DatasetRowExec` 零改动；mobile case 走 dataset 时 `initialVars` / `sensitiveVarKeys` 同样生效。
- mobile engine 在 dispatch step 前注入 `initialVars`（与 web 路径一致）。
- 数据集 UI（DatasetsPage / 编辑器）感知 platform 列：mobile case 绑定数据集时编辑器列出 mobile 语义变量名集合（如 `username_ios / username_android`）；不再用 web 专属的「列名校验」。
- 计划运行报告显示 mobile row 报告。

### 9.5 用例导出（可选，schema 预留）

- `GET /cases/:id/export-e2e`（**MVP 不做实现，仅 schema 留位置**）：返回 `{ bundleId, appRef, steps: [{ action, locator, ... }] }` JSON，由 e2e 项目的 CLI 适配器读取生成 `.e2e.ts`。
- 不引入 `e2e` SDK 到 iTest。

---

## 10. 错误处理与失败归类

新增 `FailureReason`：

- `EngineUnavailable`：mobile daemon 起不来 / 设备不可达；`humanMessage` 含 agent-device 原始 hint（"npx agent-device doctor"）。
- `MobileUnsupportedCapability`：mobile engine 不支持该 step kind（如 mobile 的 `select` 不支持某些 iOS wheel picker）；`humanMessage` 含 "改用 tap swipe" 提示。
- `MobileStepFailed`：agent-device 命令失败；`humanMessage` = agent-device 原始 message。
- `AppInstallFailed`：`device.installApp` 失败；`humanMessage` 含 "检查 appPath 是否存在且签名正确"。

mobile 不支持 `NetworkUnavailable / OriginMismatch`（preflight 跳过，UI 在执行前红字「无 preflight 报告」）。

### 10.1 兼容边界

- 真机 / 云设备：device_targets 表预留字段（deviceRef 不限 simulator），但本 MVP 不实现相关 driver。deviceRef='iPhone-真机名' 时 engine 仍尝试启动；agent-device 会自己报 unsupported，落到 EngineUnavailable。
- 多 device pool 并发：device_targets 允许多个；runPlan MVP 不实现 pool pick。
- `appRef.launchArgs` 长度上限 50（与 e2e 一致）。
- 同一 case 平台冲突：mobile case 不允许 url / defaultEnvId 非空；caseRow save 路径做一次性校验。

---

## 11. 测试

### 11.1 单测

- `apps/api/test/mobile-engine.test.ts`：
  - `MobileEngine.prepare` 在 agent-device 不可用（mock spawn 抛错）时抛 `EngineUnavailable`。
  - mobile step dispatch 单元（mock agent-device client）→ tap / swipe / fill / assertText / setAppearance / setNetwork 全部落 stepResults，无抛错。
  - dataset rowPlan 注入 `initialVars`；sensitiveVarKeys 错误信息打码。
- `apps/api/test/runCase.runCase.test.ts`（扩展）：
  - platform='mobile' 路由到 MobileEngine。
  - platform='web' 路由到 WebEngine（沿用现有断言，零行为变化）。
- `apps/api/test/device-targets.test.ts`：
  - CRUD；unique(name) 约束；projectId 级联清。
- `packages/shared/test/step-dsl.test.ts`（扩展）：
  - 增 mobile action 解析合法；web 解析拒绝 mobile kind。
- `apps/web/src/features/mobile-recorder/__tests__/`：
  - 点选节点生成 tap step；kind 默认 tap；accessibilityId 写入 strategies。

### 11.2 集成 / E2E

- `apps/api/probe-mobile.mjs`：spawn 一个临时 iOS Simulator（agent-device 自带 `prepare ios-runner`），跑「启动 Settings → 切深色 → 截图」三条 step 的 mobile 用例，校验 report status='passed'、screenshots 目录产出 png。
- `pnpm verify` 全量通过（web + mobile 双路径不互扰）。
- dev api 起动：`pnpm dev` 后 `curl POST /cases/<id>/run` 跑 mobile 用例无报错（无 Xcode 环境下用 Android 模拟器）。

### 11.3 Vitest 注意事项

按已有 memory（`vitest --no-file-parallelism`）：mobileEngine 引入 agent-device SDK 后部分 mock 依赖；统一保留 `--no-file-parallelism`（与项目惯例一致）。

---

## 12. 风险与备选

| 风险 | 备选 |
|---|---|
| agent-device daemon 协议与 e2e 描述不完全一致（viewerUrl 形态、daemon 端口、snapshot 协议） | 实现时优先看 `packages/mobile/src/*.ts` 与 README；不可读处先 mock，待 SDK 真实环境搭起来再联调 |
| `iframe viewerUrl` 在 iOS Simulator 上时延高（snapshot 5fps） | 退路：直接轮询后端 SDK 拉最新 png 当 `<img src>` 展示；点选走 `device.locator('bounds=...')` 命中 |
| agent-device iOS runner 需要 Xcode signing（即使 simulator 也要 `developer mode` 开启） | 文档引导 + 启动时 `npx agent-device doctor` 自检；模拟器环境（无 signing）应 OK |
| 多台 device 并发：单 daemon 单 session 局限 | MVP 默认 workers=1；并发走「web + mobile 同 plan」单 daemon 串行；二期再拆 pool |
| mobile 用例的 dataset 注入变量名与 web 不一致（mobile 常见 `deviceName`） | 易与现有 dataset 协议兼容；变量名不做平台区分，运维自查 |

---

## 13. 交付清单（按依赖排序）

1. `packages/shared/src/step-dsl.ts` 增 mobile action + LocatorStrategy；同 package test。
2. `apps/api` 新增 `engine.ts`（interface）+ `webEngine.ts`（把 cdp.ts 内容包成 WebEngine）；cdp.ts 仅保留 export；runCase 路由 platform。
3. db migration：`test_cases` / `reports` / `test_steps` / `plan_cases` 扩列；`device_targets` 新表。
4. `apps/api` 新增 `agentDeviceClient.ts` / `deviceSnapshot.ts` / `mobileEngine.ts`；`visionAssert.ts` 抽出共用。
5. `apps/api/src/services/deviceTargets.service.ts` 与 `apps/api/src/routes/deviceTargets.ts`；REST。
6. `apps/web` DeviceTargetsPage + API client。
7. `apps/web` MobileRecorder 组件 + CaseDetail 接入。
8. AI prompt `step-dsl-spec.ts` / 自愈 prompt 加 mobile context；自愈 system prompt 加 mobile snapshot 语义。
9. report 页 header 渲染 platform / deviceName。
10. dataset 列表 + 编辑器感知 platform；plan header 报「web X / mobile Y」。
11. `export-e2e` schema 预留；MVP 不实现。
12. 单测 / 集成脚本 / 文档（README 更新移动端章节）。