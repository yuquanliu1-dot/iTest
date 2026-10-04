# 版本空间 AI 助手(AI-First 主入口)设计

- 日期:2026-10-04
- 状态:已评审通过(设计对话逐节确认)
- 前置文档:`2026-10-03-ai-repo-context-design.md`、`2026-10-01-ai-case-creation-design.md`

## 1. 背景与目标

iTest 已有完整测试管理能力(用例/场景、环境、计划、执行、报告)。现有 AI 能力是**需求级**的用例生成工作区(`/p/:projectId/v/:versionId/ai/:requirementId`),基于 `src/pi/` 体系(pi-coding-agent `createAgentSession` + 自定义工具 + SSE + `ai_threads` 持久化)。

本设计把 AI 升级为**版本空间的主工作界面**:进入版本空间落地即对话,AI 可完成用例/场景管理、环境配置、计划制定等平台操作;意图不明时 AI 主动追问。现有页面保留为展示层与逃生舱。

## 2. 关键决策(已与用户确认)

| 决策点 | 结论 |
|---|---|
| 定位 | **AI-First 主入口**:对话是版本空间默认落地页;旧页面保留可达 |
| 首期范围 | 用例/场景管理 + 环境配置 + 计划制定;**不含**触发执行、报告/统计(留 `query_stats` 扩展位) |
| 确认机制 | **分级**:查询/创建自动执行;更新展示 diff 后执行;删除与密钥操作必须确认 |
| 布局 | **对话 + 舞台分栏**(对话流在左,舞台区展示 AI 正操作的对象) |
| 体系关系 | **升级复用**现有 pi 体系(会话机制、SSE 契约、ThreadPane、LLM 配置、repo 沙箱),不另起炉灶 |
| 旧 AI 页面 | 首期保留(`ai/:requirementId`),不再演进;空间助手覆盖其生成能力后,后续版本下线 |

## 3. 架构总览

```
┌─ apps/web ────────────────────────────────────────────┐
│ /p/:projectId/v/:versionId   ← AI-First 主视图        │
│   ├ 对话区:复用 ThreadPane + usePiRuntime             │
│   └ 舞台区:复用现有组件(用例详情/环境 diff/计划编排) │
│ overview / cases / plans / reports 等路由不变         │
└───────────────────────────────────────────────────────┘
              │ HTTP+SSE(react-pi 契约,新端点 /api/assistant/*)
┌─ apps/api ────────────────────────────────────────────┐
│ src/pi/space/(新增,与现有 requirement 级会话并列)    │
│   ├ session.ts   版本级线程:绑定 projectId+versionId │
│   ├ tools.ts     领域工具,写操作直调 service 层      │
│   ├ confirm.ts   人审挂起机制                          │
│   └ router.ts    threads CRUD + SSE + confirm 端点    │
└───────────────────────────────────────────────────────┘
```

要点:

1. **新建 `pi/space/` 而非改造现有 requirement 级会话**:二者绑定的实体(需求 vs 版本)、线程数(一需求一线程 vs 一版本多线程)、写路径(暂存草稿 vs 直落库)都不同,并列共存互不干扰。
2. **写操作直调 service 层**:现有 routes 中的业务逻辑(校验、版本绑定、group/environment 归属检查)是工具的执行后端。若逻辑困在 route handler 内,先抽到 service 再被工具复用(实施时按最小抽取原则)。
3. **权限**:每个工具执行前 `assertVersionVisible(userId, versionId)`(复用 `services/projectAccess.ts`)。工具能力 = 用户在 UI 上的能力,不多不少。
4. **复用清单**:`readLlmConfig()` 模型桥接、`checkoutRepo` 按版本 ref 的 git 沙箱与 `repo_*` 工具、`inspectPage`、SSE 事件映射(`mapSessionEvent`/`fanOut`)、前端 `createPiHttpClient`/`usePiRuntime`/snapshot 重连。

## 4. 工具面设计

领域级工具 + `action` 判别联合(discriminated union),写 action 传整对象(upsert 语义),读 action 细粒度参数:

| 工具 | action | 确认级别 |
|---|---|---|
| `manage_cases` | `search` / `get` / `create` / `update` / `delete` / `move_group` / `create_group` | 查+建自动;`update` 看后执行;`delete` 必须确认 |
| `manage_scenarios` | `list` / `create` / `update` / `delete` | 同上 |
| `manage_environments` | `list` / `get` / `upsert` / `set_secret` / `delete` | `upsert` 更新看 diff;`set_secret` / `delete` 必须确认;密钥值永不明文回显 |
| `manage_plans` | `list` / `get` / `create`(含用例编排) / `update` / `add_cases` / `remove_cases` | 查+建自动;其余看 diff |
| `inspect_page` / `repo_*` | 现有原样复用 | 自动 |
| `announce_plan` | 泛化:批量操作前声明意图(如"将创建 5 条用例"),驱动前端进度条 | 自动 |

约束:

- 每个工具的 `promptGuidelines` 写明 action 适用场景、批量并行调用(继承现有 `upsert_case` 实战经验:可选字段兜底默认值、locator 形状归一化、同一轮并行提交)。
- 工具执行器保持现有 `ToolExecutor` 形状(TypeBox schema + 可单测 execute),经 `defineTool` 适配注入 AgentSession。
- `create` 用例时,AI 先 `search` 分组树;目标分组不存在则 `create_group`(分组属用例管理范畴,复用现有 groups service,不新增平台能力)。

## 5. 人审挂起机制(confirm gate)

利用工具 `execute` 是 async 的特性,敏感 action 在真正执行前挂起:

```
LLM 调 delete_case(id=x)
  → confirm.ts 生成 confirmId,经 SSE 推送
    {type:'confirm_request', confirmId, summary:'删除用例「登录-正常」', diff?}
  → execute await 确认 promise(LLM 该轮阻塞在工具调用上,协议不变)
  → 前端在对话流渲染确认卡,用户点 [确认] / [取消]
  → POST /api/assistant/threads/:id/confirm {confirmId, approved}
  → resolve → 工具执行并返回结果;拒绝则返回 {ok:false, error:'用户取消了该操作'}
  → 5 分钟超时自动取消
```

- 对 LLM 是一次"较慢的正常工具调用",**不修改 pi 会话协议**;SSE 侧用现有 `fanOut` 注入自定义事件。
- diff 在挂起前由工具算好(旧值 vs 新值),确认卡与实际执行用同一份数据。
- 挂起态为**内存 Map**(threadId+confirmId → resolver),上限 5 分钟。API 重启丢挂起轮次的后果是该轮报错、用户重说,不为此建表(YAGNI)。
- 密钥类确认卡只显示"将设置 db 密码(值已隐藏)",不回显明文。

## 6. 前端交互

### 路由与导航

- `/p/:projectId/v/:versionId` 主视图 = AI 对话 + 舞台;现有概览移至 `overview` 子路由,其余(cases/plans/reports/environments)路由不变,侧边栏可达,AI 项默认高亮。
- 进入版本空间落地即对话。

### 舞台区

- 工具执行结果带对象引用(`kind: 'case' | 'scenario' | 'environment' | 'plan'` + id),随 SSE 事件到前端,舞台自动切换:建用例 → 用例详情卡(复用 CaseDetail);环境变更 → diff 视图;计划 → 编排列表。
- 批量生成:舞台 = 结果列表 + 点选单条详情(复用现有 ai-workspace 右栏交互)。
- 舞台卡提供"在用例库打开 →"跳传统页。

### 上下文注入

会话 system prompt 附版本空间摘要:项目/版本名与 ref、环境清单(名称+baseUrl,密钥脱敏)、分组树、用例/计划数量。AI 对"现在有哪些环境"免查直答。

舞台当前对象**不做隐式注入**(隐性上下文易误导 AI);提供舞台卡"就此提问"按钮,把对象引用显式插入输入框。

### 主动询问

对话式 agent 天然追问;`promptGuidelines` 明确:**参数不足或有歧义时先问再动手,禁止猜 URL、猜名称、猜密钥**。首期自然语言追问,不做结构化选项卡(观察使用后再定)。

### 线程管理

- 每版本多线程:主视图顶部线程下拉(最近 10 条)+ 新建按钮;标题取首条用户消息截断。
- 断线重连与消息恢复复用现有 snapshot 机制。

## 7. 数据模型与迁移(0027)

`ai_threads` 单表扩展,其余不动:

- 加 `kind` varchar(20) NOT NULL DEFAULT `'requirement'`,取值 `'requirement' | 'version'`
- 加 `version_id` uuid NULL REFERENCES `project_versions(id)` ON DELETE CASCADE
- 加 `title` text NULL
- `requirement_id` 改 nullable;删除列级 UNIQUE,建部分唯一索引 `UNIQUE(requirement_id) WHERE kind = 'requirement'`

现有 requirement 线程数据零改动(默认 kind 兜底),语义不变。空间线程查询:`WHERE kind='version' AND version_id=?`。

## 8. 错误处理

- 工具错误沿用 `{ok:false, error}`,文案面向 LLM 可操作(如"未找到用例 x,可先调 search 确认 id"),AI 自纠或转述。
- service 层 zod 校验失败 → 格式化为简洁中文返回,不抛原始堆栈。
- 权限失败 → 工具返回错误,AI 告知无权限;LLM 未配置 → 建线程时即报错,前端引导设置页(现有行为)。
- confirm 拒绝/超时 → `用户取消了该操作`,AI 优雅收尾。
- inspect_page / repo 失败 → 现有降级逻辑(promptGuidelines 兜底)继承。
- SSE 断线 → 现有重连 + snapshot 恢复。

## 9. 测试策略

- **工具执行器单测**(vitest + `test/helpers/db.ts`):每个 `manage_*` 工具覆盖 action 分发、参数校验、确认挂起(approve / reject / 超时,fake timers)、diff 计算、**密钥脱敏**(断言任何工具返回与 SSE 事件不含明文密钥)。
- **路由契约测试**:threads CRUD、SSE 序列(confirm_request 出现 → confirm 后流恢复)、越权 404;参照 `recorder-route.test.ts` 风格。
- **迁移回归**:老 requirement 线程读写不回归。
- **前端**:浏览器手动验证为主(符合项目现状),重点:确认卡交互、舞台切换、断线重连、旧页面无回归。

## 10. 非目标(首期明确不做)

- 触发计划执行/运行用例(重操作,单独打磨)
- 报告/统计查询工具(`query_stats` 预留 action 位)
- 结构化选项卡式追问
- 旧 requirement 级 AI 工作区下线与数据迁移
- 跨版本/跨项目的对话上下文
- 对话内文件上传等富媒体输入

## 11. 实施边界说明

- service 层抽取按最小必要原则:工具用得到的操作才抽,不顺手重构无关 routes。
- 现有 `ai_workspace_state` / `ai_scenarios` / `ai_cases` 草稿体系不动,仅属旧工作区。
- 版本空间摘要的拼接内容(环境清单规模、分组树深度)实施时设上限,防止 system prompt 膨胀。
