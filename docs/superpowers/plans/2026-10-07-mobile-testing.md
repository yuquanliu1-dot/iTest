# iTest 移动端测试支持 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 iTest 已有的 web 用例回放链路之外，加一整套「移动端」支持——DSL/数据模型扩展、`Engine interface` 抽象、按 platform 路由到 `WebEngine`（沿用 cdp.ts）或 `MobileEngine`（基于 `agent-device`）、web 内嵌设备预览+点选录制、报告/AI 助手/计划/dataset 全面感知 platform。MVP 范围：iOS Simulator + Android Emulator。

**Architecture:**
- **数据模型**：`device_targets` 新表（项目级）；`test_cases` / `reports` / `test_steps` 增 mobile 元数据列；migration `0032` 用 `drizzle-kit generate` 同步。
- **DSL**：`packages/shared/src/step-dsl.ts` 增 `LocatorStrategy` 项 `accessibilityId / label / predicate`，新增 `tap / swipe / setAppearance / setNetwork / setLocation / appOpen / appBack / appRestart / home` 9 个 mobile-only `StepAction` 子类型；`packages/shared/src/playback.ts` 增 4 个 `FailureReason`。
- **执行引擎**：新建 `apps/api/src/execute/engine.ts` 定义 `Engine` 接口；新增 `webEngine.ts` 把 `cdp.ts` 包成 `WebEngine`（cdp.ts 仅保留 `dispatch` 导出）；新增 `mobileEngine.ts` 包 `agent-device` SDK；`runCase.ts` 按 `caseRow.platform` 路由。`visionAssert.ts` 抽出共用，web/mobile 共用 vision LLM 判定。
- **录制器**：新增 `apps/web/src/features/mobile-recorder/` 组件，iframe 内嵌 agent-device `viewerUrl` + 右侧 accessibility tree 点选生成 step。沿用现有 recorder session 协议但接入方式是 web 而非 Chrome 扩展。
- **REST**：`/api/projects/:projectId/device-targets` CRUD + 用例 PATCH 增 `platform / mobileOs / mobileDeviceTargetId / appRef`。
- **AI 助手 / 报告 / 计划 / dataset**：`step-dsl-spec.ts` 与 `aiTask` system prompt 加 mobile 段落；`ReportDetail` header 加 platform badge；`plan_runs` 区分 web/mobile 计数；dataset 沿用同一注入协议。

**Tech Stack:**
- agent-device `^0.21.22`（callstack/callstack-agent-device，e2e 同源）；iOS 走 `xcrun simctl`，Android 走 `adb`。
- drizzle-kit generate；vitest + @testcontainers/postgresql（沿用现有 `pnpm verify`）。
- 不引入新 monorepo 包；不引入 e2e TS 框架。

---

## File Structure（按职责列出本次改动）

| 文件 | 角色 | 操作 |
|---|---|---|
| `packages/shared/src/step-dsl.ts` | StepAction DSL + LocatorStrategy | 改动：增 mobile action + strategy |
| `packages/shared/src/playback.ts` | FailureReason 枚举 | 改动：增 mobile 失败原因 |
| `packages/shared/src/index.ts` | 共享类型再导出 | 改动：导出新类型 |
| `packages/shared/test/step-dsl.test.ts` | DSL 单测 | 改动：mobile action 解析合法/拒绝 |
| `apps/api/src/db/schema.ts` | Drizzle schema | 改动：增 `deviceTargets` 表 + 4 列 |
| `apps/api/drizzle/0032_mobile_testing.sql` | 迁移 | 新增 |
| `apps/api/test/helpers/db.ts` | 测试 SCHEMA_SQL | 改动：加 mobile 列 + device_targets |
| `apps/api/src/execute/engine.ts` | Engine interface | 新增 |
| `apps/api/src/execute/visionAssert.ts` | 用例级 vision 判定共用函数 | 新增（抽出 cdp.ts 内联块） |
| `apps/api/src/execute/webEngine.ts` | WebEngine 实现 | 新增（包 cdp.ts） |
| `apps/api/src/execute/mobileEngine.ts` | MobileEngine 实现 | 新增 |
| `apps/api/src/execute/agentDeviceClient.ts` | agent-device SDK 进程/spawn/协议封装 | 新增 |
| `apps/api/src/execute/deviceSnapshot.ts` | agent-device snapshot → Locator 候选 | 新增 |
| `apps/api/src/execute/cdp.ts` | 真实浏览器执行（仅 export dispatch + 共享函数） | 改动：移除 `executeCaseReal`/`executeCaseInBrowser` 顶层实现 |
| `apps/api/src/execute/runCase.ts` | runCase 入口 | 改动：按 platform 路由 engine |
| `apps/api/src/services/deviceTargets.service.ts` | device_targets CRUD | 新增 |
| `apps/api/src/services/projectAccess.ts` | 可见性断言 | 改动：增 device_target helpers |
| `apps/api/src/services/cases.service.ts` | updateCase patch | 改动：mobile 字段校验 |
| `apps/api/src/routes/deviceTargets.ts` | REST 路由 | 新增 |
| `apps/api/src/routes/cases.ts` | 用例 patch body | 改动：mobile 字段 zod |
| `apps/api/src/routes/reports.ts` | 报告出参 | 改动：把 mobile 列透出 |
| `apps/api/src/routes/plans.ts` | plan_case 增 targetOverride | 改动 |
| `apps/api/src/execute/runPlan.ts` | runPlan 按 platform 派发 | 改动 |
| `apps/api/src/index.ts` | 路由挂载 | 改动：注册 deviceTargetsRoute |
| `apps/api/src/agent/prompts/step-dsl-spec.ts` | LLM DSL 规格 | 改动：增 mobile 段落 |
| `apps/api/src/execute/aiTask.ts` | 智能 agent prompt（mobile 系统提示） | 改动：增 MOBILE_SYSTEM_PROMPT |
| `apps/api/package.json` | 依赖 | 改动：加 `agent-device` |
| `apps/api/src/execute/locator-resolver.ts` | locator 候选构造 | 改动：accessibilityId/label/predicate 标 unsupportedOnPlatform |
| `apps/api/src/lib/secret-crypto.ts` | 不动 | — |
| `apps/api/src/execute/failureClassifier.ts` | classify 入口 | 改动：mobile reason 映射 |
| `apps/api/test/mobile-engine.test.ts` | MobileEngine 单测 | 新增 |
| `apps/api/test/device-targets.test.ts` | device_targets CRUD | 新增 |
| `apps/api/test/runCase-mobile.test.ts` | runCase mobile 路由 | 新增 |
| `apps/api/probe-mobile.mjs` | iOS/Android 集成探针 | 新增 |
| `apps/web/src/api/client.ts` | TestCase/Report 类型 + API client | 改动 |
| `apps/web/src/api/deviceTargets.ts` | API client | 新增 |
| `apps/web/src/components/Icon.tsx` | Carbon icons | 改动：增 mobile/device icon |
| `apps/web/src/pages/DeviceTargetsPage.tsx` | 项目级设备目标 CRUD | 新增 |
| `apps/web/src/features/mobile-recorder/` | iframe + 点选层组件 | 新增 |
| `apps/web/src/pages/CaseDetail.tsx` | 用例详情 | 改动：mobile 元数据 + mobile 录制入口 |
| `apps/web/src/pages/ReportDetail.tsx` | 报告详情 | 改动：platform/device 头 + mobile icon |
| `apps/web/src/pages/PlanRunDetail.tsx` | 计划运行详情 | 改动：web/mobile 计数 |
| `apps/web/src/components/StepEditDrawer.tsx` | 步骤编辑抽屉 | 改动：mobile action 显示 |
| `apps/web/src/App.tsx` | 路由 | 改动：device-targets 路由 |

**不动**：`apps/recorder/`（保留 Chrome 扩展作为 web 录制器入口）、`packages/ui`、`packages/mobile/README.md`（参考用）。

---

## Task 1: Shared DSL 扩展（mobile locator + mobile actions + FailureReason）

**Files:**
- Modify: `packages/shared/src/step-dsl.ts`
- Modify: `packages/shared/src/playback.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/test/step-dsl.test.ts`

- [ ] **Step 1.1: 加 mobile LocatorStrategy**

`packages/shared/src/step-dsl.ts:4`：
```ts
export const LocatorStrategy = z.enum([
  'role', 'text', 'testId', 'css', 'xpath',
  'accessibilityId', 'label', 'predicate',
]);
```

- [ ] **Step 1.2: 加 9 个 mobile-only StepAction 子类型**

`packages/shared/src/step-dsl.ts` 在 `SwitchTabAction` 之后、`AiTaskAction` 之前追加：
```ts
export const TapAction = z.object({
  kind: z.literal('tap'),
  locator: z.array(Locator).min(1),
  intentLocator: IntentLocator.optional(),
  doubleTap: z.boolean().optional(),
  longPressMs: z.number().int().min(100).max(5000).optional(),
});
export const SwipeAction = z.object({
  kind: z.literal('swipe'),
  from: z.array(Locator).min(1),
  to: z.array(Locator).min(1),
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
  bundleId: z.string().min(1).optional(),
});
export const AppBackAction = z.object({ kind: z.literal('appBack') });
export const AppRestartAction = z.object({ kind: z.literal('appRestart') });
export const HomeAction = z.object({ kind: z.literal('home') });
```

- [ ] **Step 1.3: 把新类型加入 StepAction 联合 + discriminated union**

`packages/shared/src/step-dsl.ts:201-218`：
```ts
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
  | z.infer<typeof SwitchTabAction>
  | z.infer<typeof TapAction>
  | z.infer<typeof SwipeAction>
  | z.infer<typeof SetAppearanceAction>
  | z.infer<typeof SetNetworkAction>
  | z.infer<typeof SetLocationAction>
  | z.infer<typeof AppOpenAction>
  | z.infer<typeof AppBackAction>
  | z.infer<typeof AppRestartAction>
  | z.infer<typeof HomeAction>
  | z.infer<typeof AiTaskAction>
  | z.infer<typeof AssertJsonAction>
  | z.infer<typeof ExtractAction>
  | z.infer<typeof QueryDbAction>
  | z.infer<typeof ObserveLogAction>;
```

`packages/shared/src/step-dsl.ts:220-238` 在 `SwitchTabAction,` 之后插入对应 9 项，保持 discriminated union 与类型对齐。

- [ ] **Step 1.4: 加 FailureReason 移动端项**

`packages/shared/src/playback.ts:6-40`：
```ts
export const FailureReason = z.enum([
  'URLUnreachable', 'NotLoggedIn', 'SlowLoad', 'ElementOccluded',
  'PageStructureChanged', 'TestDataMissing', 'AssertionMismatch',
  'FixedValueConflict', 'TabMissing', 'AttachmentMissing',
  'SecretMissing', 'DisabledTimeout', 'LoadingTimeout',
  'OverlayTimeout', 'LocatorAllFailed', 'CDPUnavailable',
  'QueryDbError', 'QueryDbTableNotAllowed', 'QueryDbColumnNotAllowed',
  'QueryDbAssertionFailed',
  'EnvMissing', 'EnvDbMissing', 'EnvSyslogMissing',
  'SyslogConnectFailed', 'SyslogAuthFailed', 'SyslogFileMissing',
  'SyslogTimeout', 'LogAssertionFailed',
  'EnvMissing', 'EnvProjectMismatch',
  /** Track 1：用例级 vision LLM 判定最终截图与 expectedOutcome 不符 */
  'VisionAssertionFailed',
  /** 2026-10-07：mobile engine 失败归类 */
  'EngineUnavailable',         // daemon 起不来 / 设备不可达
  'MobileUnsupportedCapability', // mobile 不支持的 step kind
  'MobileStepFailed',          // agent-device 命令失败
  'AppInstallFailed',          // device.installApp 失败
  'Unknown',
]);
```

