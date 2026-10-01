# AI 创建用例：会话式工作台（assistant-ui + Pi 栈）

日期：2026-10-01
状态：待用户审阅
上游参考：
- 用户提供的界面截图（左聊天 / 右用例审阅列表 / Stop Generating / 进度条）
- `docs/superpowers/specs/2026-09-30-plan-execution-design.md`（SSE + 进程内总线模式）
- `docs/superpowers/specs/2026-10-01-ai-step-optimization-design.md`（LLM 设置 / mock 约定）

## 背景与目标

现有「AI 生成用例」（requirement2cases workflow）是一键式：无对话、不可迭代、生成即写库、无审阅环节。本期用对话式 AI 工作台替换它：用户与 AI 就需求对话，AI 把分解出的测试场景与用例实时流入右侧审阅列表，用户可勾选、可继续对话迭代、可随时停止，确认后选择分组保存入库。

技术栈（用户指定，调研确认真实包名）：

```
@assistant-ui/react (UI)  →  @assistant-ui/react-pi (适配器)
    →  Pi 运行时 @earendil-works/pi-coding-agent (AgentSession, 进程内)
        →  @earendil-works/pi-ai (模型接口)  →  LLM 提供商
```

要点：`pi-ai` / `pi-agent-core` 裸名包是占位包（0.0.1），真实包为 `@earendil-works/pi-*`（~0.99.2）；`@assistant-ui/react-pi` 0.0.25 定义了标准 HTTP+SSE 线路契约，agent 固定跑在服务端，浏览器只是客户端。Pi 要求 Node >= 22.19（本机 v24.14.1 满足；plan 阶段第一步须核实 CI / 部署环境 Node 版本，不满足则先升）。

### 本期范围（YAGNI）

**做**：

- 需求级 AI 工作台页 `/p/:projectId/requirements/:id/ai`：左聊天（流式 token + 思考折叠）、右审阅列表（场景→用例两级、复选、进度条）
- 测试场景（scenarios）概念落地：新表 + 用例挂接 + AI 先分解场景再生成用例
- 暂存 + 确认保存：AI 产出只进工作台暂存文档，不直接写业务表；保存时事务写 scenarios + testCases + testSteps，支持多次部分保存，保存时选分组（记忆上次）
- 每需求一个可恢复会话线程：聊天记录（Pi SessionManager JSONL）+ 暂存文档（DB jsonb）跨刷新/重启保留
- 对话迭代：AI 通过幂等 upsert 工具修改/删除已生成条目
- Stop Generating：中止当前 turn
- 模型配置复用现有 settings 表（llm_provider / llm_api_key / llm_model / llm_base_url）桥接 pi-ai；mock provider 注入脚本化假模型
- 替换旧流程：删除 requirement2cases workflow 及需求页生成入口；agentRuns 基础设施与 case2script 保留

**明确不做**：

- 暂存条目的手动表单编辑（迭代靠对话；保存后可在普通用例页编辑）
- 右栏搜索 / Type / Priority 筛选（暂存量小，截图元素从简）
- 多会话线程 / 线程列表切换（每需求固定一线程）
- 模型切换 / thinking 级别 UI（线路契约中相关端点返回 501）
- 左栏附件上传（附件区仅占位）
- 多人实时协同编辑同一暂存文档
- 权限粒度变化（沿用现状：项目可见即可用工作台）

### 设计决策（已与用户确认）

| 议题 | 决策 |
|---|---|
| 与旧 requirement2cases 关系 | 替换；删 workflow 与入口，保留 agentRuns 基础设施 |
| 页面位置 | 独立新路由 `/p/:projectId/requirements/:id/ai`，需求详情页保持现状 + 跳转按钮 |
| Scenarios 概念 | 本期落地：scenarios 表 + requirement→scenario→case 层级 |
| 写入策略 | 暂存 + 确认保存，不直接写库 |
| 会话生命周期 | 每需求一线程，聊天与暂存均可恢复 |
| 保存目标分组 | 保存弹窗选择，记忆上次选择 |
| 实现方案 | 方案 A：完整 Pi 栈、服务端进程内 Agent、Express 实现 react-pi 线路契约 |
| 优先级口径 | 沿用 P0–P3；prompt 约定 Must have→P0、Should have→P1、Could have→P2 |
| 暂存用例步骤 | 复用现有 CasesOutput 步骤结构（name + action + assertion），保存时映射 testSteps |

## 架构

