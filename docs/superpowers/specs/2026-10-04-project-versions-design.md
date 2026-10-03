# 项目 → 版本 → 测试环境/用例 全量重构（设计）

日期：2026-10-04
状态：待用户审阅
上游参考：
- `docs/superpowers/specs/2026-10-03-ai-repo-context-design.md`（AI 工作台仓库上下文）
- `apps/api/src/db/schema.ts`（现 projects/groups/testCases/testEnvironments/executionPlans/planCases）
- `apps/api/src/routes/{projects,environments,cases,plans}.ts`
- `apps/web/src/pages/{ProjectsHome,GroupsPage,Environments,PlanDetail,AiWorkspacePage}.tsx`
- `apps/web/src/components/layout/Sidebar.tsx`

## 背景与目标

iTest 当前的实体关系是「项目 → 分组 → 用例 + 项目 → 环境 + 项目 → 执行计划 → 用例」。一个项目只承载一份用例清单 + 一套环境。这套结构无法回答三个真实业务问题：

1. **同一项目多个版本并行** —— 产品线一次规划多个 release（v1.0/v1.1/v2.0），每个版本的用例、回归基线、被测环境都不一样；现在只能在描述里写「V1.0 的登录」，无法按版本筛选报告。
2. **跨版本引用** —— V1.1 的回归计划应当能复用 V1.0 的稳定用例作为基线（不重复维护），而现在只能整项目克隆。
3. **选择项目 = 选择工作面** —— 进项目后看到的「用例 / 环境 / AI 工作台 / 执行计划」应该都是当前版本下的视图，且版本切换是显式动作。

本期目标：**让版本（version）成为一级实体，挂在项目下；测试环境、用例、AI 工作台、跨版本计划全部按版本工作；导航从「项目 → 模块」变成「项目 → 版本 → 模块」**。

### 与用户的核心确认（已在 brainstorming 阶段确认）

| 议题 | 决策 |
|---|---|
| 版本 ↔ 用例关系 | **每个版本独享用例**。制定执行计划时，计划的用例可跨版本引用（如 V1.1 计划选 V1.0 基线用例） |
| 测试环境归属 | **属版本**（V1.0 与 V1.1 环境独立；计划选环境也只能选当前版本下的环境） |
| AI 工作台与版本 | **进项目时同时选版本**；后续 AI 生成、用例保存、上下文选择器都针对该版本 |
| 迁移策略 | **后向兼容**：现存每个项目自动创建一个 `v0` 默认版本（`is_default=true`），现存所有用例 / 环境全部归到 `v0` |
| 默认版本位置 | **项目级默认版本**（`project_versions.is_default`，进项目时自动选中） |

### 本期范围（YAGNI）

**做**：

- `project_versions` 表：每项目 1..N 个版本；必有 1 个 `is_default=true` 的版本；`name` 项目内唯一
- 测试环境 (`test_environments`) 加 `version_id` 非空 FK → `project_versions.id`，把现有数据全部填到项目 `v0`
- 用例 (`test_cases`) 加 `version_id` 非空 FK；同样回填到 `v0`；保持 `group_id` 不变
- 执行计划 (`execution_plans`) 加 `version_id` FK 可空 → 表示「计划创建时所属的版本」（决定计划列表默认所属版本 + 计划环境只能从该版本选）
- `plan_cases` 不加 version_id（跨版本引用语义保留，`case_id` 仍指向具体 case 的 uuid，case 自带 version_id 可追溯）
- `requirements` **不加** version_id：AI 工作台需求是项目级概念（同一段需求文本可被多个版本复用）
- 「选择项目 + 版本」导航流：选项目卡片 → 进版本选择/直接进默认版本 → 二级路由 (`/p/:pid/v/:vid/...`)；侧边栏加「版本切换」chip
- 版本管理 UI：项目设置/项目首页加「版本管理」入口；列表 + 新建 + 设默认 + 删除（删除最后版本被拒）
- 所有 `cases` / `environments` / `plans` 接口加 `version_id` 过滤或强校验

**明确不做**：

- 用例 fork / diff / 三方合并
- 版本分支图、tag/branch 概念
- 自动按 git tag 创建版本
- 跨组织共享版本
- 把 requirements 划归版本（保留项目级）

## 架构

