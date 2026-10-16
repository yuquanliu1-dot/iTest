# 环境多 Web 服务与相对 URL 设计

日期:2026-10-16
状态:已与用户逐节确认

## 背景与动机

现状初始导航 URL 固化:`test_cases.url` 存绝对地址(录制 finish 自动写入,recorder.ts:125-136),执行解析链为 `case.url → group.defaultUrl → 环境.baseUrl → 项目默认环境.baseUrl`(resolve-url.ts)。环境 `baseUrl` 是单值,挂在 `test_environments` 行上;同一项目多个 web 服务(前端/后端不同主机)无法表达,一个用例无法跨环境执行。

**目标**:用例只保存相对 URL;初始导航的绝对地址在执行时由环境里管理的 web 服务对象(多主机 http/https ip:port)拼接;分组不再保存 URL;环境对象支持多个 web 服务。

## 需求口径(已确认)

1. **服务绑定**:环境内 web 服务标 isDefault,用例不指定时用默认;用例可选填 web 服务标识覆盖(如指向"后端")。
2. **相对化范围**:初始导航 + 中途 navigate 步骤都支持相对 URL;绝对 URL 保留兼容(外链仍可直接写)。
3. **存量迁移**:自动尽力迁移 + 运行时兼容——环境 baseUrl 自动转默认 web 服务;用例 url / navigate 步骤 origin 能匹配到所属项目环境 web 服务的自动剥离成相对;匹配不到的保留绝对,执行时直接用(不随环境变,但不会坏)。
4. **loginUrl**:login 对象的 loginUrl 一并相对化(相对时拼默认 web 服务)。
5. **建模**:复用 `environmentObjects`,新增 objectType='web'(不建新表、不加 JSON 列)。

## 数据模型

### Schema 变更(schema.ts)

1. `environmentObjects.objectType` 清单加 `'web'`:
   - 写死清单的两处同步:routes/environments.ts:18、environments.service.ts:14(OBJECT_TYPES)
   - payload 结构 `{ name?, scheme: 'http'|'https', host: string, port?: number }`
   - `name`:英文短标识(合法变量名字符 `^[A-Za-z_][A-Za-z0-9_]*$`,≤64),per-env 唯一;用于用例绑定(`web_service_ref`)与执行期变量注入(`web_<name>`);可缺省——缺省时该对象仅可作为默认服务,不可被引用
   - 显示名走现有 `label`(可中文,默认"默认")
   - 无 secret;mask/normalize 逻辑空转无副作用
   - `isDefault` 复用"每 (envId, objectType) 唯一默认"语义与 UI 徽标
2. `test_cases` 加列 `web_service_ref varchar(64) null`:空=用环境的默认 web 服务;值=web 对象 `name`
3. 删列:`groups.default_url`(schema.ts:390)、`test_environments.base_url`(schema.ts:570)
4. AI 草稿表 `aiStageEnvironments` 保留 baseUrl 字段(草稿宽松),save 落库时自动转默认 web 对象(见 AI 链路)

### 数据搬迁(单个迁移文件内按序执行,尽力语义)

1. 每个环境插入默认 web 对象:`base_url` 非空取其 origin;`base_url` 空则取 login 对象 loginUrl 的 origin;两者皆空不插入。插入行 payload `{ name: 'web', scheme, host, port }`(name 固定 'web'),isDefault=true
2. `test_cases.url` 为绝对 http(s) 且 origin 命中该用例所属项目任一环境的任一 web origin → `url` 改为 path(含 query/hash),`web_service_ref='web'`;未命中保留绝对
3. `test_steps.compiled`(jsonb)中 kind=navigate 元素的 url,同规则剥离(jsonb_array_elements 重写,不用全文 regexp);未命中保留绝对
4. `groups.default_url` 随列删除,不做数据搬迁。受影响面:url 为空且依赖分组兜底的用例,行为回落为"环境默认 web 服务首页"——**已知行为变化**,不做兼容
5. 删 `test_environments.base_url` 列