```
浏览器 apps/web
└── AiWorkspacePage  /p/:projectId/requirements/:id/ai（新路由）
    ├── 左栏聊天：@assistant-ui/react <Thread> + usePiRuntime({ client: createPiHttpClient('/api/pi') })
    └── 右栏工作台面板：暂存文档渲染（场景/用例两级、复选、进度条、保存）

服务端 apps/api
└── /api/pi/* 新路由组（auth 中间件 + projectAccess 校验）
    ├── react-pi 线路契约：threads 增查 / messages / events(SSE) / cancel / models
    └── src/pi/ 模块：createAgentSession 进程内运行，每需求一个会话
        ├── 模型桥接：settings 表 → pi-ai provider（openai 兼容 base_url 透传）
        └── 自定义工具（TypeBox）：announce_plan / upsert_scenario / upsert_case / remove_item
            → 原子写 ai_workspace_state（jsonb）→ SSE 推 workspace_doc 事件 → 右栏实时更新

保存：POST /api/requirements/:id/ai-workspace/save
    → 单事务写 scenarios + testCases(+scenario_id) + testSteps → 暂存文档移除已存条目
```

### 数据流（一次生成）

1. 需求列表行 / 需求详情页点「AI 创建用例」→ 工作台页；页面先调 `POST /api/requirements/:id/ai-thread`（幂等：无则建，返回 threadId）
2. 加载线程 → assistant-ui 恢复历史消息，右栏恢复暂存文档
3. 用户发消息 → `POST /api/pi/threads/:id/messages` 立即返回，agent 进程内流式执行
4. agent 先调 `announce_plan`（N 场景 / M 用例）→ 进度条分母；逐条 `upsert_scenario` / `upsert_case` → 右栏实时出现，进度 = 已完成 / 计划
5. Stop（`POST /threads/:id/cancel`）随时可中止；已写入暂存的条目保留（每次工具调用已原子落库），plan 保留、进度停在当前值；可继续对话迭代（修改优先级、补充异常场景等）
6. 勾选 → 保存 → 选分组 → 入库；已存条目移出暂存区

持久化分工：聊天记录由 Pi SessionManager（JSONL，`apps/api/.data/` 下，已 gitignore）；暂存文档存 DB。`ai_threads` 维护 requirementId ↔ piThreadId 映射。

## 数据模型（3 个迁移）

