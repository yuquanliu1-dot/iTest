# verify_case 实测验证闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 版本空间助手新增 `verify_case` 工具：凭证自动登录 → 复用 executeCaseInBrowser 失败即停执行 → 失败页元素清单反馈，agent 自修正 compiled 再验证。

**Architecture:** 薄编排层，不写新执行器。三处小提取（登录编排 → `pi/autoLogin.ts`、元素提取 → `extractPageElements`、cdp 失败钩子 → `onFailurePage`），新工具 `pi/space/tools/verifyCase.ts` 组装，不落 report。

**Tech Stack:** NestJS 风格 Express + drizzle + playwright-core + TypeBox（ToolExecutor 模式）+ vitest/testcontainers。

**Spec:** `docs/superpowers/specs/2026-10-09-verify-case-design.md`

**测试命令（apps/api 下）:** 单文件 `TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/<file>.ts`（需 Docker）；typecheck `npm run typecheck`；lint `npm run lint`。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/api/src/pi/inspectPage.ts` | 修改 | 导出 `extractPageElements(page)`（inspect_page 与 verify_case 失败页快照共用） |
| `apps/api/src/execute/cdp.ts` | 修改 | `runStepsInContext`/`executeCaseInBrowser` 加可选 `onFailurePage` 钩子 |
| `apps/api/src/pi/autoLogin.ts` | 新建 | `loginInContext`/`fillLoginForm`/`isLoginPage`（自 login.ts 提取） |
| `apps/api/src/pi/space/tools/login.ts` | 修改 | perform_login 改调 loginInContext（外部行为不变） |
| `apps/api/src/pi/space/tools/verifyCase.ts` | 新建 | verify_case 工具主体 |
| `apps/api/src/pi/space/tools/index.ts` | 修改 | 注册 verify_case |
| `apps/api/test/pi-extract-elements.test.ts` | 新建 | extractPageElements 单测 |
| `apps/api/test/pi-auto-login.test.ts` | 新建 | loginInContext 单测 |
| `apps/api/test/execute-cdp-onfailure.test.ts` | 新建 | onFailurePage 钩子单测 |
| `apps/api/test/pi-verify-case.test.ts` | 新建 | verify_case 工具集成测试 |

---

### Task 0: 处理工作区未提交的 execute/ WIP（前置，必须先做）

工作区有 4 个未提交的用户改动文件（cdp.ts / engine.ts / runCase.ts / webEngine.ts）。Task 2 要修改 cdp.ts 并提交，**直接 `git add apps/api/src/execute/cdp.ts` 会把用户 WIP 一起带进提交**。

- [ ] **Step 0.1: 与用户确认处理方式**（AskUserQuestion）：建议 `git stash push -m "WIP execute engines (verify_case 前置暂存)" apps/api/src/execute/`，本计划完成并提交后由用户决定何时 `git stash pop`（可能有冲突，不自动 pop）。若用户选择先自行提交 WIP，则跳过 stash。

- [ ] **Step 0.2: 执行 stash（若确认）并验证工作区干净**

Run: `git stash list | head -3 && git status --short`
Expected: `apps/api/src/execute/` 下无 M 状态文件；stash 列表含 "WIP execute engines"。

---

### Task 1: 提取 extractPageElements（inspectPage.ts）

**Files:**
- Modify: `apps/api/src/pi/inspectPage.ts`
- Test: `apps/api/test/pi-extract-elements.test.ts`

- [ ] **Step 1.1: 写失败的单测**

创建 `apps/api/test/pi-extract-elements.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright-core';
import { extractPageElements } from '../src/pi/inspectPage.js';

function fakePage(evaluates: unknown, url = 'http://x/y') {
  return { url: () => url, evaluate: async () => evaluates } as unknown as Page;
}

describe('extractPageElements', () => {
  it('返回 url/title/elements/truncated 快照形状', async () => {
    const snap = await extractPageElements(
      fakePage({ title: '元素管理', elements: ['- button#add "添加" 选择器: #add'], truncated: true }),
      'http://192.168.30.228:8088/element-manager',
    );
    expect(snap.url).toBe('http://192.168.30.228:8088/element-manager');
    expect(snap.title).toBe('元素管理');
    expect(snap.elements).toEqual(['- button#add "添加" 选择器: #add']);
    expect(snap.truncated).toBe(true);
  });
});
```

- [ ] **Step 1.2: 运行确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/pi-extract-elements.test.ts`
Expected: FAIL，报错 `No matching export in "inspectPage.js" for import "extractPageElements"`（该测试无需 Docker，容器未启动也能跑）。

- [ ] **Step 1.3: 在 inspectPage.ts 实现导出**

`apps/api/src/pi/inspectPage.ts`：import 行改为

```ts
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
```

在 `EXTRACT_JS` 常量定义之后、`inspectPage` 函数之前新增：

```ts
export interface PageElementSnapshot {
  url: string;
  title: string;
  elements: string[];
  truncated: boolean;
}

/** 在已打开的页面上提取可交互元素清单（inspect_page 与 verify_case 失败页快照共用）。 */
export async function extractPageElements(page: Page): Promise<PageElementSnapshot> {
  const extracted = (await page.evaluate(EXTRACT_JS)) as { title: string; elements: string[]; truncated: boolean };
  return { url: page.url(), title: extracted.title, elements: extracted.elements, truncated: extracted.truncated };
}
```

`inspectPage` 函数体内，把 `const extracted = (await page.evaluate(EXTRACT_JS)) as {...}` 及其后对 `extracted` 的引用改为使用 `extractPageElements`：