**顺序约束**:搬迁步骤 1-3 必须先于步骤 5 删列(同一迁移文件内保证)。prod 走 drizzle-kit push 的现实下:先执行 `drizzle migrate`(数据搬迁+DDL),再部署新镜像;push 的 DDL diff 与迁移结果一致,无冲突。

**执行链运行时解析**

### EnvCtx 扩展(envContext.ts)

- EnvCtx 新增 `webServices: Array<{ name: string | null; label: string; origin: string; isDefault: boolean }>`(从 web 对象构建,origin = `scheme://host[:port]`,80/443 默认端口省略)
- 新增 `resolveWebOrigin(ref?: string | null): string | null`:
  - ref 非空 → 找 `name === ref` 的 web 服务;找不到抛 `WebServiceMissing`(消息含环境名与可用服务清单)
  - ref 空 → isDefault 优先 → 最早的 web 服务
  - 环境无任何 web 对象 → 返回 null(由调用方决定报错或兼容)
- 现有 `baseUrl` 单值字段改为派生 getter(= resolveWebOrigin()),兼容既有消费点(login.ts:81 兜底、stage summary 等),不要求本次全部清除

### 初始导航(resolve-url.ts 重写)

`resolveCaseUrl(caseRow, envCtx)` 新链:

- `case.url` 绝对(http/https 开头)→ 原样返回
- `case.url` 相对(`/` 开头)→ `resolveWebOrigin(caseRow.web_service_ref)` + path;origin 为 null(ref 不匹配或环境无 web 服务)→ 抛 `WebServiceMissing`
- `case.url` 空 → 默认 web origin(即环境首页);无 web 服务 → null(维持"about:blank 开始"现状)
- group.defaultUrl 链删除

`runCase.ts:248` 调用处:`WebServiceMissing` 落单步失败报告,复用 EnvMissing 呈现机制(runCase.ts:217-241),failureReason='WebServiceMissing',humanMessage 示例:"环境「测试环境」未配置 web 服务,请到项目环境页添加" / "环境「测试环境」不存在 web 服务 backend,可用:web、frontend"。

### 中途 navigate(cdp.ts:287)

dispatch 顺序调整:先 `substituteVars(url)` → 结果以 `/` 开头 → 拼**用例绑定服务**的 origin(绝对原样)→ 其他形态(如 `foo/bar`)步骤失败。用例绑定的 origin 由 runCase 在解析初始导航时一并求出,注入 ExecContext(如 `ctx.caseWebOrigin`)。

**跨服务跳转零新语法**:`{{web_backend}}/api/x` 变量替换后为绝对,直通现有逻辑;`/api/x` 拼绑定服务 origin。

### web 变量注入

runCase 组装 initialVars 后叠加 `web_<name>` = origin(仅 name 合法且 per-env 唯一者)。`web_` 为系统保留前缀:与数据集变量同名时**环境注入覆盖**(不硬禁存量数据集变量名,文档写明)。

### loginUrl(loginPrepare.ts)

goto 前 loginUrl 以 `/` 开头 → 拼默认 web origin;绝对原样。preflight 已接收解析后 targetUrl(cdp.ts:889),无需改。

### 展示链(cases.service.ts:296 resolvedUrl)

改为:相对 + 用例默认环境(无则项目默认环境)web origin 拼接的绝对值;无环境或无 web 服务 → 返回相对原样,前端配"环境未配置 web 服务"提示。

## 录入/编辑/AI 链路

### 录制(recorder.ts)

- create:targetUrl 仍解析为**绝对**给浏览器(CaseDetail 录制输入框默认填 resolvedUrl,可改)
- finish 落库"尽力相对化":targetUrl/首步 URL 的 origin 命中项目任一环境 web 服务 → 存相对 + `web_service_ref`=该服务 name;未命中(外站)→ 存绝对。现有 `^https?://` 校验(recorder.ts:133)调整为"命中剥离、未命中保留绝对"
- 录制产生的中途 navigate 步骤(compiled.url)同规则剥离

