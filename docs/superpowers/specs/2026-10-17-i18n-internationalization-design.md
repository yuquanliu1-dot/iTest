# iTest 国际化改造设计

日期:2026-10-17
状态:已确认(待写实施计划)

## 1. 背景与目标

iTest 是 AI 驱动的自动化测试平台 MVP,当前全中文。本次改造使其支持多语言,并能分发给非中文用户使用。

### 现状盘点

| 区域 | 中文规模 | 说明 |
|---|---|---|
| apps/web (React 19 + Vite) | 111 文件 / ~2300 行 | UI 壳层文案 |
| apps/api (Express) | ~2700 行 | 大部分是 prompt / 日志 / LLM 上下文,真正用户可见的是 HttpError 边界 |
| apps/recorder (Chrome MV3) | ~420 行 | popup / panel / 录制 HUD 覆盖层 |
| packages/shared | ~63 行 | schema 校验 message + 注释 |
| packages/ui | ~0 | 设计令牌 + glass 工具类,无文案 |

### 已有的有利基础

- `users.languagePreference` 字段已存在(`'zh-CN' | 'en-US'`,默认 zh-CN),`PATCH /users/me` 已接受该字段 —— 语言状态链路半成品
- API 错误统一 `HttpError(status, code, message)`,第二个参数是稳定机器码(`not_found` / `invalid_credentials` / `weak_password`)—— 错误码目录可直接复用它,后端零改动
- SSE 计划运行事件 `PlanRunEvent` 是结构化字段(`type/status/stepKind`),前端 `StatusPill` 已做「状态→样式」映射 —— 定位=把映射点改成 `t()`
- LLM 调用统一走 `agent/llm-client.ts`(`systemPrompt` + `messages`)—— 语言注入点干净
- `STEP_DSL_SPEC` 现有规则已强制「`Locator.value` / `assertText.equals` 必须取页面真实 UI 文本片段」—— 定位/展示分离的种子已存在

### 关键约束

- **被测系统语言不定**(可能仍是中文版):AI 生成的「定位用业务文案」必须与被测页面实际文本一致,不能随平台语言翻译,否则破坏元素定位
- **存量数据不动**:不迁移已入库的中文数据;每次会话只按当前语言产生新内容

## 2. 范围决策(已确认)

1. **覆盖程度**:全链路含 AI 输出 —— UI 壳层 + API 错误提示/SSE + AI 生成的用例/需求/助手回复。存量数据不迁移。
2. **语种框架**:可扩展多语言框架(加语言=加资源目录),本期实装 zh-CN + en-US。
3. **SUT 语言**:被测系统语言不定 → 定位文本与展示文案分离。
4. **AI 语言规则**:AI 生成的展示内容跟随界面语言(切英文就输出英文),确定性强、便于测试。

## 3. 总体架构

```
┌────────────────────────────────────────────────┐
│ web (React 19 + Vite)                          │
│   react-i18next ── t('ns:key')                 │
│   i18n/locales/{zh-CN,en-US}/<ns>.json         │  ← 资源按 feature 分命名空间
│        │                                       │
│        ▼ 语言偏好                               │
│   users.languagePreference (已有字段)           │
│   └─ 登录后取 → init i18n → dayjs.locale       │
│   └─ UserMenu 语言切换 → PATCH /users/me       │
└────────────────────────────────────────────────┘
```

- **框架**:react-i18next。资源文件式(加语言=加 JSON 目录)、与 React 19 兼容、复数/插值开箱即用。
- **语言真相源 = 后端 `users.languagePreference`**,非浏览器探测。登录响应带 user(已含该字段),前端据此初始化;切换时同步 PATCH。
- **默认值**:存量与新建用户默认 `zh-CN`(与 DB 默认一致),即「没切过 = 保持现状」,零感知。
- **兜底语言 = zh-CN**:en 资源缺 key 回落到中文,保证迁移期不出现裸 key。
- **`<html lang>` 与 dayjs**:随语言同步更新 `document.documentElement.lang` 与 dayjs locale。`<html lang>` 同时被 recorder bridge.js 读取,作为扩展语言同步来源。

