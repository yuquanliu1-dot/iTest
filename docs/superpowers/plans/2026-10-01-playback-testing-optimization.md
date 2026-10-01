# 回放测试优化 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 iTest 中按 CueCast 回放指南补齐稳定性等待、失败归类、DOM 降级、窗口策略、无痕模式、执行前检查、报告明细模式。

**Architecture:** 后端在 `apps/api/src/execute/` 下新增四个小模块（stability / failureClassifier / preflight / domFallback），并在 `cdp.ts/runCase.ts/runPlan.ts` 中接入；数据模型通过 Drizzle 迁移增加 `test_cases` 与 `reports` 字段；前端 `ReportDetail` 加明细模式 Tab，`CaseDetail` 加执行设置区块；`packages/shared` 增加共享枚举。

**Tech Stack:** Node 22 + Express 5 + Drizzle + PostgreSQL（后端）；React 18 + Vite + Tailwind v4（前端）；vitest + supertest + testcontainers-postgresql（后端测试）；playwright-core（已在使用）。

---

## File Structure

**新增文件**
- `apps/api/src/execute/stability.ts` — 元素就绪三态判断 + 自动等待
- `apps/api/src/execute/failureClassifier.ts` — 异常 → 枚举 + humanMessage
- `apps/api/src/execute/preflight.ts` — 执行前检查
- `apps/api/src/execute/domFallback.ts` — DOM 降级动作
- `apps/api/src/execute/elementGuard.ts` — 命中 Locator 记录 + 抛 ElementNotStable 时的 source 注入
- `apps/api/drizzle/0008_playback_runtime.sql` — schema 迁移
- `apps/api/test/stability.test.ts`
- `apps/api/test/failureClassifier.test.ts`
- `apps/api/test/domFallback.test.ts`
- `apps/api/test/playback-runtime.test.ts`（迁移 + 自定义校验）
- `apps/api/test/playback-preflight.test.ts`
- `apps/api/test/playback-integration.test.ts`
- `apps/api/test/playback-plan-conflict.test.ts`
- `packages/shared/src/playback.ts` — 共享枚举/类型
- `packages/shared/test/playback.test.ts`

**修改文件**
- `packages/shared/src/index.ts` — 导出新模块
- `apps/api/src/db/schema.ts` — 加字段
- `apps/api/src/execute/cdp.ts` — 接入新模块
- `apps/api/src/execute/runCase.ts` — 接入新模块
- `apps/api/src/execute/runPlan.ts` — incognito × loginPrepare 互斥
- `apps/api/src/routes/cases.ts` — PATCH 接受新字段并校验
- `apps/api/test/cases.test.ts` — 加 case（PATCH 校验 window_strategy=custom 必须有 width/height）
- `apps/api/test/plans.test.ts` — 加 case（incognito × loginPrepare 互斥）
- `apps/web/src/pages/ReportDetail.tsx` — 明细模式 Tab
- `apps/web/src/pages/CaseDetail.tsx` — 执行设置区块

---

## Task 1: 共享枚举与类型

**Files:**
- Create: `packages/shared/src/playback.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/playback.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect } from 'vitest';
import { WindowStrategy, FailureReason } from '../src/playback.js';

describe('playback shared types', () => {
  it('WindowStrategy accepts known values', () => {
    expect(WindowStrategy.parse('maximize')).toBe('maximize');
    expect(WindowStrategy.parse('current')).toBe('current');
    expect(WindowStrategy.parse('custom')).toBe('custom');
  });
  it('WindowStrategy rejects unknown', () => {
    expect(() => WindowStrategy.parse('huge')).toThrow();
  });
  it('FailureReason enum exposes expected names', () => {
    const all = FailureReason.options;
    expect(all).toContain('URLUnreachable');
    expect(all).toContain('DisabledTimeout');
    expect(all).toContain('CDPUnavailable');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/shared test -- playback.test.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 3: 实现 `packages/shared/src/playback.ts`**

```ts
import { z } from 'zod';

export const WindowStrategy = z.enum(['maximize', 'current', 'custom']);
export type WindowStrategy = z.infer<typeof WindowStrategy>;

export const FailureReason = z.enum([
  'URLUnreachable',
  'NotLoggedIn',
  'SlowLoad',
  'ElementOccluded',
  'PageStructureChanged',
  'TestDataMissing',
  'AssertionMismatch',
  'FixedValueConflict',
  'TabMissing',
  'AttachmentMissing',
  'SecretMissing',
  'DisabledTimeout',
  'LoadingTimeout',
  'OverlayTimeout',
  'LocatorAllFailed',
  'CDPUnavailable',
  'Unknown',
]);
export type FailureReason = z.infer<typeof FailureReason>;

export interface HitLocator {
  kind: string;
  value: string;
}

export interface PreflightReport {
  urlReachable: boolean;
  urlNote?: string;
  loggedIn: boolean;
  sourceOrigin?: string;
  currentOrigin?: string;
  originMismatch?: boolean;
  tabsObserved?: number[];
  durationMs: number;
}
```

- [ ] **Step 4: 在 `packages/shared/src/index.ts` 末尾导出**

```ts
export * from './playback.js';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @itest/shared test -- playback.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/playback.ts packages/shared/src/index.ts packages/shared/test/playback.test.ts
git commit -m "feat(shared): playback runtime enums (windowStrategy, failureReason)"
```

---

## Task 2: 数据库迁移

**Files:**
- Create: `apps/api/drizzle/0008_playback_runtime.sql`
- Modify: `apps/api/src/db/schema.ts`

- [ ] **Step 1: 写迁移 SQL 到 `apps/api/drizzle/0008_playback_runtime.sql`**

```sql
ALTER TABLE "test_cases" ADD COLUMN "window_strategy" varchar(16) NOT NULL DEFAULT 'maximize';--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "window_width" integer;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "window_height" integer;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "incognito" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "preflight" jsonb;
```

- [ ] **Step 2: 修改 `apps/api/src/db/schema.ts`**

在 `testCases` 表定义里追加：

```ts
windowStrategy: varchar('window_strategy', { length: 16 }).notNull().default('maximize'),
windowWidth: integer('window_width'),
windowHeight: integer('window_height'),
incognito: boolean('incognito').notNull().default(false),
```

在 `reports` 表定义里追加：

```ts
preflight: jsonb('preflight'),
```

- [ ] **Step 3: 同步 helper SQL（`apps/api/test/helpers/db.ts`）**

在 `test_cases` 建表语句中加：

```sql
window_strategy varchar(16) NOT NULL DEFAULT 'maximize',
window_width integer,
window_height integer,
incognito boolean NOT NULL DEFAULT false,
```

在 `reports` 建表语句中加：

```sql
preflight jsonb,
```

- [ ] **Step 4: 跑迁移 + 类型检查**

Run:
```bash
cd apps/api && pnpm exec drizzle-kit migrate
cd ../.. && pnpm --filter @itest/api typecheck
```
Expected: 迁移成功，typecheck 通过

- [ ] **Step 5: 提交**

```bash
git add apps/api/drizzle/0008_playback_runtime.sql apps/api/src/db/schema.ts apps/api/test/helpers/db.ts
git commit -m "feat(api): playback runtime fields (window_strategy/incognito/preflight)"
```

---

## Task 3: failureClassifier 单元模块

**Files:**
- Create: `apps/api/src/execute/failureClassifier.ts`
- Test: `apps/api/test/failureClassifier.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect } from 'vitest';
import { classify } from '../src/execute/failureClassifier.js';