### CaseDetail UI

- "初始化导航 URL"区改为:**相对路径输入**(占位 `/admin/login`)+ **web 服务下拉**(选项=默认 + 各服务 name,来自用例默认环境或项目默认环境的 web 对象;无环境时仅"默认")
- 不再提供绝对 URL 编辑;旁边展示 resolvedUrl 拼接结果
- 保存 patch:`{ url: 相对或空, webServiceRef: 选定 name 或 null }`

### GroupsPage UI

- 删 defaultUrl 表单字段(schema.ts:390 相关)与列表列展示;新建用例对话框的 URL 预填删除(新建用例 url 留空走环境)
- API:cases.service createGroup 去掉 defaultUrl 入参;routes/groups PATCH 去掉透传;client.ts 类型同步清理

### EnvironmentsPage UI

- 环境表单删 baseUrl 输入
- 对象区加 'web' 类型卡片(globe 图标),表单字段:name(英文标识,可选,placeholder "如 backend")、协议(http/https 下拉)、host、port;默认徽标与"设为默认"复用现有交互
- 保存校验:name 若填必须合法变量名;同环境内 name 重复(不同 label)拒绝

### AI 工具

- environments 工具(pi/space/tools/environments.ts):objectType 清单加 'web',AI 可建/改 web 对象
- stage-tools.ts:464 约束改写:"navigate 的 url 优先相对(以 / 开头);跳其他 web 服务写 `{{web_<name>}}/path`;仅外部站点写绝对 URL";466(禁止步骤重复初始 navigate)保留
- stageRoute save:staged 环境 baseUrl 非空 → 落库时生成 isDefault=true 的 web 对象
- case-ops-tools.ts:update_case patch.url 语义改相对;:100 提示文案同步更新
- solidifyCase / verifyCase:走新 resolveCaseUrl(自动生效);skipInit 比较用解析后的绝对值
- AI 环境摘要(summary.ts):列出 web 服务清单(name/origin),让模型知道可引用哪些 `web_<name>`

### DSL 校验(step-dsl.ts:13)

`NavigateAction.url` 从 `z.string().url()` 放宽为 refine,允许三种形态:

1. 绝对 http(s):`^https?:\/\//`
2. 相对:`^\/`
3. 变量打头:`^\{\{/`(替换后由运行时判断,与 fill.value 模板语义一致)

## 错误处理汇总

| 场景 | 行为 |
|---|---|
| 执行前:环境无 web 服务 / ref 不存在 | `WebServiceMissing` 单步失败报告(humanMessage 带环境名+可用服务清单),复用 EnvMissing 呈现机制 |
| navigate 替换后既非绝对也非 `/` 开头(含变量 missing) | 步骤失败,错误信息含模板原值(沿用 substituteVars 语义) |
| 数据集变量与 `web_` 注入同名 | 环境注入覆盖(系统保留前缀,文档写明;不硬禁存量变量名) |
| 录制 finish origin 不匹配任何环境 | 保留绝对,不阻塞录制 |
| 展示链无 web 服务 | 显示相对原样 + "环境未配置 web 服务"提示 |
| 一切存量绝对 URL(case.url / navigate / loginUrl) | 全链路原样直通,不随环境变 |

## 测试

