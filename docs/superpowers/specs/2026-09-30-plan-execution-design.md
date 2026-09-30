# 执行计划优化 · 策略 + 登录准备 + 执行历史 设计文档

> 日期：2026-09-30
> 状态：已获用户批准
> 前置：项目 / 分组 / 执行计划 MVP（spec `2026-09-30-projects-groups-design.md`）

## 1. 目标

把执行计划从「仅按序执行一组用例」升级为「带策略、带登录准备、带计划级执行历史」的长期回归单元；并把单例报告与计划运行统一到一个「执行历史」入口。

## 2. 非目标（本期不做）

- 定时调度执行计划
- 并发执行（同 plan 多 browser 并行）
- MCP / API 触发（本期仅 UI 触发；trigger 字段预留）
- 跨项目用例 / 跨项目登录用例
- i18n / 多用户权限 / 移动端适配
- 浏览器上下文之外的录制（API-only 用例）

## 3. 总体架构

一次「一键执行」对应一个 `plan_run`，里面串行执行计划中的用例。每条业务用例独立 CDP context，登录准备通过 Playwright `storageState` 注入维持登录态。

```
UI → POST /plans/:id/run ──► 后端新建 plan_run（status=running）──► 异步执行
                              ├─ 登录准备（可选）
                              │   ├─ 探测（URL + CSS + 关键词）
                              │   ├─ 已登录 → 跳过（不计总数）
                              │   └─ 未登录 → 执行登录用例 → 导出 storageState
                              ├─ 按 order 串行执行业务用例
                              │   ├─ 每条新建 context，注入 storageState
                              │   ├─ 调用 runCase(caseId) 复用现有 reports
                              │   └─ 按 strategy（run_all / fail_fast）决定是否继续
                              └─ 收尾 → 写 plan_run.status、聚合统计

UI ←─── SSE /plan-runs/:id/events ─── 每一步 fan-out 进度
```

实时进度：SSE 在执行期间持续推送；后端用进程内 EventEmitter + 客户端简单订阅（不引入 Redis，单进程即可；MVP 无多 worker 部署）。

中止：UI 点「中止」→ `POST /plan-runs/:id/cancel` → 后端在内存中设标志位，下一条用例开始前检查并停止。

mock 回退：保留现有 mock 行为，登录准备在没有 chromium 时直接跳过（提示「未安装浏览器」），不阻断计划。

## 4. 数据模型

### 4.1 新增表

```sql
plan_runs (
  id uuid pk,
  plan_id uuid fk→execution_plans not null,
  project_id uuid fk→projects not null,
  status varchar(20) not null,            -- running | passed | failed | cancelled
  strategy varchar(20) not null,          -- run_all | fail_fast
  login_prepare_enabled boolean not null default false,
  login_case_id uuid fk→test_cases,       -- null 表示关闭
  detection_url text,
  login_success_selector text,
  login_unauthorized_keywords jsonb,      -- text[]
  started_at, finished_at, duration_ms,
  summary text,
  total_cases int not null,
  passed_cases int, failed_cases int, skipped_cases int,
  cancel_requested boolean not null default false
)

plan_run_cases (
  id uuid pk,
  plan_run_id uuid fk→plan_runs not null,
  case_id uuid fk→test_cases not null,
  report_id uuid fk→reports,              -- 单条 report 关联；登录准备的 report_id 也存这里
  order int not null,
  status varchar(20) not null,            -- pending | running | passed | failed | skipped
  step_kind varchar(20) not null,         -- business | login_prepare
  started_at, finished_at, duration_ms,
  error text
)
```

### 4.2 变更表

`execution_plans` 新增：

```sql
strategy varchar(20) not null default 'run_all',
login_prepare_enabled boolean not null default false,
login_case_id uuid fk→test_cases,
detection_url text,
login_success_selector text,
login_unauthorized_keywords jsonb         -- text[]，默认 ["请先登录", "登录", "未登录", "未授权"]
```

### 4.3 迁移

drizzle 迁移：加表 + 加列，默认值兼容存量数据。