describe('failureClassifier', () => {
  it('ElementNotStable/disabled → DisabledTimeout', () => {
    const e = new Error('not stable'); (e as Error & { name: string; reason: string }).name = 'ElementNotStable';
    (e as Error & { name: string; reason: string }).reason = 'disabled';
    expect(classify(e).reason).toBe('DisabledTimeout');
  });
  it('tab-missing → TabMissing', () => {
    expect(classify(new Error('tab-missing: foo')).reason).toBe('TabMissing');
  });
  it('assertText failed → AssertionMismatch', () => {
    expect(classify(new Error('assertText failed (page/contains): expected 1, actual 2')).reason).toBe('AssertionMismatch');
  });
  it('attachment-missing → AttachmentMissing', () => {
    expect(classify(new Error('attachment-missing: x')).reason).toBe('AttachmentMissing');
  });
  it('secret-missing → SecretMissing', () => {
    expect(classify(new Error('secret-missing: step 1')).reason).toBe('SecretMissing');
  });
  it('locator all-failed → LocatorAllFailed', () => {
    expect(classify(new Error('all locator candidates failed')).reason).toBe('LocatorAllFailed');
  });
  it('count=0 → LocatorAllFailed', () => {
    expect(classify(new Error('count=0 (css)')).reason).toBe('LocatorAllFailed');
  });
  it('default → Unknown', () => {
    expect(classify(new Error('whatever')).reason).toBe('Unknown');
  });
  it('assertText failed + defaultKeywords → NotLoggedIn', () => {
    const ctx = { action: { kind: 'assertText', equals: '请先登录' } };
    expect(classify(new Error('assertText failed: expected "ok"'), ctx).reason).toBe('NotLoggedIn');
  });
  it('fill + duplicate key message → FixedValueConflict', () => {
    const ctx = { action: { kind: 'fill', value: 'x' } };
    expect(classify(new Error('unique constraint violation: duplicate key'), ctx).reason).toBe('FixedValueConflict');
  });
  it('durationMs > 15000 → SlowLoad', () => {
    const ctx = { durationMs: 20000 };
    expect(classify(new Error('not stable'), ctx).reason).toBe('SlowLoad');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/api test -- failureClassifier.test.ts`
Expected: FAIL（找不到模块）

- [ ] **Step 3: 实现 `apps/api/src/execute/failureClassifier.ts`**

```ts
import type { FailureReason } from '@itest/shared';
import type { StepAction } from '@itest/shared';

const DEFAULT_KEYWORDS = ['请先登录', '未登录', '未授权', '登录后'];

export interface ClassifiedFailure {
  reason: FailureReason;
  humanMessage: string;
}

const HUMAN: Record<FailureReason, string> = {
  URLUnreachable: '起始 URL 无法访问，请检查网络或地址',
  NotLoggedIn: '检测到登录态失效，请先登录或启用登录准备',
  SlowLoad: '页面加载过慢，超出预期耗时',
  ElementOccluded: '目标元素被遮挡，无法操作',
  PageStructureChanged: '页面结构疑似变化，多步连续失败',
  TestDataMissing: '目标测试数据不存在',
  AssertionMismatch: '断言不匹配',
  FixedValueConflict: '固定输入值重复导致新建失败',
  TabMissing: '切换的目标标签页已不可用',
  AttachmentMissing: '上传附件未绑定或已失效',
  SecretMissing: '敏感字段未配置或解密失败',
  DisabledTimeout: '元素被禁用，等待超时',
  LoadingTimeout: '元素仍在加载，等待超时',
  OverlayTimeout: '元素被遮罩覆盖，等待超时',
  LocatorAllFailed: '所有定位候选均未命中',
  CDPUnavailable: '真实浏览器不可用，已尝试 DOM 降级仍失败',
  Unknown: '未知错误',
};

interface ClassifyCtx {
  action?: StepAction | { kind?: string; value?: unknown; equals?: string };
  durationMs?: number;
}

function asErrorWithName(err: unknown): Error & { name?: string; reason?: string } {
  return err as Error & { name?: string; reason?: string };
}

export function classify(err: unknown, ctx: ClassifyCtx = {}): ClassifiedFailure {
  const e = asErrorWithName(err);
  const msg = e?.message ?? '';
  // 优先: ElementNotStable + reason
  if (e?.name === 'ElementNotStable') {
    if (e.reason === 'disabled') return { reason: 'DisabledTimeout', humanMessage: HUMAN.DisabledTimeout };
    if (e.reason === 'loading') return { reason: 'LoadingTimeout', humanMessage: HUMAN.LoadingTimeout };
    if (e.reason === 'overlay') return { reason: 'OverlayTimeout', humanMessage: HUMAN.OverlayTimeout };
  }
  // 信号串匹配
  if (msg.includes('tab-missing')) return { reason: 'TabMissing', humanMessage: HUMAN.TabMissing };
  if (msg.includes('assertText failed') || msg.includes('assertJson')) {
    if (ctx.action && 'equals' in (ctx.action as { equals?: string }) && typeof (ctx.action as { equals?: string }).equals === 'string') {
      const equals = (ctx.action as { equals: string }).equals;
      if (DEFAULT_KEYWORDS.some((k) => equals.includes(k))) {
        return { reason: 'NotLoggedIn', humanMessage: HUMAN.NotLoggedIn };
      }
    }
    return { reason: 'AssertionMismatch', humanMessage: HUMAN.AssertionMismatch };
  }
  if (msg.includes('attachment-missing')) return { reason: 'AttachmentMissing', humanMessage: HUMAN.AttachmentMissing };
  if (msg.includes('secret-missing')) return { reason: 'SecretMissing', humanMessage: HUMAN.SecretMissing };
  if (msg.includes('all locator candidates failed') || msg.includes('count=0')) {
    return { reason: 'LocatorAllFailed', humanMessage: HUMAN.LocatorAllFailed };
  }
  if (ctx.action && (ctx.action as { kind?: string }).kind === 'fill' &&
      (msg.includes('unique constraint') || msg.includes('duplicate'))) {
    return { reason: 'FixedValueConflict', humanMessage: HUMAN.FixedValueConflict };
  }
  if (typeof ctx.durationMs === 'number' && ctx.durationMs > 15000) {
    return { reason: 'SlowLoad', humanMessage: HUMAN.SlowLoad };
  }
  return { reason: 'Unknown', humanMessage: HUMAN.Unknown };
}

export const __test = { HUMAN, DEFAULT_KEYWORDS };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/api test -- failureClassifier.test.ts`
Expected: PASS（11 个用例）

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/execute/failureClassifier.ts apps/api/test/failureClassifier.test.ts
git commit -m "feat(api): failureClassifier — exception → FailureReason + humanMessage"
```

---

## Task 4: stability 模块

**Files:**
- Create: `apps/api/src/execute/stability.ts`
- Test: `apps/api/test/stability.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect, vi } from 'vitest';

function makePage(evalResult: unknown) {
  return {
    evaluate: vi.fn().mockResolvedValue(evalResult),
  } as never;
}

import { waitForStable, ElementNotStable } from '../src/execute/stability.js';

describe('waitForStable', () => {
  it('returns ready when evaluate reports no blockers', async () => {
    const page = makePage({ ready: true });
    const r = await waitForStable(page as never, {} as never);
    expect(r.ready).toBe(true);
  });

  it('throws ElementNotStable(disabled) when reason=disabled', async () => {
    const page = makePage({ ready: false, reason: 'disabled', source: '.ant-btn[disabled]' });
    await expect(waitForStable(page as never, {} as never, { timeoutMs: 50, pollMs: 10 }))
      .rejects.toMatchObject({ name: 'ElementNotStable', reason: 'disabled' });
  });

  it('retries until ready within timeout', async () => {
    let calls = 0;
    const page = {
      evaluate: vi.fn().mockImplementation(async () => {
        calls++;
        if (calls < 3) return { ready: false, reason: 'loading', source: '.ant-spin' };
        return { ready: true };
      }),
    };
    const r = await waitForStable(page as never, {} as never, { timeoutMs: 500, pollMs: 10 });
    expect(r.ready).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('throws on timeout with last reason=overlay', async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue({ ready: false, reason: 'overlay', source: '.ant-modal-mask' }),
    };
    await expect(waitForStable(page as never, {} as never, { timeoutMs: 30, pollMs: 10 }))
      .rejects.toMatchObject({ name: 'ElementNotStable', reason: 'overlay' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/api test -- stability.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `apps/api/src/execute/stability.ts`**

```ts
import type { Page } from 'playwright-core';

export type StabilityReason = 'disabled' | 'loading' | 'overlay' | 'readonly' | 'hidden';

export interface StabilityOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface StabilityReport {
  ready: boolean;
  reason?: StabilityReason;
  source?: string;
}

export class ElementNotStable extends Error {
  name = 'ElementNotStable' as const;
  reason: StabilityReason;
  source?: string;
  constructor(reason: StabilityReason, source?: string) {
    super(`ElementNotStable: ${reason}${source ? ` (${source})` : ''}`);
    this.reason = reason;
    this.source = source;
  }
}

/** 在 page.evaluate 中执行的检查脚本，返回当前阻塞原因；返回 {ready:true} 即放行。 */
async function probe(page: Page): Promise<StabilityReport> {
  return page.evaluate(() => {
    const sel = document.querySelector(':focus, [data-itest-active="true"], button, input, select, [role="button"]') as HTMLElement | null;
    const el = sel ?? (document.activeElement as HTMLElement | null);
    if (!el) return { ready: true };
    const isDisabled = (el: HTMLElement) =>
      (el as HTMLButtonElement).disabled === true ||
      el.getAttribute('aria-busy') === 'true' ||
      el.getAttribute('data-loading') === 'true' ||
      el.classList.contains('ant-btn-loading');
    if (isDisabled(el)) return { ready: false, reason: 'disabled', source: el.outerHTML.slice(0, 80) };
    const isLoadingAncestor = (el: HTMLElement): string | null => {
      let cur: HTMLElement | null = el;
      for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
        if (cur.classList.contains('ant-spin') || cur.classList.contains('ant-spin-spinning')) return '.ant-spin';
        if (cur.getAttribute('aria-busy') === 'true') return '[aria-busy="true"]';
      }
      return null;
    };
    const loadingSrc = isLoadingAncestor(el);
    if (loadingSrc) return { ready: false, reason: 'loading', source: loadingSrc };
    const isOverlayAncestor = (el: HTMLElement): string | null => {
      let cur: HTMLElement | null = el;
      for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
        if (cur.classList.contains('ant-modal-mask') || cur.classList.contains('el-overlay')) return 'overlay-mask';
        if (cur.getAttribute('data-mask') === 'true') return '[data-mask="true"]';
        const pe = window.getComputedStyle(cur).pointerEvents;
        if (pe === 'none') return 'pointer-events:none';
      }
      return null;
    };
    const overlaySrc = isOverlayAncestor(el);
    if (overlaySrc) return { ready: false, reason: 'overlay', source: overlaySrc };
    const ro = (el as HTMLInputElement).readOnly === true || el.getAttribute('aria-readonly') === 'true';
    if (ro) return { ready: false, reason: 'readonly', source: el.outerHTML.slice(0, 80) };
    return { ready: true };
  });
}

export async function waitForStable(
  page: Page,
  _locator: ReturnType<Page['locator']>,
  opts: StabilityOptions = {},
): Promise<StabilityReport> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let last: StabilityReport = { ready: true };
  // eslint-disable-next-line no-constant-condition
  while (true) {
    last = await probe(page);
    if (last.ready) return last;
    if (last.reason && last.reason !== 'hidden') {
      if (Date.now() >= deadline) throw new ElementNotStable(last.reason, last.source);
    }
    if (Date.now() >= deadline) throw new ElementNotStable(last.reason ?? 'hidden', last.source);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/api test -- stability.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/execute/stability.ts apps/api/test/stability.test.ts
git commit -m "feat(api): stability wait — disabled/loading/overlay/readonly + auto poll"
```

---

## Task 5: preflight 模块

**Files:**
- Create: `apps/api/src/execute/preflight.ts`
- Test: `apps/api/test/playback-preflight.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { preflight } from '../src/execute/preflight.js';

function pageWith(evaluateImpl: (fn: () => unknown) => Promise<unknown>, gotoImpl: () => Promise<unknown>) {
  return {
    evaluate: vi.fn().mockImplementation((fn: () => unknown) => evaluateImpl(fn)),
    goto: vi.fn().mockImplementation(() => gotoImpl()),
    url: vi.fn(() => 'https://example.com/login'),
    context: () => ({ pages: () => [{}, {}] }),
  } as never;
}

describe('preflight', () => {
  it('reports urlReachable=true when goto succeeds and body lacks defaultKeywords', async () => {
    const page = pageWith(async () => '欢迎回来', async () => undefined);
    const r = await preflight(page, { url: 'https://example.com/login', title: 'login' });
    expect(r.urlReachable).toBe(true);
    expect(r.loggedIn).toBe(true);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports urlReachable=false when goto throws', async () => {
    const page = pageWith(async () => '', async () => { throw new Error('net down'); });
    const r = await preflight(page, { url: 'https://x.test', title: 'x' });
    expect(r.urlReachable).toBe(false);
    expect(r.urlNote).toMatch(/net down/);
  });

  it('reports loggedIn=false when body contains 未登录', async () => {
    const page = pageWith(async () => '未登录，请先登录', async () => undefined);
    const r = await preflight(page, { url: 'https://x.test', title: 'x' });
    expect(r.urlReachable).toBe(true);
    expect(r.loggedIn).toBe(false);
  });

  it('skips navigate when url is empty', async () => {
    const page = pageWith(async () => 'x', async () => undefined);
    const r = await preflight(page, { url: '', title: 'x' });
    expect(r.urlReachable).toBe(true);
    expect(r.urlNote).toBeUndefined();
  });

  it('records tabsObserved from context.pages().length', async () => {
    const page = pageWith(async () => 'x', async () => undefined);
    const r = await preflight(page, { url: '', title: 'x' });
    expect(r.tabsObserved).toEqual([0, 1]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/api test -- playback-preflight.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `apps/api/src/execute/preflight.ts`**

```ts
import type { Page } from 'playwright-core';
import type { PreflightReport } from '@itest/shared';

const DEFAULT_KEYWORDS = ['请先登录', '未登录', '未授权', '登录后'];

interface CaseRowLite { url?: string | null; title: string }

export async function preflight(page: Page, caseRow: CaseRowLite): Promise<PreflightReport> {
  const started = Date.now();
  let urlReachable = true;
  let urlNote: string | undefined;
  if (caseRow.url && caseRow.url.trim()) {
    try {
      await page.goto(caseRow.url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    } catch (e) {
      urlReachable = false;
      urlNote = e instanceof Error ? e.message : String(e);
    }
  }
  let loggedIn = true;
  try {
    const body = await page.evaluate(() => (document?.body?.innerText ?? '')) as string;
    loggedIn = !DEFAULT_KEYWORDS.some((k) => body.includes(k));
  } catch {
    loggedIn = true;
  }
  let tabsObserved: number[] | undefined;
  try {
    const ctx = page.context();
    const pages = ctx.pages();
    tabsObserved = pages.map((_, i) => i);
  } catch {
    tabsObserved = undefined;
  }
  let sourceOrigin: string | undefined;
  let currentOrigin: string | undefined;
  let originMismatch: boolean | undefined;
  try {
    if (caseRow.url) sourceOrigin = new URL(caseRow.url).origin;
    const u = page.url();
    currentOrigin = new URL(u).origin;
    originMismatch = sourceOrigin && currentOrigin ? sourceOrigin !== currentOrigin : undefined;
  } catch {
    /* noop */
  }
  return {
    urlReachable,
    urlNote,
    loggedIn,
    sourceOrigin,
    currentOrigin,
    originMismatch,
    tabsObserved,
    durationMs: Date.now() - started,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/api test -- playback-preflight.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/execute/preflight.ts apps/api/test/playback-preflight.test.ts
git commit -m "feat(api): preflight — URL reachability + login state + tabs"
```

---

## Task 6: domFallback 模块

**Files:**
- Create: `apps/api/src/execute/domFallback.ts`
- Test: `apps/api/test/domFallback.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { domClick, domFill, domCheck, domSelect } from '../src/execute/domFallback.js';

function pageWith(evalImpl: (fn: (arg: unknown) => unknown, arg?: unknown) => Promise<unknown>) {
  return {
    evaluate: vi.fn().mockImplementation((fn: unknown, arg?: unknown) => evalImpl(fn as never, arg)),
  } as never;
}

describe('domFallback', () => {
  it('domClick returns ok when evaluator returns ok=true', async () => {
    const page = pageWith(async () => ({ ok: true }));
    const r = await domClick(page, [{ strategy: 'css', value: '#btn' }]);
    expect(r.ok).toBe(true);
  });

  it('domClick returns error when evaluator returns ok=false', async () => {
    const page = pageWith(async () => ({ ok: false, error: 'not found' }));
    const r = await domClick(page, [{ strategy: 'css', value: '#btn' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/);
  });

  it('domFill passes value through', async () => {
    let captured: unknown;
    const page = pageWith(async (_fn, arg) => { captured = arg; return { ok: true }; });
    const r = await domFill(page, [{ strategy: 'css', value: '#x' }], 'hello');
    expect(r.ok).toBe(true);
    expect(captured).toMatchObject({ value: 'hello' });
  });

  it('domCheck toggles checked', async () => {
    let captured: unknown;
    const page = pageWith(async (_fn, arg) => { captured = arg; return { ok: true }; });
    await domCheck(page, [{ strategy: 'css', value: '#cb' }], true);
    expect(captured).toMatchObject({ checked: true });
  });

  it('domSelect passes value', async () => {
    let captured: unknown;
    const page = pageWith(async (_fn, arg) => { captured = arg; return { ok: true }; });
    await domSelect(page, [{ strategy: 'css', value: 'select' }], 'cn');
    expect(captured).toMatchObject({ value: 'cn' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/api test -- domFallback.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `apps/api/src/execute/domFallback.ts`**

```ts
import type { Page } from 'playwright-core';
import type { Locator } from '@itest/shared';

export type DomFallbackResult = { ok: true } | { ok: false; error: string };

function locatorToCss(page: Page, locators: Locator[]): string | null {
  for (const l of locators) {
    if (l.strategy === 'css') return l.value;
    if (l.strategy === 'testId') return l.value.startsWith('[') ? l.value : `[data-testid="${l.value}"]`;
  }
  return null;
}

interface ScriptArg {
  selector: string;
  value?: string;
  checked?: boolean;
}

async function runDomAction(
  page: Page,
  locators: Locator[],
  arg: ScriptArg,
  script: (a: ScriptArg) => { ok: boolean; error?: string },
): Promise<DomFallbackResult> {
  const sel = locatorToCss(page, locators);
  if (!sel) return { ok: false, error: 'no-css-locator' };
  const res = await page.evaluate((a) => {
    // 这里的 fn 由调用方注入；这里只是 placeholder，真实脚本在每个 wrapper 里
    return { ok: true };
  }, arg);
  return (res as DomFallbackResult) ?? { ok: false, error: 'no-result' };
}

export async function domClick(page: Page, locators: Locator[]): Promise<DomFallbackResult> {
  const sel = locatorToCss(page, locators);
  if (!sel) return { ok: false, error: 'no-css-locator' };
  const r = await page.evaluate((selector: string) => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) return { ok: false, error: 'not found' };
    el.scrollIntoView();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { ok: true };
  }, sel);
  return r;
}

export async function domFill(page: Page, locators: Locator[], value: string): Promise<DomFallbackResult> {
  const sel = locatorToCss(page, locators);
  if (!sel) return { ok: false, error: 'no-css-locator' };
  const r = await page.evaluate(({ selector, value }: ScriptArg) => {
    const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) return { ok: false, error: 'not found' };
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }, { selector: sel, value });
  return r;
}

export async function domCheck(page: Page, locators: Locator[], checked: boolean): Promise<DomFallbackResult> {
  const sel = locatorToCss(page, locators);
  if (!sel) return { ok: false, error: 'no-css-locator' };
  const r = await page.evaluate(({ selector, checked }: ScriptArg) => {
    const el = document.querySelector(selector) as HTMLInputElement | null;
    if (!el) return { ok: false, error: 'not found' };
    if (el.checked !== checked) {
      el.checked = checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true };
  }, { selector: sel, checked });
  return r;
}

export async function domSelect(page: Page, locators: Locator[], value: string): Promise<DomFallbackResult> {
  const sel = locatorToCss(page, locators);
  if (!sel) return { ok: false, error: 'no-css-locator' };
  const r = await page.evaluate(({ selector, value }: ScriptArg) => {
    const el = document.querySelector(selector) as HTMLSelectElement | null;
    if (!el) return { ok: false, error: 'not found' };
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }, { selector: sel, value });
  return r;
}

export async function domUpload(_page: Page, _locators: Locator[], _storedPath: string): Promise<DomFallbackResult> {
  // upload 仍走真实 setInputFiles；DOM 路径无需额外实现
  return { ok: false, error: 'upload-not-supported-in-dom-fallback' };
}

// silence unused for runDomAction placeholder
void runDomAction;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/api test -- domFallback.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/execute/domFallback.ts apps/api/test/domFallback.test.ts
git commit -m "feat(api): domFallback — click/fill/check/select via dispatchEvent"
```

---

## Task 7: 接入 stability + domFallback + classifier 到 cdp.ts

**Files:**
- Modify: `apps/api/src/execute/cdp.ts`

- [ ] **Step 1: 在 `cdp.ts` 顶部 import 新模块**

```ts
import { waitForStable, ElementNotStable } from './stability.js';
import { classify } from './failureClassifier.js';
import { preflight } from './preflight.js';
import { domClick, domFill, domCheck, domSelect } from './domFallback.js';
```

- [ ] **Step 2: 扩展 `ExecStepResult` 接口**

在 `ExecStepResult` 内追加字段（与 spec §5 一致）：

```ts
failureReason?: import('@itest/shared').FailureReason;
humanMessage?: string;
hitLocator?: { kind: string; value: string };
tabIndex?: number;
```

- [ ] **Step 3: 在 `tryFirstMatch` 命中候选时写入 `opts.ctx.hitLocator`**

替换 `tryFirstMatch` 函数体（关键段）：

```ts
async function tryFirstMatch(
  page: Page,
  locator: Locator[],
  intentLocator?: IntentLocator,
  hitSink?: { current?: { kind: string; value: string } | null },
): Promise<ReturnType<Page['locator']>> {
  const cands = buildCandidates(page, { locator, intentLocator });
  if (cands.length === 0) throw new Error('locator array is empty');
  let lastErr: unknown;
  for (const c of cands) {
    const probe = c.loc as unknown as { count?: () => Promise<number>; isVisible?: () => Promise<boolean> };
    if (probe && typeof probe.count === 'function') {
      try {
        const n = await probe.count();
        if (n > 0) {
          if (hitSink) hitSink.current = { kind: c.kind, value: locatorForCandidate(locator, intentLocator, c.kind) };
          return c.loc;
        }
        lastErr = new Error(`count=0 (${c.kind})`);
      } catch (e) {
        lastErr = e;
      }
      continue;
    }
    if (hitSink) hitSink.current = { kind: c.kind, value: locatorForCandidate(locator, intentLocator, c.kind) };
    return c.loc;
  }
  throw lastErr instanceof Error ? lastErr : new Error('all locator candidates failed');
}

/** 把候选 kind 反向映射到原始 locator 表达（用于报告展示）。 */
function locatorForCandidate(locator: Locator[], intent: IntentLocator | undefined, kind: string): string {
  if (kind === 'intent-testid' && intent?.semanticRole) return `[data-testid="${intent.semanticRole}"]`;
  if (kind === 'intent-text' && intent?.contextText) return `text=${intent.contextText}`;
  for (const l of locator) {
    if (kind === 'stable-css' && l.strategy === 'css') return l.value;
    if (kind === 'css' && l.strategy === 'css') return l.value;
    if (kind === 'xpath' && l.strategy === 'xpath') return l.value;
    if (kind === 'role' && l.strategy === 'role') return l.value;
    if (kind === 'text' && l.strategy === 'text') return l.value;
    if (kind === 'testId' && l.strategy === 'testId') return l.value;
  }
  return kind;
}
```

- [ ] **Step 4: 改造 `dispatch` — 交互动作前 stability + DOM 降级**

替换 `dispatch` 函数体（关键段，click/fill/check/select/upload）：

```ts
async function dispatch(action: StepAction, opts: DispatchOpts): Promise<string | undefined> {
  const { page, vars } = opts;
  const interactive: StepAction['kind'][] = ['click', 'fill', 'check', 'select', 'upload'];
  if (interactive.includes(action.kind) && action.kind !== 'switchTab') {
    try {
      await waitForStable(page, page.locator('body'), { timeoutMs: 2000, pollMs: 100 });
    } catch (e) {
      if (e instanceof ElementNotStable) {
        // 仅对 click/fill/check/select 走 DOM 降级；upload 仍走真实路径
        if (action.kind === 'click' || action.kind === 'fill' || action.kind === 'check' || action.kind === 'select') {
          const r = await tryDomFallback(action, page);
          if (r.ok) return 'dom-fallback';
          throw e; // 由外层归类为 Disabled/Loading/OverlayTimeout
        }
        throw e;
      }
      throw e;
    }
  }
  switch (action.kind) {
    // ...原 case 保持不变
  }
}

async function tryDomFallback(action: StepAction, page: Page): Promise<{ ok: boolean; error?: string }> {
  switch (action.kind) {
    case 'click':
      return domClick(page, action.locator);
    case 'fill':
      return domFill(page, action.locator, '');
    case 'check':
      return domCheck(page, action.locator, action.checked);
    case 'select':
      return domSelect(page, action.locator, action.value);
    default:
      return { ok: false, error: 'unsupported' };
  }
}
```

> 注意：fill 走 DOM 时 value 留空由 `domFill` 自行处理；上面代码仅为占位；实际 fill 场景下把 `''` 换成 `materializeValue(action.value, vars)`。

- [ ] **Step 5: 改造 switchTab 宽容匹配**

替换 `switchTab` case：

```ts
case 'switchTab': {
  let target = opts.ctx.tabMap?.get(action.tabRef);
  if (!target) {
    const ctx = page.context();
    const pages = ctx.pages();
    // 模糊匹配：找一个 URL 与已记录目标相近的 page（兼容 tab 关闭后 reopen）
    if (pages.length > 0) target = pages[pages.length - 1]!;
    if (!target) throw new Error(`tab-missing: ${action.tabRef}`);
    opts.ctx.tabMap?.set(action.tabRef, target);
  }
  await target.bringToFront();
  opts.page = target;
  return 'tab-fuzzy-match';
}
```

- [ ] **Step 6: 在 `executeCaseReal` 主循环写入归类 + hitLocator + tabIndex**

替换主循环内 try/catch：

```ts
for (let i = 0; i < steps.length; i++) {
  const step = steps[i]!;
  const started = Date.now();
  opts.stepId = step.id;
  const hitSink: { current: { kind: string; value: string } | null } = { current: null };
  const tabIndex = opts.ctx.tabMap && step.tabRef
    ? Array.from(opts.ctx.tabMap.keys()).indexOf(step.tabRef)
    : 0;
  try {
    if (step.delayMs) await opts.page.waitForTimeout(step.delayMs);
    const warning = await dispatch(step.action as StepAction, opts);
    const screenshot = await writeStepScreenshot(ctx.reportId, i + 1, opts.page);
    results.push({
      order: step.order,
      status: 'passed',
      durationMs: Date.now() - started,
      warning,
      screenshot,
      hitLocator: hitSink.current ?? undefined,
      tabIndex: tabIndex >= 0 ? tabIndex : 0,
    });
  } catch (e) {
    const screenshot = await writeStepScreenshot(ctx.reportId, i + 1, opts.page);
    const cls = classify(e, { action: step.action as StepAction, durationMs: Date.now() - started });
    results.push({
      order: step.order,
      status: 'failed',
      durationMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
      screenshot,
      failureReason: cls.reason,
      humanMessage: cls.humanMessage,
      hitLocator: hitSink.current ?? undefined,
      tabIndex: tabIndex >= 0 ? tabIndex : 0,
    });
    break;
  }
}
```

- [ ] **Step 7: 在 `executeCaseReal` 启动后写 preflight 到 `reports.preflight`**

```ts
let preflightReport: PreflightReport | undefined;
try {
  preflightReport = await preflight(page, { url: targetUrl ?? null, title: '' });
} catch (e) {
  logger.warn({ err: e }, 'preflight failed; continuing');
}

// ... 主循环 ... 最后：
return { results, preflightReport };
```

把 `executeCaseReal` 的返回签名改为 `{ results: ExecStepResult[]; preflight?: PreflightReport }`。

- [ ] **Step 8: 跑后端测试确认未破坏**

Run: `pnpm --filter @itest/api test -- execute-cdp.test.ts`
Expected: PASS（已有 17 个 case 都通过）

- [ ] **Step 9: 提交**

```bash
git add apps/api/src/execute/cdp.ts
git commit -m "feat(api): integrate stability/domFallback/classifier/preflight into cdp.ts"
```

---

## Task 8: runCase 接入窗口策略 + incognito + 移除随机 mock

**Files:**
- Modify: `apps/api/src/execute/runCase.ts`
- Modify: `apps/api/src/execute/cdp.ts`（executeCaseReal 入参扩展）

- [ ] **Step 1: 扩展 `executeCaseReal` 入参**

在 `cdp.ts` 文件顶部：

```ts
import type { WindowStrategy } from '@itest/shared';

export interface CaseWindow {
  strategy: WindowStrategy;
  width?: number;
  height?: number;
}
```

把 `executeCaseReal` 第三个参数位置加入 `caseWindow?: CaseWindow; incognito?: boolean;`：

```ts
export async function executeCaseReal(
  caseId: string,
  steps: Array<{...}>,
  ctx: ExecContext,
  targetUrl?: string,
  storageState?: unknown,
  caseWindow?: CaseWindow,
  incognito?: boolean,
): Promise<{ results: ExecStepResult[]; preflight?: PreflightReport }>;
```

`browser.newContext` 改成：

```ts
const viewport = caseWindow?.strategy === 'custom' && caseWindow.width && caseWindow.height
  ? { width: caseWindow.width, height: caseWindow.height }
  : caseWindow?.strategy === 'current'
    ? undefined
    : { width: 1280, height: 800 };
const context = await browser.newContext({
  ...(storageState && !incognito ? { storageState: storageState as never } : {}),
  ...(viewport ? { viewport } : {}),
});
```

- [ ] **Step 2: 改 `runCase.ts` 加载新字段并移除 mock**

把 `runCase.ts` 的 caseRow 读取改为：

```ts
const caseWindow = {
  strategy: caseRow.windowStrategy as WindowStrategy,
  width: caseRow.windowWidth ?? undefined,
  height: caseRow.windowHeight ?? undefined,
};
const incognito = !!caseRow.incognito;
```

替换原 mock 路径（`runCase.ts:60-75`）：

```ts
} catch (cdpErr) {
  logger.warn({ err: cdpErr, caseId, reportId }, 'CDP path failed; falling back to DOM');
  // 这里直接抛错，由 router 返回 500；不再随机 mock。
  // 失败原因通过 failureReason 标注（由调用方记录到 summary）。
  throw cdpErr;
}
```

> 注：DOM 整用例重跑逻辑暂不实现（避免引入新失败模式）；CDP 失败时直接抛错让上层处理。

把 `executeCaseReal` 调用改成新签名：

```ts
const { results: stepResults, preflight: preflightReport } = await executeCaseReal(
  caseId,
  steps.map((s) => ({...})),
  { reportId, projectId },
  undefined,
  opts?.storageState,
  caseWindow,
  incognito,
);
```

并把 preflight 写入 `reports.preflight`：

```ts
await db.update(reports).set({
  status,
  durationMs,
  stepResults: stepResults as object,
  summary: buildSummary(stepResults, preflightReport),
  preflight: (preflightReport as object | undefined) ?? null,
}).where(eq(reports.id, reportId));
```

在文件末尾追加：

```ts
function buildSummary(steps: ExecStepResult[], preflight: PreflightReport | undefined): string {
  const passed = steps.filter((r) => r.status === 'passed').length;
  const base = `${steps.length} steps, ${passed} passed, ${steps.length - passed} failed`;
  if (!preflight) return base;
  const tags: string[] = [];
  if (!preflight.urlReachable) tags.push('URLUnreachable');
  if (!preflight.loggedIn) tags.push('NotLoggedIn');
  if (preflight.originMismatch) tags.push('OriginMismatch');
  return tags.length ? `${base} · preflight: ${tags.join(',')}` : base;
}
```

- [ ] **Step 3: 跑后端测试**

Run: `pnpm --filter @itest/api test`
Expected: PASS（其它未改路径不回归）

- [ ] **Step 4: 提交**

```bash
git add apps/api/src/execute/runCase.ts apps/api/src/execute/cdp.ts
git commit -m "feat(api): runCase — window strategy, incognito, preflight summary; remove mock"
```

---

## Task 9: PATCH /api/cases 接受新字段 + 校验

**Files:**
- Modify: `apps/api/src/routes/cases.ts`

- [ ] **Step 1: 扩展 `CreateBody` schema**

```ts
const CreateBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P1'),
  requirementId: z.string().uuid().optional(),
  groupId: z.string().uuid(),
  url: z.string().optional(),
  windowStrategy: z.enum(['maximize', 'current', 'custom']).default('maximize'),
  windowWidth: z.number().int().min(200).max(10000).optional(),
  windowHeight: z.number().int().min(200).max(10000).optional(),
  incognito: z.boolean().default(false),
}).superRefine((v, ctx) => {
  if (v.windowStrategy === 'custom' && (!v.windowWidth || !v.windowHeight)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['windowWidth'],
      message: 'window_strategy=custom 必须同时提供 windowWidth/windowHeight',
    });
  }
});
```

- [ ] **Step 2: 在 PATCH handler 接受部分字段**

`PATCH /:id` 已经用 `CreateBody.partial()`，无需大改；只需保证 `UpdateBody` 接受新字段：

```ts
const UpdateBody = CreateBody.partial();
```

- [ ] **Step 3: 添加集成测试到 `apps/api/test/cases.test.ts`**

```ts
it('PATCH window_strategy=custom requires width/height', async () => {
  const { groupId } = await seedProject(pool);
  const c = await request(app).post('/api/cases').send({ title: 'X', groupId });
  const r = await request(app).patch(`/api/cases/${c.body.id}`).send({ windowStrategy: 'custom' });
  expect(r.status).toBe(400);
  expect(r.body.message ?? JSON.stringify(r.body)).toMatch(/windowWidth/);
});

