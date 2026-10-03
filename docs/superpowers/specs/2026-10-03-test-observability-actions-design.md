# 测试可观测动作：DB 查询 + syslog 观察 — 设计文档

> Status: Draft · 2026-10-03
> 目标: 在用例步骤中除操作 web 元素外，引入两类"测试动作"：数据库查询（queryDb）与日志观察（observeLog），结果写入报告便于排障。
> 范围: 后端 DSL + 执行器 + 数据库 / syslog 客户端 + env 模型 + 前端编辑器与报告页。

## 1. 背景与目标

iTest 当前用例步骤只覆盖 web UI 操作（click/fill/assertText 等）。真实测试过程里，UI 操作只是表象，业务是否真的走通经常要看数据库落库是否正确、应用后端日志是否出现对应行为；当前只能截图 + step error，定位成本大。

引入两类新 DSL 步骤：

1. **`queryDb`** — 用例步骤里写"查某张白名单表、断言结果"，跟 click 同列。
2. **`observeLog`** — 用例步骤里写"按时间窗 + 关键字读远端 syslog，断言命中"。

两类动作同时承担**采集**与**可选断言**两种角色：开 assertion → 不匹配即步骤失败；不开 → 仅采集记录入报告。

为了让多项目 + 多测试环境共用，将 DB 连接 + syslog SSH 凭据抽象为 `test_environments`（项目下多个 env），用例与 plan 各自引用：

- `test_cases.defaultEnvId`：单用例跑时的默认环境。
- `execution_plans.environmentId`：plan 跑时的目标环境。
- 解析优先级：`plan.environmentId > case.defaultEnvId`，缺省 → 步骤失败 `EnvMissing`（详见 §8）。

不做：iframe、多 DB schema、DB 写动作、SSO 接入 vault。

## 2. 架构总览

**新增/修改模块**：

| 文件 | 角色 |
| --- | --- |
| `apps/api/drizzle/0010_test_environments.sql`（新） | 项目级环境表 + 凭据密文列；cases/plans 加 FK |
| `apps/api/src/db/schema.ts`（改） | `test_environments`；`test_cases.defaultEnvId`；`execution_plans.environmentId` |
| `packages/shared/src/step-dsl.ts`（改） | `QueryDbAction` / `ObserveLogAction` 两个新 kind |
| `packages/shared/src/environments.ts`（新） | 共享 env DTO + DSL 子 schema |
| `apps/api/src/execute/envContext.ts`（新） | 解析优先级 + 凭据解密，注入执行上下文 |
| `apps/api/src/execute/dbQuery.ts`（新） | 白名单表 + 参数化 SELECT 执行器 |
| `apps/api/src/execute/syslogReader.ts`（新） | ssh2 客户端 + `awk` 时间窗过滤 |
| `apps/api/src/execute/cdp.ts`（改） | `dispatch` 加 queryDb / observeLog 分支；接收 opts.env |
| `apps/api/src/execute/runCase.ts`（改） | 解析 env（plan > case），传入 executeCaseReal |
| `apps/api/src/execute/runPlan.ts`（改） | 把 execution_plans.environmentId 透传给 runCase |
| `apps/api/src/execute/failureClassifier.ts`（改） | 新增 10 个 FailureReason |
| `apps/api/src/routes/environments.ts`（新） | CRUD |
| `apps/api/src/routes/cases.ts`（改） | PATCH 接受 defaultEnvId |
| `apps/api/src/routes/plans.ts`（改） | PATCH 接受 environmentId |
| `apps/web/src/pages/ProjectSettings.tsx`（改） | 环境 Tab |
| `apps/web/src/pages/CaseDetail.tsx`（改） | 默认环境下拉 |
| `apps/web/src/pages/PlanDetail.tsx`（改） | 目标环境下拉 + planRun 头部徽标 |
| `apps/web/src/components/StepEditDrawer.tsx`（改） | queryDb / observeLog 子表单 |
| `apps/web/src/pages/ReportDetail.tsx`（改） | 明细模式 DB / 日志列 |

**核心流程**（planRun 一条 case；env 缺失或断言失败均落 stepResult.failed，不抛 500）：