## 5. 执行模型与登录准备

### 5.1 登录准备判定

执行顺序（同步、单线程、`runPlan` 驱动）：

1. 若 `login_prepare_enabled = false`：跳过登录准备，直接从第 1 条业务用例开始。
2. 否则：
     - 解析 `detection_url`：优先 `detection_url` → 计划内第 1 条业务用例的 `case.url` → `group.default_url` → `project.default_url`。
     - 用 chromium 打开该 URL（独立 context），等待 `networkidle`（5s 上限）。
     - 判定「已登录」（任一命中即视为已登录）：
       1. `login_success_selector` 非空 + `document.querySelector` 命中；
       2. URL 不含 `login`/`signin`/`auth`/`unauthorized` 等关键字且不含 `input[type=password]`；
       3. 页面文本不含 `login_unauthorized_keywords` 任一项。
     - 命中 → 跳过登录用例；记 `plan_run_cases` 一条 `status=skipped, step_kind=login_prepare`（不计 `total_cases`）；导出 storageState。
     - 未命中 → 执行登录用例：新建 context，执行登录用例步骤；结束后再次 `querySelector(login_success_selector)` 或检查关键词不出现；成功 → 导出 storageState；失败 → 写 `status=failed, step_kind=login_prepare` + error，整计划中止。
3. 按 `plan_cases.order` 串行执行业务用例：每条新建 context 并 `addInitScript` 或 `storageState` 注入。
4. 每条业务用例执行完后写 `plan_run_cases`（status / duration_ms / report_id / error）。
5. 收尾：更新 `plan_run.status`（passed / failed / cancelled），聚合 `passed_cases/failed_cases/skipped_cases`，写 summary。

登录用例本身是普通用例（用 `runCase`）。建议在末尾加登录后才出现的断言（用户名、退出入口等），自动判断会主动校验。

### 5.2 策略

- `run_all`（默认）：一条失败不中断后续。
- `fail_fast`：一条失败 → 后续用例 `status=skipped`，`plan_run.status=failed`。

取消：用户主动中止时立即设 `cancel_requested=true`，当前用例继续跑完，下一条开始前停止。

## 6. API 设计

所有路径挂 `/api`。

### 6.1 plans（变更）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/projects/:id/plans` | body: `{ name, environment?, strategy='run_all' \| 'fail_fast', loginPrepare? }` |
| GET | `/plans/:id` | 返回 plan + cases（含 case.url），含 strategy、login_prepare_* |
| PATCH | `/plans/:id` | body 可含 name / environment / strategy / loginPrepare 子对象 |
| PUT | `/plans/:id/cases` | 覆盖式设用例（保持现有） |
| PUT | `/plans/:id/cases/order` | 新增：`{ caseIds[] }`，按数组顺序写入 order |
| GET | `/plans/:id/login-cases?q=&groupId?` | 登录用例候选（按项目过滤，搜索 title 与 group.name） |

loginPrepare 子对象：

```ts
{
  enabled: boolean;
  caseId?: string;
  detectionUrl?: string;
  successSelector?: string;
  unauthorizedKeywords?: string[];
}
```

### 6.2 plan runs

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/plans/:id/run` | 新建 plan_run，立即返回 `{ runId }`，后台执行 |
| GET | `/plan-runs/:id` | 详情：含 plan_run_cases（含 step_kind、report_id、error、duration） |
| POST | `/plan-runs/:id/cancel` | 中止（幂等） |
| GET | `/plan-runs/:id/events` | SSE：`plan_run_case_start` / `plan_run_case_complete` / `plan_run_login` / `plan_run_complete` |

### 6.3 executions（统一历史）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/executions?projectId=&kind=case\|plan\|all&page=&pageSize=` | 合并单例报告 + plan_run 列表（按时间倒序） |

`kind=case`：原 `reports` 列表数据；
`kind=plan`：plan_runs 列表；
`kind=all`：合并后按 createdAt 排序。

### 6.4 错误

