# 项目 · 分组 · 执行计划 设计文档

> 日期：2026-09-30
> 状态：已获用户批准
> 前置：iTest MVP（需求→用例→步骤→执行 全链路已通）

## 1. 目标

引入「项目 → 分组 → 用例」三级资产组织方式，让测试资产按业务/环境隔离，并支持执行计划（环境 + 回归目的）做有组织的一键回归。

## 2. 非目标（本期不做）

- 密码框录制加密（敏感信息落库加密另起 spec）
- 定时调度执行计划
- 跨项目复制用例
- i18n / 多用户权限 / 移动端适配

## 3. 总体导航：项目即工作空间

```
/                     ProjectsHome      项目选择与创建（卡片网格）
/p/:projectId         项目内布局（进入后所有页面共享项目上下文）
  ├─ /overview        Dashboard        统计（用例数、通过率，按分组聚合）
  ├─ /groups          用例列表         左侧分组树 + 右侧用例表
  ├─ /groups/:gid     分组用例（同上，预选该分组）
  ├─ /cases/:id       用例详情         现有页面，加面包屑返回当前项目
  ├─ /requirements    需求列表         保留，AI 生成用例时选目标分组
  ├─ /plans           执行计划         计划列表 + 详情
  └─ /reports         报告             现有页面
```

规则：

- 顶部栏显示当前项目名 + 「退出项目」按钮（回 `/`）。
- 未进入项目时访问 `/p/...` 重定向到 `/`。
- 当前项目（id + 名称 + 默认域名）存 Zustand，刷新不丢。
- **需求保留**：仍是 AI 生成用例的来源；生成用例时可选择目标分组。

## 4. 数据模型

新表：

```sql
projects        id uuid pk, name varchar(200) not null,
                default_url text, created_at, updated_at
groups          id uuid pk, project_id uuid fk→projects not null,
                name varchar(200) not null, default_url text,
                created_at, updated_at
execution_plans id uuid pk, project_id uuid fk→projects not null,
                name varchar(200) not null, environment varchar(100),
                created_at, updated_at
plan_cases      id uuid pk, plan_id uuid fk→execution_plans not null,
                case_id uuid fk→test_cases not null, "order" int not null
```

`test_cases` 变更：

- 新增 `group_id uuid fk→groups not null`
- `requirement_id` 保留（来源追溯），不再承担组织职责

默认域名解析链（新建用例表单、录制目标 URL 预填用）：

```
用例.url ?? 分组.default_url ?? 项目.default_url ?? 空
```

### 4.1 存量迁移

迁移脚本（drizzle migration + 一次性数据迁移，随 `db:migrate` 执行）：

1. 建表（projects / groups / execution_plans / plan_cases，test_cases 加 group_id 列，先允许 NULL）。
2. 插入默认项目「默认项目」（default_url 为空）与默认分组「默认分组」。
3. `UPDATE test_cases SET group_id = <默认分组> WHERE group_id IS NULL`。
4. group_id 改 NOT NULL。

## 5. 页面设计

### 5.1 ProjectsHome（`/`）

- 卡片网格：项目名称、用例数、默认域名。
- 每张卡片操作：进入 / 编辑 / 删除。
  - 编辑：弹窗改名称、默认域名。
  - 删除：二次确认；**项目内存在用例或计划时禁止删除**（返回 409，前端提示先清空）。
- 末尾「新建项目」卡片：弹窗填名称 + 默认域名（可空）。

### 5.2 项目内布局（`/p/:projectId`）

- 顶部栏：项目名 + 面包屑上下文 + 「退出项目」。
- 左侧导航：工作台 / 用例 / 需求 / 执行计划 / 报告。
- 所有查询按 projectId 过滤。

### 5.3 用例列表（`/p/:projectId/groups`）

- 左侧分组树：项目名 → 分组列表；分组节点支持 新建 / 改名 / 删除（删除要求分组内无用例，否则 409）/ 设默认域名。迁移保证每个用例都归属分组，不设「未分组」节点。
- 右侧用例表：标题、优先级、状态、所属需求、更新时间。
- 勾选多条 → 批量操作条：批量复制（选目标分组）、加入计划（选计划）。
- 行内操作：复制（弹层选目标分组）、删除、进入详情。

### 5.4 复制用例