```sql
-- 0012: 场景表
CREATE TABLE scenarios (
  id uuid PRIMARY KEY,
  requirement_id uuid NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  "order" integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 0013: 用例挂场景（nullable，存量用例不受影响）
ALTER TABLE test_cases ADD COLUMN scenario_id uuid REFERENCES scenarios(id) ON DELETE SET NULL;

-- 0014: 工作台持久化
CREATE TABLE ai_threads (
  id uuid PRIMARY KEY,               -- 对外 threadId（/api/pi 契约用）
  requirement_id uuid NOT NULL UNIQUE REFERENCES requirements(id) ON DELETE CASCADE,
  pi_thread_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_workspace_state (
  requirement_id uuid PRIMARY KEY REFERENCES requirements(id) ON DELETE CASCADE,
  doc jsonb NOT NULL,                -- 见下
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

`doc` 形状：

```jsonc
{
  "plan": { "scenarios": 5, "cases": 5 },   // announce_plan 写入；null = 未announce
  "scenarios": [
    {
      "id": "s1",                            // agent 会话内稳定 id，幂等 upsert 键
      "title": "客户信息管理",
      "description": "…",
      "cases": [
        {
          "id": "c1",
          "title": "成功创建新客户并验证信息正确性",
          "description": "…",
          "priority": "P0",                  // P0|P1|P2|P3
          "steps": [ { "name": "…", "action": "…", "assertion": "…" } ]
        }
      ]
    }
  ]
}
```

- 优先级沿用现有枚举，UI 用现有 PriorityBadge 渲染
- 未挂场景的散用例允许存在（agent 可不建场景直接 `upsert_case`，scenarioId 可空）——对应 schema 中 scenario_id nullable
- 保存后条目从 `doc.scenarios` 移除；已保存用例不在工作台内展示（去普通页面看）

## 服务端设计

新增 `apps/api/src/pi/`：

```
router.ts        /api/pi/* 线路契约路由（挂 auth + 项目访问校验）
session.ts       会话管理：requirementId ↔ AgentSession，进程内 Map + 惰性恢复（重启后按 ai_threads 重建）
tools.ts         announce_plan / upsert_scenario / upsert_case / remove_item（TypeBox schema）
workspace.ts     WorkspaceStore：读写 ai_workspace_state + 发布变更事件（复用 sse/runBus 模式）
modelBridge.ts   settings 表 → pi-ai provider/model
```

### 线路契约实现

| 端点 | 处理 |
|---|---|
| `POST /api/pi/threads` | 创建线程（`metadata.requirementId`），校验访问权；建 AgentSession + `ai_threads` 行 + 空暂存文档 |
| `GET /api/pi/threads` | 支持按 requirementId 过滤（恢复用：查 `ai_threads` 反查） |
| `GET /api/pi/threads/:id` | 线程详情 + 完整消息历史（Pi session 恢复） |
| `POST /api/pi/threads/:id/messages` | 追加消息并触发执行；立即返回（不阻塞至跑完；浏览器断开不中断运行，官方要求） |
| `GET /api/pi/threads/:id/events` | SSE：转发 Pi 原生事件（token / thinking / tool 执行）+ 同连接插入自定义 `workspace_doc` 事件。若 react-pi reducer 拒绝未知事件类型，降级为运行期 1.5s 轮询暂存文档 |
| `POST /api/pi/threads/:id/cancel` | 中止当前 turn |
| `GET /api/pi/models` | modelBridge 返回当前配置；未配置返回明确错误状态 |
| `PATCH/DELETE /api/pi/threads/:id`、`POST threads/:id/model|thinking`、`POST host-ui` | 501（对应 UI 不启用） |

**访问控制**：全部端点先过现有 auth 中间件，再经 projectAccess 校验「用户—项目—需求」链路；不可见需求的 threadId 一律 404。工作台权限沿用应用现状（项目可见即可用；每需求一线程，无用户私有线程）。

**工具执行**：每次调用 = 一次原子 DB 写 + 一次 SSE 推送；upsert 按 id 幂等（AI 迭代 = 更新非追加）；任意时刻崩溃不丢已生成内容。

**模型桥接**：`openai|anthropic|google` 映射 pi-ai 对应 provider，api_key / model / base_url 透传；`mock` 注入脚本化假模型（确定性地调用工具），本地开发与单测不依赖外部 key。设置页不新增键。

**辅助端点**：`POST /api/requirements/:id/ai-thread`（幂等建线程，返回 threadId）与 `GET /api/requirements/:id/ai-workspace`（读暂存文档，右栏 react-query 用）挂现有路由体系；`POST /api/requirements/:id/ai-workspace/save` 执行保存事务。

**保存语义**（消歧义）：body 为 `{ groupId, scenarioIds, caseIds }`（单次保存一个目标分组）。勾选语义：勾选场景 = 全选其下用例（三态复选框：全选/部分/未选）；事务内创建「被勾选用例所属的场景行」+「被勾选的场景行」及其用例；仅勾选场景而无用例勾选的场景视为整组保存。多次保存同一场景时，场景行按 (requirementId, title) 幂等复用已有行，避免重复场景。

### 旧流程清理

- 删除 `agent/workflows/requirement2cases.ts`、对应 prompt、`builtinTools.createSaveCaseTool` 中仅服务于它的部分、agentRuns 路由的 requirement2cases 分支及其测试
- 需求详情页「生成用例」入口按钮 + AgentStreamPanel 在需求场景的用法移除（组件若被别处使用则保留）
- `case2script`、runBus、llm-client 等基础设施不动

## 前端设计

**新依赖**（apps/web，版本锁死）：`@assistant-ui/react`、`@assistant-ui/react-pi`。

**页面结构**（`src/pages/AiWorkspacePage.tsx` + `src/features/ai-workspace/`）：

```
┌──────────────────────────────────────────────────────────────────┐
│ ← | {项目} / {需求标题}    Scenarios(n) | Test Cases(n)  [● Stop Generating] │
├────────────────────┬─────────────────────────────────────────────┤
│ 左栏 固定 ~400px    │ 右栏 自适应                                   │
│ assistant-ui Thread│ Progress: 45%   Preparing test cases…        │
│  消息流/思考折叠     │ ▢ 全选  已选 x/y                             │
│  底部输入框          │ ▢ 场景卡片（可折叠）                           │
│  （附件区占位）      │   ▢ 用例卡片：标题 [PriorityBadge] + 描述      │
│                    │              [保存所选 → 选分组弹窗]            │
└────────────────────┴─────────────────────────────────────────────┘
```

- 右栏数据：react-query 读 `/api/requirements/:id/ai-workspace`；SSE `workspace_doc` 事件触发缓存刷新
- Stop 按钮仅运行中显示（assistant-ui runtime 状态）；进度 = 已完成条目 / plan
- 保存弹窗：分组树选择（localStorage 记忆上次）→ save 接口；成功后条目移出暂存 + toast；可多次部分保存
- 入口：需求列表行 + 需求详情页头部「AI 创建用例」按钮；旧生成按钮移除

## 错误处理

- 未配置模型：进页面即提示「请先到设置页配置 LLM」，输入框禁用
- LLM 中途报错：Pi 错误事件呈现于聊天流；暂存保留已生成条目，可直接重试
- 服务重启 / 浏览器断开：运行不中断（进程内继续）；重进恢复消息与暂存
- 保存时需求/分组已删：404 / 409，提示刷新
- Pi 破坏性变更风险（pre-1.0）：锁版本；集成缝隙收敛在 `src/pi/` 与 `features/ai-workspace/` 两处，变更只改局部

## 测试

- API（vitest + 现有测试基建）：mock 模型脚本化调工具 → 验证暂存文档写入、ai_threads 映射、访问控制（未登录 / 越权 403/404）、保存事务（scenarios+cases+steps 落库、部分保存、暂存清理）、requirement2cases 路由已移除
- Web：typecheck + lint + 手动金路径（mock 模型跑通 生成 → 迭代 → Stop → 保存）
- 回归：api 套件全量（已知 plans.test 有 1 个 pre-existing 失败）