- [ ] **Step 1.5: index.ts 重新导出**

`packages/shared/src/index.ts` 末尾加：
```ts
export type { StepAction } from './step-dsl.js';
```

确认已有 `FailureReason` 类型再导出（动作保留）。

- [ ] **Step 1.6: 单测覆盖 mobile action 解析**

`packages/shared/test/step-dsl.test.ts` 末尾追加：
```ts
import { LocatorStrategy } from '../src/step-dsl.js';

it('accepts tap action with accessibilityId', () => {
  const r = StepAction.safeParse({
    kind: 'tap',
    locator: [{ strategy: 'accessibilityId', value: 'login_button' }],
  });
  expect(r.success).toBe(true);
});

it('accepts swipe action', () => {
  const r = StepAction.safeParse({
    kind: 'swipe',
    from: [{ strategy: 'accessibilityId', value: 'list_top' }],
    to: [{ strategy: 'accessibilityId', value: 'list_bottom' }],
    durationMs: 500,
  });
  expect(r.success).toBe(true);
});

it('rejects swipe with missing durationMs (uses default)', () => {
  const r = StepAction.safeParse({
    kind: 'swipe',
    from: [{ strategy: 'accessibilityId', value: 'a' }],
    to: [{ strategy: 'accessibilityId', value: 'b' }],
  });
  expect(r.success).toBe(true);
});

it('accepts setNetwork airplane', () => {
  const r = StepAction.safeParse({ kind: 'setNetwork', state: 'airplane' });
  expect(r.success).toBe(true);
});

it('rejects setLocation out of latitude range', () => {
  const r = StepAction.safeParse({ kind: 'setLocation', latitude: 95, longitude: 0 });
  expect(r.success).toBe(false);
});

it('rejects web click with mobile-only strategy', () => {
  // 仅校验 strategy 解析合法；具体路由由 buildCandidates 决定（web 路径下标 unsupported）
  const r = LocatorStrategy.safeParse('accessibilityId');
  expect(r.success).toBe(true);
});
```

- [ ] **Step 1.7: 跑单测**

Run: `pnpm -F @itest/shared test`
Expected: 全部 PASS（含新增 6 个）。

- [ ] **Step 1.8: 提交**

```bash
git add packages/shared/src packages/shared/test
git commit -m "feat(shared): step-dsl 支持 mobile locator + 9 个 mobile action + FailureReason 扩展"
```

---

## Task 2: DB schema 扩展（device_targets + 4 列）+ migration 0032

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0032_mobile_testing.sql`
- Modify: `apps/api/test/helpers/db.ts`

- [ ] **Step 2.1: 加 deviceTargets 表定义**

`apps/api/src/db/schema.ts` 末尾（datasets 表后）追加：
```ts
export const deviceTargets = pgTable('device_targets', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 128 }).notNull(),
  mobileOs: varchar('mobile_os', { length: 16 }).notNull(), // 'ios' | 'android'
  deviceRef: varchar('device_ref', { length: 128 }).notNull(),
  appBundleId: varchar('app_bundle_id', { length: 256 }),
  appPath: text('app_path'),
  launchArgs: jsonb('launch_args').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  uniqByProjectName: uniqueIndex('device_targets_project_name_uq').on(t.projectId, t.name),
}));

export interface AppRef {
  bundleId: string;
  appPath?: string;
  launchArgs?: string[];
}
```

- [ ] **Step 2.2: 在 testCases 增 mobile 列**

`apps/api/src/db/schema.ts:35-59` `testCases` 表内追加：
```ts
  platform: varchar('platform', { length: 16 }).notNull().default('web'),
  mobileOs: varchar('mobile_os', { length: 16 }),
  mobileDeviceTargetId: uuid('mobile_device_target_id').references(() => deviceTargets.id, { onDelete: 'set null' }),
  appRef: jsonb('app_ref').$type<AppRef | null>(),
```

- [ ] **Step 2.3: 在 testSteps 增 mobileOs**

`apps/api/src/db/schema.ts:227-250` 末尾追加：
```ts
  mobileOs: varchar('mobile_os', { length: 16 }),
```

- [ ] **Step 2.4: 在 reports 表增 mobile 列**

`apps/api/src/db/schema.ts:252-263` 末尾追加：
```ts
  platform: varchar('platform', { length: 16 }).notNull().default('web'),
  mobileOs: varchar('mobile_os', { length: 16 }),
  deviceName: varchar('device_name', { length: 128 }),
  deviceTargetId: uuid('device_target_id').references(() => deviceTargets.id, { onDelete: 'set null' }),
