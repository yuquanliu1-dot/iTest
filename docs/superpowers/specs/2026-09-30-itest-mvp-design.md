# iTest MVP 设计

**日期**: 2026-09-30
**状态**: 设计稿，待用户审阅
**目标**: 搭建 iTest 自动化测试平台的 MVP 框架，确认技术栈选型，重点验证 AI 智能体方案与 UI 风格。

**端口约定**：API 54321、Web 5173、PostgreSQL 5432、Redis 6379（均为本机）。

---

## 1. 背景与目标

iTest 是一个自动化测试平台，核心能力：

1. **需求 → 测试用例**：通过 AI Agent 分析需求文本，自动生成结构化测试用例
2. **用例 → 测试脚本**：通过 AI Agent 把用例转换为可执行的步骤 DSL
3. **录制补充**：通过 Chrome 浏览器扩展在真实页面录制操作，补充与修正脚本
4. **执行与报告**：执行用例生成测试报告（含步骤级状态、截图、错误上下文）

**MVP 范围**：搭起框架让四个链路端到端跑通，但 Agent 输出与脚本执行均为 Mock（不接真实 CDP/LLM）；LLM 接入保留配置入口。

**MVP 不做**：

- 真实 CDP 回放（仅留接口与扩展骨架）
- 多用户/权限/审计
- 国际化（i18n）
- 移动端适配
- 性能压测与可观测性

---

## 2. 技术栈

| 维度 | 选型 | 参考来源 |
|---|---|---|
| Monorepo | Turborepo + npm workspaces | iDO |
| 前端 | React 18 + Vite + Tailwind v4 + Radix UI + Zustand + TanStack Query | iDO |
| 后端 | Node 22 + Express + TypeScript + Drizzle ORM + PostgreSQL + ioredis | iDO |
| LLM 框架 | `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` | tf-soc-agent |
| LLM 接入 | Provider 枚举（mock/openai/anthropic/google）+ KV settings + Settings UI | AgentSOC |
| 录制扩展 | 自研 Chrome 扩展（Manifest V3） | icuecast-extension-2.0.1 |
| 设计令牌 | 紫罗兰渐变画布 + 玻璃面板 | iDO |
| 共享代码 | `packages/shared`（类型 + DSL）+ `packages/ui`（组件） | iDO |

---

## 3. 仓库结构

```
iTest/
├── apps/
│   ├── web/              # React 18 中台（端口 5173）
│   ├── api/              # Node 22 后端（端口 54321）
│   └── recorder/         # Chrome 扩展（MV3，独立加载）
├── packages/
│   ├── shared/           # 共享 TS 类型 + Zod schema + 步骤 DSL
│   └── ui/               # 跨包可复用 React 组件
├── infra/
│   └── docker-compose.yml  # postgres + redis
├── docs/
│   └── superpowers/specs/
├── package.json
├── turbo.json
└── tsconfig.base.json
```

`pnpm dev` 一键启动：docker-compose 起 PG + Redis，turbo 并行跑 api + web。

---

## 4. 进程与通信

```
┌─────────────────┐      HTTP/JSON       ┌──────────────────────┐
│  apps/web (UI)  │ ───────────────────► │   apps/api (REST)    │
│   React SPA │ ◄─── SSE (流式) ──── │   Express + pi-agent │
└─────────────────┘                      └──────────┬───────────┘
                                                  │ Drizzle
                                                  ▼
                                          ┌──────────────────┐
                                          │  PostgreSQL      │
                                          │  + Redis (队列)  │
                                          └──────────────────┘
                                                  ▲
                                                  │ WS + HTTP
                                                  │
                                         ┌────────┴─────────┐
                                         │ apps/recorder    │
                                         │  Chrome Ext MV3  │
                                         └──────────────────┘
```

- **Web ↔ API**：HTTP/JSON（SSE 用于 Agent 流式输出）
- **API ↔ DB**：Drizzle ORM（PG）、ioredis（队列/限流，MVP 仅占位）
- **扩展 ↔ API**：WebSocket（`wss://localhost:54321/recorder?sessionId=&token=`）+ HTTP
- **Web ↔ 扩展**：`window.postMessage` 桥接