```ts
    const snap = await extractPageElements(page);
    const lines = [
      `页面: ${url.toString()}`,
      `标题: ${snap.title || '(无)'}`,
      '注意: 此快照仅为页面初始状态。点击/提交后才出现的元素（结果区、错误提示等）不在清单中——断言这类元素必须先触发相应操作，或断言清单中其稳定的父容器；清单里不存在的 testid/id 绝对禁止编造。',
      `可交互元素 (${snap.elements.length}${snap.truncated ? `，已截断至 ${MAX_ELEMENTS}` : ''}):`,
      ...snap.elements,
    ];
```

（`MAX_ELEMENTS`/`MAX_OUTPUT_CHARS`/`EXTRACT_JS` 常量保持不动；文件头注释补一句"extractPageElements 供 verify_case 失败页快照复用"。）

- [ ] **Step 1.4: 新测试通过 + 既有 inspectPage 测试不回归**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/pi-extract-elements.test.ts test/pi-inspect-page.test.ts`
Expected: 全部 PASS（pi-inspect-page 是重构安全网，需 Docker）。

- [ ] **Step 1.5: Commit**

```bash
git add apps/api/src/pi/inspectPage.ts apps/api/test/pi-extract-elements.test.ts
git commit -m "refactor(pi): 提取 extractPageElements 供 inspect_page 与 verify_case 失败页快照共用"
```

---

### Task 2: cdp.ts onFailurePage 钩子

**Files:**
- Modify: `apps/api/src/execute/cdp.ts`（runStepsInContext 签名、失败 catch 块、executeCaseInBrowser 透传）
- Test: `apps/api/test/execute-cdp-onfailure.test.ts`

利用确定性失败路径：`compiled: null` 的步骤在步骤循环里直接抛 `compile-missing`（cdp.ts 约 756 行），不触 dispatch、不依赖真实浏览器。

- [ ] **Step 2.1: 写失败的测试**

创建 `apps/api/test/execute-cdp-onfailure.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { executeCaseInBrowser } from '../src/execute/cdp.js';

/** 覆盖 runStepsInContext 对 page 的已知调用面；未覆盖的方法按报错补 no-op（预期内的红绿迭代）。 */
function fakePage() {
  return {
    url: () => 'about:blank',
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    screenshot: async () => Buffer.alloc(0),
    evaluate: async () => { throw new Error('no evaluate in fake'); },
    locator: () => { throw new Error('no locator in fake'); },
    content: async () => '<html></html>',
    close: async () => {},
  } as unknown as Page;
}

function fakeContext(page: Page) {
  return { newPage: async () => page } as unknown as BrowserContext;
}

describe('executeCaseInBrowser onFailurePage 钩子', () => {
  it('步骤失败时触发：携带失败步骤下标与当前页，结果仍为 failed', async () => {
    const page = fakePage();
    const hook = vi.fn();
    const results = await executeCaseInBrowser(
      'case-x',
      [{ order: 1, compiled: null }], // compile-missing → 确定性失败，不触 dispatch
      { reportId: 'ut-onfailure' },
      {} as Browser,
      fakeContext(page),
      undefined,
      undefined,
      undefined,
      hook,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error).toContain('compile-missing');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]![0]).toBe(page);
    expect(hook.mock.calls[0]![1]).toBe(0);
  });

  it('全部通过时不触发钩子；不传钩子行为不变', async () => {
    const page = fakePage();
    const hook = vi.fn();
    // navigate 是 fake page 可满足的动作：goto + waitForLoadState 均为 no-op。
    // 不传 targetUrl → init-goto 跳过；preflight 收到 url:null 不发真实网络请求
    //（preflight.ts:12 对空 url 跳过 goto，其余探测均有内部 catch）。
    const results = await executeCaseInBrowser(
      'case-y',
      [{ order: 1, compiled: [{ kind: 'navigate', url: 'https://example.com/' }] }],
      { reportId: 'ut-onfailure-2' },
      {} as Browser,
      fakeContext(page),
      undefined,
      undefined,
      undefined,
      hook,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('passed');
    expect(hook).not.toHaveBeenCalled();

    const noHook = await executeCaseInBrowser(
      'case-y',
      [{ order: 1, compiled: null }],
      { reportId: 'ut-onfailure-3' },
      {} as Browser,
      fakeContext(fakePage()),
    );
    expect(noHook[0]!.status).toBe('failed');
  });
});
```

- [ ] **Step 2.2: 运行确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/execute-cdp-onfailure.test.ts`
Expected: FAIL——`executeCaseInBrowser` 不接受第 9 个参数（TS 多余参数 / hook 未被调用）。若 fake page 缺方法报错，按报错给 fakePage 补对应 no-op。

- [ ] **Step 2.3: 实现**

`apps/api/src/execute/cdp.ts`：

(a) `runStepsInContext` 签名（约 680 行起）在 `caseWindow?: CaseWindow,` 后追加参数：

```ts
  /** 失败即停钩子（verify_case 用）：失败 break 前携带失败步骤下标与当前页触发；钩子抛错忽略。 */
  onFailurePage?: (page: Page, failedIndex: number) => Promise<void>,
```

(b) 步骤循环的 catch 块内，`results.push({ order: step.order, status: 'failed', ... })` 之后、`// 失败立即终止...` 注释与 `break;` 之前插入：

```ts
      if (onFailurePage) await onFailurePage(opts.page, i).catch(() => undefined);
```