### 语言切换入口

UserMenu 下拉内置语言切换项(theme 切换同类入口)。用户点击 → 变更本地 i18n 状态 + `PATCH /users/me { languagePreference }`。

## 4. UI 壳层改造(web)

- **命名空间**:`common`(按钮/通用)、`auth`、`cases`、`reports`、`plans`、`projects`、`datasets`、`environments`、`groups`、`members`、`settings`、`overview`、`assistant`(space-assistant)、`mobile`、`components`(通用组件)、`errors`(错误码目录,见第 5 节)。
- **迁移方式**:JSX 中文字面量换 `t('ns:key')`。两类难缠点:
  - 动态插值:如 `共 {n} 条` → `t('cases:total', { count })`;en 复数用 `_one`/`_other` key 后缀。
  - 数据映射型文案:表头、状态枚举文本、空状态、toast 文案 —— 同时改源数据映射,如状态枚举从硬编码中文改为 `t('cases:status.running')`。
- **生成内容不碰**:LLM 回复的 markdown、需求正文、报告里的 AI 结论段落是数据,由 AI 层(第 6 节)决定语言。
- **存量数据原样展示**。

## 5. 服务端错误与 SSE 层

**核心判断:后端中文里只有跨界面的边界需要 i18n。主路径(REST HttpError + SSE 结构化事件)后端零改动;**例外=给零散非结构化 `error` 字段补稳定 code,属于逐个清点的小改动,不做全量枚举。**

1. **REST 错误 → 错误码目录**:
   - `apps/web/src/api/client.ts` 的 `ApiError` 目前只透传 `message`(`client.ts:40` 丢弃了 `body.code`)= 唯一前端改造点:补 `code` 透传。
   - 新增 `locales/*/errors.json`,key = 现有 HttpError 稳定 code(`not_found` / `invalid_credentials` / `weak_password` …)。
   - 渲染原则:`t('errors:' + code)` 命中即本地化;未命中回落 `body.message` 中文 —— 永不出现裸 key。
2. **结构化 `error` 字段**(`{ok:false,error}`,如回购检查、test-db):先试 code 再 pass-through;清点后「发现一个补一个 code」,不做全量枚举。
3. **SSE 计划运行事件**:载荷已是结构化 `type/status/stepKind`,前端在 StatusPill 等映射点改为 `t()`;`summary` 字段是 AI 文本,走第 6 节规则。
4. **AI 生成的错误文本**(LLM 失败原因、校验结论):不进目录,由 AI 输出语言规则控制。
5. **零散非结构化返回**(如「仓库不可用」类 `{error: 中文}`):保留中文兜底,遇一个改一个。

## 6. AI 输出层(定位/展示分离)

**核心机制:一条「语言指令块」在 prompt 装配点统一注入。**

1. **语言注入**:所有 LLM 调用在 `systemPrompt` 末尾追加语言指令块,模板固定、随 `req.user.languagePreference` 注入:
   > 「界面语言 = en-US。**写给用户看的内容**(用例标题、步骤说明、需求摘要、判定理由、聊天回复)一律用界面语言。
   > **用于元素定位的业务文案**(`Locator.value`、`assertText.equals`、`IntentLocator.contextText`)必须取自被测页面快照的实际文本,保持被测系统语言,禁止翻译或改写。」
2. **prompt 模板本身不翻**:`STEP_DSL_SPEC` 等模板中的中文是 LLM 内部指令上下文,非用户可见;翻译只有维护成本无用户体验收益。输出语言由指令块管。
3. **服务端生成的用户可见文本**(工具 tool `summary`,如「已复制用例为「xx」」):代码拼的、存进会话记录 —— 服务端按会话语言用小型 `t()`-helper 格式化。**会话语言 = 会话创建者的 `languagePreference` 在建会话时快照**,存量会话保持原语言(与「存量数据不动」一致)。
4. **`aiTask.instruction`(双角色)**:既是展示文字又是回放驱动指令 —— 跟随界面语言。回放智能体看截图做视觉推理,指令语言不影响对中文页面执行。
5. **判定/报告文本**(`judgeCaseOutcome` 的"做了什么/原因")、需求分析、AI 补步骤:同一注入规则,按发起请求用户的 `languagePreference`。