```
runPlanAsync(planId)
  ├─ plan.environmentId 解析为 envRow → decrypt → envCtx（一次创建）
  └─ runCase(caseId, { envOverride: envCtx })
        ├─ caseRow.defaultEnvId 兜底
        ├─ executeCaseReal(steps, ctx{...envCtx})
        │    └─ for each step:
        │         ├─ dispatch(action)
        │         │ ├─ queryDb → runQueryDb → DbQueryRowResult
        │         │ └─ observeLog → runObserveLog → ObserveLogLineResult
        │         ├─ assertion? → 校验 rows/lines → stepResult.status
        │         └─ stepResult.db / stepResult.log 入 reports.step_results
        └─ runCase finally → envCtx.close()（pg pool end、ssh end）
```

## 3. 数据模型变更

新增迁移 `0010_test_environments.sql`：

```sql
CREATE TABLE "test_environments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "name" varchar(120) NOT NULL,
  "db_host" varchar(200),
  "db_port" integer,
  "db_name" varchar(120),
  "db_user" varchar(120),
  -- AES-256-GCM 密文三件套（base64）
  "db_password_ciphertext" text,
  "db_password_iv" text,
  "db_password_tag" text,
  "syslog_host" varchar(200),
  "syslog_user" varchar(120),
  "syslog_ssh_port" integer DEFAULT 22,
  "syslog_key_ciphertext" text,
  "syslog_key_iv" text,
  "syslog_key_tag" text,
  "syslog_file_path" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  UNIQUE ("project_id","name")
);

ALTER TABLE "test_cases" ADD COLUMN "default_env_id" uuid REFERENCES "test_environments"("id") ON DELETE SET NULL;
ALTER TABLE "execution_plans" ADD COLUMN "environment_id" uuid REFERENCES "test_environments"("id") ON DELETE SET NULL;
```

迁移策略：

- 默认值：两个 FK 列都为 NULL；老用例 / 老 plan 跑时若含 queryDb / observeLog 步骤 → 步骤失败 `EnvMissing`（详见 §8）。
- `name` 在同 project 内唯一，便于前端 Select 选。

`apps/api/src/db/schema.ts` 加 `testEnvironments`；`testCases.defaultEnvId` 与 `executionPlans.environmentId` 加 FK。

**白名单表**（写死在 `apps/api/src/execute/dbQuery.ts` 常量里，不入 DB）：

```ts
export const ALLOWED_DB_TABLES = new Set([
  'projects', 'groups', 'users', 'test_cases', 'test_steps',
  'reports', 'execution_plans', 'plan_runs', 'plan_run_cases', 'test_attachments',
]);
```

白名单列同步在常量 `ALLOWED_QUERY_COLUMNS: Record<AllowedTable, Set<string>>`。

## 4. DSL（`packages/shared/src/step-dsl.ts`）

新增两个 kind：

```ts
export const DbAssertionMatch = z.enum(['equals', 'contains', 'regex']);

export const QueryDbAction = z.object({
  kind: z.literal('queryDb'),
  table: z.enum([
    'projects', 'groups', 'users', 'test_cases', 'test_steps',
    'reports', 'execution_plans', 'plan_runs', 'plan_run_cases', 'test_attachments',
  ]),
  where: z.array(z.object({
    column: z.string().min(1).max(64),
    equals: z.union([z.string().max(500), z.number(), z.boolean()]),
  })).max(10).default([]),
  columns: z.array(z.string().min(1).max(64)).max(40).default([]),
  limit: z.number().int().min(1).max(200).default(50),
  assertion: z.object({
    match: DbAssertionMatch.default('contains'),
    expected: z.string().max(2000),
    column: z.string().max(64).optional(),
  }).optional(),
});

export const ObserveLogAction = z.object({
  kind: z.literal('observeLog'),
  windowMs: z.number().int().min(1000).max(600000).default(60000),
  keywords: z.array(z.string().min(1).max(200)).max(10).default([]),
  fromLine: z.number().int().min(1).max(10000).default(200),
  assertion: z.object({
    match: DbAssertionMatch.default('contains'),
    expected: z.string().max(2000),
  }).optional(),
});
```

`StepAction` 联合类型与 `StepAction` discriminated union 各加两条；assertion 字段决定采集/断言两种行为。

**`ExecStepResult` 新增字段**（写入 `reports.step_results`）：