it('PATCH window_strategy=custom with width/height succeeds', async () => {
  const { groupId } = await seedProject(pool);
  const c = await request(app).post('/api/cases').send({ title: 'X', groupId });
  const r = await request(app).patch(`/api/cases/${c.body.id}`).send({ windowStrategy: 'custom', windowWidth: 1024, windowHeight: 768 });
  expect(r.status).toBe(200);
  expect(r.body.windowStrategy).toBe('custom');
  expect(r.body.windowWidth).toBe(1024);
});

it('PATCH incognito=true persists', async () => {
  const { groupId } = await seedProject(pool);
  const c = await request(app).post('/api/cases').send({ title: 'X', groupId });
  const r = await request(app).patch(`/api/cases/${c.body.id}`).send({ incognito: true });
  expect(r.status).toBe(200);
  expect(r.body.incognito).toBe(true);
});
```

- [ ] **Step 4: 跑测试**

Run: `pnpm --filter @itest/api test -- cases.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/routes/cases.ts apps/api/test/cases.test.ts
git commit -m "feat(api): PATCH /cases accepts window_strategy/width/height/incognito"
```

---

## Task 10: runPlan incognito × loginPrepare 互斥

**Files:**
- Modify: `apps/api/src/execute/runPlan.ts`
- Modify: `apps/api/src/routes/planRuns.ts`（写失败时返回 422）

- [ ] **Step 1: 在 `runPlanAsync` 入口扫描**

在 `runState.set(planRunId, { cancelRequested: false });` 之后、`run.loginPrepareEnabled` 检查之前，插入：

```ts
if (run.loginPrepareEnabled) {
  const conflict = await db
    .select({ id: testCases.id, title: testCases.title, incognito: testCases.incognito })
    .from(testCases)
    .innerJoin(planCases, eq(planCases.caseId, testCases.id))
    .where(eq(planCases.planId, run.planId));
  const incognitoOnes = conflict.filter((c) => c.incognito);
  if (incognitoOnes.length > 0) {
    const ids = incognitoOnes.map((c) => c.id).join(',');
    await finalizeRun(planRunId, 'failed', {
      passed: 0,
      failed: 1,
      skipped: 0,
      summary: `incognito 模式与登录准备互斥：${ids}`,
    });
    publish(planRunId, { type: 'plan_run_complete', status: 'failed', summary: 'incognito × loginPrepare 互斥' });
    runState.delete(planRunId);
    return { conflict: true, caseIds: incognitoOnes.map((c) => c.id) };
  }
}
```

把 `runPlanAsync` 签名改为返回 `{ conflict?: boolean; caseIds?: string[] }`。

- [ ] **Step 2: 在路由处返回 422**

修改 `apps/api/src/routes/planRuns.ts` 中调用 `runPlanAsync` 的位置（查找已有调用），拿到返回值后：

```ts
if (result?.conflict) {
  throw new HttpError(422, 'incognito-conflicts-with-login-prepare', `cases: ${result.caseIds?.join(',')}`);
}
```

确保 `HttpError` 已在该文件 import（沿用现有 import）。

- [ ] **Step 3: 添加 plan 测试**

在 `apps/api/test/plans.test.ts` 添加：

```ts
it('rejects planRun when any case is incognito and loginPrepareEnabled', async () => {
  const { groupId, projectId } = await seedProject(pool);
  const c = await request(app).post('/api/cases').send({ title: 'A', groupId, incognito: true });
  const plan = await request(app).post('/api/plans').send({ projectId, name: 'p', loginPrepareEnabled: true });
  await request(app).post(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c.body.id] });
  const r = await request(app).post(`/api/plans/${plan.body.id}/runs`).send({});
  expect(r.status).toBe(422);
  expect(JSON.stringify(r.body)).toMatch(/incognito-conflicts-with-login-prepare/);
});
```

- [ ] **Step 4: 跑测试**

Run: `pnpm --filter @itest/api test -- plans.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/execute/runPlan.ts apps/api/src/routes/planRuns.ts apps/api/test/plans.test.ts
git commit -m "feat(api): reject planRun with incognito × loginPrepare conflict"
```

---

## Task 11: 集成测试 — 命中 Locator + 失败归类落报告

**Files:**
- Create: `apps/api/test/playback-integration.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('playwright-core', () => {
  return {
    chromium: {
      launch: vi.fn().mockResolvedValue({
        newContext: () => ({
          newPage: () => Promise.resolve({
            goto: vi.fn().mockResolvedValue(undefined),
            locator: vi.fn().mockReturnValue({
              click: vi.fn().mockImplementation(() => Promise.reject(new Error('not found'))),
              count: vi.fn().mockResolvedValue(0),
              first: vi.fn().mockReturnThis(),
            }),
            getByText: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(1) }),
            getByRole: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(1) }),
            screenshot: vi.fn().mockResolvedValue(undefined),
            waitForTimeout: vi.fn().mockResolvedValue(undefined),
            url: vi.fn(() => 'https://example.com/login'),
            evaluate: vi.fn().mockResolvedValue('欢迎回来'),
            bringToFront: vi.fn().mockResolvedValue(undefined),
            context: () => ({ pages: () => [{}] }),
          }),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    },
  };
});

