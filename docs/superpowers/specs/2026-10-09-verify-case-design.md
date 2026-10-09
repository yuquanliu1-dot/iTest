# AI 用例生成实测验证闭环（verify_case）

- 日期：2026-10-09
- 状态：已评审通过（待实现）
- 范围：apps/api 版本空间助手（`pi/space/tools`）

## 背景与问题

AI 助手生成用例的两条信息来源各有缺陷：

1. **页面抓取（inspect_page）**：抓取被测平台真实渲染页面时，因未携带环境中记录的登录凭证，往往拿到登录页或空页面，抓取失败。
2. **源码分析（repo 沙箱）**：无真实 DOM 校验，LLM 从源码推断 locator/文案/流程存在幻觉，生成的 `compiled` DSL 步骤在真实页面上不可回放。

版本空间助手已有 `perform_login`（凭证自动填表导出 storageState）与 `executeCaseInBrowser`（共享 context 逐步执行、失败即停）等积木，缺的只是"试执行 → 失败反馈 → 修正"的编排层。

## 目标

给版本空间助手新增 `verify_case` 工具：生成/修改用例后，agent 自主调用它——自动用环境 login 凭证登录被测系统、逐步执行 compiled DSL、失败即停并返回失败页真实元素清单；agent 依据反馈修正用例后可再验证，形成"生成 → 实测 → 修正"闭环。

## 非目标（v1 不做）

- 移动端用例验证（platform=mobile 直接拒绝并说明）
- 验证报告落库、"已验证"徽标（结果仅存对话上下文）
- 批量验证管线、dry-run 模式（接受副作用，与正式执行行为一致）
- 需求级老助手（pi/tools.ts）接入

## 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 集成形态 | agent 工具，agent 在对话内自主"验证 → 看反馈 → 修正 → 再验证" |
| 作用范围 | 仅版本空间助手 |
| 执行粒度 | 失败即停 + 失败页元素快照 |
| 副作用 | 接受（被测环境即测试环境，与 runCase 行为一致） |
| 结果留存 | 仅对话内，不动 schema/前端 |
| 实现路径 | 薄编排：复用 executeCaseInBrowser，不写新执行器、不走 runCase 全链路 |

## 架构与数据流

```
agent 对话循环
   │ upsert_case（写入 steps + compiled DSL）
   ▼
verify_case(caseId)                    [新] pi/space/tools/verifyCase.ts
   ├─ 读 case + steps（同 runCase 查询：testSteps by caseId, order asc）
   ├─ resolveEnv → LoginCtx（无 login 凭据则跳过登录直跑）
   ├─ openLoggedInContext()            [提取] pi/autoLogin.ts（自 login.ts 提取填表逻辑）
   │     launch chromium → goto loginUrl → 探测/验证码检查/自动填表 → 登录态 context
   ├─ resolveCaseUrl → targetUrl
   ├─ executeCaseInBrowser(...)        [复用] execute/cdp.ts，天然失败即停
   │     └─ 失败时触发 onFailurePage 回调 → extractPageElements(page)
   │                                      [提取] 自 pi/inspectPage.ts 的 EXTRACT_JS
   ▼
返回结构化结果（步骤摘要 + 失败详情 + 失败页元素清单）
   ▼
agent 依据元素清单修正 compiled → upsert_case → 再 verify_case（≤3 轮）
```

执行语义与正式回放完全一致（同一 dispatcher、同一 locator 解析/断言/失败归因），验证通过即正式执行也会通过。

## 组件明细

### 1. `pi/autoLogin.ts`（新，纯提取）

把 `pi/space/tools/login.ts` 中的 `URL_LOGIN_HINTS`、`isLoginPage`、`fillLoginForm` 及"launch → 探测 → 验证码检查 → 登录"编排提取为 `openLoggedInContext(envCtx, opts?)`。`perform_login` 改为调用它（外部行为不变），`verify_case` 复用。密码仅在此模块内部解密使用，不进任何返回值或日志。

### 2. `execute/cdp.ts` 最小改动

`runStepsInContext` / `executeCaseInBrowser` 增加可选参数 `onFailurePage?: (page: Page, failedIndex: number) => Promise<void>`，在现有失败 break 点（失败即停处）触发。不传则零行为变化。相比事后从 `context.pages()` 猜活动页（switchTab 场景顺序不可靠），回调精确拿到失败时刻的页面。