```ts
export interface DbQueryRowResult {
  rowCount: number;
  durationMs: number;
  rows: Record<string, unknown>[];
  truncated?: boolean;
  assertion?: { matched: boolean; expected: string; match: 'equals' | 'contains' | 'regex' };
}

export interface ObserveLogLineResult {
  matchedLineCount: number;
  durationMs: number;
  lines: { ts?: string; raw: string }[];
  truncated?: boolean;
  assertion?: { matched: boolean; expected: string; match: 'equals' | 'contains' | 'regex' };
}

export interface ExecStepResult {
  // ...现有字段
  db?: DbQueryRowResult;
  log?: ObserveLogLineResult;
}
```

## 5. 执行器

### 5.1 `apps/api/src/execute/envContext.ts`（新）

```ts
export interface EnvCtx {
  envId: string;
  db?: { host: string; port: number; database: string; user: string; password: string };
  syslog?: { host: string; port: number; user: string; privateKey: Buffer; filePath: string };
  /** 用于资源回收 */
  close(): Promise<void>;
}

export async function resolveEnv(opts: {
  planEnvId?: string | null;
  caseEnvId?: string | null;
}): Promise<EnvCtx>;

function decrypt(ciphertext: string, iv: string, tag: string, key: Buffer): string;
```

实现：

- 优先取 `planEnvId`，其次 `caseEnvId`；都没有 → 抛 `EnvMissing`（外层 runCase 转为 stepResult 失败，不抛 500）。
- 解密 dbPassword 与 syslogKey（key 取自 `process.env.ENCRYPTION_KEY`，复用 `lib/secret-crypto.ts`）。
- 创建 `pg.Pool`（envCtx.db 存在时）与 `ssh2.Client`（envCtx.syslog 存在时），挂到 ctx 上。
- `close()` 释放 pool 与 ssh 连接；幂等。

### 5.2 `apps/api/src/execute/dbQuery.ts`（新）

```ts
export async function runQueryDb(opts: {
  env: NonNullable<EnvCtx['db']>;
  action: QueryDbAction;
}): Promise<DbQueryRowResult>;
```

实现要点：

- zod parse 后强制首词 = SELECT；拒绝 `;` 多语句；拒绝 INTO/UNION/RETURNING/DDL。
- 列名查白名单 `ALLOWED_QUERY_COLUMNS[table]`；不存在 → 抛 `QueryDbColumnNotAllowed`。
- where params → `$1/$2/...` 占位 + pg prepared statement；不拼字符串。
- `result.rows` 截断 50 行；超出 → `truncated: true`。
- assertion? → `match` 决定 equals 全等 / contains 包含 / regex JS 正则；可选 `column` 限定到单列匹配。
- 异常归类 `QueryDbError` / `QueryDbTableNotAllowed` / `QueryDbColumnNotAllowed`。

### 5.3 `apps/api/src/execute/syslogReader.ts`（新）

```ts
export async function runObserveLog(opts: {
  env: NonNullable<EnvCtx['syslog']>;
  action: ObserveLogAction;
  since: Date;
}): Promise<ObserveLogLineResult>;
```

实现要点：

- `ssh2.Client.connect({ host, port, username, privateKey })` → 成功后再 `exec('tail -n 200 <file>')` 拉初始片段。
- 时间窗：按 `since` 转为 ISO8601 UTC，构造 `awk -v since="<ISO>" '$1 >= since' <file>` 命令（行首视为 ISO ts；如文件格式不同由后续扩展字段定义）。
- 关键字过滤：任一 keyword 命中即保留（大小写不敏感）。
- 行数超 50 → 截断。
- assertion? → 任一行包含 / equals / regex expected。
- 异常归类 `SyslogConnectFailed` / `SyslogAuthFailed` / `SyslogFileMissing` / `SyslogTimeout`。

### 5.4 `apps/api/src/execute/cdp.ts` 改造点

1. `executeCaseReal` 入参新增 `envCtx?: EnvCtx`。
2. `dispatch(action, opts)` switch 加两个分支：
   - `queryDb` → `runQueryDb`；assertion 不匹配 → `stepResult.status = 'failed'`，failureReason = `QueryDbAssertionFailed`。
   - `observeLog` → `runObserveLog`，`since = new Date()`；assertion 不匹配 → status='failed'，failureReason = `LogAssertionFailed`。
3. 步骤结果里 `stepResult.db` / `stepResult.log` 写入（即使未断言也写）。
4. 步骤结束后由 `runCase` 顶层 `try/finally` 关闭 envCtx。