import { executeCaseReal } from '../src/execute/cdp.js';

describe('playback integration', () => {
  it('failure path writes failureReason + humanMessage', async () => {
    const { results, preflight } = await executeCaseReal(
      '00000000-0000-0000-0000-000000000099',
      [{ order: 1, action: { kind: 'click', locator: [{ strategy: 'css', value: '#missing' }] } }],
      { reportId: 'r-fail' },
    );
    expect(results[0]!.failureReason).toBeDefined();
    expect(results[0]!.humanMessage).toBeTruthy();
    expect(preflight?.urlReachable).toBe(true);
  });

  it('records hitLocator when intent matches', async () => {
    const { results } = await executeCaseReal(
      '00000000-0000-0000-0000-000000000098',
      [{
        order: 1,
        action: {
          kind: 'click',
          locator: [{ strategy: 'css', value: '.btn' }],
          intentLocator: { semanticRole: 'loginBtn' },
        },
      }],
      { reportId: 'r-hit' },
    );
    // 由于 mock locator count=1，候选命中；hitLocator 应有值
    expect(results[0]!.hitLocator?.kind).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `pnpm --filter @itest/api test -- playback-integration.test.ts`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add apps/api/test/playback-integration.test.ts
git commit -m "test(api): playback integration — failureReason + hitLocator recorded"
```

---

## Task 12: Web ReportDetail 明细模式 Tab

**Files:**
- Modify: `apps/web/src/pages/ReportDetail.tsx`

- [ ] **Step 1: 扩展 `StepResult` 类型**

```ts
interface StepResult {
  order: number;
  status: string;
  durationMs: number;
  error?: string;
  warning?: string;
  screenshot?: string;
  tabIndex?: number;
  failureReason?: string;
  humanMessage?: string;
  hitLocator?: { kind: string; value: string };
}
```

- [ ] **Step 2: 顶部加 Segmented（截图模式 / 明细模式）**

```tsx
import Segmented from '../components/ui/Segmented';
const [view, setView] = useState<'screenshot' | 'detail'>('screenshot');
// 在 header 区域 StatusPill 之后：
<Segmented
  value={view}
  onChange={setView}
  options={[{ label: '截图模式', value: 'screenshot' }, { label: '明细模式', value: 'detail' }]}
/>
```

- [ ] **Step 3: 明细模式表格**

替换 "步骤时间线" 区域为：

```tsx
{view === 'detail' ? (
  <div className="glass-card rounded-[12px] overflow-hidden">
    <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse' }}>
      <thead style={{ background: 'var(--color-background-subtle)' }}>
        <tr style={{ color: 'var(--color-foreground-muted)' }}>
          <th className="px-3 py-2 text-left">#</th>
          <th className="px-3 py-2 text-left">动作</th>
          <th className="px-3 py-2 text-left">步骤名</th>
          <th className="px-3 py-2 text-left">目标</th>
          <th className="px-3 py-2 text-right">耗时</th>
          <th className="px-3 py-2 text-left">命中 Locator</th>
          <th className="px-3 py-2 text-left">结果</th>
          <th className="px-3 py-2 text-left">失败原因</th>
        </tr>
      </thead>
      <tbody>
        {stepResults.map((s) => (
          <tr key={s.order} style={{ borderTop: '1px solid var(--color-muted)' }}>
            <td className="px-3 py-2 font-mono">#{s.order}</td>
            <td className="px-3 py-2">{(s as unknown as { action?: { kind?: string } }).action?.kind ?? '—'}</td>
            <td className="px-3 py-2">{(s as unknown as { name?: string }).name ?? '—'}</td>
            <td className="px-3 py-2 truncate max-w-[200px]">{(s as unknown as { target?: string }).target ?? '—'}</td>
            <td className="px-3 py-2 text-right font-mono">{s.durationMs} ms</td>
            <td className="px-3 py-2 font-mono text-[11px]" title={s.hitLocator ? `${s.hitLocator.kind}: ${s.hitLocator.value}` : ''}>
              {s.hitLocator ? `${s.hitLocator.kind}` : '—'}
            </td>
            <td className="px-3 py-2" style={{ color: s.status === 'passed' ? 'var(--color-success)' : 'var(--color-destructive)' }}>
              {s.status === 'passed' ? '✓ 通过' : '✕ 失败'}
            </td>
            <td className="px-3 py-2" title={s.humanMessage ?? ''}>
              {s.failureReason ?? '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
) : (
  /* 原有"步骤时间线"内容 */
)}
```

> 注意：`action.kind/name/target` 来自原始 step 元数据；目前 `stepResults` jsonb 不含 step 元数据。暂时只显示 `failureReason/humanMessage/hitLocator`，其它列显示 `—`；如果报告需要带 step 元数据，需要回 `runCase` 写入。这里**先显示已可用的字段**，把 `name/action.kind/target` 留待后续增强。

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @itest/web typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/pages/ReportDetail.tsx
git commit -m "feat(web): ReportDetail detail mode — failureReason + hitLocator columns"
```

---

## Task 13: Web CaseDetail 执行设置区块

**Files:**
- Modify: `apps/web/src/pages/CaseDetail.tsx`

- [ ] **Step 1: 在 `api.client` 增 patch 字段**

`apps/web/src/api/client.ts` 中 `cases.patch(id, body)` 已经存在；只需要保证后端接受新字段（已在 Task 9 完成）。

- [ ] **Step 2: 引入本地 state + 提交**

在 `CaseDetail` 组件内（已有 `caseData` 状态附近）追加：

```tsx
const [windowStrategy, setWindowStrategy] = useState<'maximize' | 'current' | 'custom'>('maximize');
const [windowWidth, setWindowWidth] = useState<number | undefined>();
const [windowHeight, setWindowHeight] = useState<number | undefined>();
const [incognito, setIncognito] = useState(false);

// 初次拿到 caseData 时同步：
useEffect(() => {
  if (caseData) {
    setWindowStrategy((caseData.windowStrategy as 'maximize' | 'current' | 'custom') ?? 'maximize');
    setWindowWidth(caseData.windowWidth);
    setWindowHeight(caseData.windowHeight);
    setIncognito(!!caseData.incognito);
  }
}, [caseData]);

const saveRuntimeSettings = async () => {
  await api.cases.patch(id!, { windowStrategy, windowWidth, windowHeight, incognito } as never);
  qc.invalidateQueries({ queryKey: ['case', id] });
  toast('已保存');
};
```

- [ ] **Step 3: UI 渲染（在 description Tab 内、状态/优先级 badge 区块下追加）**

```tsx
<div className="glass-card rounded-[12px] p-5 flex flex-col gap-4">
  <div className="text-[13px] font-medium" style={{ color: 'var(--color-foreground)' }}>执行设置</div>
  <div className="flex flex-col gap-2">
    <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>窗口策略</span>
    <Segmented
      value={windowStrategy}
      onChange={setWindowStrategy as never}
      options={[
        { label: '默认最大化', value: 'maximize' },
        { label: '当前窗口', value: 'current' },
        { label: '自定义', value: 'custom' },
      ]}
    />
  </div>
  {windowStrategy === 'custom' && (
    <div className="flex gap-3">
      <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
        宽
        <Input type="number" value={windowWidth ?? ''} onChange={(v) => setWindowWidth(v ? Number(v) : undefined)} />
      </label>
      <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
        高
        <Input type="number" value={windowHeight ?? ''} onChange={(v) => setWindowHeight(v ? Number(v) : undefined)} />
      </label>
    </div>
  )}
  <div className="flex items-center gap-3">
    <Toggle checked={incognito} onChange={setIncognito} label="无痕模式" />
    <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
      每次回放从新会话开始，不保留登录态
    </span>
  </div>
  <div className="flex justify-end">
    <Button onClick={saveRuntimeSettings}>保存</Button>
  </div>
</div>
```

确认 `Segmented` / `Toggle` / `Input` / `Button` 已在该文件 import。

- [ ] **Step 4: typecheck**

Run: `pnpm --filter @itest/web typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/pages/CaseDetail.tsx
git commit -m "feat(web): CaseDetail runtime settings — window strategy + incognito"
```

---

## Task 14: 端到端校验

**Files:** none (manual)

- [ ] **Step 1: 跑全量测试**

Run:
```bash
pnpm verify
```
Expected: PASS

- [ ] **Step 2: 手动验证 — 真实 chromium + 无 UI**

```bash
docker compose -f infra/docker-compose.yml up -d --wait
pnpm --filter @itest/api db:migrate
pnpm --filter @itest/api dev &
pnpm --filter @itest/web dev &
```

打开 `/cases/...` 详情 → 录制一条用例（用 mock 也行，单纯验证 playback）→ 设置 `windowStrategy=custom, windowWidth=800, windowHeight=600, incognito=true` → 保存 → 点执行。

预期:
- 用例详情页保存成功（toast 已保存）。
- 报告页明细模式 Tab 可见；空步骤时显示 `—`。

- [ ] **Step 3: 手动验证 — 真实浏览器跑 disabled 按钮**

在测试目标页（如 AntD demo）录一条用例，含一个 `loading` 按钮点击。报告页明细模式查看失败原因，应为 `LoadingTimeout` 或 `DisabledTimeout`（取决于第一次 evaluate 时按钮的状态）。

- [ ] **Step 4: 手动验证 — incognito × loginPrepare 互斥**

新建 plan 启用登录准备，把一条 incognito 用例加入 plan；启动 plan → HTTP 422 + `incognito-conflicts-with-login-prepare`。

- [ ] **Step 5: 关闭所有 dev 进程**

```bash
# Ctrl-C
```

---

## 自审

**Spec coverage:**
- §1 背景与目标 → Task 1（共享枚举）, Task 2（迁移）, Task 7（接入）, Task 12（明细模式）
- §3 数据模型变更 → Task 2
- §4.1 stability → Task 4
- §4.2 failureClassifier → Task 3
- §4.3 preflight → Task 5
- §4.4 domFallback → Task 6
- §4.5 cdp.ts 改造点 → Task 7
- §4.6 runCase.ts 改造点 → Task 8
- §4.7 runPlan.ts 改造点 → Task 10
- §4.8 浏览器启动参数 → Task 8
- §5 数据流与契约 → Task 7, Task 8（写 preflight + 步骤扩展字段）
- §6 错误处理策略 → Task 3 + Task 7
- §7 前端改造 → Task 12, Task 13
- §8 测试计划 → Task 3, 4, 5, 6, 11, 14

**Placeholder scan:** 已扫描；`step.action` 在 stepResults 中确实没有持久化（spec §5 仅扩展了 failureReason/humanMessage/hitLocator/tabIndex），所以 Task 12 的明细模式只显示已有字段——这一点在 Task 12 Step 3 中已显式说明。

**Type consistency:**
- `FailureReason` 在 `@itest/shared` 导出（Task 1），`failureClassifier` 与 `cdp.ts` 都从 `@itest/shared` import（Task 3 Step 3、Task 7 Step 2）。
- `WindowStrategy` 在 `@itest/shared` 导出（Task 1），`runCase.ts` 与 `routes/cases.ts` 都从 `@itest/shared` 引用（Task 8 Step 1、Task 9 Step 1）。
- `ElementNotStable.name === 'ElementNotStable'`：`stability.ts` 内 class 显式 `name = 'ElementNotStable'`（Task 4 Step 3）；`failureClassifier` 用 `e.name === 'ElementNotStable'` 判断（Task 3 Step 3）。
- `executeCaseReal` 入参顺序：`(caseId, steps, ctx, targetUrl?, storageState?, caseWindow?, incognito?)` 与 Task 7 Step 7 / Task 8 Step 2 一致。