### 3. `verify_case` 工具（`pi/space/tools/verifyCase.ts`）

- **参数**：`{ caseId: string }`。环境走 resolveEnv 既有优先级链（case defaultEnv > version link > 项目默认），不引入覆盖参数。不收 storageState——登录由工具内部完成，避免大 JSON 经 LLM 上下文搬运。
- **返回约定**：基础设施失败（登录失败、chromium 启动失败、超时）返回 `ok:false`（工具错误，无 data）；用例真实执行完成则 `ok:true`，`result` 为 passed/failed。
- **前置校验**：case 存在、platform=web、steps 非空。
- **execCtx**：`reportId` 用 `verify-<nanoid>`（截图机制照常落盘，路径返回供用户查看）；`expectedOutcome: null` 跳过 vision 判定（v1 不做，省时省钱）。
- **整体超时**：硬上限 120s，超时终止并返回 error。
- **资源清理**：finally 中关 browser、envCtx.close()。每次验证独立 browser，不做长驻复用。
- **返回 data**（JSON 字符串；成功时精简，失败时信息密集）：

```jsonc
{
  "result": "passed | failed",
  "caseId": "...", "envId": "...", "targetUrl": "...",
  "login": "logged-in | not-needed",
  "steps": [ { "order": 1, "status": "passed", "durationMs": 830, "hitLocator": "..." } ],
  "failure": {                          // 仅 result=failed 时存在
    "stepOrder": 3,
    "action": { "kind": "click", "locator": [ ... ] },   // 失败动作（敏感值脱敏）
    "error": "...", "failureReason": "ElementNotFound",
    "humanMessage": "...", "screenshotPath": "...",
    "page": { "url": "...", "title": "...", "elements": [ "- button#submit ..." ] }
    // elements 复用 inspectPage 的 300 元素 / 30k 字符上限与格式
  }
}
```

### 4. promptGuidelines（注入系统提示）

- 含 compiled 步骤的用例创建/修改后，环境可用时调用 verify_case 实测验证。
- 修正时只能使用 `failure.page.elements` 中真实存在的选择器，禁止臆造。
- 同一用例最多重试 3 轮；仍失败则保留用例、向用户如实说明失败步骤与原因，不无限循环。
- 环境未配置 login 凭据而页面需要登录时，引导用户到环境页配置，不伪造登录步骤。

## 错误处理

| 场景 | 行为 |
|---|---|
| caseId 不存在 / platform=mobile / steps 为空 | `ok:false`，明确文案 |
| 环境无 login 凭据 | 跳过登录直跑；若因登录页失败，元素清单暴露登录表单，agent 引导用户配置 |
| 登录失败（验证码/表单不识别） | `ok:false`，复用 perform_login 文案 |
| chromium 启动失败 / 整体超时 120s | `ok:false`，finally 关 browser + envCtx |
| 步骤执行失败 | 失败即停 + onFailurePage 快照，组装 failure 结构返回 |

## 测试

- `test/pi-verify-case.test.ts`：返回组装三分支（passed / failed 含 failure 结构 / 登录失败），mock db + chromium（参照 `test/pi-inspect-page.test.ts` 的 launch 处理）。
- `test/execute-cdp-extract.test.ts` 补 onFailurePage 触发时机（失败步骤处、携带失败页引用）。
- 手工验收：真实环境走一轮"生成错误 locator → 验证失败 → 按清单修正 → 验证通过"。

## 涉及文件

| 文件 | 动作 |
|---|---|
| `apps/api/src/pi/space/tools/verifyCase.ts` | 新增（工具主体） |
| `apps/api/src/pi/autoLogin.ts` | 新增（自 login.ts 提取登录编排） |
| `apps/api/src/pi/space/tools/login.ts` | 改为调 autoLogin（外部行为不变） |
| `apps/api/src/pi/inspectPage.ts` | 导出 extractPageElements（元素提取共享函数） |
| `apps/api/src/execute/cdp.ts` | 加可选 onFailurePage 参数 |
| `apps/api/src/pi/space/tools/index.ts` | 注册 verify_case |
| `apps/api/test/pi-verify-case.test.ts` | 新增测试 |