(c) `executeCaseInBrowser`（约 898 行）签名末尾追加同名参数并透传（完整新签名）：

```ts
export async function executeCaseInBrowser(
  caseId: string,
  steps: Array<{
    order: number;
    assertion?: unknown;
    delayMs?: number | null;
    id?: string;
    tabRef?: string | null;
    componentKind?: string | null;
    sensitive?: boolean | null;
    compiled?: unknown[] | null;
  }>,
  ctx: ExecContext,
  browser: Browser,
  context: BrowserContext,
  targetUrl?: string,
  onPreflight?: (report: PreflightReport) => void,
  caseWindow?: CaseWindow,
  onFailurePage?: (page: Page, failedIndex: number) => Promise<void>,
): Promise<ExecStepResult[]> {
  void browser;
  return runStepsInContext(caseId, steps, ctx, context, targetUrl, onPreflight, caseWindow, onFailurePage);
}
```

- [ ] **Step 2.4: 运行测试通过 + 既有 cdp 测试不回归**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/execute-cdp-onfailure.test.ts test/execute-cdp-extract.test.ts test/failureClassifier.test.ts`
Expected: 全部 PASS。

- [ ] **Step 2.5: Commit**

```bash
git add apps/api/src/execute/cdp.ts apps/api/test/execute-cdp-onfailure.test.ts
git commit -m "feat(execute): executeCaseInBrowser 增加可选 onFailurePage 失败页钩子(verify_case 前置)"
```

---

### Task 3: 提取 pi/autoLogin.ts（loginInContext）

**Files:**
- Create: `apps/api/src/pi/autoLogin.ts`
- Modify: `apps/api/src/pi/space/tools/login.ts`
- Test: `apps/api/test/pi-auto-login.test.ts`

- [ ] **Step 3.1: 写失败的测试**

创建 `apps/api/test/pi-auto-login.test.ts`（loginInContext 只收 context 参数，类型导入无运行时依赖，纯单测、无需容器）：

```ts
import { describe, it, expect } from 'vitest';
import type { BrowserContext } from 'playwright-core';
import { loginInContext } from '../src/pi/autoLogin.js';

interface Script {
  url: string;
  passwordCount?: number;
  captchaCount?: number;
  usernameIdx?: number;
  formSubmitCount?: number;
  /** 提交后密码框数量（0=已跳离登录页 → 登录成功） */
  afterSubmitPasswordCount?: number;
}

/** 状态化 fake：locator 按 selector 关键字分发；提交动作(click/press)翻转密码框计数。 */
function fakeContextWithPage(s: Script) {
  const fills: string[] = [];
  const state = { passwordCount: s.passwordCount ?? 0 };
  const password = {
    count: async () => state.passwordCount,
    fill: async (v: string) => { fills.push(`password:${v}`); },
    press: async (k: string) => { fills.push(`press:${k}`); state.passwordCount = s.afterSubmitPasswordCount ?? 0; },
    first() { return password; },
    waitFor: async () => {},
  };
  const captcha = { count: async () => s.captchaCount ?? 0, first() { return captcha; } };
  const formSubmit = {
    count: async () => s.formSubmitCount ?? 0,
    click: async () => { state.passwordCount = s.afterSubmitPasswordCount ?? 0; },
    first() { return formSubmit; },
  };
  const generic = { count: async () => 0, fill: async (v: string) => { fills.push(`input:${v}`); }, nth() { return generic; } };
  const page = {
    url: () => s.url,
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    close: async () => {},
    locator: (sel: string) => {
      if (sel.includes('password')) return password;
      if (sel.includes('captcha')) return captcha;
      if (sel.startsWith('form:has')) return formSubmit;
      return generic;
    },
    evaluate: async () => s.usernameIdx ?? 0,
  };
  return { context: { newPage: async () => page } as unknown as BrowserContext, fills };
}

const CRED = { user: 'qa01', password: 'Secret!1', loginUrl: null };

describe('loginInContext', () => {
  it('页面无密码框且 URL 无登录提示 → not-needed', async () => {
    const { context } = fakeContextWithPage({ url: 'http://e/home' });
    await expect(loginInContext(context, CRED, 'http://e/home')).resolves.toBe('not-needed');
  });

  it('密码框存在且提交后跳离登录页 → logged-in，并填入用户名/密码', async () => {
    const { context, fills } = fakeContextWithPage({
      url: 'http://e/home',
      passwordCount: 1,
      usernameIdx: 0,
      formSubmitCount: 1,
      afterSubmitPasswordCount: 0,
    });
    await expect(loginInContext(context, CRED, 'http://e/home')).resolves.toBe('logged-in');
    expect(fills).toContain('input:qa01');
    expect(fills).toContain('password:Secret!1');
  });

  it('登录页有验证码 → 抛错（不填表）', async () => {
    const { context } = fakeContextWithPage({ url: 'http://e/login', passwordCount: 1, captchaCount: 1 });
    await expect(loginInContext(context, CRED, 'http://e/login')).rejects.toThrow(/验证码/);
  });

  it('提交后仍在登录页 → 抛自动填表登录失败', async () => {
    const { context } = fakeContextWithPage({
      url: 'http://e/home',
      passwordCount: 1,
      usernameIdx: 0,
      formSubmitCount: 1,
      afterSubmitPasswordCount: 1,
    });
    await expect(loginInContext(context, CRED, 'http://e/home')).rejects.toThrow(/自动填表登录失败/);
  });
});
```

- [ ] **Step 3.2: 运行确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/pi-auto-login.test.ts`
Expected: FAIL，`Cannot find module '../src/pi/autoLogin.js'`。

