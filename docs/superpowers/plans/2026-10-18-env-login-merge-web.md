# 环境管理:登录凭据并入 Web 服务(0041)

> **Goal:** Web 服务与登录凭据一一对应——登录凭据就是该 Web 服务的默认凭证。删除独立 `objectType 'login'`,凭证字段内嵌进 web payload;环境级登录凭据 = 环境**默认 web 服务**内嵌的凭证,autoLogin「无登录用例自动填表」语义不变。

## 背景与决策

环境管理 `environment_objects` 原有 4 类:`db` / `syslog` / `login`(登录凭据)/ `web`(Web 服务)。login 与 web 无关联,「默认凭证」是环境级。经用户确认合并:

- **合并成单实体**:删 `objectType 'login'`,`user / loginUrl / secret(AES 三元组)` 内嵌进 web payload。
- **autoLogin 语义不变**:计划「无登录用例自动填表」仍用**该环境默认 web 服务**内嵌的凭证——凭证宿主即默认 web,`baseUrl === 其自身 origin`,相对 loginUrl 拼接逻辑(`loginPrepare.ts:100-102`、`login.ts:81`)逐字节不变,执行链改动最小。

## 数据模型

`web` payload 变为 `{ name?, scheme, host, port?, user?, loginUrl?, secret? }`(secret = AES-256-GCM `{c,i,t}` base64 三元组)。

**无任何 DDL**:`object_type` 是自由 varchar、`payload` 是 jsonb → schema.ts / SCHEMA_SQL / drizzle-kit push 均无 diff。

## 代码改动清单(已实施)

### 后端

| 文件 | 改动 |
|---|---|
| `routes/environments.ts:18` | `OBJECT_TYPES` 去 `'login'` |
| `services/environments.service.ts:15` | `OBJECT_TYPES` 去 `'login'`;`normalizeObjectPayload` 统一按 `out.password` 加密(web 走 non-syslog 分支);`assertWebPayload` 追加 `user/loginUrl/password` 类型轻校验(`invalid_web_credentials`) |
| `execute/envContext.ts` | `LoginPayload` 并入 `WebPayload`;`resolveEnv` 登录凭据由 `pick('login')` 改为 `pick('web')`(isDefault→最早,与 `resolveWebOrigin()` 空 ref 同一选择),`user + secret 三元组齐全` 判据不变 |
| `execute/enqueuePlanRun.ts` | `assertLoginPrepareHasSource` 改查 `objectType='web'` 按 `is_default DESC, created_at, id` 取默认,判定 `user` 非空 + secret 三元组齐全(与 resolveEnv 逐字段对齐);422 文案改「…默认 web 服务对象中配置登录凭据」 |
| `runPlan.ts / loginPrepare.ts / cdp.ts / lib/resolve-url.ts / routes/recorder.ts` | 零改动(消费 `envCtx.login` / web payload,shape 未变) |

### AI 工具 / stage

| 文件 | 改动 |
|---|---|
| `pi/space/tools/environments.ts` | zod / Type.Union 去 `'login'`;description 注明 web 可带 `user / loginUrl` |
| `pi/space/tools/stage-tools.ts` | 三处 union 去 `'login'` |
| `pi/space/stageRoute.ts` | union 收窄;save 时**过滤 staged 遗留 login 草稿**(`.filter(o => o.objectType !== 'login')`),避免落成孤儿行 |
| `tools/login.ts / verifyCase.ts / solidifyCase.ts / inspect.ts / loginStateCache.ts` | 零改动(全读 `envCtx.login`) |

### 前端

| 文件 | 改动 |
|---|---|
| `apps/web/src/api/client.ts` | objectType union 三处去 `'login'`;`StagedEnvironmentObject` 补 `'web'`(顺带修既有缺 web 的 bug);payload 注释更新 |
| `apps/web/src/pages/EnvironmentsPage.tsx` | `ObjType` 去 `'login'`;`buildObjectPayload` 删 login 分支、web 分支追加 `user/loginUrl/password`;`objectSummary` web 可带 `user@`;卡片三元简化;删「新增登录」按钮;表单删 login 分支、web 表单在 port 后追加登录凭据区;测试连接判断只限 db/syslog |
| i18n `environments.json`(zh-CN / en-US) | 删 `objTypes.login`;新增 `form.webCredsTitle`;`form.loginHelp` 改为 web 作用域文案;description / emptyObjects 去「登录凭据」字样 |

## 迁移 `apps/api/drizzle/0041_merge_login_into_web.sql`(纯数据、手写、无 DDL)