```
浏览器 apps/web
└── /
    └── ProjectsHome（项目卡片；点击进项目）
        └── /p/:projectId
            ├── ProjectGuard（要求选中项目 + 版本；否则跳到版本选择页）
            ├── ProjectShell（在 AppShell 之上挂一层"版本选择面包屑 + 切换器"）
            │   ├── /v/:versionId/overview   Dashboard（项目统计限定当前版本）
            │   ├── /v/:versionId/groups     GroupsPage（用例列表限定当前版本）
            │   ├── /v/:versionId/environments  Environments（环境列表限定当前版本）
            │   ├── /v/:versionId/plans      Plans + PlanDetail（计划列表 + 详情）
            │   ├── /v/:versionId/ai/:id     AI 工作台（限定当前版本；保存事务写到该版本）
            │   └── /v/:versionId/reports    报告（按版本过滤；跨版本时显示来源版本徽标）
            └── /versions                    版本管理（建/删/设默认）

持久层 apps/api
└── 新表
    └── project_versions  (id, project_id, name, is_default, description, created_at, updated_at)
└── 改动
    ├── test_environments  + version_id
    ├── test_cases         + version_id
    ├── execution_plans    + version_id
    └── (不改动) requirements, groups, plan_cases
```

数据流：
1. 用户在 ProjectsHome 点项目卡 → `enter({id, name, defaultUrl})` + `useProjectStore.currentVersion` 默认 null
2. ProjectGuard 检查：有 `default_version_id` → 用 query 加载 `currentVersion`，写 store → 进版本化路由
3. 侧边栏 chip 显示 `v1.0 ▾`，点击下拉切版本 → store + URL 双写 → 触发 query 失效
4. 跨版本用例引用：`plan_cases.case_id` 不变，前端做 `case.version_id !== plan.version_id` 标记 + 列表筛选

## 服务端设计

### schema 改动

**新表 `project_versions`**：

```ts
export const projectVersions = pgTable('project_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 80 }).notNull(),       // 自由文本，UI 不强制语义（v1.0 / 2026Q1 / baseline…）
  description: text('description'),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectNameUq: unique('project_versions_project_name_uq').on(t.projectId, t.name),
  projectIdIdx: index('project_versions_project_idx').on(t.projectId),
}));
```

`test_environments`：加 `versionId uuid('version_id') not null references project_versions.id on delete restrict`（restrict：版本非空才能删环境）

`test_cases`：加 `versionId uuid('version_id') not null references project_versions.id on delete restrict`

`execution_plans`：加 `versionId uuid('version_id') references project_versions.id on delete set null`（可空：允许跨版本计划——计划的环境/用例跨版本引用时，计划归属 null；但本期默认行为 = 创建时落当前版本）

迁移策略（迁移 SQL `0020_project_versions.sql`）：

```sql
CREATE TABLE project_versions (...);
ALTER TABLE test_environments ADD COLUMN version_id uuid REFERENCES project_versions(id) ON DELETE RESTRICT;
ALTER TABLE test_cases        ADD COLUMN version_id uuid REFERENCES project_versions(id) ON DELETE RESTRICT;
ALTER TABLE execution_plans   ADD COLUMN version_id uuid REFERENCES project_versions(id) ON DELETE SET NULL;
ALTER TABLE test_environments ALTER COLUMN version_id SET NOT NULL;
ALTER TABLE test_cases        ALTER COLUMN version_id SET NOT NULL;

-- 回填：每个现存项目建一个 'v0' 默认版本；把现存所有环境/用例/计划归到 v0
INSERT INTO project_versions (project_id, name, is_default)
SELECT id, 'v0', true FROM projects;

UPDATE test_environments e
SET version_id = v.id
FROM project_versions v
WHERE v.project_id = e.project_id AND v.is_default = true;

UPDATE test_cases c
SET version_id = v.id
FROM groups g, project_versions v
WHERE g.id = c.group_id AND v.project_id = g.project_id AND v.is_default = true;

UPDATE execution_plans p
SET version_id = v.id
FROM project_versions v
WHERE v.project_id = p.project_id AND v.is_default = true;

-- 加 unique / index
CREATE UNIQUE INDEX project_versions_project_name_uq ON project_versions(project_id, name);
CREATE INDEX project_versions_project_idx           ON project_versions(project_id);
CREATE INDEX test_environments_version_idx          ON test_environments(version_id);
CREATE INDEX test_cases_version_idx                 ON test_cases(version_id);
CREATE INDEX execution_plans_version_idx            ON execution_plans(version_id);
```

**不变**：
- `groups` 仍是项目级（不分版本，分组是组织用例的方式；同一分组逻辑可以在不同版本下承载不同用例）
- `requirements` 仍是项目级（AI 需求文本）
- `plan_cases` 不加 version_id（保留跨版本引用语义）

### 路由改动