- [ ] **Step 3.3: 创建 autoLogin.ts**

创建 `apps/api/src/pi/autoLogin.ts`（`fillLoginForm`/`isLoginPage` 原样搬自 login.ts，勿改逻辑）：

```ts
/**
 * 凭证自动登录（自 pi/space/tools/login.ts 提取，perform_login 与 verify_case 共用）。
 * 在调用方持有的 BrowserContext 上完成：新开页 → goto 登录页 → 探测 → 验证码检查 → 自动填表。
 * 密码仅在本模块内部解密使用，不进返回值/日志。
 */
import type { BrowserContext, Page } from 'playwright-core';
import type { LoginCtx } from '../execute/envContext.js';

const GOTO_TIMEOUT_MS = 20_000;
const SETTLE_MS = 800;

const URL_LOGIN_HINTS = /(?:^|\/)(login|signin|sign-in|auth|unauthorized)(?:\/|$|\?)/i;

async function isLoginPage(page: Page): Promise<boolean> {
  if (URL_LOGIN_HINTS.test(page.url())) return true;
  const hasPassword = await page.locator('input[type="password"]').count().catch(() => 0);
  return hasPassword > 0;
}

/** 在登录页自动填表提交；不泄露密码到返回值或日志。 */
async function fillLoginForm(page: Page, cred: LoginCtx): Promise<boolean> {
  try {
    if (cred.loginUrl && !URL_LOGIN_HINTS.test(page.url())) {
      await page.goto(cred.loginUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
      await page.waitForTimeout(SETTLE_MS);
    }
    const password = page.locator('input[type="password"]').first();
    if ((await password.count()) === 0) return false;

    const inputs = page.locator('input');
    const usernameIdx = await page.evaluate<number>(`(() => {
      const els = Array.from(document.querySelectorAll('input'));
      const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
      const pi = els.findIndex((el) => el.type === 'password' && visible(el));
      if (pi < 0) return -1;
      for (let i = pi - 1; i >= 0; i--) {
        const el = els[i];
        const t = (el.type || 'text').toLowerCase();
        if (['text', 'email', 'tel', 'username'].includes(t) && visible(el)) return i;
      }
      return -1;
    })()`);
    if (usernameIdx < 0) return false;

    await inputs.nth(usernameIdx).fill(cred.user);
    await password.fill(cred.password);

    const formSubmit = page
      .locator('form:has(input[type="password"]) button[type="submit"], form:has(input[type="password"]) input[type="submit"]')
      .first();
    if ((await formSubmit.count()) > 0) {
      await formSubmit.click({ timeout: 5000 });
    } else {
      const pageSubmit = page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
      if ((await pageSubmit.count()) > 0) {
        await pageSubmit.click({ timeout: 5000 });
      } else {
        await password.press('Enter');
      }
    }
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
    return !(await isLoginPage(page));
  } catch {
    return false;
  }
}

/** 在 context 上完成登录。返回 'logged-in'（本次完成登录）或 'not-needed'（无需登录/已有登录态）。
 *  失败抛错（文案可直接回给 AI/用户）。结束后关闭登录页；登录态(cookie/localStorage)留在 context。 */
export async function loginInContext(
  context: BrowserContext,
  cred: LoginCtx,
  startUrl: string,
): Promise<'logged-in' | 'not-needed'> {
  const page = await context.newPage();
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(SETTLE_MS);
    // 部分登录页为客户端渲染/重定向，初次判定可能为 false；短暂等待密码框出现以避免误判
    await Promise.race([
      page.waitForTimeout(5000),
      page.locator('input[type="password"]').first().waitFor({ state: 'attached', timeout: 5000 }),
    ]).catch(() => undefined);
    if (!(await isLoginPage(page))) return 'not-needed';
    const captcha = await page
      .locator('input#auth-captcha, input[name="captcha"], input[id*="captcha" i], input[placeholder*="验证码" i]')
      .first()
      .count() > 0;
    if (captcha) throw new Error('登录页需要验证码，无法自动完成登录');
    const ok = await fillLoginForm(page, cred);
    if (!ok) throw new Error('自动填表登录失败（未找到用户名/密码输入框或提交后仍在登录页）');
    return 'logged-in';
  } finally {
    await page.close().catch(() => undefined);
  }
}
```

注意 fake 分发规则与 `fillLoginForm` 的 selector 用法对应：`'form:has(...)'` 以 `form:has` 开头、`'button[type="submit"]:visible...'` 走 generic（count 0 → password.press('Enter') 兜底，press 同样翻转状态）。