- 409：登录用例与计划不属于同一项目。
- 422：loginPrepare.enabled=true 但 caseId 为空且 detection_url 与第 1 条业务用例都没解析到。
- 404：plan / plan_run / case 不存在。
- 200 + cancel 已生效：再次 cancel 返回 `{ ok: true }` 不报错。

## 7. UI 设计

### 7.1 `Plans.tsx`

保留现有；卡片新增「最近一次状态 / 通过率 / 时间」摘要，点击进入 `PlanRunDetail`。

### 7.2 `PlanDetail.tsx`

- 顶部策略行：`执行策略` 下拉（全部执行 / 失败即停）；
- 「登录准备」开关 + 折叠区：
  - 登录用例下拉（搜索框 + 分组 chip）；
  - 「高级配置」折叠：检测页面、登录成功标识（CSS 选择器）、未授权关键字（多行文本，默认含「请先登录」「登录」等）；
- 用例顺序：drag handle + 行内「上移 / 下移」按钮；
- 「添加用例」弹层：左侧分组树 + 右侧用例表（多选 checkbox），底部「加入计划（已选 N）」按钮；
- 「一键执行」按钮：执行中变「中止」+ 进度条；执行完毕弹 toast，跳转 `PlanRunDetail`。

### 7.3 `PlanRunDetail.tsx` 新增

- 路由：`/p/:projectId/plans/:planId/runs/:runId`；
- 顶部：status pill + 总数 + 耗时 + summary；
- 时间线：登录准备块（仅当实际执行；显示 case title + status + error），业务用例块（order、title、status、duration、report_id 链接）；
- 业务用例点击进对应 `ReportDetail`。

### 7.4 `Reports.tsx` → 执行历史

- 路径保留；页面 title 改「执行历史」；
- 顶部 tab：所有 / 单用例 / 计划运行；
- tab=all：合并 `executions`（kind=all）；
- tab=case：`kind=case`；
- tab=plan：`kind=plan`；
- sidebar 文字同步改为「执行历史」。

### 7.5 API client

`apps/web/src/api/client.ts` 新增：

- `plans.loginCases(planId, q?)`；
- `plans.reorderCases(planId, caseIds)`；
- `plans.run(planId)` 返回 `runId`；
- `planRuns.get(id)`、`planRuns.cancel(id)`、`planRuns.eventsUrl(id)`；
- `executions.list({ projectId, kind })`。

## 8. 错误处理

- 登录用例失败 → plan_run.status=failed，业务用例全部 skipped（保留 summary）；
- CDP 不可用 → mock 回退；登录准备直接跳过 + 一条 plan_run_cases（step_kind=login_prepare, status=skipped, error=chromium 未安装），不阻断计划；
- SSE 中断：客户端仅影响 UI 实时性，后端继续执行；UI 可手动刷新页面读最新状态；
- 取消：当前用例跑完后 plan_run.status=cancelled。

## 9. 测试

后端（testcontainers 集成测试）：

- 创建/更新执行计划：strategy + loginPrepare 字段持久化；
- PUT `/plans/:id/cases/order` 顺序回写；
- POST `/plans/:id/run` mock 路径下 SSE 事件序列完整；
- 跨项目登录用例 → 422；
- fail_fast：mock 用例第 2 条失败 → 后续 status=skipped、plan_run.status=failed；
- cancel：mock 用例执行中调用 cancel → 计划 cancelled。

前端 vitest：

- 策略下拉切换立即 PATCH；
- 登录用例下拉搜索；
- 执行详情按 step_kind 区分登录/业务块。

e2e（可选，dev server + mock 路径）：点击一键执行 → 看到 SSE 进度条 → 进入 PlanRunDetail 验证时间线。

## 10. 验收标准

1. 计划详情策略可切换，登录准备开关可启用。
2. 启用登录准备后能选同项目登录用例；高级配置可填并保存。
3. 一键执行 → SSE 进度 → PlanRunDetail 时间线（含登录块）。
4. fail_fast：第 N 条失败，N+1..K 状态 skipped。
5. 「执行历史」tab 切换内容正确。
6. `pnpm verify` 全绿。