1. 临时表 `_mig_web_targets`(web 按 `is_default DESC, created_at, id` 编号 wn)、`_mig_login_rows`(login 同序编号 ln + loginUrl + web_count + **payload**,与运行时 pick 选择逻辑对齐)。
2. 并入:同序号 login → web(COALESCE 语义:**不覆盖** web 上已有的 user/loginUrl/完整 secret 三元组),标 `updated_at=now()`。
3. 环境有 login 但无 web:loginUrl 为绝对 http(s) → 由 loginUrl 造默认 web 对象(`row_number()=1` 首条 is_default=true,避开部分唯一索引),内嵌凭证;非绝对 → 进入丢弃点。
4. 丢弃点:`RAISE NOTICE`(环境名 + loginUrl)后 `DELETE FROM environment_objects WHERE object_type='login'` 收尾清场。丢弃仅发生在「有 login、无 web、loginUrl 相对/为空」——这类凭据旧代码仅用于 cdp 机械派发 / verify_case 占位符替换(不依赖 host)。NOTICE 是唯一回溯信号,须留存。
5. 幂等:全部语句只作用于残余 login 行,首遍后归零;TEMP 表先建后查,重跑 no-op。

### 部署顺序(关键)

**先发新代码 → 再 psql 跑 0041**。先迁移会让仍在读 login 行的旧代码 enqueue 校验 422;先代码则有短暂窗口新代码不读 login,迁移后即恢复。同一发布窗完成。api 容器启动的 `drizzle-kit push --force` 只跑 DDL,不执行本文件——须手工 psql。

## 数据丢弃点与风险

- **唯一数据丢弃**:环境有 login、无 web、且 loginUrl 相对/为空 —— 该凭据仅服务 cdp/verify_case 占位符替换逻辑,不依赖 host;`RAISE NOTICE` 留存为唯一回溯信号。
- **stage 草稿**:暂存环境里的 login 对象迁移前保存会被 stageRoute 过滤掉;迁移后 AI 重建环境时须把 login 凭据并入 web 对象(AI 工具描述已引导)。
- **web.name 冲突**:迁移第 3 步造对象固定 `name='web'`,若环境已有同名会 409(0040 同款约定;实测 dev 库无此冲突)。
- **resolveEnv 与 enqueue 校验**:两者选择逻辑一致(isDefault→最早),确定性对齐;仅「无默认的多 web」边角差异可接受。

## 验证(2026-10-18 已完成)

- **单元/集成测试全绿**:
  - `src/execute/envContext.test.ts` 25 例 —— 三处 login fixture 改 web 内嵌凭证 + 新增「多 web 时 login 取默认 web」;
  - `test/environments.service.test.ts` 12 例 —— login fixture 改 web 携带凭证(密码加密/留空沿用旧密文/入参 secret 丢弃)+ 新增 `assertWebPayload` 凭证字段类型校验;
  - `test/pi-verify-case.test.ts` 38 例 —— `seedLoginObject` 合并成单条 web 对象含凭证;
  - `test/plans.test.ts` 18 例 —— 新增「环境默认 web 带内嵌凭据 → run 200」/「无凭据 → 422」覆盖新 enqueue 语义。
- **类型检查**:api `tsc --noEmit`、web `tsc -b` 均干净。
- **浏览器 UI 验证**(chrome-devtools MCP 实测):环境页只留 数据库/syslog/Web 服务 三入口按钮、无「新增登录」;web 卡片显示 `user@origin` + 已配置徽标(db 卡显示未配置凭据);web 编辑表单含「应用登录凭据（可选）」区(loginUrl / 用户名 / 密码「留空表示不修改」+ loginHelp);页面头描述无「登录凭据」字样;console 无 i18n 缺 key 告警。
- **本地 dev DB 实地演练**(itest-pg):
  - 迁移前:3 环境各 1 条 login、0 条 web(3 条 loginUrl 均绝对 http(s));
  - 执行前备份 3 行到 `/private/tmp/0041_pre_login_backup.csv`;
  - `0041.sql` 执行:UPDATE 0 / INSERT 0 3 / DELETE 3,无 NOTICE(零丢弃);
  - 结果:`login` 归零、3 环境各生成 1 条默认 web 对象,均带 `user + loginUrl + secret`(has_secret=t),`is_default=t`;
  - 重跑幂等验证:二次执行 SELECT 0 / UPDATE 0 / INSERT 0 / DELETE 0。
- **修复的错误**:`_mig_login_rows` 临时表初版未物化 `payload` 列,UPDATE/INSERT 引用 `l.payload` 报 `column l.payload does not exist` —— 在临时表 SELECT 中补 `l.payload` 后重跑通过。