- [ ] **Step 3.4: 运行测试通过**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/pi-auto-login.test.ts`
Expected: 4 个用例 PASS。

- [ ] **Step 3.5: 重构 login.ts 复用 loginInContext**

`apps/api/src/pi/space/tools/login.ts`：删除 `GOTO_TIMEOUT_MS`/`SETTLE_MS`/`URL_LOGIN_HINTS`/`isLoginPage`/`fillLoginForm`（第 8-66 行），把首部 `import { chromium, type Page } from 'playwright-core';` 改为 `import { chromium } from 'playwright-core';`，并新增：

```ts
import { loginInContext } from '../../autoLogin.js';
```

`perform_login` 的 `execute` 整体替换为：

```ts
      execute: async (input) => {
        const { url } = input as { url?: string };
        let envCtx: Awaited<ReturnType<typeof resolveEnv>> | undefined;
        try {
          envCtx = await resolveEnv({ versionId: ctx.versionId }, { expectedProjectId: ctx.projectId });
          if (!envCtx.login) {
            return { ok: false, error: '当前默认环境未配置 login 凭据' };
          }
          const targetUrl = url || envCtx.login.loginUrl || envCtx.baseUrl || '';
          if (!targetUrl) {
            return { ok: false, error: '缺少登录目标 URL（未传 url，且环境未配置 loginUrl/baseUrl）' };
          }
          const browser = await chromium.launch({
            headless: true,
            executablePath: process.env.CHROMIUM_PATH || undefined,
          });
          try {
            const context = await browser.newContext({ ignoreHTTPSErrors: true });
            const status = await loginInContext(context, envCtx.login, targetUrl);
            const storageState = await context.storageState();
            return {
              ok: true,
              data: JSON.stringify({
                storageState,
                message: status === 'logged-in' ? '登录成功' : '页面无需登录或已有登录态',
              }),
            };
          } finally {
            await browser.close().catch(() => {});
          }
        } catch (e) {
          return { ok: false, error: `登录失败:${(e as Error).message}` };
        } finally {
          if (envCtx) await envCtx.close().catch(() => {});
        }
      },
```

已知行为差异（可接受，无既有测试锁定文案）：验证码/填表失败现在统一带 `登录失败:` 前缀；成功文案与 storageState 语义不变。

- [ ] **Step 3.6: typecheck + 相关测试**

Run: `cd apps/api && npm run typecheck && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/pi-auto-login.test.ts test/pi-inspect-page.test.ts`
Expected: typecheck 0 错误；测试 PASS。

- [ ] **Step 3.7: Commit**

```bash
git add apps/api/src/pi/autoLogin.ts apps/api/src/pi/space/tools/login.ts apps/api/test/pi-auto-login.test.ts
git commit -m "refactor(pi): 提取 loginInContext 凭证自动登录,perform_login 复用(verify_case 前置)"
```

---

### Task 4: verify_case 工具 + 注册 + 集成测试

**Files:**
- Create: `apps/api/src/pi/space/tools/verifyCase.ts`
- Modify: `apps/api/src/pi/space/tools/index.ts`
- Test: `apps/api/test/pi-verify-case.test.ts`

- [ ] **Step 4.1: 写失败的测试**

创建 `apps/api/test/pi-verify-case.test.ts`（mock 三件套：playwright-core / autoLogin / cdp 的 executeCaseInBrowser；真实 db + resolveEnv 走 testcontainers）：

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

// executeCaseInBrowser / loginInContext 打桩：工具测试聚焦编排与结果组装。
vi.mock('../src/execute/cdp.js', () => ({ executeCaseInBrowser: vi.fn() }));
vi.mock('../src/pi/autoLogin.js', () => ({ loginInContext: vi.fn() }));
vi.mock('playwright-core', () => ({
  chromium: {
    launch: async () => ({
      newContext: async () => ({ __fake: 'context' }),
      close: async () => {},
    }),
  },
}));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let projectId: string;
let groupId: string;
let versionId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await pool.query(`TRUNCATE test_steps, test_cases, test_environments, environment_objects,
    requirements, "groups", projects, project_versions, ai_threads, ai_workspace_state
    RESTART IDENTITY CASCADE`);
  const seed = await seedProject(pool);
  projectId = seed.projectId;
  groupId = seed.groupId;
  versionId = seed.versionId;
  // 每个用例都要求环境可解析（resolveEnv 需要）：默认环境无 login 凭据
  await pool.query(
    `INSERT INTO test_environments(project_id, name, is_default, base_url) VALUES ($1, '默认环境', true, 'http://env.example')`,
    [projectId],
  );
});

async function seedCase(opts: { platform?: string; url?: string | null; steps?: unknown[] }): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO test_cases(id, group_id, version_id, title, url, platform) VALUES ($1, $2, $3, '验证用例', $4, $5)`,
    [id, groupId, versionId, opts.url ?? 'http://env.example/page', opts.platform ?? 'web'],
  );
  for (let i = 0; i < (opts.steps ?? []).length; i++) {
    await pool.query(
      `INSERT INTO test_steps(case_id, "order", source, compiled) VALUES ($1, $2, 'ai', $3::jsonb)`,
      [id, i + 1, JSON.stringify(opts.steps![i])],
    );
  }
  return id;
}

async function seedLoginObject(): Promise<void> {
  const { encrypt } = await import('../src/lib/secret-crypto.js');
  const enc = encrypt('Passw0rd!');
  // 先降级 beforeEach 插入的默认环境（唯一部分索引 test_environments_project_default_uq），再插新默认
  await pool.query(`UPDATE test_environments SET is_default = false WHERE project_id = $1`, [projectId]);
  const env = await pool.query(
    `INSERT INTO test_environments(project_id, name, is_default, base_url) VALUES ($1, '登录环境', true, 'http://env.example') RETURNING id`,
    [projectId],
  );
  const payload = {
    user: 'qa01',
    loginUrl: 'http://env.example/login',
    secret: { c: enc.ciphertext.toString('base64'), i: enc.iv.toString('base64'), t: enc.tag.toString('base64') },
  };
  await pool.query(
    `INSERT INTO environment_objects(environment_id, object_type, label, payload, is_default) VALUES ($1, 'login', '默认', $2::jsonb, true)`,
    [env.rows[0]!.id, JSON.stringify(payload)],
  );
}