### 5.5 `apps/api/src/execute/runCase.ts` 改造点

- 读 `caseRow.defaultEnvId`。
- 入参新增 `opts.envOverride?: EnvCtx`（来自 planRun 链路）。
- 调 `resolveEnv({ planEnvId: opts.envOverride?.envId, caseEnvId: caseRow.defaultEnvId })`，缺省 → EnvMissing → runCase 写失败 stepResult（不抛 500）。
- envCtx 传给 `executeCaseReal`；`finally { envCtx.close() }`。

### 5.6 `apps/api/src/execute/runPlan.ts` 改造点

- `runPlanAsync` 启动时读 `execution_plans.environmentId` → `resolveEnv({ planEnvId })` → envCtx 缓存到 planRun 生命周期。
- 循环 `runCase(...)` 时 `envOverride: envCtx`。
- planRun 结束 `await envCtx.close()`。

### 5.7 `apps/api/src/execute/failureClassifier.ts` 新增

```ts
| 'QueryDbError' | 'QueryDbTableNotAllowed' | 'QueryDbColumnNotAllowed'
| 'QueryDbAssertionFailed' | 'EnvMissing' | 'EnvDbMissing' | 'EnvSyslogMissing'
| 'SyslogConnectFailed' | 'SyslogAuthFailed' | 'SyslogFileMissing' | 'SyslogTimeout'
| 'LogAssertionFailed'
```

humanMessage 中文短句映射（不再额外给 hint）。

## 6. API 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/projects/:projectId/environments` | 列出项目下 env；敏感字段 mask `••••••` |
| POST | `/api/projects/:projectId/environments` | 新建；明文 password/key → 加密落库 |
| PATCH | `/api/environments/:id` | 编辑；明文字段缺省保留旧值；非空 → 重加密 |
| DELETE | `/api/environments/:id` | 返回关联 case/plan 数；前端二次确认 |
| PATCH | `/api/cases/:id` | 接受 `defaultEnvId`；跨 project → 422 |
| PATCH | `/api/plans/:id` | 接受 `environmentId`；跨 project → 422 |
| GET | `/api/environments/allowed-tables` | 暴露 queryDb 白名单表 + 列给前端 |

鉴权：与既有 project 路由同级（需项目权限）；`allowed-tables` 不含敏感信息。

## 7. 前端改造

#### `apps/web/src/pages/ProjectSettings.tsx`
- 新增「测试环境」Tab：表格列 `name | DB | syslog | 默认 | 操作`。
- 新建/编辑抽屉：表单 `name / db_host / db_port / db_name / db_user / db_password` + syslog 区块。
- 密码 / SSH key 首次写明文（接口加密落库），列表与详情页只见掩码；再次修改需重输明文。
- 删除二次确认 + 「是否同步解除关联」(cases/plans 引用数)。

#### `apps/web/src/pages/CaseDetail.tsx`
- 「执行设置」区新增 `默认环境` Select：项目下全部 env；空 = 「跟随 plan」。

#### `apps/web/src/pages/PlanDetail.tsx`
- 「执行设置」区新增 `目标环境` Select。
- 启动 planRun 时把 env 名显示在头部；planRun 详情页也展示。

#### `apps/web/src/components/StepEditDrawer.tsx`
- `kind` 下拉加 `queryDb` / `observeLog`。
- `queryDb` 子表单：表名 Select / columns MultiSelect / where 动态行 / limit / 可选 assertion。
- `observeLog` 子表单：windowMs / keywords tag 输入 / fromLine / 可选 assertion。

#### `apps/web/src/pages/ReportDetail.tsx`
- 明细模式新增两列「DB 结果」 / 「日志结果」。
- DB 单元格：折叠 JSON（id、status、rowCount、assertion.matched），hover 展开前 5 行原始 JSON。
- 日志单元格：折叠行号 + raw；关键字命中行底色高亮。
- assertion 不匹配 → 行整体红徽标 + 失败原因气泡。

## 8. 数据流与契约

`executeCaseReal` 返回 `ExecStepResult[]` 新增字段 `db?: DbQueryRowResult` / `log?: ObserveLogLineResult`；写入 `reports.step_results`（jsonb 字段保持兼容）。

