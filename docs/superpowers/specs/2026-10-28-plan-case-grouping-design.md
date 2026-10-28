# 执行计划用例分组与组级执行策略 设计文档

日期：2026-10-28
状态：已评审通过（用户逐节确认）

## 1. 背景与目标

现状是「一计划 = 一环境 + 一登录准备 + 扁平有序用例列表」：

- `execution_plans` 挂单一 `environment_id` + 登录准备五件套（`login_prepare_enabled`/`login_case_id`/`detection_url`/`login_success_selector`/`login_unauthorized_keywords`）+ `strategy`（`run_all`|`fail_fast`）+ `rca_enabled`
- `plan_cases` 是带 `order` 的扁平清单，`target_override` jsonb **存而未消费**
- `runPlan.ts` 只做一次环境解析、一次登录准备，storageState 全计划共享，用例串行

目标：计划内用例支持**分组**，每组独立配置执行策略——目标环境、登录准备、组内 fail_fast、设备/浏览器上下文。

### 已确认的需求决策

| 决策点 | 结论 |
|---|---|
| 执行语义 | 组间串行按组序，组内用例串行 |
| 组级策略范围 | 目标环境、登录准备、组内 fail_fast、设备/浏览器上下文（消费 target_override 形状） |
| 兼容策略 | 全分组化：每个用例恰属一组；存量计划迁移为一个「默认分组」 |
| 失败传导 | 计划级 `strategy` 管**组间**；组级 `fail_fast` 管**组内**；组内失败不中途打断当前组，组边界评估 |
| 用例重复 | 同一用例可出现在同计划多个分组（支持同用例跑多环境/多身份） |
| 数据模型 | 方案 A：独立 `plan_case_groups` 表 + `plan_cases.group_id` FK |

明确不做（YAGNI）：组间并行、组级重试、组级并发度、组间依赖声明。

## 2. 数据模型

### 2.1 新表 `plan_case_groups`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `plan_id` | FK → execution_plans | ON DELETE CASCADE |
| `name` | varchar NOT NULL | 组名 |
| `order` | int NOT NULL | 组序，索引 `(plan_id, order)` |
| `environment_id` | FK → test_environments, nullable | 组环境；null 则逐用例走自身默认链 |
| `login_prepare_enabled` | bool | 组级登录开关 |
| `login_case_id` | FK → test_cases, nullable | 登录用例；不填且组环境有凭据则自动登录（沿用现语义） |
| `detection_url` / `login_success_selector` / `login_unauthorized_keywords` | 与现计划级三件套同型 | |
| `fail_fast` | bool | 组内策略 |
| `target_config` | jsonb | `{deviceTargetId?, browserContext?}`，与现 `target_override` 同形状 |

### 2.2 `plan_cases` 改造

- 加 `group_id` FK → plan_case_groups，回填后置 **NOT NULL**
- `order` 语义变为**组内序**
- 已查证：现表无 `(plan_id, case_id)` 唯一约束（仅 `(planId, order)` 索引），多组重复在 DB 层天然允许；服务层加组用例逻辑不得以「已在计划内」为由拒绝重复

### 2.3 `execution_plans` 字段去留

- **保留**：`strategy`（语义改为管组间）、`rca_enabled`
- **删除**：`environment_id` + 登录准备五件套（先迁移回填、grep 确认零读者、再 push 删列）

### 2.4 run 快照

- `plan_run_cases` 加 `group_id` + `group_name`（冗余名，历史稳定）+ `group_order`；每组登录准备生成 `step_kind=login_prepare` 行挂对应组
- `plan_runs` 加 `groups` jsonb 快照（组配置全量存档，等价现计划级登录快照保真度）
- run 启动时快照定格组结构，执行中编辑不影响当次 run（沿既有快照语义）

## 3. 存量迁移（一次性脚本，随发版跑）

1. 每个**有用例**的计划：建一个「默认分组」（order=0），拷贝计划级环境 + 登录配置；`fail_fast = (strategy == 'fail_fast')` 映射
2. 全部 plan_cases 挂入该组，组内序沿用原全局序
3. 空计划不建组（编辑器显示「创建第一个分组」引导）
4. 校验通过后删除计划级旧列
5. 幂等可重跑；按计划粒度事务化，单计划失败不影响其他；列变更（push --force）在回填之后执行

## 4. 执行引擎（runPlan.ts 双层循环）

```
for group in groups (按组序):
  前置判断：
    - cancel_requested → 剩余全部标记取消，结束
    - plan.strategy == fail_fast 且上一组失败 → 剩余组标记跳过，结束
  组环境解析：group.environmentId 有值 → resolveEnv(组环境)；
    null → 不做组级解析，逐用例走默认链（case.defaultEnvId → version → 项目默认）
  组登录准备（签名可复用，见下）：
    - 登录用例模式：caller-owned 浏览器跑登录用例，导出 storageState
    - 自动登录模式：!loginCaseId && 组环境凭据 → autoFillLogin
    - 失败 → 组失败：本组业务用例全标记跳过，进组边界评估
  组内用例串行（组内 order）：
    - 注入组 storageState（mobile 用例豁免，沿用现状）
    - 组 target_config 统一生效
    - 用例失败 && group.fail_fast → 本组剩余标记跳过
  组边界：groupFailed = 任一用例失败 || 登录准备失败
```