新增 `apps/api/src/routes/projectVersions.ts`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects/:projectId/versions` | 列出项目所有版本（含默认标记） |
| POST | `/api/projects/:projectId/versions` | 新建版本（`{name, description?}`）；必填非空 |
| PATCH | `/api/project-versions/:id` | 改名 / 改描述（默认版本不能改名成已存在名） |
| POST | `/api/project-versions/:id/set-default` | 设为项目默认（事务：旧的取消） |
| DELETE | `/api/project-versions/:id` | 删除版本（若非空：环境/用例/计划仍引用 → 400；若是默认版本且还有别的版本：先迁移默认；若是项目最后版本：拒绝） |

`environments.ts`：
- `GET /projects/:projectId/environments` → 接受 `?versionId=`；未传 → 用项目默认版本
- `POST /projects/:projectId/environments` body 加 `versionId`，未传 → 默认版本；强校验 = 必须同项目
- `PATCH/DELETE /environments/:id` 不变（环境自带 version_id，按 version_id 校验可见性）

`cases.ts`：
- `GET /cases` 加 `?versionId=`；未传 → 默认版本
- `POST /cases` body 加 `versionId`；未传 → 默认版本；强校验 groupId 所属项目与 versionId 所属项目一致
- `GET/PATCH /cases/:id` 不变（case 自带 version_id）
- 跨版本用例复制：`POST /cases/:id/copy` body 加 `targetVersionId`（必须同 project；不传 → 同版本复制）
- 报告 / 报告详情：reports 表自身无 version_id，但**每条 report.caseId → case → version**；reports 列表增加 `versionId` 字段透传（计算字段，不存）

`plans.ts`：
- `GET /plans`（项目维度）按 `versionId` 过滤；项目下若不指定 → 列**项目全部**版本计划
- `POST /plans` body 加 `versionId`；`environmentId` 必须同 `versionId`（拒绝跨版本环境引用）；未传 → 默认版本
- `GET /plans/:id` 不变；`setCases` 不变（case.id 是 uuid，跨版本引用语义保留）

`ai-workspace`：
- 不加 version 维度（ai 是 requirement 维度，requirement 是项目级）；但 **保存事务** `POST /api/requirements/:id/ai-workspace/save` 接受 `targetVersionId`，未传 → 默认版本；**ai_cases → cases 写入时强制 version_id = targetVersionId**

### 服务层改动

`apps/api/src/services/projectAccess.ts`：
- `assertProjectVisible` 不变
- 新增 `assertVersionVisible(versionId, user)`：先取 version → project → org 链路做 404 检查
- 新增 `resolveVersionProjectId(versionId)`：`project_versions.id → project_id`

`assertEnvironmentVisible` / `assertCaseVisible` 已经有「解析 projectId」能力；新增 `assertVersionMatchForCase(caseId, versionId)` / `assertVersionMatchForEnv(envId, versionId)`：用于 PATCH、复制、跨版本保护。

## 前端设计

### 导航

`apps/web/src/App.tsx`：
- 全部 `/p/:projectId/...` 改成 `/p/:projectId/v/:versionId/...`
- 新增 `/p/:projectId/versions`（版本管理页）
- 新增 `/p/:projectId/versions/select`（选版本中间页；URL 不带 versionId 时进入）

`apps/web/src/components/layout/Sidebar.tsx`：
- 现有 4 个二级导航条目保持不变
- 顶部加版本 chip：`当前 v1.0 ▾`（点开下拉：项目所有版本 + 「管理版本…」）
- 选中版本高亮；默认版本带「默认」徽标

`apps/web/src/components/layout/ProjectGuard.tsx`：
- 检测 `useParams` 是否含 versionId；不含 → 跳到 `/p/:projectId/versions/select`
- versionId 不属于该 project → 404

### Store

`apps/web/src/stores/project.ts`：
- `current: { id, name, defaultUrl, versionId, versionName }`
- `enter(project, version)`：写 store + localStorage
- `switchVersion(versionId, versionName)`：写 store（保留 project），URL 同步跳转
- `exit()`：清空

### 版本选择中间页（`/p/:pid/versions/select`）

- 显示项目所有版本卡片（默认版本高亮）
- 点击进入对应版本化路由
- 顶部「管理版本」按钮跳到 `/p/:pid/versions`

### 版本管理页（`/p/:pid/versions`）

- 列表：版本名 + 描述 + 默认徽标 + 用例/环境/计划计数 + 操作（设默认 / 编辑 / 删除）
- 「+ 新建版本」按钮 → 弹窗（输入 name + description）
- 删除默认版本 → 弹「需要先把 X 设为默认」

### 各业务页改动

- `GroupsPage`：`useParams` 加 `versionId`；`api.cases.list` / 创建 / 复制 / `api.tags.list` / `api.scenarios.listForProject` 全部带 `versionId`；URL 跟随版本
- `ProjectEnvironments`：拿 `versionId`；`api.environments.list/create/patch/remove` 带 `versionId`；标题副标题展示版本名
- `Plans` / `PlanDetail`：列表按当前版本过滤；详情环境选择只能选当前版本下的环境；用例候选池 = 项目全版本用例 + 「来源版本」徽标
- `AiWorkspacePage`：`useParams.versionId` → 注入到 `onSave` payload；`doc.contextMode` 与版本无关但 AI 输出强制指向 versionId
- `Dashboard` / `Overview`：统计按当前版本
- `Reports`：列表增加版本徽标（来自 case.version.name）

### API client（`apps/web/src/api/client.ts`）

- 新增 `api.versions.{list, create, patch, setDefault, remove}` 接口
- `api.environments.list/create/patch/remove`：`{ projectId, versionId?, ... }` / `{ versionId?, ... }`
- `api.cases.list/create/copy` 全部接受 `versionId`
- `api.plans.{list, create}` 接受 `versionId`
- `api.aiWorkspace.save(targetVersionId?)`：`POST /requirements/:id/ai-workspace/save` body

### 类型

`apps/web/src/api/client.ts` 新增/扩展：

```ts
export interface ProjectVersion {
  id: string; name: string; description: string | null;
  isDefault: boolean; createdAt: string; updatedAt: string;
  // 计数（可选，列表接口带；详情/单取不返回）：
  caseCount?: number; environmentCount?: number; planCount?: number;
}
export interface Environment extends ProjectVersion & { ... }   // 不必，Environment 不动
export interface TestCase extends ... { versionId: string; versionName?: string; }   // 透传字段
```

## 错误处理

| 场景 | 行为 |
|---|---|
| 项目无版本（理论不可能：迁移总会创建 v0；前端兜底） | 后端 500；前端跳 `/p/:pid/versions/select` |
| URL versionId 不属于该项目 | ProjectGuard → 跳 `/p/:pid/versions/select` |
| 删除非空版本（仍有 env/case/plan） | 后端 400 `version_not_empty` + 计数；前端展示「先迁移或删除引用」 |
| 删除最后一个版本 | 400 `last_version` |
| 删除当前默认版本但项目还有别的版本 | 自动迁移默认到最早创建的版本；前端弹「已将 X 设为默认」 |
| 跨版本用例复制 | 允许（用户确认弹窗：标题/分组/环境都不变）；case 写入时强制 targetVersionId |
| 跨版本环境引用 | 拒绝（environment_id 与 version_id 不一致 → 400） |
| AI 保存到不同版本 | body `targetVersionId` 允许与 `requirement` 默认版本不一致；前端默认填当前版本 |
| 报告按版本筛选 | 后端透传 `versionId` 字段，前端按需过滤；不存 |

## 测试

- **API**
  - `services/projectAccess` 单元：`assertVersionVisible` / `resolveVersionProjectId`
  - `routes/projectVersions.test.ts`：
    - 新建/改/设默认/删；非空拒绝；跨项目 404；默认版本删除迁移
  - `routes/environments.test.ts`：
    - `?versionId=` 过滤；跨版本 `environmentId` 拒绝
  - `routes/cases.test.ts`：
    - `?versionId=` 过滤；group/version 不同项目拒绝；copy 跨版本允许
  - `routes/plans.test.ts`：
    - 创建 plan 强制 environmentId 同 versionId；跨版本用例引用允许
  - `routes/ai-workspace-save.test.ts`：
    - `targetVersionId` 落库到正确 case.versionId
  - **回归**：所有现 tests 走测；迁移 SQL 单独跑一次（drizzle-kit push 验证 schema + 手写 SQL 模拟数据回填）
- **Web**
  - `VersionsSelector.test.tsx`：切换 → store + URL 更新
  - `ProjectVersions.test.tsx`（管理页）：新建 / 设默认 / 删除 / 计数
  - `GroupsPage` 端到端：版本切换 → 列表更新
  - 手动金路径：建项目 → 自动 v0 → 切到 v0.1（新建）→ 进用例页空 → 切回 v0 看到原用例 → AI 工作台生成保存到 v0.1 → PlanDetail 跨版本引用 v0 用例

## 后续（YAGNI 已划掉）

- 用例 fork / 三方合并
- 版本分支图 / tag 概念
- 自动按 git tag 创建版本
- 跨组织共享版本
- 「基线快照」不可变版本（类似 schema freeze）
- 把 requirements 划归版本
