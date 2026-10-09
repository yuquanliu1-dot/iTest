# verify_case / perform_login 自动识别图形验证码 — 设计

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `verify_case` 与 `perform_login` 的 pre-login 阶段从「遇验证码即放弃」升级为「遇验证码即复用 aiTask 既有的 VLM 识别策略」，使其在带图形验证码的登录页也能完成自动登录。

**Architecture:** 一处提取 + 一处扩展。不新增并行执行器，**完全复用 `execute/aiTask.ts` 既有的 `solveCaptchaOnce` 单轮识别 + `runAiTask` 多轮兜底**——它们已经经过验证、行为稳定、prompt 调优到位。`pi/autoLogin.ts` 的 `loginInContext` 在探测到登录页含验证码时，**复用同一套 LLM client 与 OCR prompt**，把识别结果填入对应输入框，再走原有 `fillLoginForm` 提交流程。两条上游路径（`perform_login` 工具、`verify_case` 工具）共用此能力。

**Tech Stack:** playwright-core + 已有 `LLMClient`（settings 表里的 anthropic/openai/google）+ 已有 `solveCaptchaOnce`（`apps/api/src/execute/aiTask.ts`）+ vitest 单测。

**Spec:** `docs/superpowers/specs/2026-10-09-verify-case-design.md`（本次为扩展 spec；与原 spec 行为兼容，不破坏既有契约）。

---

## 现状回顾

### verify_case 与 perform_login 当前的失败路径

`apps/api/src/pi/autoLogin.ts:91`：
```ts
if (captcha) throw new Error('登录页需要验证码，无法自动完成登录');
```

这是硬断点。`verify_case` / `perform_login` 走到这里就抛错返回，prod228 实测真实结果（`bc6a59ec` 用例）：
```
verify_case → isError:true, "登录失败: 登录页需要验证码，无法自动完成登录"
```
用例 URL 本身就是登录页（`https://192.168.30.123:1688/tf/auth/login`），且用例步骤已用 `aiTask` 自己识别 captcha，但 pre-login 在 verify_case 工具内就挂了，根本走不到用例步骤。

### 已有的识别能力（直接复用即可）

`apps/api/src/execute/aiTask.ts:204`：
```ts
export async function solveCaptchaOnce(page, client, hint?): Promise<string>
```
- 页内启发式定位「验证码图 + 配套输入框」
- 4x 白底放大截图（OCR 友好）
- 一次 VLM 调用（prompt `CAPTCHA_OCR_PROMPT`）
- 返回「已识别验证码为 X 并填入」summary
- 抛错表示失败

### aiTask 既有的「多轮验证」重试（可参考）

`apps/api/src/execute/cdp.ts:602` 的 `runCaptchaRetry` 模式：提交后页面出现验证码失败提示（`detectCaptchaFailure` 探测 `document.body.innerText`）→ 重新识别 → 重新提交；最多 `CAPTCHA_RETRY_ROUNDS` 轮。这是 cdp.ts 已经验证过的「验证码场景回放容错」套路。pre-login 阶段没这个回路（因为 pre-login 本来就还没提交），我们不需要做多轮重试，只需要一次识别就够——验证码还没换，识别一次成功即可填表提交。

### 约束（来自用户决策）

| 项 | 决策 |
|---|---|
| 识别类型 | 图形验证码（字母/数字）；点选/滑动拼图/短信 OTP 不在本轮 |
| 触发时机 | 仅登录页存在验证码元素时调用 AI；其他场景走原路径 |
| 重试/超时 | 参考 aiTask 识别策略（**单轮 solveCaptchaOnce 失败回退多轮 runAiTask**；与 cdp.ts runCaptchaRetry 同源） |
| 隐私边界 | 仅传 `page.screenshot`；环境凭据（密码）不进入 VLM 输入 |

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/api/src/pi/autoLogin.ts` | 修改 | `loginInContext` 增加可选 captcha solver 注入；探测到验证码时调用；失败抛错保持原文案 |
| `apps/api/src/pi/space/tools/verifyCase.ts` | 修改 | `buildVerifyCaseTool` 创建 LLMClient 后透传进 `loginInContext` |
| `apps/api/src/pi/space/tools/login.ts` | 修改 | `perform_login` 创建 LLMClient 后透传进 `loginInContext` |
| `apps/api/test/pi-auto-login-captcha.test.ts` | 新建 | 「有验证码调用 AI 一次识别成功」「有验证码 AI 失败抛错」「无验证码不走 AI」三条分支 |

---

## 关键设计点

### 1. loginInContext 增加可选 captcha solver 参数

不直接 `import { solveCaptchaOnce }`，避免 autoLogin 反向依赖 execute 包（模块分层问题）。改为**依赖注入**：

```ts
export type CaptchaSolver = (page: Page) => Promise<void>;

