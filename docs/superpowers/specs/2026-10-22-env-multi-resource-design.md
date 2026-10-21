# 环境多资源（凭据 / 数据库 / syslog）设计

日期:2026-10-22
状态:已与用户确认范围（A+B+C 全做，pi 层本轮一并改）

## 背景与动机

环境信息已集中管理（`test_environments` + `environment_objects`，web 对象内嵌各自的应用登录凭据），但**消费端把多实例塌缩成了单例**：

```
envContext.ts:199  const pick = (type) => objects.find(o => o.objectType === type && o.isDefault)
                                    ?? objects.find(o => o.objectType === type);
```

于是执行期只存在「一个 web、一个 db、一个 syslog、一份 login 凭据」，靠 `__ITEST_USERNAME__` / `__ITEST_PASSWORD__` 这类**无归属的固定变量**取用。用户的原话：

> 在使用的时候不应该是一个个固定的变量。比如 web 登陆地址和凭证，有可能一个项目有多个 web（一个后端管理，一个前端用户界面），比如数据库，一个关系数据，一个 olap 数据库。现在用的固定变量模式应该是无法满足要求的。

三类真实缺口：

| 缺口 | 现象 |
|---|---|
| **凭据无归属** | `pick('web')` 只把默认 web 的 payload 派生成 `EnvCtx.login`。前端 web 与后端 web 各有账号时，后端登录无凭据可用 → `EnvMissing`。 |
| **db 单例且只能查平台自己** | `queryDb` 的 `ALLOWED_QUERY_COLUMNS` 白名单只有 iTest 自己的 10 张表（projects/test_cases/…）。**它无法查询被测系统的库**，关系库/OLAP 的结果校验根本没法做。 |
| **syslog 单例** | `observeLog` 只连 `pick('syslog')`，多台日志机无法分设备断言。 |

## 需求口径（已确认）

1. **场景**：不同用例测不同 web；**也可能同一个用例测不同 web**（如"测前端 → 登录 → 跳后端看结果"）。
2. **命名**：用稳定的 `name`（web 沿用现有 `payload.name`；db / syslog 复用现有 `label`，`(env, type, label)` 本就唯一，零 schema 变更、零迁移）。
3. **引擎**：暂不引入新驱动，只有 postgres / mysql。
4. **范围**：批次 A（多 web 凭据）+ B（命名 db + 只读 SQL 动作）+ C（命名 syslog）全做。
5. **pi 层**（verifyCase / solidifyCase / login）本轮一并改。

## 核心概念：占位符带归属

现状的 `__ITEST_USERNAME__` 回答的是"**用哪份用户名**"，没说"**哪个系统的**"。改造后占位符自带 ref：

```
__ITEST_USERNAME@backend__      →  web 服务 name=backend 的用户名
__ITEST_PASSWORD@frontend__    →  web 服务 name=frontend 的密码
{{ITEST_USERNAME@backend}}      →  模型常见的花括号变体，等价
__ITEST_USERNAME__              →  无 ref，按下面的三级链解析
```

`@ref` 段**只用于 web 凭据**（应用账号）。db / syslog 的归属靠 DSL 动作上的显式字段表达（`sql.dbRef` / `observeLog.syslogRef`），不塞进占位符——凭据是「填进表单的值」，数据库是「连哪个实例」，两者语义不同。

### 三级默认解析链（无 `@ref` 时）

```
显式 @ref  →  用例的 web_service_ref  →  环境的默认 web 对象
```

一条链同时覆盖两种场景：
- **不同用例测不同 web** → 用例绑 `web_service_ref=backend`，机械 DSL 的 `__ITEST_USERNAME__` 与 AI 相的 `__ITEST_USERNAME__` 都解析到 backend 的凭据（回放路径不再需要改写）。
- **同一用例跨 web** → 步骤里显式写 `__ITEST_USERNAME@backend__`，走第一个分支。

## 架构

三层，各自职责不变：

```
执行期 EnvCtx（envContext.ts）      资源清单 + 按 ref 解析连接/凭据
      ↓ 暴露                          不再是单值
CredentialResolver（aiTask.ts）      占位符解析 + 真实值替换（唯一的替换点）
      ↓ 被两条路径共用
机械路径 cdp.resolveEnvCredential    valueSub = makeCredentialValueSub(...)
AI 路径   runAiTask 的 fill 分支     同一份 resolver，两处不重复实现
```

关键约束：**只有一个 resolver 实现**。上一轮 prod228 事故（`{{ITEST_USERNAME}}` 字面量敲进表单、模型空转 12+ 次 LLM）的根因就是机械路径与 AI 路径各写了一套 `=== USER_PH` 的精确匹配。本次一律收敛到 `parseCredentialPlaceholder`。