function toolCtx() {
  return { threadId: 't1', versionId, projectId, repo: { cwd: null, issue: null, noRepo: false }, emit: () => {} };
}

const CLICK_COMPILED = [{ kind: 'click', locator: [{ strategy: 'css', value: '#missing' }] }];

describe('verify_case 前置校验', () => {
  it('用例不存在 → ok:false', async () => {
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId: randomUUID() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('用例不存在');
  });

  it('移动端用例 → ok:false', async () => {
    const caseId = await seedCase({ platform: 'mobile', steps: CLICK_COMPILED });
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('移动端');
  });

  it('无步骤 → ok:false', async () => {
    const caseId = await seedCase({ steps: [] });
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('没有可验证的步骤');
  });
});

describe('verify_case 执行编排', () => {
  it('无 login 凭据：跳过登录直跑，全部通过 → result passed', async () => {
    const caseId = await seedCase({ steps: CLICK_COMPILED });
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    const { loginInContext } = await import('../src/pi/autoLogin.js');
    vi.mocked(executeCaseInBrowser).mockResolvedValue([
      { order: 1, status: 'passed', durationMs: 12, hitLocator: { kind: 'css', value: '#missing' } },
    ] as never);
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('passed');
      expect(data.login).toBe('not-needed');
      expect(data.steps).toHaveLength(1);
    }
    expect(loginInContext).not.toHaveBeenCalled();
    // 编排契约：verify- 前缀 reportId、expectedOutcome null、第 9 参为失败钩子
    const call = vi.mocked(executeCaseInBrowser).mock.calls[0]!;
    expect(call[2].reportId).toMatch(/^verify-/);
    expect(call[2].expectedOutcome).toBeNull();
    expect(call[5]).toBe('http://env.example/page');
    expect(call[8]).toBeTypeOf('function');
  });

  it('失败即停：failure 结构含失败动作/归因/失败页元素清单', async () => {
    const caseId = await seedCase({
      steps: [CLICK_COMPILED, [{ kind: 'assertText', locator: [{ strategy: 'css', value: '.msg' }], value: '成功' }]],
    });
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    vi.mocked(executeCaseInBrowser).mockImplementation(async (...args: unknown[]) => {
      // 模拟引擎：先触发失败钩子（携带失败页），再返回失败结果
      const onFailurePage = args[8] as (p: unknown, i: number) => Promise<void>;
      await onFailurePage(
        {
          url: () => 'http://env.example/list',
          evaluate: async () => ({ title: '列表页', elements: ['- button#del "删除" 选择器: #del'], truncated: false }),
        },
        1,
      );
      return [
        { order: 1, status: 'passed', durationMs: 10 },
        { order: 2, status: 'failed', durationMs: 5000, error: '元素未找到: .msg', failureReason: 'ElementNotFound', humanMessage: '未找到待断言元素', screenshot: '/screenshots/verify-x/step-2.png' },
      ] as never;
    });
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = JSON.parse(r.data!);
      expect(data.result).toBe('failed');
      expect(data.failure.stepOrder).toBe(2);
      expect(data.failure.action).toEqual([{ kind: 'assertText', locator: [{ strategy: 'css', value: '.msg' }], value: '成功' }]);
      expect(data.failure.failureReason).toBe('ElementNotFound');
      expect(data.failure.page.url).toBe('http://env.example/list');
      expect(data.failure.page.elements[0]).toContain('button#del');
      expect(typeof data.failure.note).toBe('string');
    }
  });

  it('配置 login 凭据：loginInContext 被调用(明文密码不出现在返回中) → logged-in', async () => {
    await seedLoginObject();
    const caseId = await seedCase({ steps: CLICK_COMPILED });
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    const { loginInContext } = await import('../src/pi/autoLogin.js');
    vi.mocked(loginInContext).mockResolvedValue('logged-in');
    vi.mocked(executeCaseInBrowser).mockResolvedValue([{ order: 1, status: 'passed', durationMs: 5 }] as never);
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(true);
    const call = vi.mocked(loginInContext).mock.calls[0]!;
    expect(call[1]).toMatchObject({ user: 'qa01', password: 'Passw0rd!', loginUrl: 'http://env.example/login' });
    expect(call[2]).toBe('http://env.example/login');
    if (r.ok) expect(JSON.parse(r.data!).login).toBe('logged-in');
    if (r.ok) expect(r.data).not.toContain('Passw0rd!');
  });

  it('loginInContext 抛错 → ok:false 登录失败', async () => {
    await seedLoginObject();
    const caseId = await seedCase({ steps: CLICK_COMPILED });
    const { executeCaseInBrowser } = await import('../src/execute/cdp.js');
    const { loginInContext } = await import('../src/pi/autoLogin.js');
    vi.mocked(loginInContext).mockRejectedValue(new Error('自动填表登录失败（未找到用户名/密码输入框或提交后仍在登录页）'));
    const { buildVerifyCaseTool } = await import('../src/pi/space/tools/verifyCase.js');
    const r = await buildVerifyCaseTool(toolCtx()).execute({ caseId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('登录失败');
    expect(executeCaseInBrowser).not.toHaveBeenCalled();
  });
});

describe('verify_case 注册', () => {
  it('buildSpaceTools 包含 verify_case', async () => {
    const { buildSpaceTools } = await import('../src/pi/space/tools/index.js');
    const names = buildSpaceTools(toolCtx()).map((t) => t.name);
    expect(names).toContain('verify_case');
  });
});
```

- [ ] **Step 4.2: 运行确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/pi-verify-case.test.ts`
Expected: FAIL，`Cannot find module .../verifyCase.js`。