export async function loginInContext(
  context: BrowserContext,
  cred: LoginCtx,
  startUrl: string,
  opts?: { solveCaptcha?: CaptchaSolver },
): Promise<'logged-in' | 'not-needed'> { ... }
```

调用方（`verifyCase.ts` / `login.ts`）传入：
```ts
const solveCaptcha: CaptchaSolver = async (page) => {
  const client = (await resolveLlmClient()).client;
  await solveCaptchaOnce(page, client, /* hint */ null)
    .catch(() => runAiTask(page, '识别当前验证码图片中的字符并填入验证码输入框', client));
};
```

这样的好处：
- autoLogin 保持「不知道 LLM 的存在」，与 cdp.ts 的 `ExecContext.llmClient` 注入模式对称
- 单测里可以传入 mock solver，验证「探测到验证码时调用 solver / solver 抛错时透传」

### 2. 探测策略与 cdp.ts 对齐

`apps/api/src/pi/autoLogin.ts:87-91` 当前的选择器：
```ts
input#auth-captcha, input[name="captcha"], input[id*="captcha" i], input[placeholder*="验证码" i]
```
复用既有选择器——已经覆盖 prod228 实测的 `input[name="verificationCode"]`（SOC 平台）。如果以后要扩，按同样模式追加候选。

### 3. 不改密码字段

识别只填 captcha 输入框；用户名/密码继续由 `fillLoginForm` 处理。识别顺序：在 `fillLoginForm` 之前先识别，识别成功后再填表提交。

### 4. 失败透传

`solveCaptchaOnce` 抛错（识别结果非法 / 没找到输入框 / LLM 调用失败）→ 由 `loginInContext` 的 try/catch 透传出去，原始错误文案包含「验证码识别失败: ...」，与原「登录页需要验证码，无法自动完成登录」并列，不吞错。`verify_case` / `perform_login` 的外层 try/catch（已存在）会把它转成 `ok:false, error: ...`。

### 5. promptGuidelines 同步

`verify_case` 的 promptGuidelines 已经说「环境未配置 login 凭据而验证因登录页失败时，引导用户到项目环境页配置 login 凭据，不要伪造登录步骤」。现在要补一句：

> 「本工具已自动识别图形验证码（字母/数字）。若识别仍失败，按提示调整 locator 或联系管理员。」

放在原 guidelines 数组里，不改既有条目顺序。

---

## Task 0: 前置门禁

- [ ] 跑 `npm run typecheck` + `npm run lint -- --quiet`（apps/api）确认当前干净
- [ ] 跑 `git status --short` 确认工作区只有本次改动

## Task 1: 给 autoLogin 增加可选 solver 注入（不改行为）

- [ ] **Step 1.1:** 在 `apps/api/src/pi/autoLogin.ts` 导出 `type CaptchaSolver = (page: Page) => Promise<void>`
- [ ] **Step 1.2:** `loginInContext` 加第 4 个参数 `opts?: { solveCaptcha?: CaptchaSolver }`，签名兼容
- [ ] **Step 1.3:** 探测到验证码时：若 `opts?.solveCaptcha` 存在则先 await；抛错透传；不存在则保留原 `throw new Error('登录页需要验证码，无法自动完成登录')`
- [ ] **Step 1.4:** 跑既有 `apps/api/test/pi-auto-login.test.ts` 4 个用例确认无回归

## Task 2: 在 verifyCase.ts / login.ts 注入 solver

- [ ] **Step 2.1:** `apps/api/src/pi/space/tools/verifyCase.ts` 在启动 chromium 之前先 `resolveLlmClient()` 拿到 client；构造 `solveCaptcha` 透传给 `loginInContext`
- [ ] **Step 2.2:** `apps/api/src/pi/space/tools/login.ts` 的 `perform_login` 同样注入
- [ ] **Step 2.3:** `verifyCase.ts` 的 promptGuidelines 数组追加一条「已自动识别图形验证码；失败按提示调整」

## Task 3: 单测

- [ ] **Step 3.1:** 新建 `apps/api/test/pi-auto-login-captcha.test.ts`
  - 「有验证码时调用 solver」：mock solver 收到 page.handle，断言被调用
  - 「solver 抛错透传」：mock solver throw，断言 loginInContext 抛同错
  - 「无验证码时不调用 solver」：mock solver 不应被调用
- [ ] **Step 3.2:** `TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/pi-auto-login-captcha.test.ts` 通过
- [ ] **Step 3.3:** `TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/pi-auto-login.test.ts` 既有 4 用例仍通过

## Task 4: 全量回归与发版

- [ ] **Step 4.1:** `npm run typecheck` + `npm run lint -- --quiet`（apps/api 与 apps/web）
- [ ] **Step 4.2:** `TESTCONTAINERS_RYUK_DISABLED=true npx vitest run` apps/api 全量测试；记录通过/失败比
- [ ] **Step 4.3:** 单文件 commit「feat(pi): verify_case / perform_login 自动识别图形验证码」+ 列出关键文件
- [ ] **Step 4.4:** `bash infra/docker/release.sh --env prod228`
- [ ] **Step 4.5:** 在 prod228 chrome devtools 走完整链路：用 admin 登录 web → 进入 base-all V1.13 → AI 助手发「用 verify_case 验证用例 bc6a59ec-315f-43c9-9276-fcf4aaba9886」→ 观察远端 agent 调用 verify_case → 应跑通 pre-login → 期望用例步骤里的 aiTask 自动识别验证码并登录成功

## 风险与权衡

- **LLM 成本**：每次 verify_case / perform_login 触发最多 1~2 次 VLM 调用（一次 solveCaptchaOnce + 一次 runAiTask 兜底）。识别失败时 `verify_case` 已经走原错误路径，不会无谓浪费。prod228 LLM 是 anthropic Auto 模型，2481ms latency 可接受。
- **错误暴露面**：solver 抛错会带 LLM 原始输出片段（截断 80 字）。这是与 aiTask 步骤一致的；不是新增隐私风险。
- **验证码类型**：仅「字母+数字」类（`/^[a-z0-9]{3,6}$/i`）的 OCR 强约束由 `solveCaptchaOnce` 保证；其他类型（点选/滑动）会在校验阶段抛错并被透传。
- **回退兼容**：现有 `loginInContext(ctx, cred, url)` 三参调用不受影响（opts 可选）；既有测试不需改。