---

## 批次 A：多 web 各自凭据

### A1. 占位符协议扩展（`apps/api/src/execute/aiTask.ts`）

```ts
export type CredentialKind = 'user' | 'password' | 'secret';
/** 解析结果：kind + web 服务 name（null = 未指定，按三级链解析） */
export interface ParsedCredential { kind: CredentialKind; ref: string | null }

/** 解析 __ITEST_USERNAME@backend__ / {{ITEST_USERNAME@backend}} / {{__ITEST_USERNAME@backend__}}。
 *  裸名（无哨兵/花括号包裹）仍不认，避免普通文本误判。 */
export function parseCredentialPlaceholder(raw: string): ParsedCredential | null;

/** 向后兼容包装：只要 kind，丢弃 ref（aiActionMap 的固化判定用）。 */
export function credentialPlaceholderKind(raw: string): CredentialKind | null;

/** 渲染占位符，供提示词拼装（避免各处硬编码字符串）。 */
export function credentialPlaceholder(kind: CredentialKind, ref?: string | null): string;

/** ref 段合法性：与 VAR_NAME_RE 同口径（字母/数字/下划线，字母或下划线开头，≤64）。 */
export function isValidCredentialRef(ref: string): boolean;
```

`CREDENTIAL_REF_RE` 同步扩展 `referencesCredential`：`@backend` 段可选，识别结果不受影响（该函数只判布尔）。

### A2. CredentialSource 扩展（保留全部既有调用形态）

```ts
export interface CredentialSource {
  /** 无 ref / 解析不出 ref 时的默认来源（既有调用方零改动） */
  user?: string | null;
  password?: string | null;
  secret?: string | null;
  /** 带 ref 解析：按 web 服务 name 取该服务的凭据；返回 null = 该 ref 无凭据 → EnvMissing。 */
  byRef?: (ref: string) => { user?: string | null; password?: string | null } | null;
}
```

`makeCredentialValueSub(src)` 的解析顺序：`@ref` 且 `src.byRef` 命中 → 用该服务凭据；否则回落到 `src.user/password/secret`；两者皆空 → 抛命名错误。

**错误消息必须点名缺失的资源**（用户排查靠它）：

```
env-missing: 用例步骤引用了 __ITEST_USERNAME@backend__，但环境「SOC 测试环境」的 web 服务 backend 未配置用户名/密码（请到项目设置→测试环境配置）
```

`secret` 的 `@ref` 形态**不解析**（敏感密文是步骤级，与 web 无关）；`__ITEST_STEP_SECRET@x__` 按无 ref 处理并在解析时忽略 `@x`。

### A3. EnvCtx 暴露多份凭据（`apps/api/src/execute/envContext.ts`）

```ts
export interface LoginCtx { user: string; password: string; loginUrl: string | null; }

/** 新增：web 服务 name → 该服务内嵌的凭据（仅已配 user+secret 的）。 */
logins: Map<string, LoginCtx>;
/** 保留：默认 web 服务的凭据（旧消费点零改动）。 */
login?: LoginCtx;
/** 新增：按 ref 取 web 凭据；ref 空 → 默认 web；无对应 → null。 */
resolveLogin(ref?: string | null): LoginCtx | null;
/** 新增：某 web 服务是否配了凭据（AI 资源清单渲染用，不泄漏任何值）。 */
hasCredentials(ref: string): boolean;
```

`logins` 的 key 就是 `payload.name`（无名对象不参与引用，与既有语义一致）。

### A4. 三级链的第二级：把用例绑定传进执行上下文

`ExecContext` 新增 `caseWebServiceRef?: string | null`；`runCase.ts` 已有 `caseRow.webServiceRef`，随 `resolveEnv` 结果一起注入。`aiCredentialSub` 据此构造：

```ts
function aiCredentialSub(ctx: ExecContext, secret: string | undefined): CredentialSource {
  const env = ctx.envCtx;
  const defaultRef = ctx.caseWebServiceRef
    ?? env?.webServices.find((w) => w.isDefault)?.name
    ?? env?.webServices.find((w) => w.name)?.name
    ?? null;
  return {
    user: env?.resolveLogin(defaultRef)?.user ?? null,
    password: env?.resolveLogin(defaultRef)?.password ?? null,
    secret: secret ?? null,
    byRef: (ref) => env?.resolveLogin(ref) ?? null,
  };
}
```

`cdp.resolveEnvCredential`（机械路径）改调同一个 `makeCredentialValueSub`，不再自己 `=== USER_PH`。