env 解析失败 → `runCase` 写一条 `ExecStepResult { order: 1, status: 'failed', failureReason: 'EnvMissing', humanMessage: '缺少环境配置，请到项目设置配置' }`，不抛 500。

envCtx 内部对象不写出进程边界；日志只输出 envId 与 host（不写 password / key）。

## 9. 测试计划

### 单元测试
- `envContext.test.ts`：plan > case 优先级；都缺 → EnvMissing；跨项目 → EnvProjectMismatch；解密失败 → DecryptError。
- `dbQuery.test.ts`：拒绝 DROP/INSERT/UPDATE/`;`；列名不在白名单 → 列名错；参数化 where；assertion 三档；>50 行 truncated。
- `syslogReader.test.ts`（mock ssh2）：连接失败 / 认证失败 / 文件不存在；时间窗过滤；关键字过滤；assertion 命中 / 不命中。
- `failureClassifier.test.ts`：新增 10 个 FailureReason 字符串 → 正确归类。

### 集成测试
- `environments.test.ts`：CRUD + 跨项目拒绝 + 二次删除确认接口。
- `cases.test.ts`：PATCH `defaultEnvId`；跨项目 envId → 422。
- `plans.test.ts`：PATCH `environmentId`；跨项目 → 422。
- `execute-cases.test.ts`（扩展）：缺 env + 含 queryDb → 步骤失败 EnvMissing；plan env > case env（spy pool 接到 plan env 的 host）；observeLog 步骤 → mock ssh2 返回 5 行，断言 lines + assertion。
- `execute-plans.test.ts`：planRun 结束 envCtx.close 调用一次（spy）。

### E2E 手动验证
- 起全栈 → 新建 project → 项目设置 → 新建 env（DB 连本地 PG，syslog 用 SSH mock fixture）。
- 创建含 queryDb 步骤 + 不指定 env → 启动 → 步骤失败，failureReason=EnvMissing。
- 改用例 defaultEnvId → 重跑 → stepResults 看到 DB 行。
- 加 observeLog 步骤（关键字 + 时窗） → 跑 → 看到 syslog 行 / 命中徽标。
- plan 指定 environmentId → 跑 planRun → 头部展示 env 名 + DB host。

## 10. 风险与边界

| 风险 | 缓解 |
| --- | --- |
| queryDb 接受任意 SQL → 注入 | DSL 表/列白名单 + 强制 SELECT + 拒 `;` + 参数化 prepared statement |
| env 凭据明文泄日志 | 解密仅 envCtx 内部；logger 不输出 password/key；失败时只记 cipher 解码失败 |
| ssh2 长连接泄漏 | planRun 结束统一 close；runCase try/finally；SIGTERM 钩子 |
| syslog 文件巨大 → 内存爆 | 仅 since 后 / 关键字命中行 + 截断 50 |
| 时区问题 | syslog 时间统一按 UTC ISO8601；fixture 覆盖跨时区 |
| 凭据 ENV 缺失 | ENCRYPTION_KEY 缺失 → 启动 fail-fast（已落地） |
| 多 env 并行 | planRun 串行 case；同一 envCtx 共用 |
| DB 写动作 | 不在本期；仅白名单 SELECT |
| SSH key 格式校验 | zod 要求 PEM 头尾；缺 → 422 |
| 历史报告脱敏 | DSL 禁止查含 password 列的表（白名单列不含 secret_* / password） |

## 11. 兼容性与迁移

- drizzle 迁移默认 NULL 老 FK；旧用例 / plan 不需改动。
- 旧报告 `step_results` 缺新字段，UI 显示 `—`，不影响现有流程。
- PATCH `/api/cases/:id` 与 `/api/plans/:id` 接受新字段，旧调用方不传也合法。
- `packages/shared` 增量导出，无 breaking change。
- `ENCRYPTION_KEY` 已在 dev 环境通过 `apps/api/.env` 提供（见 `project_encryption_key_missing.md`），无需额外配置。

## 12. 不在本期范围

- 多项目共用 env（global env 表）。
- DB 写动作（INSERT/UPDATE/DELETE）。
- 多 SSH key 轮换 / vault 接入。
- 环境变量模板（Terraform / Helm 拉环境配置）。
- WebSocket 实时推 syslog 增量。
- 历史报告 DB 行 / log 行的脱敏迁移脚本。
- iframe 与多 DB schema。
- 自定义稳定性等待参数。