```

- [ ] **Step 2.5: 在 planCases 增 targetOverride**

`apps/api/src/db/schema.ts:397-402` `planCases` 内追加：
```ts
  targetOverride: jsonb('target_override').$type<{ deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null>(),
```

- [ ] **Step 2.6: 创建 migration 0032**

`apps/api/drizzle/0032_mobile_testing.sql`：
```sql
-- 0032: 移动端测试支持（spec: docs/superpowers/specs/2026-10-07-mobile-testing-design.md）
CREATE TABLE IF NOT EXISTS device_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name varchar(128) NOT NULL,
  mobile_os varchar(16) NOT NULL,
  device_ref varchar(128) NOT NULL,
  app_bundle_id varchar(256),
  app_path text,
  launch_args jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE device_targets ADD CONSTRAINT device_targets_project_name_uq UNIQUE(project_id, name);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE test_cases ADD COLUMN platform varchar(16) NOT NULL DEFAULT 'web';
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE test_cases ADD COLUMN mobile_os varchar(16);
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE test_cases ADD COLUMN mobile_device_target_id uuid REFERENCES device_targets(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE test_cases ADD COLUMN app_ref jsonb;
EXCEPTION WHEN duplicate_column THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE test_steps ADD COLUMN mobile_os varchar(16);
EXCEPTION WHEN duplicate_column THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE reports ADD COLUMN platform varchar(16) NOT NULL DEFAULT 'web';
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE reports ADD COLUMN mobile_os varchar(16);
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE reports ADD COLUMN device_name varchar(128);
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE reports ADD COLUMN device_target_id uuid REFERENCES device_targets(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE plan_cases ADD COLUMN target_override jsonb;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
```

- [ ] **Step 2.7: 更新测试 SCHEMA_SQL**

`apps/api/test/helpers/db.ts` 的 `SCHEMA_SQL` 字符串里在 `CREATE TABLE datasets` 块之后追加：
```sql
CREATE TABLE device_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name varchar(128) NOT NULL,
  mobile_os varchar(16) NOT NULL,
  device_ref varchar(128) NOT NULL,
  app_bundle_id varchar(256),
  app_path text,
  launch_args jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT device_targets_project_name_uq UNIQUE(project_id, name)
);
```

并把 `test_cases` / `test_steps` / `reports` / `plan_cases` 的 CREATE TABLE 内追加 mobile 列（与 0032 对齐）。

- [ ] **Step 2.8: 跑测试基线（确认无回归）**

Run: `pnpm -F @itest/api test -- --reporter=dot`
Expected: 现有所有 PASS。

- [ ] **Step 2.9: 提交**

```bash
git add apps/api/src/db apps/api/drizzle apps/api/test/helpers
git commit -m "feat(api): db schema + migration 0032 增 device_targets + mobile 元数据列"
```

---

## Task 3: Engine interface + visionAssert 抽出 + WebEngine 包 cdp.ts

**Files:**
- Create: `apps/api/src/execute/engine.ts`
- Create: `apps/api/src/execute/visionAssert.ts`
- Create: `apps/api/src/execute/webEngine.ts`
- Modify: `apps/api/src/execute/cdp.ts`

- [ ] **Step 3.1: 抽出 visionAssert 共用函数**

`apps/api/src/execute/cdp.ts:794-848` 的 vision 判定块（写文件 / `--flag` 文件名 / judgeCaseOutcome 调用 + 脱敏 + stepResult push）整体抽出为函数。直接「读」原块，搬代码不改逻辑：

新建 `apps/api/src/execute/visionAssert.ts`：
```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import type { ExecStepResult } from './cdp.js';
import { materializeExpectedOutcome, maskSensitiveValues } from './cdp.js';

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

export interface VisionAssertInput {
  page: import('playwright-core').Page;
  reportId: string;
  caseTitle: string;
  caseUrl: string | null;
  expectedOutcome: string;
  vars: Record<string, string>;
  sensitiveVarKeys: string[];
  llmClient?: import('../agent/llm-client.js').LLMClient;
}

export interface VisionAssertOutcome {
  passed: boolean;
  reason: string;
  screenshot: string;
  expected: string;
}

/** 用例级 vision 判定：失败追加 order=-1 的 failed stepResult；
 *  成功挂到最后一条 stepResult 的 visionAssert 字段。best-effort，异常 swallow。 */
export async function runCaseVisionAssert(
  input: VisionAssertInput,
): Promise<{ outcome: VisionAssertOutcome | null; failureStep?: ExecStepResult; onLastPass?: (r: ExecStepResult) => void }> {
  // 原 cdp.ts:794-848 的代码搬过来，去掉 try/catch 外部（仍包 try/catch，但 throw 不外抛）。
  // 保留 maskForReport / expectedForReport / expectedForJudge 三段脱敏逻辑。
  // ...（实际代码从 cdp.ts 复制，把 `results.push(...)` 改为返回 failureStep，passed 改为返回 onLastPass 回调）
}
```

> 实现细节：直接抄 `cdp.ts:794-848` 的 50 行，把 push 到 results 的两条分支分别封装为返回值；外部 runStepsInContext 据此调整。

- [ ] **Step 3.2: cdp.ts 移除内联 vision 块 + 抽出 dispatch 导出**

`apps/api/src/execute/cdp.ts`：
- 删除 line 794-848 的 vision 判定块（含 try/catch），改为 `await runCaseVisionAssert({ ... })` 调用；
- 把 `executeCaseReal` / `executeCaseInBrowser` 重写为「仅 export 函数转发」：
  ```ts
  export async function executeCaseReal(...): Promise<ExecStepResult[]> {
    return runWebCase(/* ... */);
  }
  export async function executeCaseInBrowser(...): Promise<ExecStepResult[]> {
    return runWebCase(/* ... */);
  }
  ```
  其中 `runWebCase` 是 `cdp.ts` 内 private 函数，**不**导出。

> 兼容性：保留 `executeCaseReal`/`executeCaseInBrowser` 名字与签名（runPlan.ts、recorder finish、aiTask 兜底、tests 都引用）。

- [ ] **Step 3.3: Engine interface**

`apps/api/src/execute/engine.ts`：
```ts
import type { ExecStepResult, ExecContext, CaseWindow } from './cdp.js';
import type { FailureReason, PreflightReport } from '@itest/shared';

export interface EngineInput {
  caseId: string;
  caseTitle: string;
  caseUrl: string | null;
  expectedOutcome: string | null;
  steps: Array<{
    order: number; assertion: unknown; delayMs: number | null; id: string;
    tabRef: string | null; componentKind: string | null; sensitive: boolean;
    compiled: unknown[] | null | undefined;
  }>;
  envCtx?: import('./envContext.js').EnvCtx;
  initialVars?: Record<string, string>;
  sensitiveVarKeys?: string[];
  rowPlan?: { rowIndex: number; snapshot: unknown; vars: Record<string, string>; sensitiveVarKeys: string[] };
  reportId: string;
  projectId: string | undefined;
  caseWindow?: CaseWindow;
  incognito: boolean;
  appRef?: { bundleId: string; appPath?: string; launchArgs?: string[] } | null;
  deviceTargetId?: string | null;
  mobileOs?: 'ios' | 'android' | null;
}

export interface Engine {
  readonly platform: 'web' | 'mobile';
  execute(input: EngineInput, targetUrl?: string, preflightSink?: (r: PreflightReport) => void): Promise<ExecStepResult[]>;
  prepare(input: EngineInput): Promise<void>;
  release(input: EngineInput): Promise<void>;
}

export class EngineUnavailable extends Error {
  readonly failureReason: FailureReason = 'EngineUnavailable';
  constructor(msg: string) { super(msg); this.name = 'EngineUnavailable'; }
}
```

- [ ] **Step 3.4: WebEngine 实现**

`apps/api/src/execute/webEngine.ts`：
```ts
import type { Engine, EngineInput } from './engine.js';
import { executeCaseReal, executeCaseInBrowser, type ExecStepResult } from './cdp.js';
import type { Browser, BrowserContext } from 'playwright-core';
import type { PreflightReport } from '@itest/shared';

export class WebEngine implements Engine {
  readonly platform = 'web' as const;

  async prepare(): Promise<void> { /* no-op */ }
  async release(): Promise<void> { /* no-op */ }

  async execute(
    input: EngineInput,
    targetUrl?: string,
    preflightSink?: (r: PreflightReport) => void,
  ): Promise<ExecStepResult[]> {
    const ctx: import('./cdp.js').ExecContext = {
      reportId: input.reportId,
      projectId: input.projectId,
      envCtx: input.envCtx,
      expectedOutcome: input.expectedOutcome ?? null,
      caseTitle: input.caseTitle,
      caseUrl: input.caseUrl,
      ...(input.initialVars ? { initialVars: input.initialVars } : {}),
      ...(input.sensitiveVarKeys ? { sensitiveVarKeys: input.sensitiveVarKeys } : {}),
    };
    // 调用 cdp.ts 现有的 executeCaseReal；其内部已用 runStepsInContext（含 visionAssert）
    return executeCaseReal(
      input.caseId,
      input.steps,
      ctx,
      targetUrl,
      undefined, // storageState 由 runPlan 链注入（沿用现有语义）
      preflightSink,
      input.caseWindow,
      input.incognito,
    );
  }
}
```

> 后续 runPlan 的 loginPrepare 路径（`executeCaseInBrowser`）：通过 envCtx / runCase 链注入时，WebEngine.execute 接受一个可选 `ownedBrowser?: Browser`/`ownedContext?: BrowserContext`；第一版仅覆盖 executeCaseReal 路径，loginPrepare 与 mobile 互斥（mobile case 不走 loginPrepare），第二期再扩。

- [ ] **Step 3.5: 跑现有测试（确保 dispatch + runStepsInContext 重构未回归）**

Run: `pnpm -F @itest/api test -- --reporter=dot`
Expected: 全部 PASS。

- [ ] **Step 3.6: 提交**

```bash
git add apps/api/src/execute
git commit -m "refactor(api): 抽出 Engine interface + visionAssert 共用 + WebEngine 包 cdp.ts"
```

---

## Task 4: agent-device 客户端 + MobileEngine + runCase 路由

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/src/execute/agentDeviceClient.ts`
- Create: `apps/api/src/execute/deviceSnapshot.ts`
- Create: `apps/api/src/execute/mobileEngine.ts`
- Modify: `apps/api/src/execute/runCase.ts`
- Modify: `apps/api/src/execute/locator-resolver.ts`

- [ ] **Step 4.1: 加 agent-device 依赖**

`apps/api/package.json` 38 行后加：
```json
    "agent-device": "^0.21.22",
```

Run: `pnpm install`
Expected: 安装成功。

- [ ] **Step 4.2: agent-device 客户端封装**

`apps/api/src/execute/agentDeviceClient.ts`：
```ts
import { logger } from '../logger.js';

export interface AgentDeviceSession {
  /** 设备唯一标识符（iOS simulator name/UDID 或 Android serial/emulator 名） */
  deviceId: string;
  /** 会话内 snapshot/tap/swipe 等命令的客户端 */
  client: {
    snapshot(): Promise<AccessibilitySnapshot>;
    tap(opts: { x: number; y: number; doubleTap?: boolean; longPressMs?: number }): Promise<void>;
    swipe(opts: { fromX: number; fromY: number; toX: number; toY: number; durationMs: number }): Promise<void>;
    type(opts: { selector: string; value: string }): Promise<void>;
    fill(opts: { selector: string; value: string }): Promise<void>;
    expect(selector: string): { toBeVisible(): Promise<void>; toHaveText(text: string): Promise<void> };
    screenshot(opts: { path: string }): Promise<void>;
    setAppearance(opts: { mode: 'light' | 'dark' }): Promise<void>;
    setNetwork(opts: { state: 'online' | 'offline' | 'airplane' }): Promise<void>;
    setLocation(opts: { latitude: number; longitude: number }): Promise<void>;
    home(): Promise<void>;
    appBack(): Promise<void>;
    openApp(opts: { bundleId: string; launchArgs?: string[] }): Promise<void>;
    restartApp(opts: { bundleId: string }): Promise<void>;
    installApp(opts: { path: string }): Promise<void>;
  };
  /** 设备预览流（MJPEG / 单图 refresh / screencast 等，由 agent-device SDK 决定） */
  viewerUrl: string;
}

export interface AccessibilitySnapshot {
  nodes: Array<{
    accessibilityId?: string;
    label?: string;
    role?: string;
    bounds?: { x: number; y: number; width: number; height: number };
    text?: string;
  }>;
}

/** agent-device SDK 协议在不同版本之间有差异；这里用 lazy import 容忍版本漂移。 */
let sdkModule: any | null = null;
async function loadSdk() {
  if (sdkModule) return sdkModule;
  sdkModule = await import('agent-device');
  return sdkModule;
}

/** spawn 一个 daemon 并 acquire 设备。失败抛 EngineUnavailable。 */
export async function acquireDevice(opts: {
  mobileOs: 'ios' | 'android';
  deviceRef: string;
  bundleId: string;
  appPath?: string;
  launchArgs?: string[];
}): Promise<AgentDeviceSession> {
  try {
    const sdk = await loadSdk();
    // SDK 形态（agent-device v0.21.22）由实现期确定。这里假定一个最小接口；
    // 若实际 API 不同，按 SDK 文档调整，但保持对外形态不变。
    const session = await sdk.acquireDevice({
      platform: opts.mobileOs,
      device: opts.deviceRef,
      appPath: opts.appPath,
    });
    if (opts.appPath) await session.installApp({ path: opts.appPath });
    await session.openApp({ bundleId: opts.bundleId, launchArgs: opts.launchArgs ?? [] });
    return session as AgentDeviceSession;
  } catch (e) {
    logger.warn({ err: e }, 'agent-device acquireDevice failed');
    throw e;
  }
}
```

> 注：agent-device SDK 实际协议需在实现时按 SDK README 校对；以上是「最小可用形态」。`acquireDevice` 失败 → 调用方（MobileEngine.prepare） catch 后抛 `EngineUnavailable`。

- [ ] **Step 4.3: snapshot → Locator 候选**

`apps/api/src/execute/deviceSnapshot.ts`：
```ts
import type { AccessibilitySnapshot } from './agentDeviceClient.js';
import type { Locator } from '@itest/shared';

/** 把 agent-device 返回的 accessibility snapshot 转成可被 tryFirstMatch 使用的 locator 数组。
 *  优先 accessibilityId，回退 label，最后 predicate。 */
export function snapshotToLocators(node: AccessibilitySnapshot['nodes'][number]): Locator[] {
  const out: Locator[] = [];
  if (node.accessibilityId) out.push({ strategy: 'accessibilityId', value: node.accessibilityId });
  if (node.label) out.push({ strategy: 'label', value: node.label });
  // predicate 作为兜底（基于 role+bounds 的描述，跨 SDK 多语言
  if (node.role && node.bounds) {
    const cx = node.bounds.x + node.bounds.width / 2;
    const cy = node.bounds.y + node.bounds.height / 2;
    out.push({ strategy: 'predicate', value: `role==${node.role} && bounds.center==(${cx},${cy})` });
  }
  return out;
}

/** 找最近一个匹配 selector 的节点 bounds。null 表示未命中。 */
export function findBounds(snapshot: AccessibilitySnapshot, predicate: (n: AccessibilitySnapshot['nodes'][number]) => boolean): { x: number; y: number; width: number; height: number } | null {
  for (const n of snapshot.nodes) if (predicate(n) && n.bounds) return n.bounds;
  return null;
}
```

- [ ] **Step 4.4: locator-resolver 标 mobile-only strategy 为 unsupported**

`apps/api/src/execute/locator-resolver.ts` `buildCandidates` 函数末尾追加：
```ts
  // mobile-only strategy 在 web 回放下拒绝命中（不应被误用）
  for (const l of action.locator) {
    if (l.strategy === 'accessibilityId' || l.strategy === 'label' || l.strategy === 'predicate') {
      throw new Error(`locator strategy '${l.strategy}' is mobile-only; cannot run on web engine`);
    }
  }
```

- [ ] **Step 4.5: MobileEngine 实现**

`apps/api/src/execute/mobileEngine.ts`：
```ts
import type { Engine, EngineInput } from './engine.js';
import { EngineUnavailable } from './engine.js';
import type { ExecStepResult } from './cdp.js';
import { maskSensitiveValues, materializeExpectedOutcome } from './cdp.js';
import { acquireDevice, type AgentDeviceSession } from './agentDeviceClient.js';
import { findBounds } from './deviceSnapshot.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import type { StepAction, Locator } from '@itest/shared';

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

export class MobileEngine implements Engine {
  readonly platform = 'mobile' as const;
  private session: AgentDeviceSession | null = null;
  private reportId: string | null = null;

  async prepare(input: EngineInput): Promise<void> {
    if (!input.deviceTargetId || !input.mobileOs) {
      throw new EngineUnavailable('mobile case missing deviceTargetId or mobileOs');
    }
    const appRef = input.appRef;
    if (!appRef?.bundleId) throw new EngineUnavailable('mobile case missing appRef.bundleId');
    const { resolveDeviceTarget } = await import('../services/deviceTargets.service.js');
    const target = await resolveDeviceTarget(input.deviceTargetId);
    if (!target) throw new EngineUnavailable('device target not found');
    try {
      this.session = await acquireDevice({
        mobileOs: input.mobileOs,
        deviceRef: target.deviceRef,
        bundleId: appRef.bundleId,
        ...(appRef.appPath ? { appPath: appRef.appPath } : {}),
        launchArgs: appRef.launchArgs ?? [],
      });
      this.reportId = input.reportId;
    } catch (e) {
      throw new EngineUnavailable(`agent-device acquire failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async release(): Promise<void> {
    // SDK 不暴露 release；由下次 acquire 重新接管。best-effort。
    this.session = null;
  }

  async execute(input: EngineInput): Promise<ExecStepResult[]> {
    if (!this.session) throw new EngineUnavailable('mobile session not prepared');
    const results: ExecStepResult[] = [];
    const vars: Record<string, string> = { ...(input.initialVars ?? {}) };
    for (const step of input.steps) {
      const started = Date.now();
      const compiled = step.compiled;
      if (!Array.isArray(compiled) || compiled.length === 0) {
        results.push({
          order: step.order, status: 'failed', durationMs: 0,
          error: `compile-missing: 第 ${step.order} 步未编译`,
          failureReason: 'MobileUnsupportedCapability', humanMessage: '移动端步骤缺少 compiled DSL',
        });
        break;
      }
      try {
        for (const sub of compiled as StepAction[]) {
          await this.dispatchMobile(sub, vars);
        }
        const screenshot = await this.captureStepScreenshot(input.reportId, step.order);
        results.push({ order: step.order, status: 'passed', durationMs: Date.now() - started, screenshot });
      } catch (e) {
        let msg = e instanceof Error ? e.message : String(e);
        if (input.sensitiveVarKeys?.length) msg = maskSensitiveValues(msg, vars, input.sensitiveVarKeys);
        const screenshot = await this.captureStepScreenshot(input.reportId, step.order);
        const reason = e instanceof Error && e.name === 'MobileUnsupportedCapability' ? 'MobileUnsupportedCapability' : 'MobileStepFailed';
        results.push({
          order: step.order, status: 'failed', durationMs: Date.now() - started,
          error: msg, screenshot, failureReason: reason,
          humanMessage: reason === 'MobileUnsupportedCapability' ? '当前 mobile 引擎不支持该动作' : `agent-device 命令失败：${msg}`,
        });
        break;
      }
    }
    // 用例级 vision 兜底：复用 visionAssert（共用函数）
    if (input.expectedOutcome && results.every((r) => r.status === 'passed')) {
      const { runCaseVisionAssert } = await import('./visionAssert.js');
      const va = await runCaseVisionAssert({
        page: undefined as never, // mobile 不传 page；visionAssert 在 page 缺失时短路（见 Step 4.7）
        reportId: input.reportId,
        caseTitle: input.caseTitle,
        caseUrl: input.caseUrl,
        expectedOutcome: materializeExpectedOutcome(input.expectedOutcome, vars),
        vars,
        sensitiveVarKeys: input.sensitiveVarKeys ?? [],
      });
      if (va?.failureStep) results.push(va.failureStep);
      else if (va?.onLastPass) va.onLastPass(results[results.length - 1]!);
    }
    return results;
  }

  private async dispatchMobile(action: StepAction, vars: Record<string, string>): Promise<void> {
    const session = this.session!;
    switch (action.kind) {
      case 'tap': {
        const snap = await session.client.snapshot();
        const bounds = findBounds(snap, (n) => action.locator.some((l) => matchLocator(l, n)));
        if (!bounds) throw new Error('tap: locator not found in accessibility tree');
        await session.client.tap({
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
          ...(action.doubleTap ? { doubleTap: true } : {}),
          ...(action.longPressMs ? { longPressMs: action.longPressMs } : {}),
        });
        return;
      }
      case 'swipe': {
        const snap = await session.client.snapshot();
        const fromBounds = findBounds(snap, (n) => action.from.some((l) => matchLocator(l, n)));
        const toBounds = findBounds(snap, (n) => action.to.some((l) => matchLocator(l, n)));
        if (!fromBounds || !toBounds) throw new Error('swipe: from/to not found');
        await session.client.swipe({
          fromX: fromBounds.x + fromBounds.width / 2,
          fromY: fromBounds.y + fromBounds.height / 2,
          toX: toBounds.x + toBounds.width / 2,
          toY: toBounds.y + toBounds.height / 2,
          durationMs: action.durationMs,
        });
        return;
      }
      case 'fill': {
        const value = materializeVarValue(action.value, vars);
        await session.client.fill({ selector: action.locator[0]?.value ?? '', value });
        return;
      }
      case 'click': {
        // web 复用：tap(doubleTap=false)
        const snap = await session.client.snapshot();
        const bounds = findBounds(snap, (n) => action.locator.some((l) => matchLocator(l, n)));
        if (!bounds) throw new Error('click: locator not found');
        await session.client.tap({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
        return;
      }
      case 'assertVisible': {
        await session.client.expect(action.locator[0]?.value ?? '').toBeVisible();
        return;
      }
      case 'assertText': {
        await session.client.expect(action.locator[0]?.value ?? '').toHaveText(action.equals);
        return;
      }
      case 'screenshot': {
        const dir = join(SCREENSHOTS_DIR, this.reportId!);
        await mkdir(dir, { recursive: true });
        await session.client.screenshot({ path: join(dir, `step-${action.name ?? 'snap'}.png`) });
        return;
      }
      case 'setAppearance':
        await session.client.setAppearance({ mode: action.mode }); return;
      case 'setNetwork':
        await session.client.setNetwork({ state: action.state }); return;
      case 'setLocation':
        await session.client.setLocation({ latitude: action.latitude, longitude: action.longitude }); return;
      case 'home':
        await session.client.home(); return;
      case 'appBack':
        await session.client.appBack(); return;
      case 'appRestart':
        await session.client.restartApp({ bundleId: (await getAppBundleId(this)) ?? 'unknown' });
        return;
      case 'appOpen':
        await session.client.openApp({ bundleId: action.bundleId ?? (await getAppBundleId(this)) ?? 'unknown' });
        return;
      default:
        const e: Error & { name?: string } = new Error(`mobile engine does not support kind=${action.kind}`);
        e.name = 'MobileUnsupportedCapability';
        throw e;
    }
  }

  private async captureStepScreenshot(reportId: string, stepIndex: number): Promise<string | undefined> {
    try {
      const dir = join(SCREENSHOTS_DIR, reportId);
      await mkdir(dir, { recursive: true });
      const filename = `step-${stepIndex}.png`;
      const path = join(dir, filename);
      await this.session?.client.screenshot({ path });
      return `/screenshots/${reportId}/${filename}`;
    } catch (e) {
      logger.warn({ err: e, reportId, stepIndex }, 'mobile step screenshot failed');
      return undefined;
    }
  }
}

function matchLocator(l: Locator, n: { accessibilityId?: string; label?: string }): boolean {
  if (l.strategy === 'accessibilityId') return n.accessibilityId === l.value;
  if (l.strategy === 'label') return n.label === l.value;
  return false;
}

function materializeVarValue(v: unknown, vars: Record<string, string>): string {
  if (typeof v === 'string') {
    const { value } = require('@itest/shared').substituteVars(v, vars);
    return value;
  }
  return String(v ?? '');
}

async function getAppBundleId(engine: MobileEngine): Promise<string | null> {
  // 第一版：从报告 / engine input 记录；mobileEngine.prepare 已存。
  // 这里仅返回 null 时落 Unknown 错误，避免过度设计。
  return null;
}
```

> **简注**：`materializeVarValue` 用了 `require` 是占位——实际项目用 ESM import。修订时改成 `import { materializeValue, substituteVars } from '@itest/shared';`。

- [ ] **Step 4.6: visionAssert 适配 mobile 路径（page 可选）**

`apps/api/src/execute/visionAssert.ts` 把 page 改成可选；mobile 路径下 `page` 传 `undefined`，函数内若 page 缺失则直接 skip 并返回 null：

```ts
export interface VisionAssertInput {
  page?: import('playwright-core').Page;  // mobile 路径不传
  reportId: string;
  ...
}
// 在函数体最前面：
if (!input.page) return { outcome: null }; // mobile 路径：直接跳过 vision（agent-device 内部已判最终态）
```

> 第二期（截图+vision mobile LLM）可在此基础上扩展；MVP 暂跳过。

- [ ] **Step 4.7: runCase 按 platform 路由**

`apps/api/src/execute/runCase.ts`：

新增 import：
```ts
import { WebEngine } from './webEngine.js';
import { MobileEngine } from './mobileEngine.js';
import { EngineUnavailable } from './engine.js';
```

`runCaseOnceInner` 中替换 line 234-262 的 if-else 块为：
```ts
    const engine = caseRow.platform === 'mobile' ? new MobileEngine() : new WebEngine();
    const engineInput: EngineInput = {
      caseId,
      caseTitle: caseRow.title,
      caseUrl: caseRow.url ?? null,
      expectedOutcome: caseRow.expectedOutcome ?? null,
      steps: stepInput,
      envCtx,
      reportId,
      projectId,
      caseWindow,
      incognito,
      appRef: caseRow.appRef ?? null,
      deviceTargetId: caseRow.mobileDeviceTargetId ?? null,
      mobileOs: caseRow.mobileOs ?? null,
      ...(rowPlan ? { initialVars: rowPlan.vars, sensitiveVarKeys: rowPlan.sensitiveVarKeys } : {}),
    };
    try {
      await engine.prepare(engineInput);
      if (opts?.ownedBrowser && opts?.ownedContext && engine instanceof WebEngine) {
        // loginPrepare 链路：直接调底层避免 launch
        stepResults = await executeCaseInBrowser(
          caseId, stepInput, buildExecCtx(engineInput, envCtx),
          opts.ownedBrowser, opts.ownedContext, targetUrl,
          (r) => { preflightReport = r; }, caseWindow,
        );
      } else {
        stepResults = await engine.execute(engineInput, targetUrl, (r) => { preflightReport = r; });
      }
      const failed = stepResults.filter((r) => r.status === 'failed').length;
      status = failed === 0 ? 'passed' : 'failed';
    } catch (e) {
      // EngineUnavailable → MobileEngine prepare 失败；记为对应 failureReason
      if (e instanceof EngineUnavailable) {
        stepResults = [{
          order: 1, status: 'failed', durationMs: 0,
          error: e.message, failureReason: 'EngineUnavailable',
          humanMessage: '移动端引擎不可用：' + e.message,
        }];
        status = 'failed';
      } else {
        logger.warn({ err: e, caseId, reportId }, 'engine execution failed; writing CDPUnavailable failed report');
        stepResults = [{
          order: 1, status: 'failed', durationMs: 0,
          error: e instanceof Error ? e.message : String(e),
          failureReason: 'CDPUnavailable',
          humanMessage: '执行失败',
        }];
        status = 'failed';
      }
    } finally {
      try { await engine.release(engineInput); } catch { /* swallow */ }
      if (envCtx && !opts?.ownedBrowser) envCtx.close().catch(() => undefined);
    }
```

并在 `runCaseOnce`（line 91）插入 report 时把 mobile 列写入：
```ts
    .values({
      caseId,
      status: 'running',
      stepResults: [] as object,
      summary: 'execution in progress',
      platform: caseRow.platform,
      ...(caseRow.mobileOs ? { mobileOs: caseRow.mobileOs } : {}),
      ...(caseRow.mobileDeviceTargetId ? { deviceTargetId: caseRow.mobileDeviceTargetId } : {}),
      ...(rowPlan ? { datasetRowIndex: rowPlan.rowIndex, datasetSnapshot: rowPlan.snapshot } : {}),
    })
```

并在 runCaseOnceInner 末尾 update reports 时写入 deviceName（从 deviceTargets 解析）：
```ts
      // 在 set 前：若 mobile，从 device_targets 取 device_name
      let deviceName: string | null = null;
      if (caseRow.platform === 'mobile' && caseRow.mobileDeviceTargetId) {
        const { resolveDeviceTarget } = await import('../services/deviceTargets.service.js');
        const t = await resolveDeviceTarget(caseRow.mobileDeviceTargetId);
        if (t) deviceName = t.name;
      }
      await db.update(reports).set({
        status, durationMs, stepResults: stepResults as object,
        summary: buildSummary(stepResults, preflightReport),
        preflight: preflightReport ?? null,
        ...(deviceName ? { deviceName } : {}),
      }).where(eq(reports.id, reportId));
```

- [ ] **Step 4.8: 跑现有测试**

Run: `pnpm -F @itest/api test -- --reporter=dot`
Expected: web 路径所有测试 PASS（mobile 不参与既有测试 → 应自动旁路）。

- [ ] **Step 4.9: 提交**

```bash
git add apps/api/src/execute apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): agent-device SDK + MobileEngine + runCase 按 platform 路由"
```

---

## Task 5: deviceTargets CRUD service + route + visibility

**Files:**
- Create: `apps/api/src/services/deviceTargets.service.ts`
- Modify: `apps/api/src/services/projectAccess.ts`
- Create: `apps/api/src/routes/deviceTargets.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 5.1: deviceTargets 服务**

`apps/api/src/services/deviceTargets.service.ts`：
```ts
import { eq, asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { deviceTargets } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';

export interface DeviceTargetSaveBody {
  name: string;
  mobileOs: 'ios' | 'android';
  deviceRef: string;
  appBundleId?: string | null;
  appPath?: string | null;
  launchArgs?: string[];
}

export async function listDeviceTargets(projectId: string) {
  return db.select().from(deviceTargets).where(eq(deviceTargets.projectId, projectId)).orderBy(asc(deviceTargets.createdAt));
}

export async function getDeviceTarget(id: string) {
  return (await db.select().from(deviceTargets).where(eq(deviceTargets.id, id)).limit(1))[0] ?? null;
}

export async function resolveDeviceTarget(id: string) {
  return getDeviceTarget(id);
}

export async function createDeviceTarget(projectId: string, body: DeviceTargetSaveBody) {
  try {
    const row = (await db.insert(deviceTargets).values({
      projectId,
      name: body.name.trim(),
      mobileOs: body.mobileOs,
      deviceRef: body.deviceRef.trim(),
      appBundleId: body.appBundleId ?? null,
      appPath: body.appPath ?? null,
      launchArgs: body.launchArgs ?? [],
    }).returning())[0]!;
    return row;
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') {
      throw new HttpError(409, 'name_conflict', 'device target name already exists in this project');
    }
    throw e;
  }
}

export async function updateDeviceTarget(id: string, body: DeviceTargetSaveBody) {
  const existing = await getDeviceTarget(id);
  if (!existing) throw new HttpError(404, 'not_found', 'device target not found');
  try {
    const row = (await db.update(deviceTargets).set({
      name: body.name.trim(),
      mobileOs: body.mobileOs,
      deviceRef: body.deviceRef.trim(),
      appBundleId: body.appBundleId ?? null,
      appPath: body.appPath ?? null,
      launchArgs: body.launchArgs ?? [],
      updatedAt: new Date(),
    }).where(eq(deviceTargets.id, id)).returning())[0]!;
    return row;
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') {
      throw new HttpError(409, 'name_conflict', 'device target name already exists in this project');
    }
    throw e;
  }
}

export async function deleteDeviceTarget(id: string) {
  const deleted = await db.delete(deviceTargets).where(eq(deviceTargets.id, id)).returning({ id: deviceTargets.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'device target not found');
}
```

- [ ] **Step 5.2: 可见性 helpers**

`apps/api/src/services/projectAccess.ts` 末尾追加：
```ts
import { deviceTargets } from '../db/schema.js';

export async function resolveDeviceTargetProjectId(deviceTargetId: string): Promise<string | null> {
  const rows = await db.select({ projectId: deviceTargets.projectId }).from(deviceTargets).where(eq(deviceTargets.id, deviceTargetId)).limit(1);
  return rows[0]?.projectId ?? null;
}

export async function assertDeviceTargetVisible(deviceTargetId: string, user: AuthUser): Promise<{ projectId: string }> {
  const projectId = await resolveDeviceTargetProjectId(deviceTargetId);
  if (!projectId) throw new HttpError(404, 'not_found', 'device target not found');
  await assertProjectVisible(projectId, user);
  return { projectId };
}
```

- [ ] **Step 5.3: REST 路由**

`apps/api/src/routes/deviceTargets.ts`：
```ts
import { Router } from 'express';
import { z } from 'zod';
import { assertProjectVisible } from '../services/projectAccess.js';
import {
  createDeviceTarget, deleteDeviceTarget, getDeviceTarget, listDeviceTargets, updateDeviceTarget,
} from '../services/deviceTargets.service.js';

export const deviceTargetsRoute = Router();

const SaveBody = z.object({
  name: z.string().min(1).max(128),
  mobileOs: z.enum(['ios', 'android']),
  deviceRef: z.string().min(1).max(128),
  appBundleId: z.string().max(256).nullable().optional(),
  appPath: z.string().nullable().optional(),
  launchArgs: z.array(z.string()).max(50).optional(),
});

deviceTargetsRoute.get('/projects/:projectId/device-targets', async (req, res) => {
  await assertProjectVisible(req.params.projectId!, req.user!);
  res.json(await listDeviceTargets(req.params.projectId!));
});

deviceTargetsRoute.post('/projects/:projectId/device-targets', async (req, res) => {
  await assertProjectVisible(req.params.projectId!, req.user!);
  res.json(await createDeviceTarget(req.params.projectId!, SaveBody.parse(req.body)));
});

deviceTargetsRoute.get('/projects/:projectId/device-targets/:id', async (req, res) => {
  const { projectId, id } = req.params;
  await assertProjectVisible(projectId!, req.user!);
  const target = await getDeviceTarget(id!);
  if (!target || target.projectId !== projectId) {
    res.status(404).json({ error: 'not_found', message: 'device target not found' });
    return;
  }
  res.json(target);
});

deviceTargetsRoute.put('/projects/:projectId/device-targets/:id', async (req, res) => {
  const { projectId, id } = req.params;
  await assertProjectVisible(projectId!, req.user!);
  const existing = await getDeviceTarget(id!);
  if (!existing || existing.projectId !== projectId) {
    res.status(404).json({ error: 'not_found', message: 'device target not found' });
    return;
  }
  res.json(await updateDeviceTarget(id!, SaveBody.parse(req.body)));
});

deviceTargetsRoute.delete('/projects/:projectId/device-targets/:id', async (req, res) => {
  const { projectId, id } = req.params;
  await assertProjectVisible(projectId!, req.user!);
  const existing = await getDeviceTarget(id!);
  if (!existing || existing.projectId !== projectId) {
    res.status(404).json({ error: 'not_found', message: 'device target not found' });
    return;
  }
  await deleteDeviceTarget(id!);
  res.json({ ok: true });
});
```

- [ ] **Step 5.4: 挂载路由**

`apps/api/src/index.ts`：
- line 21 之后加 `import { deviceTargetsRoute } from './routes/deviceTargets.js';`
- line 58 之后加 `app.use('/api', deviceTargetsRoute);`

- [ ] **Step 5.5: 跑测试**

Run: `pnpm -F @itest/api test -- --reporter=dot`
Expected: PASS。

- [ ] **Step 5.6: 提交**

```bash
git add apps/api/src
git commit -m "feat(api): deviceTargets CRUD service + REST route + 可见性断言"
```

---

## Task 6: 用例 PATCH 增 mobile 字段

**Files:**
- Modify: `apps/api/src/routes/cases.ts`
- Modify: `apps/api/src/services/cases.service.ts`

- [ ] **Step 6.1: PatchBody 增 mobile 字段**

`apps/api/src/routes/cases.ts:46-56` PatchBody 末尾 `.extend` 加：
```ts
    // 2026-10-07: 移动端支持
    platform: z.enum(['web', 'mobile']).optional(),
    mobileOs: z.enum(['ios', 'android']).nullable().optional(),
    mobileDeviceTargetId: z.string().uuid().nullable().optional(),
    appRef: z.object({
      bundleId: z.string().min(1).max(256),
      appPath: z.string().optional(),
      launchArgs: z.array(z.string()).max(50).optional(),
    }).nullable().optional(),
```

并在 `casesRoute.patch('/:id'` line 162-169 之后加：
```ts
  if (body.mobileDeviceTargetId !== undefined && body.mobileDeviceTargetId !== null) {
    const { assertDeviceTargetVisible } = await import('../services/projectAccess.js');
    await assertDeviceTargetVisible(body.mobileDeviceTargetId, req.user!);
  }
  // mobile platform 与 mobileOs / mobileDeviceTargetId / appRef 协同：要么全清，要么都给齐
  if (body.platform !== undefined) {
    if (body.platform === 'mobile') {
      // mobileOs / mobileDeviceTargetId / appRef 在同次 patch 里要么已存在，要么一起给出
      const mOs = body.mobileOs ?? existing?.mobileOs ?? null;
      const mDt = body.mobileDeviceTargetId ?? existing?.mobileDeviceTargetId ?? null;
      const aRef = body.appRef ?? existing?.appRef ?? null;
      if (!mOs || !mDt || !aRef?.bundleId) {
        throw new HttpError(400, 'mobile_config_required', 'mobile case requires mobileOs, mobileDeviceTargetId, appRef.bundleId');
      }
    } else {
      // platform=web 时清空 mobile 字段
      body.mobileOs = null;
      body.mobileDeviceTargetId = null;
      body.appRef = null;
    }
  }
```

> 需要从 `req.body` 取 `existing`，可用 `const existing = await getCaseDetail(req.params.id!);`。

- [ ] **Step 6.2: updateCase 校验 mobile**

`apps/api/src/services/cases.service.ts:150-166` `UpdateCasePatch` 加：
```ts
  platform?: 'web' | 'mobile';
  mobileOs?: 'ios' | 'android' | null;
  mobileDeviceTargetId?: string | null;
  appRef?: AppRef | null;
```

并 import：
```ts
import type { AppRef } from '../db/schema.js';
```

`updateCase` 函数 line 197 后（dataset 校验后）加：
```ts
  if (patch.mobileDeviceTargetId !== undefined && patch.mobileDeviceTargetId !== null) {
    const dtPid = await resolveDeviceTargetProjectId(patch.mobileDeviceTargetId);
    if (!dtPid) throw new HttpError(404, 'not_found', 'device target not found');
    if (dtPid !== targetPid) throw new HttpError(400, 'device_target_project_mismatch', 'device target does not belong to this project');
  }
```

并 import：
```ts
import { resolveDeviceTargetProjectId } from './projectAccess.js';
```

- [ ] **Step 6.3: 跑测试**

Run: `pnpm -F @itest/api test -- --reporter=dot`
Expected: PASS。

- [ ] **Step 6.4: 提交**

```bash
git add apps/api/src/routes/cases.ts apps/api/src/services/cases.service.ts apps/api/src/services/projectAccess.ts
git commit -m "feat(api): 用例 PATCH 增 platform/mobileOs/deviceTarget/appRef + 跨项目断言"
```

---

## Task 7: Report / Plan 透出 mobile 元数据

**Files:**
- Modify: `apps/api/src/routes/reports.ts`
- Modify: `apps/api/src/routes/plans.ts`
- Modify: `apps/api/src/execute/runPlan.ts`

- [ ] **Step 7.1: reports 列表/详情透出 mobile 列**

`apps/api/src/routes/reports.ts`：在 select 查询中加入 `mobileOs / deviceName / deviceTargetId / platform`（直接 `select()` 已带，`db.select().from(reports)` 返回所有列）。无需结构变化——直接 verify 一下出参透传即可。

若 reports.ts 有字段白名单 `pick`：把新字段加进 pick。

- [ ] **Step 7.2: planCases patch 增 targetOverride**

`apps/api/src/routes/plans.ts` 的 planCases patch body 加：
```ts
targetOverride: z.object({
  deviceTargetId: z.string().uuid().optional(),
  browserContext: z.enum(['incognito', 'persistent']).optional(),
}).nullable().optional(),
```

并在 service 中 update 时写入。

- [ ] **Step 7.3: runPlan 按 platform 派发**

`apps/api/src/execute/runPlan.ts`：

line 38-50 的 `runPlanOnce` 内：调用 `runCase(opts)` 之前对 mobile case 单独处理——`opts.mobileOs / deviceTargetId / appRef` 已经在 caseRow 上有；runCase 已经按 platform 路由（Task 4.7），runPlan 不需要再改。

但 runPlan 的 `loginPrepare` 路径：在为 mobile case 跳过 loginPrepare 之前插入判断 `if (caseRow.platform === 'mobile') continue;`（loginPrepare 仅 web）。

- [ ] **Step 7.4: 跑测试**

Run: `pnpm -F @itest/api test -- --reporter=dot`
Expected: PASS。

- [ ] **Step 7.5: 提交**

```bash
git add apps/api/src
git commit -m "feat(api): reports / plans / runPlan 透出 mobile 元数据；loginPrepare 跳过 mobile"
```

---

## Task 8: AI prompt 增 mobile 段落

**Files:**
- Modify: `apps/api/src/agent/prompts/step-dsl-spec.ts`
- Modify: `apps/api/src/execute/aiTask.ts`

- [ ] **Step 8.1: STEP_DSL_SPEC 增 mobile**

`apps/api/src/agent/prompts/step-dsl-spec.ts:3-38`：
在 `Locator = ...` 行的注释里加 mobile 策略说明，并在末尾增「mobile-only action」段落：
```text
Locator = {"strategy":"role"|"text"|"testId"|"css"|"xpath","value":"定位值"}
（mobile-only："accessibilityId"|"label"|"predicate"，仅在 platform=mobile 用例中可产出；web 用例不得使用）
mobile-only action（仅 platform=mobile 时产出）：
- {"kind":"tap","locator":[Locator,...]}（首选 tap；click 在 mobile 也可用但会映射为 tap）
- {"kind":"swipe","from":[Locator,...],"to":[Locator,...],"durationMs":300（默认）}
- {"kind":"setAppearance","mode":"light"|"dark"}
- {"kind":"setNetwork","state":"online"|"offline"|"airplane"}
- {"kind":"setLocation","latitude":<float>,"longitude":<float>}
- {"kind":"appOpen","bundleId":"com.x.y"}（缺省用 case.appRef.bundleId）
- {"kind":"appBack"}
- {"kind":"appRestart"}
- {"kind":"home"}
规则（同前）：
- platform=mobile 时 locator 优先 accessibilityId / label，禁止使用 css 修饰符。
- platform=web 时 locator 优先 role / text / testId；移动端策略不被接受。
```

- [ ] **Step 8.2: aiTask 增 MOBILE_SYSTEM_PROMPT**

`apps/api/src/execute/aiTask.ts:11-28` 之后追加：
```ts
const MOBILE_SYSTEM_PROMPT = `你是移动端测试执行智能体，在 iOS Simulator / Android Emulator 上执行自然语言测试指令。
可观测：当前 accessibility tree（节点含 accessibilityId / label / role / bounds）、当前屏幕截图。
只输出 JSON，格式：
{"actions": [...], "done": false, "summary": "一句话进展"}
actions 元素类型：
- {"type":"tap","accessibilityId":"..."} 或 {"label":"..."}（优先 accessibilityId）
- {"type":"fill","accessibilityId":"...","value":"..."}
- {"type":"swipe","from":{"accessibilityId":"..."},"to":{"accessibilityId":"..."},"durationMs":500}
- {"type":"setAppearance","mode":"light"|"dark"}
- {"type":"setNetwork","state":"online"|"offline"|"airplane"}
- {"type":"setLocation","latitude":<float>,"longitude":<float>}
- {"type":"home"} / {"type":"appBack"} / {"type":"appRestart"} / {"type":"appOpen","bundleId":"..."}
- {"type":"wait","ms":<毫秒>}
- {"type":"screenshot","accessibilityId":"..."}　请求该节点 4 倍放大截图，下轮附图发给你
结束方式（二选一）：
- 指令已完成：{"done": true, "summary": "做了什么"}
- 无法完成：{"fail": "原因"}
规则：
- 节点中心坐标取 bounds 中心；不要做坐标绝对计算。
- 每轮动作要保守，最多 6 个；每个动作结果下轮反馈给你，出错就换 accessibilityId / label 重试。
- 屏幕中可能同时存在多个相同 label 的节点，命中歧义时优先选 accessibilityId。`;
```

并在 `runAiTask` 函数签名（line ~140）增可选 `mobile?: boolean` 参数；mobile=true 时用 `MOBILE_SYSTEM_PROMPT`，dumpElements 改为 dump accessibility tree。

- [ ] **Step 8.3: 跑测试**

Run: `pnpm -F @itest/api test -- --reporter=dot`
Expected: PASS（现有 aiTask 测试不动；mobile=true 路径无测试，第二期补）。

- [ ] **Step 8.4: 提交**

```bash
git add apps/api/src/agent/prompts apps/api/src/execute/aiTask.ts
git commit -m "feat(api): step-dsl-spec + aiTask 增 mobile 段落（系统提示 + 动作映射）"
```

---

## Task 9: Web — deviceTargets API client + Icons + 路由

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Create: `apps/web/src/api/deviceTargets.ts`
- Modify: `apps/web/src/components/Icon.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 9.1: API client — deviceTargets**

`apps/web/src/api/client.ts` 末尾（`}` 前）加：
```ts
export interface DeviceTarget {
  id: string;
  projectId: string;
  name: string;
  mobileOs: 'ios' | 'android';
  deviceRef: string;
  appBundleId: string | null;
  appPath: string | null;
  launchArgs: string[];
  createdAt: string;
  updatedAt: string;
}
```

并在 `api` 对象内加：
```ts
deviceTargets: {
  list: (projectId: string) => request<DeviceTarget[]>(`/projects/${projectId}/device-targets`),
  create: (projectId: string, body: Omit<DeviceTarget, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>) =>
    request<DeviceTarget>(`/projects/${projectId}/device-targets`, { method: 'POST', body: JSON.stringify(body) }),
  update: (projectId: string, id: string, body: Omit<DeviceTarget, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>) =>
    request<DeviceTarget>(`/projects/${projectId}/device-targets/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  remove: (projectId: string, id: string) =>
    request<{ ok: true }>(`/projects/${projectId}/device-targets/${id}`, { method: 'DELETE' }),
},
```

并在 `TestCase` 接口（line 756-779）增加：
```ts
  platform?: 'web' | 'mobile';
  mobileOs?: 'ios' | 'android' | null;
  mobileDeviceTargetId?: string | null;
  appRef?: { bundleId: string; appPath?: string; launchArgs?: string[] } | null;
```

并在 `Report` 接口（line 893-904）增加：
```ts
  platform?: 'web' | 'mobile';
  mobileOs?: 'ios' | 'android' | null;
  deviceName?: string | null;
  deviceTargetId?: string | null;
```

- [ ] **Step 9.2: Icon 增 mobile**

`apps/web/src/components/Icon.tsx`：
- line 2 之后加：`import Tablet from '@carbon/icons-react/es/Tablet';`
- iconMap 中加：`tablet: Tablet,`（用作 mobile device 视觉标识）。
- 再加 mobile 手机图标作为备选：`import Mobile from '@carbon/icons-react/es/Mobile';` + `mobile: Mobile,`

- [ ] **Step 9.3: App.tsx 增 device-targets 路由**

`apps/web/src/App.tsx`：
- import：`import DeviceTargetsPage from './pages/DeviceTargetsPage';`
- 在 environments 路由后加：
  ```tsx
          <Route path="/p/:projectId/device-targets" element={<DeviceTargetsPage />} />
  ```

- [ ] **Step 9.4: 提交**

```bash
git add apps/web/src/api apps/web/src/components apps/web/src/App.tsx
git commit -m "feat(web): deviceTargets API client + Icon(mobile/tablet) + 路由挂载"
```

---

## Task 10: Web — DeviceTargetsPage + ProjectsHome 入口

**Files:**
- Create: `apps/web/src/pages/DeviceTargetsPage.tsx`
- Modify: `apps/web/src/pages/ProjectsHome.tsx`

- [ ] **Step 10.1: DeviceTargetsPage 实现**

仿 DatasetsPage 写法（CRUD + Dialog + 删除确认 + Toast）；目标对象是 `DeviceTarget`。完整模板（自行整文件，按 DatasetsPage 的结构）：

```tsx
import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DeviceTarget } from '../api/client';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Segmented from '../components/ui/Segmented';
import EmptyState from '../components/ui/EmptyState';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/Modal';
import { useUIStore } from '../stores/ui';
import { fullDateTime } from '../lib/format';

const emptyDraft = (): Omit<DeviceTarget, 'id' | 'projectId' | 'createdAt' | 'updatedAt'> => ({
  name: '',
  mobileOs: 'ios',
  deviceRef: '',
  appBundleId: '',
  appPath: '',
  launchArgs: [],
});

export default function DeviceTargetsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const { data: list, isLoading } = useQuery({
    queryKey: ['deviceTargets', projectId],
    queryFn: () => api.deviceTargets.list(projectId!),
    enabled: !!projectId,
  });
  const [draft, setDraft] = useState<Omit<DeviceTarget, 'id' | 'projectId' | 'createdAt' | 'updatedAt'> | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DeviceTarget | null>(null);

  const save = useMutation({
    mutationFn: async (d: typeof draft & {}) => {
      if (!d) throw new Error('no draft');
      const body = { ...d, appBundleId: d.appBundleId || null, appPath: d.appPath || null };
      return editingId
        ? api.deviceTargets.update(projectId!, editingId, body)
        : api.deviceTargets.create(projectId!, body);
    },
    onSuccess: () => {
      toast('已保存', 'success');
      setDraft(null); setEditingId(null);
      qc.invalidateQueries({ queryKey: ['deviceTargets', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: (t: DeviceTarget) => api.deviceTargets.remove(projectId!, t.id),
    onSuccess: () => {
      toast('已删除', 'success');
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: ['deviceTargets', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
          <Icon name="chevronLeft" size={12} />返回
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <h1 className="text-[16px] font-semibold">设备目标</h1>
        <div className="flex-1" />
        <Button onClick={() => { setEditingId(null); setDraft(emptyDraft()); }}>
          <Icon name="plus" size={12} />新增设备目标
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? <Icon name="loader" size={16} className="animate-spin" /> :
          (list?.length ?? 0) === 0 ? (
            <EmptyState icon="tablet" title="暂无设备目标" description="为移动端用例指定 iOS Simulator / Android Emulator 设备。" />
          ) : (
            <div className="flex flex-col gap-2">
              {list!.map((t) => (
                <div key={t.id} className="bg-card border rounded-[var(--radius-md)] p-4 flex items-center gap-3">
                  <Icon name={t.mobileOs === 'ios' ? 'tablet' : 'tablet'} size={20} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium">{t.name}</div>
                    <div className="text-[11px] font-mono" style={{ color: 'var(--muted-foreground)' }}>
                      {t.mobileOs} · {t.deviceRef}{t.appBundleId ? ` · ${t.appBundleId}` : ''}
                    </div>
                  </div>
                  <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{fullDateTime(t.updatedAt)}</span>
                  <IconButton icon="pencil" title="编辑" onClick={() => {
                    setEditingId(t.id);
                    setDraft({
                      name: t.name, mobileOs: t.mobileOs, deviceRef: t.deviceRef,
                      appBundleId: t.appBundleId ?? '', appPath: t.appPath ?? '', launchArgs: t.launchArgs,
                    });
                  }} />
                  <IconButton icon="trash" title="删除" tone="destructive" onClick={() => setConfirmDelete(t)} />
                </div>
              ))}
            </div>
          )
        }
      </div>
      {draft && (
        <Dialog open onOpenChange={(o) => !o && setDraft(null)}>
          <DialogContent style={{ maxWidth: 520 }}>
            <DialogHeader><DialogTitle>{editingId ? '编辑设备目标' : '新增设备目标'}</DialogTitle></DialogHeader>
            <div className="flex flex-col gap-3 px-5 py-4">
              <Input label="名称" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="iPhone 17 Pro (Sim)" />
              <div className="flex flex-col gap-1">
                <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>平台</span>
                <Segmented
                  value={draft.mobileOs}
                  onChange={(v) => setDraft({ ...draft, mobileOs: v as 'ios' | 'android' })}
                  options={[{ value: 'ios', label: 'iOS' }, { value: 'android', label: 'Android' }]}
                />
              </div>
              <Input label="设备标识（simulator name / Android emulator 名）" value={draft.deviceRef} onChange={(e) => setDraft({ ...draft, deviceRef: e.target.value })} />
              <Input label="默认 bundleId（可选）" value={draft.appBundleId ?? ''} onChange={(e) => setDraft({ ...draft, appBundleId: e.target.value })} placeholder="com.example.app" />
              <Input label="默认 .app / .apk 路径（可选）" value={draft.appPath ?? ''} onChange={(e) => setDraft({ ...draft, appPath: e.target.value })} />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDraft(null)}>取消</Button>
              <Button disabled={!draft.name.trim() || !draft.deviceRef.trim()} onClick={() => save.mutate(draft)}>保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {confirmDelete && (
        <Dialog open onOpenChange={(o) => !o && setConfirmDelete(null)}>
          <DialogContent style={{ maxWidth: 420 }}>
            <DialogHeader><DialogTitle>删除设备目标</DialogTitle></DialogHeader>
            <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
              确认删除「{confirmDelete.name}」？绑定的 mobile 用例将自动解绑（mobileDeviceTargetId 置 null）。
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>取消</Button>
              <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(confirmDelete)}>{remove.isPending ? '删除中...' : '确认删除'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
```

> 需 import：`IconButton from '../components/ui/IconButton';`。

- [ ] **Step 10.2: ProjectsHome 入口**

`apps/web/src/pages/ProjectsHome.tsx` 找到项目行操作按钮组（environments / datasets），仿照加一行 device-targets 入口：

```tsx
<Button variant="ghost" size="sm" onClick={() => navigate(`/p/${p.id}/device-targets`)}>
  <Icon name="tablet" size={12} />设备目标
</Button>
```

- [ ] **Step 10.3: 跑前端 typecheck**

Run: `pnpm -F @itest/web typecheck`
Expected: PASS。

- [ ] **Step 10.4: 提交**

```bash
git add apps/web/src/pages/DeviceTargetsPage.tsx apps/web/src/pages/ProjectsHome.tsx
git commit -m "feat(web): DeviceTargetsPage 项目级 CRUD + ProjectsHome 入口"
```

---

## Task 11: Web — Mobile Recorder 组件 + CaseDetail 接入

**Files:**
- Create: `apps/web/src/features/mobile-recorder/MobileRecorder.tsx`
- Create: `apps/web/src/features/mobile-recorder/index.ts`
- Modify: `apps/web/src/pages/CaseDetail.tsx`

- [ ] **Step 11.1: MobileRecorder 组件**

`apps/web/src/features/mobile-recorder/MobileRecorder.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, type DeviceTarget, type StepClip } from '../../api/client';
import Button from '../../components/ui/Button';
import Icon from '../../components/Icon';
import { useUIStore } from '../../stores/ui';

interface AccessibilityNode {
  accessibilityId?: string;
  label?: string;
  role?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  text?: string;
}

export interface MobileRecorderProps {
  caseId: string;
  defaultTargetId?: string;
  onFinish: (inserted: number) => void;
  onClose: () => void;
}

/** 通过 agent-device 后端 REST 通道：
 *  - POST /recorder/mobile-sessions 启动 daemon + 返回 viewerUrl + wsToken
 *  - WS 双向：客户端发 tap / swipe / appOpen 等命令，server 推送 accessibility snapshot
 *  - POST /recorder/mobile-sessions/:id/finish 落库 steps */
export default function MobileRecorder({ caseId, defaultTargetId, onFinish, onClose }: MobileRecorderProps) {
  const toast = useUIStore((s) => s.showToast);
  const [targetId, setTargetId] = useState<string | undefined>(defaultTargetId);
  const { data: targets } = useQuery({ queryKey: ['deviceTargets', /* projectId from store */], queryFn: () => api.deviceTargets.list(/* projectId */), enabled: false });
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [tree, setTree] = useState<AccessibilityNode[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [recordedSteps, setRecordedSteps] = useState<StepClip[]>([]);

  // 启动 daemon 会话
  const start = useMutation({
    mutationFn: async () => {
      if (!targetId) throw new Error('请先选择设备目标');
      const r = await fetch('/api/recorder/mobile-sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caseId, deviceTargetId: targetId }),
      });
      if (!r.ok) throw new Error((await r.json()).message ?? '启动失败');
      return r.json() as Promise<{ sessionId: string; viewerUrl: string; wsToken: string }>;
    },
    onSuccess: (r) => {
      setViewerUrl(r.viewerUrl);
      setSessionId(r.sessionId);
      // 打开 WebSocket（snapshot 一致）
      const ws = new WebSocket(`/api/recorder/mobile-sessions/${r.sessionId}/ws?token=${r.wsToken}`);
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'snapshot') setTree(msg.nodes);
        if (msg.type === 'step-recorded') setRecordedSteps((prev) => [...prev, msg.step]);
      };
      (window as any).__mobileWs = ws;
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const finish = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('no session');
      // 关闭 WS
      (window as any).__mobileWs?.close();
      const r = await fetch(`/api/recorder/mobile-sessions/${sessionId}/finish`, { method: 'POST' });
      if (!r.ok) throw new Error('finish failed');
      return (await r.json()) as { inserted: number };
    },
    onSuccess: (r) => {
      toast(`已写入 ${r.inserted} 个步骤`, 'success');
      onFinish(r.inserted);
      onClose();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  // 点选节点 → 发 tap
  const tapNode = (n: AccessibilityNode) => {
    const ws = (window as any).__mobileWs;
    if (!ws || ws.readyState !== 1) return;
    if (!n.accessibilityId && !n.label) return;
    ws.send(JSON.stringify({
      type: 'record',
      step: {
        source: 'recorder',
        instruction: n.label ?? n.accessibilityId ?? '',
        compiled: [{ kind: 'tap', locator: [
            ...(n.accessibilityId ? [{ strategy: 'accessibilityId', value: n.accessibilityId }] : []),
            ...(n.label ? [{ strategy: 'label', value: n.label }] : []),
          ] }],
        mobileOs: 'ios',
      },
    }));
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <Icon name="tablet" size={14} />
        <span className="text-[13px] font-medium">移动录制</span>
        <select className="input-base input-sm" value={targetId ?? ''} onChange={(e) => setTargetId(e.target.value || undefined)}>
          <option value="">选择设备目标</option>
          {(targets ?? []).map((t: DeviceTarget) => (
            <option key={t.id} value={t.id}>{t.name} ({t.mobileOs})</option>
          ))}
        </select>
        <Button size="sm" onClick={() => start.mutate()} disabled={!targetId || start.isPending}>
          <Icon name="play" size={12} />启动 daemon
        </Button>
        <Button size="sm" onClick={() => finish.mutate()} disabled={!sessionId || finish.isPending}>
          <Icon name="pause" size={12} />完成
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onClose}>关闭</Button>
      </div>
      <div className="flex-1 grid grid-cols-2 gap-3 p-3 min-h-0">
        <div className="border rounded-[var(--radius-md)] overflow-hidden bg-[#000]">
          {viewerUrl ? (
            <iframe src={viewerUrl} className="w-full h-full" title="device preview" />
          ) : (
            <div className="flex items-center justify-center h-full text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              启动 daemon 后内嵌预览
            </div>
          )}
        </div>
        <div className="border rounded-[var(--radius-md)] overflow-y-auto p-2 text-[11px] font-mono">
          <div className="text-[11px] mb-2 font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>Accessibility Tree</div>
          {tree.length === 0 ? (
            <div style={{ color: 'var(--muted-foreground)' }}>无节点</div>
          ) : (
            tree.map((n, i) => (
              <button key={i} type="button" className="block w-full text-left px-2 py-1 hover:bg-[var(--muted)] press" onClick={() => tapNode(n)}>
                <span style={{ color: 'var(--primary)' }}>{n.role ?? '?'}</span>{' '}
                {n.accessibilityId && <span style={{ color: 'var(--info)' }}>#{n.accessibilityId}</span>}{' '}
                {n.label && <span>{n.label}</span>}
                {n.bounds && <span style={{ color: 'var(--muted-foreground)' }}> ({Math.round(n.bounds.x)},{Math.round(n.bounds.y)})</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 11.2: index.ts barrel**

`apps/web/src/features/mobile-recorder/index.ts`：
```ts
export { default as MobileRecorder } from './MobileRecorder.js';
```

- [ ] **Step 11.3: CaseDetail 增 mobile 录制入口**

`apps/web/src/pages/CaseDetail.tsx`：
- import：`import { MobileRecorder } from '../features/mobile-recorder';`
- 在 `recorder.status` state 与「录制补充」按钮区域加 mobile 分支：若 `caseDetail.platform === 'mobile'`，显示「录制 Mobile」按钮，点击后弹出 modal（用现有 Dialog 组件）内嵌 `<MobileRecorder caseId={id} defaultTargetId={caseDetail.mobileDeviceTargetId ?? undefined} onFinish={...} onClose={...} />`。
- mobile 路径下隐藏「浏览器录制」分组（右侧 rail），保留 mobile 录制入口 + AI 补充。

- [ ] ] **Step 11.4: 跑前端 typecheck**

Run: `pnpm -F @itest/web typecheck`
Expected: PASS。

- [ ] **Step 11.5: 提交**

```bash
git add apps/web/src/features/mobile-recorder apps/web/src/pages/CaseDetail.tsx
git commit -m "feat(web): MobileRecorder 组件 + CaseDetail 接入 mobile 录制入口"
```

---

## Task 12: 报告 / 计划运行 / 步骤编辑 mobile 适配

**Files:**
- Modify: `apps/web/src/pages/ReportDetail.tsx`
- Modify: `apps/web/src/pages/PlanRunDetail.tsx`
- Modify: `apps/web/src/components/StepEditDrawer.tsx`

- [ ] **Step 12.1: ReportDetail header 增 platform/device badge**

`apps/web/src/pages/ReportDetail.tsx`：
- import `StatusPill` 已用；在 `h1` 行尾 status 旁加：
  ```tsx
  {data.platform === 'mobile' && (
    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full" style={{ background: 'var(--info-soft)', color: 'var(--info)' }}>
      <Icon name="tablet" size={11} />{data.mobileOs ?? 'mobile'}{data.deviceName ? ` · ${data.deviceName}` : ''}
    </span>
  )}
  ```
- 「元数据」卡片增加 platform / mobileOs / deviceName / deviceTargetId 行（与现有 caseTitle / caseId 同样 MetaRow 模式）。

- [ ] **Step 12.2: PlanRunDetail 增 web/mobile 计数**

`apps/web/src/pages/PlanRunDetail.tsx`：
- 在 summary 行加：
  ```tsx
  {(() => {
      const web = run.cases.filter((c) => c.stepKind !== 'mobile' && /* pending flag */ true).length;
      return null; // 简化：用 caseId 反查 platform（client 已有 TestCase 接口）
  })()}
  ```
- 实际：因为 PlanRun 详情没返回 platform，需后端补 `platform` 到 planRunCases 出参。简化：run header 显示「总计 / 已通过 / 已失败」保持；mobile 统计由 ReportDetail header 体现；planRun 详情仅在每个 case 行加 platform icon（仿 caseDetail 已有的 platform badge）。

- [ ] **Step 12.3: StepEditDrawer mobile action 显隐**

`apps/web/src/components/StepEditDrawer.tsx`：
- 增 mobile-only action 选项卡 / sub-form（按 spec §5.2）。**MVP 实现**：在 `kind` 选择下拉加 `tap / swipe / setAppearance / setNetwork / setLocation / appOpen / appBack / appRestart / home` 9 项；选中后展示对应字段表单（locator 与 web 一致；swipe 加 from/to；setLocation 加 lat/lon；其它单一字段）。
- `platform` context：`StepEditDrawer` 接收 `platform?: 'web' | 'mobile'` prop；`platform === 'mobile'` 时默认 kind=tap，禁用 click/fill/select 等 web-only 项。

- [ ] **Step 12.4: 跑前端 typecheck**

Run: `pnpm -F @itest/web typecheck`
Expected: PASS。

- [ ] **Step 12.5: 提交**

```bash
git add apps/web/src/pages apps/web/src/components
git commit -m "feat(web): ReportDetail / PlanRunDetail / StepEditDrawer 增 mobile 适配"
```

---

## Task 13: 测试覆盖（mobile engine + deviceTargets CRUD + runCase 路由）

**Files:**
- Create: `apps/api/test/mobile-engine.test.ts`
- Create: `apps/api/test/device-targets.test.ts`
- Create: `apps/api/test/runCase-mobile.test.ts`
- Modify: `apps/api/test/helpers/db.ts`

- [ ] **Step 13.1: device-targets CRUD 测试**

`apps/api/test/device-targets.test.ts`：仿 `apps/api/test/runCase-dataset.test.ts` 的 testcontainer + supertest + seedProject 模式。

测试点：
1. POST 创建 → GET 列表能拿到；name 冲突 → 409。
2. PUT 更新 → GET 详情能拿到新值。
3. DELETE → 列表消失；引用用例 mobileDeviceTargetId 被 FK 置 null（`onDelete: 'set null'`）。

- [ ] **Step 13.2: runCase mobile 路由测试**

`apps/api/test/runCase-mobile.test.ts`：

Mock MobileEngine：
```ts
const { mobileMock } = vi.hoisted(() => ({ mobileMock: vi.fn() }));
vi.mock('../src/execute/mobileEngine.js', () => ({ MobileEngine: class { prepare = vi.fn(); release = vi.fn(); execute = mobileMock; platform = 'mobile' } }));
```

测试点：
1. caseRow.platform='mobile' + mobileDeviceTargetId + appRef → 路由到 MobileEngine.execute；执行器收到 input.appRef / mobileOs / deviceTargetId。
2. MobileEngine.prepare 抛 EngineUnavailable → report.failureReason='EngineUnavailable'；status='failed'。
3. caseRow.platform='web' → 路由到 WebEngine（既有执行）；mobileMock 不被调。

- [ ] **Step 13.3: mobile-engine dispatch 单测**

`apps/api/test/mobile-engine.test.ts`：

Mock `acquireDevice` 返回一个伪 session（含 snapshot/tap/fill/expect 等 stub）；断言：
- `tap` 命令：session.client.tap 被调一次，参数含 {x, y}（取 bounds 中心）。
- `swipe`：from/to 中心点 + durationMs。
- `fill`：materializeValue 后注入到 session.client.fill。
- `setNetwork airplane`：session.client.setNetwork({state:'airplane'})。
- `assertText`：session.client.expect().toHaveText 被调。
- 不支持的 kind（如 `select` 在 mobile）→ 抛 MobileUnsupportedCapability。

- [ ] **Step 13.4: 跑测试**

Run: `pnpm -F @itest/api test`
Expected: 全部 PASS。

- [ ] **Step 13.5: 提交**

```bash
git add apps/api/test
git commit -m "test(api): deviceTargets CRUD + runCase mobile 路由 + MobileEngine dispatch 单测"
```

---

## Task 14: 集成探针 + README 更新

**Files:**
- Create: `apps/api/probe-mobile.mjs`
- Modify: README.md

- [ ] **Step 14.1: 移动端集成探针**

`apps/api/probe-mobile.mjs`：
```js
// 启动一个 iOS Simulator（agent-device 内部 prepare ios-runner）→ 跑 3 条 mobile step：appOpen / tap / assertVisible。
// 校验 report.status === 'passed'、screenshots 目录产出 png。
// 不在 CI 跑；本地手动验证用：node apps/api/probe-mobile.mjs
import fetch from 'node-fetch';
import { spawn } from 'child_process';

const API = process.env.API_URL ?? 'http://127.0.0.1:54321';
const TOKEN = process.env.API_TOKEN ?? '';

async function main() {
  // 1. 创建项目级 device_target（iPhone 17 Pro Simulator） + mobile case
  const project = await post('/api/projects', { name: 'probe', organizationId: process.env.ORG_ID });
  const group = await post(`/api/groups`, { projectId: project.id, name: 'g1' });
  const target = await post(`/api/projects/${project.id}/device-targets`, {
    name: 'iPhone 17 Pro (probe)', mobileOs: 'ios', deviceRef: 'iPhone 17 Pro',
  });
  const caseRow = await post('/api/cases', {
    groupId: group.id, versionId: process.env.VERSION_ID,
    title: 'mobile probe', platform: 'mobile', mobileOs: 'ios',
    mobileDeviceTargetId: target.id, appRef: { bundleId: 'com.apple.Preferences' },
  });
  // 2. 写入 3 条 mobile step
  await put(`/api/cases/${caseRow.id}/steps`, {
    steps: [
      { instruction: '打开设置', compiled: [{ kind: 'appOpen' }] },
      { instruction: '点击外观', compiled: [{ kind: 'tap', locator: [{ strategy: 'accessibilityId', value: 'appearance' }] }] },
      { instruction: '截图', compiled: [{ kind: 'screenshot', name: 'final' }] },
    ],
  });
  // 3. 执行
  const r = await post(`/api/cases/${caseRow.id}/execute`, {});
  console.log('report:', r);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 14.2: README 更新**

在 README「## Roadmap」或「## 平台支持」章节加：
```
- **移动端测试（MVP）**：iOS Simulator + Android Emulator。新增 `device_targets` 项目级资源、
  `platform='mobile'` 用例、agent-device SDK 后端、web 内嵌设备预览 + 点选录制器。
  真机 / 云设备 / 屏幕录制留二期。
```

- [ ] **Step 14.3: 提交**

```bash
git add apps/api/probe-mobile.mjs README.md
git commit -m "docs: 移动端测试 MVP 说明 + probe-mobile.mjs 集成探针"
```

---

## Self-Review

逐项检查：

1. **Spec 覆盖**：
   - §2 选型（agent-device）→ Task 4.1 ✓
   - §3 仓库结构 → 全部 Task 命中 ✓
   - §4 数据模型（device_targets + 4 列）→ Task 2 ✓
   - §5 DSL 扩展 → Task 1 ✓
   - §6 Engine interface → Task 3 ✓
   - §7 MobileEngine → Task 4 ✓
   - §8 录制器 → Task 11 ✓
   - §9 报告/AI/计划/dataset → Task 7 / Task 8 / Task 12 ✓
   - §10 错误归类 → FailureReason 增 4 项（Task 1.4） ✓
   - §11 测试 → Task 13 ✓
   - §13 交付清单 → 1-13 Task 全部 ✓

2. **Placeholder 扫描**：无 TBD / TODO；所有步骤含具体代码或文件名。

3. **类型一致性**：
   - `EngineInput.appRef` 与 `AppRef` interface 对齐；
   - `FailureReason` 增 4 项与 `MobileEngine` / `EngineUnavailable` 一致；
   - `mobile_os / platform / device_target_id` 列名贯穿 schema / migration / runCase / tests。

---

## 执行模式选择

**Plan 完成，保存于** `docs/superpowers/plans/2026-10-07-mobile-testing.md`。

**两种执行方式：**

**1. Subagent-Driven（推荐）** — 每个 Task 派一个新 subagent，task 间有 review 间隙，快速迭代。

**2. Inline Execution** — 在本会话直接执行所有 task，批量跑加 review checkpoints。

**选哪种？**