- 单条：`POST /api/cases/:id/copy { targetGroupId }`
- 批量：`POST /api/cases/copy { caseIds[], targetGroupId }`
- 副本命名：`<原名> 副本`；目标分组已存在同名时依次追加数字（`副本1`、`副本2`…）。命名在服务端正则解析 + 循环确认，避免并发重名。
- 复制内容：用例行本身 + 全部步骤（order、source、action、assertion 原样），requirement_id 不复制（副本视为独立资产）。

### 5.5 用例详情（`/p/:projectId/cases/:id`）

- 面包屑：项目 / 分组 / 用例标题。
- 新增「所属分组」选择器，可移动到其他分组（同项目内）。
- 其余保持现状（步骤编辑、AI 补充、录制、执行）。

### 5.6 需求列表（`/p/:projectId/requirements`）

- 保留现有功能。
- 「用 AI 生成用例」时增加目标分组选择器（必选，默认选第一个分组）。

### 5.7 执行计划（`/p/:projectId/plans`）

- 计划列表：名称、环境、用例数、最近运行时间。
- 新建：名称 + 环境（如「预发冒烟」）。
- 计划详情：用例有序列表（可移除、上下移）；「加入用例」入口跳转用例列表并预选该计划。
- 「运行全部」：串行逐个执行计划内用例（复用现有 execute 流程），实时显示进度（成功 n / 失败 n / 共 m）；完成后跳转报告列表。
- 运行期间禁止再次点击（前端置灰）。

## 6. API 设计

全部挂在 `/api` 下，除注明外均返回 JSON。

### 6.1 projects

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects` | 列表（含用例数聚合） |
| POST | `/projects` | 创建 `{ name, defaultUrl? }` |
| PATCH | `/projects/:id` | 改名 / 改默认域名 |
| DELETE | `/projects/:id` | 删除（有用例/计划时 409） |

### 6.2 groups

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects/:id/groups` | 项目下分组（含用例数） |
| POST | `/projects/:id/groups` | 创建 `{ name, defaultUrl? }` |
| PATCH | `/groups/:id` | 改名 / 默认域名 |
| DELETE | `/groups/:id` | 删除（有用例时 409） |

### 6.3 plans

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects/:id/plans` | 项目下计划列表 |
| POST | `/projects/:id/plans` | 创建 `{ name, environment? }` |
| GET | `/plans/:id` | 计划详情（含用例，按 order） |
| PATCH | `/plans/:id` | 改名 / 环境 |
| DELETE | `/plans/:id` | 删除 |
| PUT | `/plans/:id/cases` | 覆盖式设置用例 `{ caseIds[] }`（校验用例属于同项目） |
| POST | `/plans/:id/run` | 一键运行，串行执行，返回 `{ results: [{ caseId, reportId, status }] }` |

### 6.4 cases 变更

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/cases/:id/copy` | 单条复制 `{ targetGroupId }` → 返回新用例 |
| POST | `/cases/copy` | 批量复制 `{ caseIds[], targetGroupId }` → `{ count }` |
| PATCH | `/cases/:id` | 新增 `groupId` 字段（同项目内移动） |
| GET | `/cases` | 新增 `groupId` / `projectId` 过滤参数 |

## 7. 错误处理

- 409：`project/group 非空禁止删除`、plan 设置用例时存在跨项目用例。
- 404：目标项目/分组/计划不存在。
- 400：副本命名无法解析、请求体校验失败（沿用 zod + HttpError 中间件）。
- 计划运行中某条用例执行失败：不中断，继续执行后续用例，最终结果里逐条标注（与单用例执行的「失败即停」语义不同——计划层是批量，单条内部仍失败即停）。

## 8. 测试

- 每个新 route 一组 testcontainers 集成测试（projects/groups/plans/copy）。
- 迁移测试：空库跑 migrate → 断言默认项目/分组存在；造存量用例（构造迁移前状态）→ 跑数据迁移 → 断言归入默认分组。
- 副本命名递增：同分组复制 3 次，断言名称依次为 `X 副本`、`X 副本1`、`X 副本2`。
- 删除保护：项目/分组内有资产时返回 409。
- 计划运行：mock 执行路径下断言串行调用与结果聚合。

## 9. 验收标准

1. `pnpm dev` 后：首页出现项目选择页，可创建/进入/编辑/删除项目。
2. 进入项目后所有页面只显示当前项目数据；退出回到首页。
3. 迁移后存量用例归入「默认项目 / 默认分组」，可正常编辑执行。
4. 复制用例（单条 + 批量）名称递增正确，步骤完整。
5. 执行计划可建、可加用例、可一键运行并看到逐条结果。
6. `pnpm verify` 全绿。