**失败语义矩阵**：

| 层级 | 字段 | 管什么 |
|---|---|---|
| 计划级 | `execution_plans.strategy`（run_all/fail_fast，沿用现有字段） | 组间：fail_fast 时一个组跑完若有失败，取消后续所有组；run_all 各组独立照跑 |
| 组级 | `plan_case_groups.fail_fast` | 组内：首例失败后是否跳过本组剩余用例 |

组合规则：组内行为永远由组级 `fail_fast` 决定，计划级 fail_fast 不中途打断当前组，在**组边界**评估。登录准备失败视为组失败。

**登录态复用**：连续两组「环境 + 登录配置 + target_config」签名完全相同且上一组登录成功 → 复用 storageState、跳过登录准备、不生成登录行。签名不同才重新登录（全新上下文，组间隔离成立）。

**live view**：维持一个 run 一个 live 源（`registerLiveView('planrun:'+id)` 已贯穿 loginPrepare/runCase），组循环直接复用。

**RCA**：维持计划级开关。

## 5. API（apps/api/src/routes/plans.ts，计划作用域鉴权）

| 端点 | 说明 |
|---|---|
| `POST /plans/:id/groups` | 建组（name 必填） |
| `PATCH /plans/:id/groups/:groupId` | 改组：名称/环境/登录配置/fail_fast/target_config |
| `DELETE /plans/:id/groups/:groupId` | 组内有用例时 **409**（对齐删产品线 409 惯例），空组直接删 |
| `PUT /plans/:id/groups/order` | 组排序（整包替换） |
| `PUT /plans/:id/groups/:groupId/cases` | 整包替换该组用例（含组内序）；原 `PUT /:id/cases` 退役 |
| `POST /plans/:id/cases` | 加用例，必传 `groupId` |
| `PUT /:id/cases/order` | 保留，加 `groupId`（组内重排）；接受跨组移动语义 |

- `POST /plans` / `PATCH /:id` 去掉环境/登录字段；`strategy`/`rca_enabled` 保留
- 每端点校验 groupId 归属该计划，防越组
- 上线前 grep 全部旧端点调用方（前端 + 可能的 AI 助手工具）确保无漏改；`PUT /:id/cases` 退役是破坏性变更，须确认无外部消费者

## 6. 前端

**PlanDetail.tsx**：

- 用例列表改分组区块：组头（组名、环境选择器、登录配置入口、fail_fast 开关、target 配置、组菜单：重命名/排序/删除）+ 组内用例列表
- 用例可跨组移动（拖拽或「移动到组」菜单）；组排序沿用现有交互模式
- 计划设置瘦身：只剩 strategy + RCA
- 加用例弹窗加「目标分组」选择（默认当前/末组）；同用例已在它组给提示但允许加入
- 空计划显示「创建第一个分组」引导

**PlanRunDetail.tsx**：

- 进度按组分节（组名 + 组状态徽标 + 组环境），组内含登录准备行 + 业务用例行
- 跳过态可视化区分：plan fail_fast 取消的后续组整节「已跳过（计划策略）」；组 fail_fast 跳过的用例「已跳过（组策略）」

## 7. 错误处理

- **组环境被删**：视同 null 逐用例走默认链，run 记录组级「环境失效」警告；编辑器环境选择器对失效值显示占位 + 清除入口
- **登录用例被删**：编辑器检测悬空引用，显示「登录用例已删除」要求重选；run 遇悬空 `loginCaseId` 按登录准备失败处理
- **迁移失败**：按计划粒度事务化；回填失败则旧列保留、下次重跑
- **执行中编辑组结构**：run 启动快照已定格，不影响当次 run

## 8. 风险点

1. **runPlan.ts 重构是最大单点**——live view、storageState 注入、fail_fast、报告回填（onReportCreated）等横切关注绞在现有单循环里，靠集成测试矩阵保障
2. **计划级旧列删除是唯一不可逆动作**——三步闸门：迁移回填 → grep 零读者 → push 删列
3. **PlanDetail 改造量大**——实现拆两步：先引擎+API+迁移（旧 UI 兼容读单默认组），再 UI
4. **`PUT /:id/cases` 退役为破坏性 API 变更**——上线前 grep 确认仅自家前端消费

## 9. 测试策略

- **服务层单测**：组 CRUD、409 删除、跨组移动、同用例多组、groupId 归属校验
- **引擎集成测**：双组双环境（mock resolveEnv）、登录复用签名命中/不命中、失败矩阵（plan run_all/fail_fast × 组 fail_fast 开/关）、登录准备失败传导、mobile 豁免
- **迁移脚本测**：有用例计划建默认组、空计划不建、幂等重跑
- **dev E2E**：建双组计划实跑一轮，验证登录态隔离与报告分组展示