## 7. Recorder 扩展(次要面)

- 用 Chrome 官方 `_locales/` 机制(`messages.json` × zh-CN/en-US + `__MSG_key__`);最终在实施计划中与轻量 JS dict 二选一,倾向官方机制。
- 语言来源:注入中台页的 bridge.js 读 `document.documentElement.lang` → 同步到 `chrome.storage`;popup 留手动切换;兜底默认 zh-CN。
- 范围:popup / panel / 录制 HUD 覆盖层文案。录制的步骤数据语言无关(取自页面实际文本),不受影响。

## 8. packages/shared

本期不动。schema 校验 message 随 422 冒泡时,由前端错误层按 code 翻译、未知 code 中文兜底接管;注释不动。列入「未来清理」清单。

## 9. 测试与验证策略

- **语言切换冒烟**:切 en-US,断言关键页关键字符串为英文、页面无裸 `t(` key 泄漏。
- **keys 覆盖率 CI**:脚本对比 zh/en 资源 JSON 的 key 集合,差异即 fail —— 防漏翻硬闸。
- **错误目录单测**:code → 文案映射表单元测试。
- **AI 层单测**:断言装配出的 `systemPrompt` 在 zh/en 下都含语言指令块;不写死 LLM 英文输出断言(模型行为,靠手动 e2e)。
- **零回归保障**:zh 资源 = 现有文案原样搬;语言保持 zh 时行为零变化。

## 10. 实施分期与回滚

- **Phase 0 脚手架**:react-i18next + zh 资源(现状复制)+ 语言状态接线 + UserMenu 开关。纯加法,零行为变化。
- **Phase 1**:web UI 文案迁移(common → features)+ en 资源填充。
- **Phase 2**:错误目录 + code 透传 + SSE/StatusPill 映射。
- **Phase 3**:AI 指令块注入 + tool summary i18n + recorder `_locales`。
- **Phase 4**:keys-diff CI、兜底抽查、清点收尾。
- **回滚**:任意阶段切回 zh-CN 立即恢复现状;全程无数据迁移。

## 11. 开放项(实施计划阶段定)

- ~~recorder 用 Chrome `_locales` 还是轻量 JS dict~~ → **已定**:`_locales`(Task 21,default_locale zh_CN,48 键 ×2 全量对等)
- 「仓库不可用」类零散非结构化返回的最终处理方式

### Task 23 冒烟残差(双语运行时验证)

- **en 浏览器全链路未做运行时走查**。chrome-devtools MCP 浏览器反复回收标签页,zh 巡检 + 关键页(登录/项目/版本/进入工作区)零变化已实测,en 的「UI 全英文 / 403 toast 英文 / 计划运行状态徽标英文」仅由静态闸锁定(i18n:check en⊇zh + typecheck + 61 web 测试),未逐屏断言。
- **AI 输出英文运行时验证依赖 worktree api**。冒烟时 54321 上是主树 api(迁移前,AI 输出恒 zh);langDirective→LLM 的英文路径只在 worktree api 里,未起服务。单元级已锁定:i18n-st 26 测试(en 断言)+ 工具 summary 双语。
- **recorder 扩展真机语言切换未验**。`_locales` 双语为静态对等验证(48×2,default_locale zh_CN 保今天行为),popup/panel/Shadow HUD 运行时语言需手工加载 unpacked 确认。
- **api 全量测试并行 testcontainers flake(既存,非 i18n)**。recorder-relativize/cases-versions 全量并行会争 postgres:16-alpine 容器偶发失败,单文件跑全过。
- **web lint react-hooks/exhaustive-deps error(既存,非 i18n)**。6e11b81 起的配置问题,branch 未动 eslint 配置;本计划闸 = typecheck + i18n:check + test,不含 lint。
- **recorder typecheck selector-core TS2367 ×3(既存,非 i18n)**。b37dbc0 起,'xpath' 与 'text'|'role'|'testId'|'css' 无重叠;Task 21 闸 = vitest run + build。