后端仅绑定 `127.0.0.1`，不暴露到局域网。

---

## 5. 数据模型（Drizzle Schema）

文件：`apps/api/src/db/schema.ts`

### 5.1 `settings` — KV 配置表

```ts
export const settings = pgTable('settings', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

MVP 写入三个 key：`llm_provider`、`llm_api_key`、`llm_model`。

### 5.2 业务表

```ts
// 需求文档
export const requirements = pgTable('requirements', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: varchar('title', { length: 200 }).notNull(),
  content: text('content').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 测试用例
export const testCases = pgTable('test_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  requirementId: uuid('requirement_id').references(() => requirements.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  priority: varchar('priority', { length: 20 }).notNull().default('P1'),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 测试步骤（DSL JSONB）
export const testSteps = pgTable('test_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').references(() => testCases.id, { onDelete: 'cascade' }).notNull(),
  order: integer('order').notNull(),
  source: varchar('source', { length: 20 }).notNull(),  // 'agent' | 'recorder' | 'manual'
  action: jsonb('action').notNull(),
  assertion: jsonb('assertion'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Agent 运行记录
export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  targetType: varchar('target_type', { length: 30 }).notNull(),
  targetId: uuid('target_id').notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  prompt: text('prompt').notNull(),
  result: jsonb('result'),
  error: text('error'),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  finishedAt: timestamp('finished_at'),
});

// 执行报告
export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').references(() => testCases.id, { onDelete: 'cascade' }).notNull(),
  agentRunId: uuid('agent_run_id').references(() => agentRuns.id),
  status: varchar('status', { length: 20 }).notNull(),
  durationMs: integer('duration_ms'),
  stepResults: jsonb('step_results').notNull(),
  summary: text('summary'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

### 5.3 步骤 DSL

文件：`packages/shared/src/step-dsl.ts`

```ts
export type StepAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; locator: Locator[] }
  | { kind: 'fill'; locator: Locator[]; value: string }
  | { kind: 'hover'; locator: Locator[] }
  | { kind: 'waitFor'; locator: Locator[]; timeoutMs?: number }
  | { kind: 'assertText'; locator: Locator[]; equals: string }
  | { kind: 'assertVisible'; locator: Locator[] }
  | { kind: 'screenshot'; name: string };

export interface Locator {
  strategy: 'role' | 'text' | 'testId' | 'css' | 'xpath';
  value: string;
}
```

多候选 `Locator[]` 借鉴 icuecast 的"多候选定位"思路。

---

## 6. Agent 流

iTest 有两条核心 Agent 流水线，复用 tf-soc-agent 的 `Workflow = Steps[]` 模型：

### 6.1 流水线 A：需求 → 用例

```
需求文本 → [Agent: 拆解] → [Agent: 评审] → 写入 test_cases + test_steps
```

Workflow 定义：`apps/api/src/agent/workflows/requirement2cases.ts`

- 步骤 1：REQUIREMENT_DECOMPOSE_PROMPT，无工具，纯 LLM
- 步骤 2：CASE_REVIEW_PROMPT，无工具，纯 LLM
- `continueOnError: false`

触发：前端 → `POST /api/agent-runs { targetType: 'requirement2cases', targetId }` → 后端返回 `agentRunId` → 前端 SSE 订阅 `/api/agent-runs/:id/events` 收步骤进度 → 完成后写入 DB。

### 6.2 流水线 B：用例 → 脚本

```
用例 (title + steps) → [Agent: 生成 DSL] → [Agent: 自检] → 合并写入 test_steps
```

Workflow 定义：`apps/api/src/agent/workflows/case2script.ts`

- 步骤 1：根据已有用例生成补充步骤 DSL（Locator 优先 role/testId）
- 步骤 2：自检步骤完整性（缺断言？缺等待？定位器多重？）

合并策略：同 `order` 覆盖；`source: 'agent'`。

### 6.3 流水线 C：执行（Mock）

```
用例 steps[] → [后端: 模拟执行] → reports（passed/failed 80/20 随机）
```

- 不接 CDP，每步按概率返回结果
- 生成占位截图：`screenshots/{reportId}/step-{n}.png`
- 写入 `reports` 表，UI 在 `/reports/:id` 展示

### 6.4 目录结构

```
apps/api/src/agent/
├── agentFactory.ts           # createAgent(prompt, tools, skills, sessionId)
├── builtinTools.ts           # saveCaseTool、saveStepsTool、saveReportTool
├── llm-client.ts             # 读 settings KV，调用 pi-ai
├── workflows/
│   ├── requirement2cases.ts
│   └── case2script.ts
└── prompts/
    ├── requirement-decompose.ts
    ├── case-review.ts
    ├── case-to-script.ts
    └── script-selfcheck.ts
```

### 6.5 工具白名单

| Workflow | 可用工具 |
|---|---|
| requirement2cases | `saveCaseTool` |
| case2script | `saveStepsTool`、`getCaseTool` |
| caseExecute（mock） | `saveReportTool` |

MVP 不接外部 MCP server。

---

## 7. 录制集成（Chrome 扩展）

### 7.1 扩展目录结构

```
apps/recorder/
├── manifest.json          # MV3，host_permissions: <all_urls>
├── background.js          # Service Worker
├── content/
│   ├── bridge.js          # 注入所有 frame，监听 postMessage
│   ├── recorder.js        # 按需注入，捕获 DOM 事件
│   └── player.js          # 按需注入，CDP + DOM 双模式（MVP 占位）
├── modules/
│   ├── selector-core.js   # 多候选 Locator 生成
│   ├── api-client.js      # 与本地后端 WS/HTTP 通信
│   ├── recorder-manager.js # 录制状态机
│   └── player-manager.js  # 回放状态机（MVP 骨架）
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
└── icons/
```

`manifest.json` 关键字段：

- `permissions`: `scripting`, `debugger`, `notifications`, `storage`
- `host_permissions`: `<all_urls>`
- `content_scripts.matches`: 仅 `http://localhost/*` + `http://127.0.0.1/*`（中台）

### 7.2 录制流程

```
用户在中台用例详情页点「开始录制」
  ↓
前端调 POST /api/recorder/sessions → 返 sessionId + wsToken
  ↓
中台通过 window.postMessage 通知扩展 bridge
  ↓
Service Worker 连接 WS wss://localhost:54321/recorder?sessionId=&token=
  ↓
Service Worker 注入 recorder.js 到目标页 frame
  ↓
recorder.js 拦截 click/input/change/hover，selector-core 生成 Locator[]
  ↓
步骤经 recorder-manager 通过 WS 推送到后端
  ↓
用户在 popup / 中台停止录制
  ↓
POST /api/recorder/sessions/:id/finish → 后端关闭会话
  ↓
批量插入 test_steps，前端刷新用例详情
```

### 7.3 selector-core 策略

`modules/selector-core.js` 生成 5 种策略的候选 Locator：

1. `role`: `button[name="提交"]`
2. `testId`: `data-testid` 或 `data-test-id` 值
3. `text`: 元素文本（截断 50 字符）
4. `css`: 标签 + 关键属性路径
5. `xpath`: 完整 XPath

最多返回 5 个候选，按优先级排列。

### 7.4 回放引擎占位

`apps/api/src/routes/execute.ts` 暴露 `POST /api/cases/:id/execute`。MVP 走 Mock 路径（§6.3）；`player-manager.run(steps[])` 扩展骨架已就位但不挂载。

---

## 8. UI 与设计令牌

### 8.1 设计令牌

`packages/ui/src/tokens.css`，从 iDO 复制并保留原值：

```css
@theme {
  --color-background: #EEF0FF;
  --color-surface: rgba(255, 255, 255, 0.62);
  --color-surface-strong: rgba(255, 255, 255, 0.75);

  --color-primary: #7C5CFC;
  --color-primary-hover: #6A4AE0;
  --color-secondary: #af52de;

  --color-success: #12B76A;
  --color-destructive: #F04438;
  --color-warning: #F79009;
  --color-info: #06AED4;

  --color-text-primary: #232038;
  --color-text-secondary: #6E6A8A;
  --color-text-muted: #9B97B5;

  --font-sans: "DM Sans", "Inter", system-ui, sans-serif;
  --radius-md: 12px;
  --radius-lg: 16px;
  --shadow-glass: 0 8px 32px rgba(124, 92, 252, 0.12);
}
```

### 8.2 全局样式

`apps/web/src/index.css`：

```css
@import "@itest/ui/tokens.css";
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  background: linear-gradient(135deg, #EEF0FF 0%, #F5EFFF 100%);
  min-height: 100vh;
  color: var(--color-text-primary);
  font-family: var(--font-sans);
}

.glass-panel {
  background: var(--color-surface);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-glass);
}
```

### 8.3 共享组件

`packages/ui/` 从 iDO 移植以下组件（按需简化）：

- Button、Card、Input、Textarea
- Select、Dialog、Tabs（基于 Radix UI）
- Toast、Badge、Table

**不移植**：Chat/Conversation/Knowledge 等 iDO 领域组件；Framer Motion 复杂动画。

### 8.4 布局（AppShell）

顶栏 64px（Logo + 主导航 + 用户头像），无侧栏（MVP 模块少）。路由懒加载。

全局状态：Zustand 单 store + slice（`useUIStore`、`useRecorderStore`、`useAgentRunStore`）。

### 8.5 核心页面

| 路径 | 页面 | 关键元素 |
|---|---|---|
| `/` | Dashboard | 统计卡片 + 最近 Agent 运行 |
| `/requirements` | 需求列表 | 表格 + 「新建」+ 「用 AI 生成用例」 |
| `/requirements/:id` | 需求详情 | Markdown 预览 + 关联用例 |
| `/cases` | 用例列表 | 表格 + 优先级/状态筛选 |
| `/cases/:id` | 用例详情 | Tabs：[描述] [步骤] [报告] [录制历史] |
| `/reports` | 报告列表 | 表格 |
| `/reports/:id` | 报告详情 | 步骤时间线 + 截图画廊 |
| `/settings` | 设置 | LLM 配置 |

### 8.6 与 iDO 的差异

| 维度 | iDO | iTest |
|---|---|---|
| 侧栏 | 有 | 无（顶栏导航） |
| 状态管理 | 多 store | 单 store + slice |
| 动画 | Framer Motion | CSS transition |
| i18n | i18next | 不做（MVP 中文） |

---

## 9. REST API（MVP 必暴露）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/settings` | 列出所有 KV |
| GET | `/api/settings/:key` | 单个 |
| PUT | `/api/settings` | upsert `{key, value}` |
| GET | `/api/requirements` | 列表 |
| POST | `/api/requirements` | 新建 |
| GET | `/api/requirements/:id` | 详情 |
| GET | `/api/cases` | 列表（支持筛选） |
| POST | `/api/cases` | 新建 |
| GET | `/api/cases/:id` | 详情（含 steps） |
| PATCH | `/api/cases/:id` | 更新 |
| POST | `/api/cases/:id/steps` | 追加步骤 |
| POST | `/api/cases/:id/execute` | 触发执行（Mock） |
| GET | `/api/reports` | 列表 |
| GET | `/api/reports/:id` | 详情 |
| POST | `/api/agent-runs` | 启动 Agent Workflow |
| GET | `/api/agent-runs/:id/events` | SSE 订阅 |
| GET | `/api/agent-runs/:id` | 运行详情 |
| POST | `/api/recorder/sessions` | 创建录制会话 |
| POST | `/api/recorder/sessions/:id/finish` | 结束会话 |

WebSocket：

- `WS /recorder?sessionId=&token=` 录制步骤推送

---

## 10. 错误处理

### 10.1 错误分类

| 类型 | 例子 | 处理 |
|---|---|---|
| LLM 调用 | 401/429/网络 | agent_run.status = 'failed'，前端 toast |
| LLM 输出 schema | JSON 缺字段、类型错 | 写回 agent_run.result，前端展示"输出不符合预期" |
| DB | 唯一约束/外键 | 500 + 通用 toast |
| 录制器通信 | WS 断开/token 过期 | 录制 Tab 显示重连状态，重试 3 次后提示刷新 |

### 10.2 统一错误格式

```json
{ "error": "string", "message": "可选", "details": "可选" }
```

`apps/api/src/middleware/errorHandler.ts` 集中处理 ZodError、PG 唯一约束、未知错误。

### 10.3 Agent 流式错误事件

```ts
type AgentEvent =
  | { type: 'step_start'; stepId: string }
  | { type: 'step_text'; stepId: string; delta: string }
  | { type: 'step_complete'; stepId: string; output: unknown }
  | { type: 'workflow_complete'; runId: string; result: unknown }
  | { type: 'workflow_error'; runId: string; error: string; code: 'llm' | 'schema' | 'db' | 'unknown' };
```

**不静默重试**：用户主动决定是否重试。

---

## 11. 测试策略

### 11.1 单元测试（Vitest）

- `selector-core` 多候选 Locator 生成
- `step-dsl` 序列化/反序列化
- Agent prompt 模板变量替换
- DB schema Zod 校验

### 11.2 集成测试（Vitest + Supertest + testcontainers）

- Settings KV 读写
- 需求/用例 CRUD
- Agent Workflow 端到端（mock provider）
- 用例执行（mock）→ 报告写入

### 11.3 E2E / 录制器测试

- E2E 留位 `apps/web/e2e/`，MVP 不写
- 录制器测试用 jsdom 测 selector-core 与 recorder-manager 状态机，不测真实浏览器注入

### 11.4 运行

- `pnpm test` 跑单元 + 集成
- 集成测试用 `@testcontainers/postgresql` 起临时 PG
- MVP 不接 CI，本地 `pnpm verify` = lint + typecheck + test

---

## 12. 风险与已知限制

| 风险 | 影响 | 缓解 |
|---|---|---|
| `pi-agent-core` 是私有包，公共 npm 无访问 | MVP 起不来 | 第一步验证 npm 访问权限；若无则降级为自研最小 Agent 运行时 |
| LLM mock provider 行为需手工实现 | Agent 流不能完整模拟真实 LLM 流式输出 | mock 实现仅返回结构化 JSON，不模拟流式增量 |
| Chrome 扩展在 macOS 14+ 加载需开启开发者模式 | 用户手动操作一次 | README 写明安装步骤 |
| Tailwind v4 与 Radix UI 兼容 | 已知稳定 | 沿用 iDO 验证过的组合 |
| PG + Redis 启动开销 | docker-compose 启动 ~10s | README 写明首次启动需等待 |

---

## 13. 成功标准

MVP 框架完成需满足：

- [ ] `pnpm dev` 一键启动 web + api + pg + redis
- [ ] 可在 `/settings` 切换 LLM provider 并保存
- [ ] 可在 `/requirements` 新建需求，触发「用 AI 生成用例」（mock provider 返回 mock 用例）
- [ ] 可在用例详情页查看步骤，看到 `source: 'agent'` 标签
- [ ] 可加载 Chrome 扩展，开始/停止录制，步骤通过 WS 推送到后端并写入 `test_steps`
- [ ] 可在用例详情页点「▶ 录制补充」「⚡ AI 补充」按钮触发流程
- [ ] 可在用例详情页点「执行」（mock），生成报告 + 占位截图
- [ ] 可在 `/reports/:id` 查看步骤级结果
- [ ] UI 视觉与 iDO 一致（紫罗兰渐变 + 玻璃面板 + DM Sans）
- [ ] `pnpm verify` 全绿（lint + typecheck + 单元测试 + 集成测试）