- **shared**:navigate url 校验三形态 + 非法样例(裸文本、ftp:// 等)
- **resolve-url**:绝对直通 / 相对拼默认 / 相对拼 ref / 空 url 取默认 origin / 无 web 服务抛 WebServiceMissing / ref 不存在抛 WebServiceMissing / group 链已删(不再读 groups 表)
- **envContext**:webServices 构建(含默认端口省略)、resolveWebOrigin 各分支、baseUrl 派生 getter 兼容
- **environments.service**:web 对象 CRUD、同 name 异 label 拒绝、mask 空转无副作用
- **runCase**:WebServiceMissing 失败报告呈现、`web_` 变量注入与 initialVars 覆盖顺序
- **cdp**:navigate 相对拼接(ctx.caseWebOrigin)、`{{web_x}}` 跨服务直通、非法形态失败
- **loginPrepare**:loginUrl 相对拼接
- **recorder finish**:命中剥离(存相对+ref)/ 未命中保留绝对
- **迁移**:fixture 覆盖 base_url/loginUrl 生成 web 对象、case.url 与 navigate 剥离、未命中保留、列删除;以及"迁移幂等"(重跑不重复插对象)
- **AI 工具**:stage-tools 约束新文案、web 对象创建、stageRoute 落库转默认 web 对象、summary 列 web 服务
- **UI 手工清单**:环境页 web 表单与默认徽标、CaseDetail 相对输入+下拉+resolvedUrl、GroupsPage 无 URL、录制→回放跨环境黄金路径(A 环境录,B 环境跑)

## 影响面清单(实现锚点)

| 改动 | 位置 |
|---|---|
| DSL 校验放宽 | packages/shared/src/step-dsl.ts:13 |
| resolveCaseUrl 重写 | apps/api/src/lib/resolve-url.ts |
| EnvCtx webServices/resolveWebOrigin/baseUrl 派生 | apps/api/src/execute/envContext.ts |
| WebServiceMissing 失败报告 | apps/api/src/execute/runCase.ts:217-248 |
| navigate 相对拼接 + caseWebOrigin 注入 | apps/api/src/execute/cdp.ts:287、runCase.ts(execCtx) |
| web_ 变量注入 | apps/api/src/execute/runCase.ts(initialVars 组装处) |
| loginUrl 相对化 | apps/api/src/execute/loginPrepare.ts:40,93 |
| 展示链 resolvedUrl | apps/api/src/services/cases.service.ts:296 |
| 录制 finish 相对化 | apps/api/src/routes/recorder.ts:125-136,133 |
| web 对象类型清单 | apps/api/src/services/environments.service.ts:14、apps/api/src/routes/environments.ts:18 |
| 删 group defaultUrl(服务+路由+AI) | apps/api/src/services/cases.service.ts:323、apps/api/src/routes/groups.ts:13,24、apps/api/src/pi/space/tools/cases.ts:40,51,65,151 |
| AI 约束与落库 | apps/api/src/pi/space/tools/stage-tools.ts:464,466、stageRoute.ts:152、case-ops-tools.ts:100、summary.ts:38 |
| verifyCase/solidifyCase | apps/api/src/pi/space/tools/verifyCase.ts:465、solidifyCase.ts:176 |
| UI 环境页 | apps/web/src/pages/EnvironmentsPage.tsx:27,138,254,317 |
| UI 用例页 | apps/web/src/pages/CaseDetail.tsx:204,812,1396 |
| UI 分组页 | apps/web/src/pages/GroupsPage.tsx:63,563,601,734 |
| web client 类型 | apps/web/src/api/client.ts:85,97,632,678 |
| schema+迁移 | apps/api/src/db/schema.ts(40,390,570,633)+ drizzle 新迁移(0039 起) |

## 已知行为变化(不兼容项,均已确认接受)

1. `groups.default_url` 删除:依赖分组兜底且 url 为空的存量用例,初始导航回落"环境默认 web 服务首页"
2. `test_environments.base_url` 删除:环境表单不再有 baseUrl 输入,历史值转为默认 web 对象
3. CaseDetail 不再支持直接编辑绝对初始 URL(只能相对 + 服务选择);存量绝对值仍可执行但不再随环境变
4. 数据集变量 `web_` 前缀被系统占用(同名被覆盖)