- [ ] **Step 4.3: 实现 verifyCase.ts**

创建 `apps/api/src/pi/space/tools/verifyCase.ts`：

```ts
/**
 * verify_case 工具：生成/修改用例后在真实被测系统上实测验证（spec: 2026-10-09-verify-case-design）。
 * 编排：读用例 → resolveEnv → (可选)凭证自动登录 → executeCaseInBrowser 失败即停
 * → 失败页元素清单（复用 inspectPage 提取器）→ 结构化反馈供 agent 自修正 compiled。
 * 验证不落 report（结果只回对话上下文）；副作用与正式执行一致（spec 已确认接受）。
 */
import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { testCases, testSteps } from '../../db/schema.js';
import { executeCaseInBrowser } from '../../../execute/cdp.js';
import type { ExecContext, ExecStepResult } from '../../../execute/cdp.js';
import { resolveEnv } from '../../../execute/envContext.js';
import { resolveCaseUrl } from '../../../lib/resolve-url.js';
import { loginInContext } from '../../autoLogin.js';
import { extractPageElements } from '../../inspectPage.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

const VERIFY_TIMEOUT_MS = 120_000;

export function buildVerifyCaseTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'verify_case',
    description:
      '在真实被测系统上逐步验证用例的 compiled 步骤可执行性：自动用环境 login 凭据登录（未配置则跳过登录直跑），失败即停并返回失败步骤详情与失败页可交互元素清单。依据清单修正 locator 后可再次调用（同一用例建议最多 3 轮）。验证会产生真实副作用（与正式执行一致）。',
    parameters: Type.Object({
      caseId: Type.String({ minLength: 1 }),
    }),
    promptGuidelines: [
      '含 compiled 步骤的用例创建/修改后，环境可用时调用 verify_case 实测验证，不要只凭源码分析就声称用例可运行。',
      'verify_case 失败时：读取 failure.page.elements，只能用清单中真实存在的选择器修正对应步骤的 locator/动作，禁止臆造；修正（upsert_case/stage_case_op）后重新验证。',
      '同一用例验证最多重试 3 轮；仍失败则保留用例，如实向用户说明失败步骤与原因，不要无限循环。',
      '环境未配置 login 凭据而验证因登录页失败时，引导用户到项目环境页配置 login 凭据，不要伪造登录步骤。',
    ],
    execute: async (input) => {
      const { caseId } = input as { caseId: string };
      // 最外层兜底：db 查询 / chromium launch / resolveCaseUrl 等未预料异常一律转 ok:false
      // （ToolExecutor 契约：不向 agent 循环抛异常）
      try {
      // ── 前置校验（不启动浏览器）──
      const caseRow = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
      if (!caseRow) return { ok: false, error: `用例不存在: ${caseId}` };
      if (caseRow.platform === 'mobile') {
        return { ok: false, error: 'verify_case 暂不支持移动端用例（v1 仅支持 web）' };
      }
      const steps = await db
        .select()
        .from(testSteps)
        .where(eq(testSteps.caseId, caseId))
        .orderBy(asc(testSteps.order));
      if (steps.length === 0) return { ok: false, error: '用例没有可验证的步骤' };

      // ── 环境解析（case defaultEnv > version link > 项目默认）──
      let envCtx: Awaited<ReturnType<typeof resolveEnv>>;
      try {
        envCtx = await resolveEnv(
          { caseEnvId: caseRow.defaultEnvId ?? null, versionId: caseRow.versionId ?? ctx.versionId },
          { expectedProjectId: ctx.projectId },
        );
      } catch (e) {
        const errName = e instanceof Error ? e.name : '';
        if (errName === 'EnvMissing') return { ok: false, error: '缺少环境配置，请到项目环境页配置默认环境' };
        if (errName === 'EnvProjectMismatch') return { ok: false, error: '环境所属项目与当前用例不匹配' };
        return { ok: false, error: `环境解析失败: ${(e as Error).message}` };
      }

      const resolvedUrl = await resolveCaseUrl(caseRow, { envBaseUrl: envCtx.baseUrl });
      const targetUrl = resolvedUrl && /^https?:\/\//.test(resolvedUrl) ? resolvedUrl : undefined;

      // ── 浏览器 + (可选)登录 → 逐步执行（失败即停）──
      let browser: Browser | undefined;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (browser) void browser.close().catch(() => undefined);
      }, VERIFY_TIMEOUT_MS);
      try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
        const context = await browser.newContext({
          ignoreHTTPSErrors: true,
          viewport: { width: 1280, height: 800 },
        });

        let login: 'logged-in' | 'not-needed' = 'not-needed';
        if (envCtx.login) {
          const loginUrl = envCtx.login.loginUrl || envCtx.baseUrl || '';
          if (!loginUrl) {
            return { ok: false, error: '环境未配置 loginUrl/baseUrl，无法自动登录；请到环境页补全 login 凭据的登录页地址' };
          }
          try {
            login = await loginInContext(context, envCtx.login, loginUrl);
          } catch (e) {
            return { ok: false, error: `登录失败: ${(e as Error).message}` };
          }
        }

        let failurePage: Awaited<ReturnType<typeof extractPageElements>> | null = null;
        const stepInput = steps.map((s) => ({
          order: s.order,
          assertion: s.assertion,
          delayMs: s.delayMs,
          id: s.id,
          tabRef: s.tabRef,
          componentKind: s.componentKind,
          sensitive: s.sensitive,
          compiled: s.compiled as unknown[] | null | undefined,
        }));
        const execCtx: ExecContext = {
          reportId: `verify-${randomUUID()}`,
          projectId: ctx.projectId,
          envCtx,
          expectedOutcome: null, // v1 跳过用例级 vision 判定
          caseTitle: caseRow.title,
          caseUrl: caseRow.url ?? null,
        };
        let stepResults: ExecStepResult[];
        try {
          stepResults = await executeCaseInBrowser(
            caseId,
            stepInput,
            execCtx,
            browser,
            context,
            targetUrl,
            undefined,
            undefined,
            async (page) => {
              failurePage = await extractPageElements(page).catch(() => null);
            },
          );
        } catch (e) {
          if (timedOut) return { ok: false, error: `验证超时（${VERIFY_TIMEOUT_MS / 1000}s）已终止` };
          return { ok: false, error: `验证执行失败: ${(e as Error).message}` };
        }

        // ── 结果组装（成功精简、失败信息密集）──
        const stepsSummary = stepResults.map((r) => ({
          order: r.order,
          status: r.status,
          durationMs: r.durationMs,
          ...(r.hitLocator ? { hitLocator: r.hitLocator } : {}),
        }));
        const failedIndex = stepResults.findIndex((r) => r.status === 'failed');
        if (failedIndex < 0) {
          return {
            ok: true,
            data: JSON.stringify({
              result: 'passed',
              caseId,
              envId: envCtx.envId,
              targetUrl: targetUrl ?? null,
              login,
              steps: stepsSummary,
            }),
          };
        }
        const failed = stepResults[failedIndex]!;
        const failedStep = stepInput[failedIndex];
        return {
          ok: true,
          data: JSON.stringify({
            result: 'failed',
            caseId,
            envId: envCtx.envId,
            targetUrl: targetUrl ?? null,
            login,
            steps: stepsSummary,
            failure: {
              stepOrder: failed.order,
              action: failedStep?.compiled ?? null,
              error: failed.error ?? null,
              failureReason: failed.failureReason ?? null,
              humanMessage: failed.humanMessage ?? null,
              screenshot: failed.screenshot ?? null,
              page: failurePage,
              note: 'page.elements 为失败页当前可见的可交互元素；修正 locator 只能使用其中真实存在的选择器。快照不含操作后才出现的元素。',
            },
          }),
        };
      } finally {
        clearTimeout(timer);
        if (browser) await browser.close().catch(() => undefined);
        await envCtx.close().catch(() => undefined);
      }
      } catch (e) {
        return { ok: false, error: `验证失败: ${(e as Error).message}` };
      }
    },
  };
}
```