### A5. AI 资源清单进提示词

`runAiTask` 的 `RunAiTaskOpts` 新增 `resourceManifest?: string`（由调用方渲染，aiTask.ts 不依赖 EnvCtx）。SYSTEM_PROMPT 的凭据一段改为动态拼接：

```
可用 web 服务（凭据归属用 @name 指定；不写 @name 时用标注「默认」的那个）：
- backend（默认） http://192.168.30.144:90 已配置凭据
- frontend  http://192.168.30.144:1688 已配置凭据
- staging  http://10.0.0.9 未配置凭据
用户名输入框 fill 的 value 用 __ITEST_USERNAME@backend__；密码用 __ITEST_PASSWORD@backend__。
平台在填入的瞬间替换为真实值，你不得猜测或改写。
清单里「未配置凭据」的服务不要尝试登录（会必然失败）。
```

清单**只含 name / origin / 是否有凭据**，绝不出现真实值。

### A6. 前置检查与固化

- `credentialPreflightError`：改为按 `parseCredentialPlaceholder` 扫全文，对每个带 `@ref` / 无 ref 的凭据引用检查可得性；不可得即 EnvMissing，**零 LLM 调用**（保持上一轮的 fail-fast 收益）。
- `aiActionMap.mapAiActionsToCompiled`：`credentialPlaceholderKind(a.value)` 已能识别 `@ref` 形态（委托 `parseCredentialPlaceholder`）→ 带 ref 的 fill 同样不固化，理由文案补一句「凭据占位符（含 @ref）」。

---

## 批次 B：命名 db + 只读 SQL 动作

### B1. db 对象的命名

**零 schema 变更**：db 对象用既有 `label` 作 ref（`(envId,'db',label)` 已唯一，`findEnvironmentObject(environmentId,'db',label)` 已存在）。

```ts
export interface DbEntry {
  label: string;                 // ref
  dialect: DbDialect;
  host: string; port: number; database: string; user: string;
  isDefault: boolean;
}

/** EnvCtx 新增 */
dbs: DbEntry[];
resolveDb(ref?: string | null): DbEntry | null;   // 空 → isDefault → 最早；未命中 → null
resolveDbPool(ref?: string | null): Promise<QueryPool>;  // 懒建 + 缓存；无对应 → EnvDbMissing
```

**连接池策略变更**：现状 `resolveEnv` 对默认 db **急切建池**（每次执行都建）。多 db 场景下急切建全部池会浪费连接，改为**懒建 + Map 缓存**，`close()` 统一 `end()` 全部。`EnvCtx.pool` / `EnvCtx.db` 保留为默认 db 的派生（`queryDb` 零改动）。

### B2. 新 DSL 动作 `sql`（只读，查被测系统自己的库）

```ts
export const SqlAction = z.object({
  kind: z.literal('sql'),
  /** 环境 db 对象的 label；空 = 环境默认 db 对象 */
  dbRef: z.string().min(1).max(64).optional(),
  /** 单条只读 SQL，必须以 SELECT / WITH 开头 */
  sql: z.string().min(1).max(8000),
  /** 位置参数（? / $1），按方言适配 */
  params: z.array(z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).max(20).default([]),
  limit: z.number().int().min(1).max(200).default(50),
  assertion: z.object({
    match: DbAssertionMatch.default('contains'),
    expected: z.string().max(2000),
    column: z.string().max(64).optional(),
  }).optional(),
});
export type SqlAction = z.infer<typeof SqlAction>;
```

挂 `StepAction` union + `z.discriminatedUnion` 数组；**`queryDb` 语义完全不动**（它查平台自己，是平台自检）。

**只读守卫**（`apps/api/src/execute/sqlGuard.ts`，纯函数可单测）：

| 规则 | 拒绝形态 |
|---|---|
| 首关键字 | 非 `SELECT` / `WITH` → `SqlReadOnlyViolation` |
| 多语句 | 去掉字符串字面量与注释后仍含 `;` → 拒 |
| DDL/DML 关键字 | `INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/GRANT/REVOKE/CALL/COPY/INTO\s+OUTFILE` → 拒 |
| 长度 | > 8000 字符 → 拒（zod 已限，执行层再兜一层） |

配套：语句超时（`SET statement_timeout` / `SET SESSION max_execution_time`，方言分流）、行数截断到 `limit`、结果序列化截断到 2000 字符/列。

**信任边界的诚实说明**：词法守卫与既有 `ALLOWED_QUERY_COLUMNS` 同级（都靠字符串判定）。真正的防线是**给被测库配只读账号**——这条写进文档与错误提示，不假装词法守卫能挡住 `SELECT ... INTO`。

### B3. 结果承载与前端

- `ExecStepResult` 新增 `sql?: SqlStepResult`（`{ dbRef, rows, rowCount, truncated }`），与既有 `db` / `log` / `http` 同形。
- `dbQuery.ts` 不动；新增 `apps/api/src/execute/sqlQuery.ts`（`runSql({pool, action, vars})`），`cdp.ts` 加 `case 'sql'`。
- 前端：`StepEditDrawer.tsx` 加 sql 表单（dbRef 下拉 / SQL 文本 / 参数 / limit / 断言），`stepSummary.ts` 加摘要，`ReportDetail.tsx` 加结果表。

---

## 批次 C：命名 syslog

与 B 同形，key 用 `label`：

```ts
export interface SyslogEntry { label: string; ctx: SyslogCtx; isDefault: boolean; }
// EnvCtx
syslogs: SyslogEntry[];
resolveSyslog(ref?: string | null): SyslogCtx | null;
```

`ObserveLogAction` 新增 `syslogRef?: string(≤64)`；`runObserveLog` 内按 label 取连接，未命中 → `EnvSyslogMissing`（消息点名 ref 与可用清单）。**不命中默认**即静默回落默认——显式写了 ref 却落空必须是硬错误。

`syslogReader.ts` 的 SSH 连接改为懒建（与 B1 同理），`SyslogCtx` 不复用。

---

## 失败归类扩展（`packages/shared/src/playback.ts` + `failureClassifier.ts`）

`FailureReason` 新增 3 项，`HUMAN` map 同步（该 map 是穷尽的，漏一条即 typecheck 报错——这是刻意的护栏）：

| reason | humanMessage |
|---|---|
| `SqlError` | 只读 SQL 执行失败（连接或语句错误） |
| `SqlReadOnlyViolation` | SQL 非只读语句（仅允许 SELECT / WITH），已拒绝执行 |
| `SqlAssertionFailed` | SQL 结果断言未命中 |

其余（`EnvDbMissing` / `EnvSyslogMissing` / `EnvMissing`）复用，靠 `e.name` + 消息内容区分，不新增。

`classify` 的 `EnvDbMissing` 分支要能吃 `e.resource`（缺失的 ref 名），让报告写"未配置名为 olap 的数据库连接"而不是泛泛一句。

---

## pi 层同步（本轮）

| 位置 | 改动 |
|---|---|
| `verifyCase.ts:324-325` 提示词 | 凭据说明改为带 `@ref` 形态 + 附资源清单 |
| `verifyCase.ts:691-693` valueSub | 换成 `makeCredentialValueSub({...cred, byRef})`，删掉三条 `===` |
| `solidifyCase.ts:335-337` valueSub | 同上 |
| `login.ts` | `perform_login` / `get_login_credentials` 增可选 `webRef` 参数；`buildLoginCredentialSource(ctx, ref)` 复用同一 `CredentialSource` 构造（cdp.ts 的 `aiCredentialSub` 提到共享位置，两处共用） |
| 测试 | `pi-verify-case.test.ts` / `pi-solidify-case.test.ts` 里对 aiTask 的 mock 需同步（它们 `vi.mock` 了 aiTask 的常量导出） |

---

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| `EnvCtx` 形状变更波及大量消费点 | `login` / `pool` / `db` / `syslog` / `baseUrl` 全部保留为派生字段，新增项全是增量；旧字段语义不变 |
| 急切建池改懒建引入连接时序变化 | 默认 db 仍在 `resolveDbPool()` 首次调用时建；`close()` 覆盖全部；连接超时参数（5s）不变 |
| 只读守卫被绕过 | 文档明确词法守卫不是安全边界；配只读账号；guard 有单测锁死各拒绝形态 |
| pi 层与并发会话冲突 | `verifyCase/solidifyCase` 的并发会话改动已提交（`8dcf69b`），工作区干净，本轮在其上增量改 |

## 不做的事（out of scope）

- **凭据作为普通数据集变量**：`{{password}}` 走 extract/数据集列，不进本设计（凭据只来自环境对象 + 步骤密文）。
- **用例执行中临时切换环境**：环境选择仍在用例/计划/版本/项目四级解析链上。
- **新数据库驱动**：ClickHouse / Hive 等走 mysql 协议接入，不加驱动。
- **跨环境引用**：`@ref` 只在本环境内解析，不支持 `env2.backend` 形态。
- **`sql` 动作的写操作**：只读是硬边界，要写就换 ETL / 别的工具。