（缩进说明：为减少 diff 噪音，主体保持原缩进，仅用 try { ... } catch 包裹；若偏好规范缩进可在实现时整体缩进一层，eslint --fix 处理。）

- [ ] **Step 4.4: 注册到 buildSpaceTools**

`apps/api/src/pi/space/tools/index.ts`：import 区新增（`buildLoginTools` import 之后）：

```ts
import { buildVerifyCaseTool } from './verifyCase.js';
```

`buildSpaceTools` 内 `tools.push(...buildLoginTools(ctx));` 之后新增一行：

```ts
  tools.push(buildVerifyCaseTool(ctx));
```

- [ ] **Step 4.5: 运行测试通过**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/pi-verify-case.test.ts`
Expected: 8 个用例全部 PASS。

- [ ] **Step 4.6: Commit**

```bash
git add apps/api/src/pi/space/tools/verifyCase.ts apps/api/src/pi/space/tools/index.ts apps/api/test/pi-verify-case.test.ts
git commit -m "feat(pi): 版本空间助手新增 verify_case 实测验证工具(登录+失败即停+失败页清单反馈)"
```

---

### Task 5: 全量回归 + 手工验收

- [ ] **Step 5.1: typecheck + lint**

Run: `cd apps/api && npm run typecheck && npm run lint`
Expected: 0 error。

- [ ] **Step 5.2: 全量测试**

Run: `cd apps/api && npm test`
Expected: 全部 PASS（含既有套件；耗时长，后台跑）。

- [ ] **Step 5.3: 手工验收（真实环境，需用户配合）**

1. `cd apps/api && npm run dev` 启动；项目环境页确认默认环境已配置 login 凭据（user/loginUrl/密码）。
2. 打开版本空间 AI 助手，要求"基于页面 xxx 创建一条包含点击/断言步骤的用例"。
3. 确认 agent 在 upsert_case 后自主调用 verify_case；观察返回的 steps/failure 结构。
4. 构造一个错误 locator（或让 AI 生成），确认失败页 elements 清单返回且 agent 依据清单修正后第二轮验证通过。
5. 确认密码没有出现在对话输出中。

- [ ] **Step 5.4: 若验收或回归产生修复，提交修复**

```bash
git add <修复文件>
git commit -m "fix(pi): verify_case 验收修复"
```

（无修复则跳过。）

- [ ] **Step 5.5: 提醒用户恢复 stash（Task 0 暂存的 execute/ WIP）**

告知用户：`git stash pop` 恢复此前暂存的 execute/ 改动；cdp.ts 可能有冲突（我们改了签名与 catch 块），冲突处保留双方（onFailurePage 参数 + 用户 WIP）。**不要自动执行 pop。**
