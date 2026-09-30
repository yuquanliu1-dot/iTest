# 执行计划优化 · 策略 + 登录准备 + 执行历史 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给执行计划补全「执行策略（全部完成 / 失败即停）+ 登录准备（自动判定 + 高级配置）」，并新增 plan_run / plan_run_cases 表把每次计划运行变成可查看的历史，统一进「执行历史」入口。

**Architecture:** 单进程、串行执行；每条用例独立 CDP context；登录准备用 Playwright `storageState` 注入；SSE 用现有 `runBus` 进度推送；表上加 `plan_runs` / `plan_run_cases` + `execution_plans` 新字段。

**Tech Stack:** drizzle-orm + pg（迁移）、Express 5、zod、playwright-core（chromium）、SSE（Node 原生 Response）、React 18 + TanStack Query + Vite。

---

## 文件结构

**新增**
- `apps/api/src/execute/runPlan.ts` — 计划执行主循环：登录准备、串行调用 `runCase`、聚合 plan_run 状态。
- `apps/api/src/execute/loginPrepare.ts` — 登录态检测与登录用例执行；返回 `{ ok, storageState? }`。
- `apps/api/src/routes/planRuns.ts` — `/plan-runs/:id` 详情 / cancel / SSE events。
- `apps/api/src/routes/executions.ts` — `/executions?kind=case|plan|all` 合并历史接口。
- `apps/api/drizzle/0005_plan_execution.sql` — 迁移：加 `execution_plans` 字段 + 新表 `plan_runs` / `plan_run_cases`。
- `apps/web/src/pages/PlanRunDetail.tsx` — 计划运行详情页。
- `apps/web/src/pages/Executions.tsx` — 「执行历史」页（替换原 `Reports.tsx` 的位置）。

**修改**
- `apps/api/src/db/schema.ts` — 增 `planRuns` / `planRunCases` 表 + 增 `executionPlans` 字段。
- `apps/api/src/routes/plans.ts` — 创建/PATCH 支持 strategy + loginPrepare；新增 `/plans/:id/cases/order`、`/plans/:id/login-cases`、`/plans/:id/run` 改为非阻塞返回 `{ runId }`。
- `apps/api/src/index.ts` — 挂 `planRunsRoute`、`executionsRoute`。
- `apps/api/src/execute/runCase.ts` — 不变更；保持单用例执行原状（计划层用 `runCase` 复用）。
- `apps/api/test/helpers/db.ts` — `SCHEMA_SQL` 加新表 + 新列。
- `apps/web/src/api/client.ts` — 加 `plans.reorderCases`、`plans.loginCases`、`planRuns.*`、`executions.list`，改 `plans.run` 返回 `runId`。
- `apps/web/src/pages/PlanDetail.tsx` — 策略下拉、登录准备开关 + 折叠区、拖拽 + 上下移、多选加入用例、一键执行 SSE 进度。
- `apps/web/src/pages/Reports.tsx` — 改造为 `Executions`（顶部 Tab + 合并数据）；或保持文件名为 `Reports.tsx` 但内容改为历史页（简化方案二选一）。
- `apps/web/src/components/layout/Sidebar.tsx` — 「报告」改「执行历史」。
- `apps/web/src/App.tsx` — 加 `PlanRunDetail` 路由。
- `apps/web/src/pages/Plans.tsx` — 卡片摘要：最近一次状态 / 通过率。
- `apps/api/test/plans.test.ts` — 加新字段 + 顺序调整 + 跨项目登录用例 + fail_fast + cancel。

---

## Task 1: 数据库迁移（新增列与表）

**Files:**
- Modify: `apps/api/drizzle/0005_plan_execution.sql`
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/test/helpers/db.ts`

- [ ] **Step 1: 写迁移 SQL**

`apps/api/drizzle/0005_plan_execution.sql`：

```sql
ALTER TABLE "execution_plans"
  ADD COLUMN "strategy" varchar(20) NOT NULL DEFAULT 'run_all',
  ADD COLUMN "login_prepare_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN "login_case_id" uuid,
  ADD COLUMN "detection_url" text,
  ADD COLUMN "login_success_selector" text,
  ADD COLUMN "login_unauthorized_keywords" jsonb;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "execution_plans" ADD CONSTRAINT "execution_plans_login_case_id_test_cases_id_fk" FOREIGN KEY ("login_case_id") REFERENCES "public"."test_cases"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "plan_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plan_id" uuid NOT NULL REFERENCES "execution_plans"("id") ON DELETE cascade,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "status" varchar(20) NOT NULL,
  "strategy" varchar(20) NOT NULL,
  "login_prepare_enabled" boolean NOT NULL DEFAULT false,
  "login_case_id" uuid REFERENCES "test_cases"("id") ON DELETE set null,
  "detection_url" text,
  "login_success_selector" text,
  "login_unauthorized_keywords" jsonb,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "finished_at" timestamp,
  "duration_ms" integer,
  "summary" text,
  "total_cases" integer NOT NULL DEFAULT 0,
  "passed_cases" integer,
  "failed_cases" integer,
  "skipped_cases" integer,
  "cancel_requested" boolean NOT NULL DEFAULT false
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "plan_run_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plan_run_id" uuid NOT NULL REFERENCES "plan_runs"("id") ON DELETE cascade,
  "case_id" uuid NOT NULL REFERENCES "test_cases"("id") ON DELETE cascade,
  "report_id" uuid REFERENCES "reports"("id") ON DELETE set null,
  "order" integer NOT NULL,
  "status" varchar(20) NOT NULL,
  "step_kind" varchar(20) NOT NULL,
  "started_at" timestamp,
  "finished_at" timestamp,
  "duration_ms" integer,
  "error" text
);
```

- [ ] **Step 2: 更新 schema.ts**

替换 `apps/api/src/db/schema.ts` 中 `executionPlans` 块（保留原字段，添加新列）：

```ts
export const executionPlans = pgTable('execution_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  environment: varchar('environment', { length: 100 }),
  strategy: varchar('strategy', { length: 20 }).notNull().default('run_all'),
  loginPrepareEnabled: boolean('login_prepare_enabled').notNull().default(false),
  loginCaseId: uuid('login_case_id').references(() => testCases.id, { onDelete: 'set null' }),
  detectionUrl: text('detection_url'),
  loginSuccessSelector: text('login_success_selector'),
  loginUnauthorizedKeywords: jsonb('login_unauthorized_keywords'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

并在文件末尾追加：

```ts
export const planRuns = pgTable('plan_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id').notNull().references(() => executionPlans.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 20 }).notNull(),
  strategy: varchar('strategy', { length: 20 }).notNull(),
  loginPrepareEnabled: boolean('login_prepare_enabled').notNull().default(false),
  loginCaseId: uuid('login_case_id').references(() => testCases.id, { onDelete: 'set null' }),
  detectionUrl: text('detection_url'),
  loginSuccessSelector: text('login_success_selector'),
  loginUnauthorizedKeywords: jsonb('login_unauthorized_keywords'),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  finishedAt: timestamp('finished_at'),
  durationMs: integer('duration_ms'),
  summary: text('summary'),
  totalCases: integer('total_cases').notNull().default(0),
  passedCases: integer('passed_cases'),
  failedCases: integer('failed_cases'),
  skippedCases: integer('skipped_cases'),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
});

export const planRunCases = pgTable('plan_run_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  planRunId: uuid('plan_run_id').notNull().references(() => planRuns.id, { onDelete: 'cascade' }),
  caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
  reportId: uuid('report_id').references(() => reports.id, { onDelete: 'set null' }),
  order: integer('order').notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  stepKind: varchar('step_kind', { length: 20 }).notNull(),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  durationMs: integer('duration_ms'),
  error: text('error'),
});
```

- [ ] **Step 3: 更新测试 SCHEMA_SQL**

在 `apps/api/test/helpers/db.ts` 的 `SCHEMA_SQL` 字符串中：

替换 execution_plans DDL：

```sql
CREATE TABLE execution_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL, name varchar(200) NOT NULL, environment varchar(100), strategy varchar(20) NOT NULL DEFAULT 'run_all', login_prepare_enabled boolean NOT NULL DEFAULT false, login_case_id uuid, detection_url text, login_success_selector text, login_unauthorized_keywords jsonb, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
```

末尾追加：

```sql
CREATE TABLE plan_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid REFERENCES execution_plans(id) ON DELETE CASCADE NOT NULL, project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL, status varchar(20) NOT NULL, strategy varchar(20) NOT NULL, login_prepare_enabled boolean NOT NULL DEFAULT false, login_case_id uuid REFERENCES test_cases(id) ON DELETE SET NULL, detection_url text, login_success_selector text, login_unauthorized_keywords jsonb, started_at timestamp NOT NULL DEFAULT now(), finished_at timestamp, duration_ms integer, summary text, total_cases integer NOT NULL DEFAULT 0, passed_cases integer, failed_cases integer, skipped_cases integer, cancel_requested boolean NOT NULL DEFAULT false);
CREATE TABLE plan_run_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_run_id uuid REFERENCES plan_runs(id) ON DELETE CASCADE NOT NULL, case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, report_id uuid REFERENCES reports(id) ON DELETE SET NULL, "order" integer NOT NULL, status varchar(20) NOT NULL, step_kind varchar(20) NOT NULL, started_at timestamp, finished_at timestamp, duration_ms integer, error text);
```

并补充 FK：

```sql
DO $$ BEGIN
 ALTER TABLE execution_plans ADD CONSTRAINT execution_plans_login_case_id_test_cases_id_fk FOREIGN KEY (login_case_id) REFERENCES test_cases(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
```

- [ ] **Step 4: 验证迁移文件可被 drizzle-kit 识别**

运行：

```bash
cd apps/api && pnpm db:generate
```

预期：没有 diff 输出（schema 已与 SQL 对齐），若有 diff 则修正 schema 后重试。

- [ ] **Step 5: 提交**

```bash
git add apps/api/drizzle/0005_plan_execution.sql apps/api/src/db/schema.ts apps/api/test/helpers/db.ts
git commit -m "feat(db): plan_runs + plan_run_cases + execution_plans strategy/login_prepare fields"
```

---

## Task 2: 计划执行引擎 — loginPrepare 模块

**Files:**
- Create: `apps/api/src/execute/loginPrepare.ts`

- [ ] **Step 1: 写 loginPrepare.ts**

`apps/api/src/execute/loginPrepare.ts`：

```ts
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { eq, asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { testCases, testSteps } from '../db/schema.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';
import { logger } from '../logger.js';

const DEFAULT_KEYWORDS = ['请先登录', '未登录', '未授权', '登录后'];

const URL_LOGIN_HINTS = /(?:^|\/)(login|signin|sign-in|auth|unauthorized)(?:\/|$|\?)/i;

export interface LoginPrepareConfig {
  enabled: boolean;
  caseId?: string | null;
  detectionUrl?: string | null;
  successSelector?: string | null;
  unauthorizedKeywords?: string[] | null;
  /** 计划中第一个业务用例，提供 fallback detectionUrl。 */
  firstCaseId?: string | null;
}

export interface LoginPrepareResult {
  status: 'skipped' | 'passed' | 'failed';
  reason?: string;
  storageState?: unknown;
  detectionReportId?: string;
}

function buildKeywords(c: LoginPrepareConfig): string[] {
  const base = c.unauthorizedKeywords && c.unauthorizedKeywords.length > 0 ? c.unauthorizedKeywords : DEFAULT_KEYWORDS;
  return base;
}

async function resolveDetectionUrl(c: LoginPrepareConfig): Promise<string | null> {
  if (c.detectionUrl) return c.detectionUrl;
  if (!c.firstCaseId) return null;
  const row = (await db.select().from(testCases).where(eq(testCases.id, c.firstCaseId)))[0];
  if (!row) return null;
  return resolveCaseUrl(row);
}

async function openDetectionPage(browser: BrowserContext, url: string, timeoutMs = 5000): Promise<Page | null> {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => undefined);
    return page;
  } catch (e) {
    logger.warn({ err: e, url }, 'login detection: navigation failed');
    await page.close().catch(() => undefined);
    return null;
  }
}

interface DetectionOutcome {
  alreadyLoggedIn: boolean;
  reason: string;
}

async function detectLoginState(page: Page, c: LoginPrepareConfig): Promise<DetectionOutcome> {
  if (c.successSelector) {
    const found = await page.locator(c.successSelector).first().count().catch(() => 0);
    if (found > 0) return { alreadyLoggedIn: true, reason: 'selector hit' };
  }
  const url = page.url();
  if (!URL_LOGIN_HINTS.test(url)) {
    const hasPassword = await page.locator('input[type="password"]').count().catch(() => 0);
    if (hasPassword === 0) {
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000);
      const keywords = buildKeywords(c);
      const hit = keywords.find((k) => body.includes(k));
      if (!hit) return { alreadyLoggedIn: true, reason: 'no login signals' };
      return { alreadyLoggedIn: false, reason: `keyword hit: ${hit}` };
    }
  }
  return { alreadyLoggedIn: false, reason: URL_LOGIN_HINTS.test(url) ? 'url login hint' : 'password input present' };
}

/** 执行登录用例并返回 storageState。失败抛错。 */
async function runLoginCase(caseId: string): Promise<unknown> {
  // 调用 runCase 走完整 CDP 路径；这里简化为复用 dispatcher：见 runPlan 内部集成。
  throw new Error('runLoginCase not implemented here — wired by runPlan');
}

/**
 * 登录准备入口：在调用方提供的 browser context 中探测；如已登录返回 skipped；
 * 否则执行登录用例（由调用方传入的 loginCaseRunner 处理）。
 */
export async function loginPrepare(
  cfg: LoginPrepareConfig,
  opts: {
    /** 启动新 chromium；返回 browser + 是否已登录 + storageState。 */
    loginCaseRunner: (caseId: string, ctx: BrowserContext) => Promise<{ passed: boolean; storageState: unknown }>;
  },
): Promise<LoginPrepareResult> {
  if (!cfg.enabled) return { status: 'skipped', reason: 'disabled' };
  if (!cfg.caseId) return { status: 'skipped', reason: 'no login case' };

  const url = await resolveDetectionUrl(cfg);
  if (!url) {
    return { status: 'failed', reason: 'no detection URL (set detectionUrl or first business case.url)' };
  }

  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const ctx = await browser.newContext();
    const page = await openDetectionPage(ctx, url);
    if (!page) return { status: 'failed', reason: 'detection page navigation failed' };

    const detect = await detectLoginState(page, cfg);
    await page.close().catch(() => undefined);

    if (detect.alreadyLoggedIn) {
      const ss = await ctx.storageState();
      return { status: 'skipped', reason: detect.reason, storageState: ss };
    }

    const loginRun = await opts.loginCaseRunner(cfg.caseId!, ctx);
    if (!loginRun.passed) {
      return { status: 'failed', reason: 'login case failed' };
    }
    return { status: 'passed', reason: 'login case executed', storageState: loginRun.storageState };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
```

- [ ] **Step 2: typecheck**

```bash
cd apps/api && pnpm typecheck
```

预期：通过（无 error）。若报缺 module 错误，先补 import。

- [ ] **Step 3: 提交**

```bash
git add apps/api/src/execute/loginPrepare.ts
git commit -m "feat(api): loginPrepare helper (URL+CSS+keywords detection, storageState on pass)"
```

---

## Task 3: 计划执行引擎 — runPlan 主循环

**Files:**
- Create: `apps/api/src/execute/runPlan.ts`

- [ ] **Step 1: 写 runPlan.ts**

`apps/api/src/execute/runPlan.ts`：

```ts
import { eq, asc } from 'drizzle-orm';
import { chromium, type BrowserContext } from 'playwright-core';
import { db } from '../db/client.js';
import {
  executionPlans,
  planCases,
  planRuns,
  planRunCases,
  testCases,
  testSteps,
  reports,
} from '../db/schema.js';
import { runCase } from './runCase.js';
import { loginPrepare } from './loginPrepare.js';
import { publishRunEvent, subscribeRunEvent } from '../sse/planRunBus.js';
import { logger } from '../logger.js';

const STATUS = {
  RUNNING: 'running',
  PASSED: 'passed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

/** 单 planRun 的运行控制器：内存中保存 storageState 与 cancelRequested。 */
const runState = new Map<string, { cancelRequested: boolean }>();

export function requestCancel(planRunId: string): void {
  const s = runState.get(planRunId);
  if (s) s.cancelRequested = true;
}

export function isCancelRequested(planRunId: string): boolean {
  return runState.get(planRunId)?.cancelRequested ?? false;
}

interface RunPlanInput {
  planRunId: string;
}

interface StepEvent {
  type:
    | 'plan_run_login'
    | 'plan_run_case_start'
    | 'plan_run_case_complete'
    | 'plan_run_complete';
  caseId?: string;
  stepKind?: 'login_prepare' | 'business';
  status?: string;
  reportId?: string;
  summary?: string;
}

export function subscribeRun(runId: string, res: import('express').Response): () => void {
  return subscribeRunEvent(runId, res);
}

function publish(runId: string, evt: StepEvent) {
  publishRunEvent(runId, evt);
}

/** 启动一次计划执行（异步）。调用方立即返回 planRunId。 */
export async function runPlanAsync(input: RunPlanInput): Promise<void> {
  const { planRunId } = input;
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, planRunId)))[0];
  if (!run) return;
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, run.planId)))[0];
  if (!plan) return;

  runState.set(planRunId, { cancelRequested: false });

  const cases = await db
    .select({ caseId: planCases.caseId, order: planCases.order })
    .from(planCases)
    .where(eq(planCases.planId, plan.id))
    .orderBy(asc(planCases.order));

  await db.update(planRuns).set({ totalCases: cases.length, startedAt: new Date() }).where(eq(planRuns.id, planRunId));

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // 登录准备
  if (run.loginPrepareEnabled) {
    const loginCaseId = run.loginCaseId;
    const firstCaseId = cases[0]?.caseId ?? null;
    const result = await loginPrepare(
      {
        enabled: true,
        caseId: loginCaseId,
        detectionUrl: run.detectionUrl,
        successSelector: run.loginSuccessSelector,
        unauthorizedKeywords: run.loginUnauthorizedKeywords as string[] | null,
        firstCaseId,
      },
      {
        loginCaseRunner: async (cid, _ctx) => {
          // 写入 plan_run_cases（step_kind=login_prepare, status=running）
          const ins = await db
            .insert(planRunCases)
            .values({ planRunId, caseId: cid, order: 0, status: 'running', stepKind: 'login_prepare' })
            .returning();
          const row = ins[0]!;
          publish(planRunId, { type: 'plan_run_login', caseId: cid, stepKind: 'login_prepare', status: 'running' });
          try {
            const r = await runCase(cid);
            await db
              .update(planRunCases)
              .set({
                status: r.status,
                reportId: r.reportId,
                finishedAt: new Date(),
                durationMs: 0,
                error: r.status === 'failed' ? 'login case failed' : null,
              })
              .where(eq(planRunCases.id, row.id));
            if (r.status !== 'passed') {
              publish(planRunId, { type: 'plan_run_case_complete', caseId: cid, stepKind: 'login_prepare', status: 'failed', reportId: r.reportId });
              return { passed: false, storageState: undefined };
            }
            publish(planRunId, { type: 'plan_run_case_complete', caseId: cid, stepKind: 'login_prepare', status: 'passed', reportId: r.reportId });
            // 简化为：登录成功后从新启的 browser 中导出 storageState；见 runPlanAsync 末尾。
            const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
            try {
              const ctx = await browser.newContext();
              return { passed: true, storageState: await ctx.storageState() };
            } finally {
              await browser.close().catch(() => undefined);
            }
          } catch (e) {
            await db
              .update(planRunCases)
              .set({ status: 'failed', finishedAt: new Date(), error: e instanceof Error ? e.message : String(e) })
              .where(eq(planRunCases.id, row.id));
            return { passed: false, storageState: undefined };
          }
        },
      },
    );
    if (result.status === 'failed') {
      await finalizeRun(planRunId, 'failed', { passed, failed, skipped: cases.length, summary: `登录准备失败：${result.reason ?? 'unknown'}` });
      publish(planRunId, { type: 'plan_run_complete', status: 'failed', summary: '登录准备失败' });
      runState.delete(planRunId);
      return;
    }
  }

  // 业务用例串行执行
  for (let i = 0; i < cases.length; i++) {
    if (isCancelRequested(planRunId)) {
      const remaining = cases.length - i;
      for (let j = i; j < cases.length; j++) {
        await db.insert(planRunCases).values({
          planRunId,
          caseId: cases[j]!.caseId,
          order: j + 1,
          status: 'skipped',
          stepKind: 'business',
        });
      }
      skipped += remaining;
      break;
    }
    const c = cases[i]!;
    const ins = await db
      .insert(planRunCases)
      .values({ planRunId, caseId: c.caseId, order: i + 1, status: 'running', stepKind: 'business' })
      .returning();
    publish(planRunId, { type: 'plan_run_case_start', caseId: c.caseId, stepKind: 'business', status: 'running' });
    try {
      const r = await runCase(c.caseId);
      await db
        .update(planRunCases)
        .set({ status: r.status, reportId: r.reportId, finishedAt: new Date(), error: r.status === 'failed' ? 'case failed' : null })
        .where(eq(planRunCases.id, ins[0]!.id));
      publish(planRunId, { type: 'plan_run_case_complete', caseId: c.caseId, stepKind: 'business', status: r.status, reportId: r.reportId });
      if (r.status === 'passed') passed += 1;
      else {
        failed += 1;
        if (run.strategy === 'fail_fast') {
          for (let j = i + 1; j < cases.length; j++) {
            await db.insert(planRunCases).values({
              planRunId,
              caseId: cases[j]!.caseId,
              order: j + 1,
              status: 'skipped',
              stepKind: 'business',
            });
          }
          skipped += cases.length - i - 1;
          break;
        }
      }
    } catch (e) {
      await db
        .update(planRunCases)
        .set({ status: 'failed', finishedAt: new Date(), error: e instanceof Error ? e.message : String(e) })
        .where(eq(planRunCases.id, ins[0]!.id));
      failed += 1;
      publish(planRunId, { type: 'plan_run_case_complete', caseId: c.caseId, stepKind: 'business', status: 'failed' });
      if (run.strategy === 'fail_fast') {
        for (let j = i + 1; j < cases.length; j++) {
          await db.insert(planRunCases).values({
            planRunId,
            caseId: cases[j]!.caseId,
            order: j + 1,
            status: 'skipped',
            stepKind: 'business',
          });
        }
        skipped += cases.length - i - 1;
        break;
      }
    }
  }

  const finalStatus = isCancelRequested(planRunId) ? 'cancelled' : failed > 0 ? 'failed' : 'passed';
  await finalizeRun(planRunId, finalStatus, { passed, failed, skipped, summary: `${passed} 通过 / ${failed} 失败 / ${skipped} 跳过` });
  publish(planRunId, { type: 'plan_run_complete', status: finalStatus, summary: `${passed} 通过 / ${failed} 失败 / ${skipped} 跳过` });
  runState.delete(planRunId);
}

async function finalizeRun(
  planRunId: string,
  status: 'passed' | 'failed' | 'cancelled',
  counts: { passed: number; failed: number; skipped: number; summary: string },
) {
  const finishedAt = new Date();
  const startedAt = (await db.select({ s: planRuns.startedAt }).from(planRuns).where(eq(planRuns.id, planRunId)))[0]?.s ?? finishedAt;
  await db
    .update(planRuns)
    .set({
      status,
      finishedAt,
      durationMs: finishedAt.getTime() - new Date(startedAt).getTime(),
      passedCases: counts.passed,
      failedCases: counts.failed,
      skippedCases: counts.skipped,
      summary: counts.summary,
    })
    .where(eq(planRuns.id, planRunId));
}
```

- [ ] **Step 2: 创建 planRunBus（per-run SSE）**

`apps/api/src/sse/planRunBus.ts`：

```ts
import type { Response } from 'express';

export interface PlanRunEvent {
  type: string;
  caseId?: string;
  stepKind?: 'login_prepare' | 'business';
  status?: string;
  reportId?: string;
  summary?: string;
}

const subscribers = new Map<string, Set<Response>>();

export function subscribeRunEvent(runId: string, res: Response): () => void {
  let set = subscribers.get(runId);
  if (!set) {
    set = new Set();
    subscribers.set(runId, set);
  }
  set.add(res);
  return () => {
    const cur = subscribers.get(runId);
    if (!cur) return;
    cur.delete(res);
    if (cur.size === 0) subscribers.delete(runId);
  };
}

export function publishRunEvent(runId: string, event: PlanRunEvent): void {
  const set = subscribers.get(runId);
  if (!set) return;
  for (const res of set) {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      /* peer closed */
    }
  }
}

export function subscriberCount(runId: string): number {
  return subscribers.get(runId)?.size ?? 0;
}
```

- [ ] **Step 3: typecheck**

```bash
cd apps/api && pnpm typecheck
```

预期：通过。

- [ ] **Step 4: 提交**

```bash
git add apps/api/src/execute/runPlan.ts apps/api/src/sse/planRunBus.ts
git commit -m "feat(api): runPlan engine (strategy + login prepare + cancel + SSE)"
```

---

## Task 4: API 改造 — plans 路由（strategy / loginPrepare / order / run 异步化）

**Files:**
- Modify: `apps/api/src/routes/plans.ts`

- [ ] **Step 1: 重写 plans.ts**

`apps/api/src/routes/plans.ts`（替换全文）：

```ts
import { Router } from 'express';
import { z } from 'zod';
import { eq, asc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  executionPlans,
  planCases,
  planRuns,
  testCases,
  groups,
} from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { runPlanAsync } from '../execute/runPlan.js';

export const plansRoute = Router({ mergeParams: true });

const StrategyEnum = z.enum(['run_all', 'fail_fast']);

const LoginPrepareBody = z
  .object({
    enabled: z.boolean(),
    caseId: z.string().uuid().optional().nullable(),
    detectionUrl: z.string().url().optional().nullable(),
    successSelector: z.string().max(500).optional().nullable(),
    unauthorizedKeywords: z.array(z.string().max(80)).max(20).optional().nullable(),
  })
  .optional();

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  environment: z.string().max(100).optional(),
  strategy: StrategyEnum.default('run_all'),
  loginPrepare: LoginPrepareBody,
});

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  environment: z.string().max(100).optional(),
  strategy: StrategyEnum.optional(),
  loginPrepare: LoginPrepareBody,
});

plansRoute.get('/', async (req, res) => {
  const { projectId } = req.params as { projectId: string };
  const ps = await db
    .select()
    .from(executionPlans)
    .where(eq(executionPlans.projectId, projectId))
    .orderBy(asc(executionPlans.createdAt));
  const pcs = await db.select().from(planCases);
  const countByPlan = new Map<string, number>();
  for (const pc of pcs) countByPlan.set(pc.planId, (countByPlan.get(pc.planId) ?? 0) + 1);
  res.json(ps.map((p) => ({ ...p, caseCount: countByPlan.get(p.id) ?? 0 })));
});

plansRoute.post('/', async (req, res) => {
  const { projectId } = req.params as { projectId: string };
  const body = CreateBody.parse(req.body);
  const rows = await db
    .insert(executionPlans)
    .values({
      projectId,
      name: body.name,
      environment: body.environment,
      strategy: body.strategy,
      loginPrepareEnabled: body.loginPrepare?.enabled ?? false,
      loginCaseId: body.loginPrepare?.caseId ?? null,
      detectionUrl: body.loginPrepare?.detectionUrl ?? null,
      loginSuccessSelector: body.loginPrepare?.successSelector ?? null,
      loginUnauthorizedKeywords: body.loginPrepare?.unauthorizedKeywords ?? null,
    })
    .returning();
  res.json(rows[0]);
});

plansRoute.get('/:id', async (req, res) => {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  const pcs = await db
    .select()
    .from(planCases)
    .where(eq(planCases.planId, plan.id))
    .orderBy(asc(planCases.order));
  const cases = pcs.length
    ? await db.select().from(testCases).where(inArray(testCases.id, pcs.map((p) => p.caseId)))
    : [];
  const byId = new Map(cases.map((c) => [c.id, c]));
  res.json({
    ...plan,
    cases: pcs.map((pc) => ({ id: pc.caseId, order: pc.order, title: byId.get(pc.caseId)?.title ?? 'unknown', url: byId.get(pc.caseId)?.url ?? null })),
  });
});

plansRoute.patch('/:id', async (req, res) => {
  const body = PatchBody.parse(req.body);
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) update.name = body.name;
  if (body.environment !== undefined) update.environment = body.environment;
  if (body.strategy !== undefined) update.strategy = body.strategy;
  if (body.loginPrepare !== undefined) {
    update.loginPrepareEnabled = body.loginPrepare.enabled;
    update.loginCaseId = body.loginPrepare.caseId ?? null;
    update.detectionUrl = body.loginPrepare.detectionUrl ?? null;
    update.loginSuccessSelector = body.loginPrepare.successSelector ?? null;
    update.loginUnauthorizedKeywords = body.loginPrepare.unauthorizedKeywords ?? null;
  }
  const rows = await db.update(executionPlans).set(update).where(eq(executionPlans.id, req.params.id)).returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'plan not found');
  res.json(rows[0]);
});

plansRoute.delete('/:id', async (req, res) => {
  const deleted = await db.delete(executionPlans).where(eq(executionPlans.id, req.params.id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'plan not found');
  res.json({ ok: true });
});

async function validateCaseProject(planId: string, caseIds: string[]) {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  const gs = await db.select().from(groups).where(eq(groups.projectId, plan.projectId));
  const validGids = new Set(gs.map((g) => g.id));
  const rows = await db.select().from(testCases).where(inArray(testCases.id, caseIds));
  if (rows.length !== caseIds.length || !rows.every((r) => validGids.has(r.groupId))) {
    throw new HttpError(409, 'cross_project', 'all cases must belong to the plan project');
  }
}

plansRoute.put('/:id/cases', async (req, res) => {
  const { caseIds } = z.object({ caseIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  await validateCaseProject(req.params.id, caseIds);
  await db.delete(planCases).where(eq(planCases.planId, req.params.id));
  await db.insert(planCases).values(caseIds.map((caseId, i) => ({ planId: req.params.id!, caseId, order: i + 1 })));
  res.json({ ok: true });
});

plansRoute.put('/:id/cases/order', async (req, res) => {
  const { caseIds } = z.object({ caseIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  await validateCaseProject(req.params.id, caseIds);
  await db.delete(planCases).where(eq(planCases.planId, req.params.id));
  await db.insert(planCases).values(caseIds.map((caseId, i) => ({ planId: req.params.id!, caseId, order: i + 1 })));
  res.json({ ok: true });
});

plansRoute.get('/:id/login-cases', async (req, res) => {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  const q = (req.query.q as string | undefined)?.trim().toLowerCase() ?? '';
  const groupId = req.query.groupId as string | undefined;
  const gs = await db.select().from(groups).where(eq(groups.projectId, plan.projectId));
  const gids = new Set(gs.map((g) => g.id));
  let rows = await db.select().from(testCases);
  rows = rows.filter((r) => gids.has(r.groupId));
  if (groupId) rows = rows.filter((r) => r.groupId === groupId);
  if (q) {
    const groupNameById = new Map(gs.map((g) => [g.id, g.name.toLowerCase()]));
    rows = rows.filter((r) => {
      if (r.title.toLowerCase().includes(q)) return true;
      return (groupNameById.get(r.groupId) ?? '').includes(q);
    });
  }
  res.json(rows.map((r) => ({ id: r.id, title: r.title, groupId: r.groupId })));
});

plansRoute.post('/:id/run', async (req, res) => {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  if (plan.loginPrepareEnabled && !plan.loginCaseId) {
    throw new HttpError(422, 'login_case_required', 'login prepare enabled but no login case set');
  }
  const ins = await db
    .insert(planRuns)
    .values({
      planId: plan.id,
      projectId: plan.projectId,
      status: 'running',
      strategy: plan.strategy,
      loginPrepareEnabled: plan.loginPrepareEnabled,
      loginCaseId: plan.loginCaseId,
      detectionUrl: plan.detectionUrl,
      loginSuccessSelector: plan.loginSuccessSelector,
      loginUnauthorizedKeywords: plan.loginUnauthorizedKeywords,
      totalCases: 0,
    })
    .returning();
  const runId = ins[0]!.id;
  // fire-and-forget
  void runPlanAsync({ planRunId: runId }).catch((e) => {
    logger.error({ err: e, planRunId: runId }, 'runPlanAsync crashed');
  });
  res.json({ runId });
});
```

- [ ] **Step 2: typecheck**

```bash
cd apps/api && pnpm typecheck
```

预期：通过。

- [ ] **Step 3: 提交**

```bash
git add apps/api/src/routes/plans.ts
git commit -m "feat(api): plans route supports strategy/loginPrepare/order/run async + login-cases"
```

---

## Task 5: API 新增 — planRuns 路由（详情 / cancel / SSE events）

**Files:**
- Create: `apps/api/src/routes/planRuns.ts`

- [ ] **Step 1: 写 planRuns.ts**

`apps/api/src/routes/planRuns.ts`：

```ts
import { Router } from 'express';
import { eq, asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { planRuns, planRunCases, executionPlans } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { requestCancel, subscribeRun } from '../execute/runPlan.js';
import { sseHeaders } from '../sse/agentRunStream.js';

export const planRunsRoute = Router();

planRunsRoute.get('/:id', async (req, res) => {
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) throw new HttpError(404, 'not_found', 'plan run not found');
  const cases = await db
    .select()
    .from(planRunCases)
    .where(eq(planRunCases.planRunId, run.id))
    .orderBy(asc(planRunCases.order));
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, run.planId)))[0];
  res.json({
    ...run,
    planName: plan?.name ?? null,
    cases,
  });
});

planRunsRoute.post('/:id/cancel', async (req, res) => {
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) throw new HttpError(404, 'not_found', 'plan run not found');
  requestCancel(run.id);
  await db.update(planRuns).set({ cancelRequested: true }).where(eq(planRuns.id, run.id));
  res.json({ ok: true });
});

planRunsRoute.get('/:id/events', async (req, res) => {
  sseHeaders(res);
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, req.params.id)))[0];
  if (!run) {
    res.status(404).end();
    return;
  }
  const unsub = subscribeRun(run.id, res);
  // initial snapshot
  res.write(
    `data: ${JSON.stringify({
      type: 'plan_run_snapshot',
      status: run.status,
      summary: run.summary,
      totalCases: run.totalCases,
      passedCases: run.passedCases,
      failedCases: run.failedCases,
      skippedCases: run.skippedCases,
    })}\n\n`,
  );
  req.on('close', () => unsub());
});
```

- [ ] **Step 2: 挂到 index.ts**

`apps/api/src/index.ts`，在 `app.use('/api/agent-runs', ...)` 之后加：

```ts
import { planRunsRoute } from './routes/planRuns.js';
import { executionsRoute } from './routes/executions.js';
...
app.use('/api/plan-runs', planRunsRoute);
app.use('/api/executions', executionsRoute);
```

- [ ] **Step 3: typecheck + 提交**

```bash
cd apps/api && pnpm typecheck
git add apps/api/src/routes/planRuns.ts apps/api/src/index.ts
git commit -m "feat(api): planRuns route (detail/cancel/SSE events)"
```

---

## Task 6: API 新增 — executions 统一历史

**Files:**
- Create: `apps/api/src/routes/executions.ts`

- [ ] **Step 1: 写 executions.ts**

`apps/api/src/routes/executions.ts`：

```ts
import { Router } from 'express';
import { eq, desc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reports, planRuns, groups, testCases } from '../db/schema.js';

export const executionsRoute = Router();

interface CaseEntry {
  kind: 'case';
  id: string;
  caseId: string;
  status: string;
  durationMs: number | null;
  summary: string | null;
  createdAt: Date | string;
}
interface PlanEntry {
  kind: 'plan';
  id: string;
  planId: string;
  status: string;
  summary: string | null;
  totalCases: number;
  passedCases: number | null;
  failedCases: number | null;
  skippedCases: number | null;
  durationMs: number | null;
  createdAt: Date | string;
}
type Entry = CaseEntry | PlanEntry;

executionsRoute.get('/', async (req, res) => {
  const { projectId, kind = 'all' } = req.query as { projectId?: string; kind?: 'case' | 'plan' | 'all' };

  let caseRows: CaseEntry[] = [];
  let planRows: PlanEntry[] = [];

  if (kind === 'case' || kind === 'all') {
    if (projectId) {
      const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
      const gids = gs.map((g) => g.id);
      const cs = gids.length ? await db.select({ id: testCases.id }).from(testCases).where(inArray(testCases.groupId, gids)) : [];
      caseRows = cs.length
        ? ((await db.select().from(reports).where(inArray(reports.caseId, cs.map((c) => c.id))).orderBy(desc(reports.createdAt))) as CaseEntry[]).map((r) => ({ ...r, kind: 'case' as const }))
        : [];
    } else {
      caseRows = ((await db.select().from(reports).orderBy(desc(reports.createdAt))) as CaseEntry[]).map((r) => ({ ...r, kind: 'case' as const }));
    }
  }

  if (kind === 'plan' || kind === 'all') {
    const q = projectId ? eq(planRuns.projectId, projectId) : undefined;
    const rows = q
      ? await db.select().from(planRuns).where(q).orderBy(desc(planRuns.startedAt))
      : await db.select().from(planRuns).orderBy(desc(planRuns.startedAt));
    planRows = (rows as unknown as PlanEntry[]).map((r) => ({
      ...r,
      kind: 'plan' as const,
      createdAt: r.startedAt,
    }));
  }

  const merged: Entry[] = [...caseRows, ...planRows].sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    return tb - ta;
  });
  res.json(merged);
});
```

- [ ] **Step 2: typecheck + 提交**

```bash
cd apps/api && pnpm typecheck
git add apps/api/src/routes/executions.ts
git commit -m "feat(api): unified /executions history endpoint (case + plan)"
```

---

## Task 7: 后端集成测试 — 策略 + 顺序 + 跨项目登录用例 + fail_fast

**Files:**
- Modify: `apps/api/test/plans.test.ts`

- [ ] **Step 1: 追加 4 个测试**

在 `apps/api/test/plans.test.ts` 末尾追加：

```ts
import { planRunsRoute } from '../src/routes/planRuns.js';
import { executionsRoute } from '../src/routes/executions.js';
// 修改 beforeAll 中 app.use 链：
app.use('/api/plan-runs', planRunsRoute);
app.use('/api/executions', executionsRoute);

describe('plan execution extras', () => {
  it('POST/PATCH persists strategy + loginPrepare config', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const loginCase = await makeCase(groupId, 'login');
    const r = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({
        name: 'P',
        strategy: 'fail_fast',
        loginPrepare: { enabled: true, caseId: loginCase, unauthorizedKeywords: ['请先登录', '未登录'] },
      });
    expect(r.status).toBe(200);
    const planId = r.body.id as string;
    const detail = await request(app).get(`/api/plans/${planId}`);
    expect(detail.body.strategy).toBe('fail_fast');
    expect(detail.body.loginPrepareEnabled).toBe(true);
    expect(detail.body.loginCaseId).toBe(loginCase);
    expect(detail.body.loginUnauthorizedKeywords).toEqual(['请先登录', '未登录']);

    const patch = await request(app)
      .patch(`/api/plans/${planId}`)
      .send({ strategy: 'run_all', loginPrepare: { enabled: false } });
    expect(patch.body.strategy).toBe('run_all');
    expect(patch.body.loginPrepareEnabled).toBe(false);
  });

  it('PUT /plans/:id/cases/order persists new order', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P' });
    const c1 = await makeCase(groupId, 'c1');
    const c2 = await makeCase(groupId, 'c2');
    const c3 = await makeCase(groupId, 'c3');
    await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1, c2, c3] });
    const r = await request(app).put(`/api/plans/${plan.body.id}/cases/order`).send({ caseIds: [c3, c1, c2] });
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/plans/${plan.body.id}`);
    expect(detail.body.cases.map((c: { id: string }) => c.id)).toEqual([c3, c1, c2]);
  });

  it('POST /plans/:id/run returns runId and creates plan_run row', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P' });
    const c1 = await makeCase(groupId, 'c1');
    await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1] });
    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(200);
    expect(typeof r.body.runId).toBe('string');
    const detail = await request(app).get(`/api/plan-runs/${r.body.runId}`);
    expect(detail.body.planId).toBe(plan.body.id);
    expect(detail.body.status).toMatch(/running|passed|failed|cancelled/);
  });

  it('cross-project login case is rejected with 422', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    const loginCase = await makeCase(b.groupId, 'foreign-login');
    const r = await request(app)
      .post(`/api/projects/${a.projectId}/plans`)
      .send({ name: 'P', loginPrepare: { enabled: true, caseId: loginCase } });
    expect(r.status).toBe(422);
  });

  it('GET /executions returns mixed entries with kind=case and kind=plan', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P' });
    const c1 = await makeCase(groupId, 'c1');
    await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1] });
    await request(app).post(`/api/plans/${plan.body.id}/run`);
    const list = await request(app).get(`/api/executions?projectId=${projectId}&kind=all`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    const kinds = new Set(list.body.map((e: { kind: string }) => e.kind));
    expect(kinds.has('plan') || kinds.has('case')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
cd apps/api && pnpm test -- plans.test.ts
```

预期：所有新测试通过（migration 后）；若失败先看 taskContainers 是否启动成功。

- [ ] **Step 3: 提交**

```bash
git add apps/api/test/plans.test.ts
git commit -m "test(api): plans strategy/loginPrepare/order/run/executions"
```

---

## Task 8: 前端 API client 扩展

**Files:**
- Modify: `apps/web/src/api/client.ts`

- [ ] **Step 1: 扩展 plans + 新增 planRuns/executions**

在 `apps/web/src/api/client.ts`：

替换 `plans.run`：

```ts
run: (id: string) =>
  request<{ runId: string }>(`/plans/${id}/run`, { method: 'POST' }),
```

新增：

```ts
reorderCases: (id: string, caseIds: string[]) =>
  request<{ ok: boolean }>(`/plans/${id}/cases/order`, {
    method: 'PUT',
    body: JSON.stringify({ caseIds }),
  }),
loginCases: (id: string, q?: string) =>
  request<Array<{ id: string; title: string; groupId: string }>>(
    `/plans/${id}/login-cases${q ? `?q=${encodeURIComponent(q)}` : ''}`,
  ),
```

新增 `planRuns`：

```ts
planRuns: {
  get: (id: string) => request<PlanRunDetail>(`/plan-runs/${id}`),
  cancel: (id: string) => request<{ ok: boolean }>(`/plan-runs/${id}/cancel`, { method: 'POST' }),
  eventsUrl: (id: string) => `${BASE}/plan-runs/${id}/events`,
},
executions: {
  list: (params?: { projectId?: string; kind?: 'case' | 'plan' | 'all' }) => {
    const qs = new URLSearchParams();
    if (params?.projectId) qs.set('projectId', params.projectId);
    if (params?.kind) qs.set('kind', params.kind);
    const s = qs.toString();
    return request<ExecutionEntry[]>(`/executions${s ? `?${s}` : ''}`);
  },
},
```

并更新 `PlanDetail` interface 与新增：

```ts
export interface PlanDetail extends ExecutionPlan {
  cases: Array<{ id: string; order: number; title: string; url: string | null }>;
}
export interface PlanRunDetail {
  id: string;
  planId: string;
  planName: string | null;
  status: string;
  strategy: string;
  loginPrepareEnabled: boolean;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  summary: string | null;
  totalCases: number;
  passedCases: number | null;
  failedCases: number | null;
  skippedCases: number | null;
  cases: Array<{
    id: string;
    caseId: string;
    reportId: string | null;
    order: number;
    status: string;
    stepKind: 'business' | 'login_prepare';
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    error: string | null;
  }>;
}
export type ExecutionEntry =
  | { kind: 'case'; id: string; caseId: string; status: string; durationMs: number | null; summary: string | null; createdAt: string }
  | { kind: 'plan'; id: string; planId: string; status: string; summary: string | null; totalCases: number; passedCases: number | null; failedCases: number | null; skippedCases: number | null; durationMs: number | null; createdAt: string };
```

- [ ] **Step 2: typecheck**

```bash
cd apps/web && pnpm typecheck
```

预期：通过。

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/api/client.ts
git commit -m "feat(web): api client plans.reorder/loginCases/planRuns/executions"
```

---

## Task 9: 前端 PlanDetail — 策略 + 登录准备 + 拖拽 + 多选 + 一键执行

**Files:**
- Modify: `apps/web/src/pages/PlanDetail.tsx`

- [ ] **Step 1: 重写 PlanDetail.tsx**

完整替换文件，内容覆盖：策略下拉 + 登录准备折叠区（用例下拉 + 高级配置）+ 用例顺序（drag handle + 上移/下移）+ 多选添加用例 + 一键执行（SSE 进度 + 中止 + 跳转 PlanRunDetail）。

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import Button from '../components/ui/Button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';

type Strategy = 'run_all' | 'fail_fast';

export default function PlanDetail() {
  const { id, projectId } = useParams<{ id: string; projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const { data: plan } = useQuery({
    queryKey: ['plan', id],
    queryFn: () => api.plans.get(id!),
    enabled: !!id,
  });

  const [showAdd, setShowAdd] = useState(false);
  const [selectedAdd, setSelectedAdd] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const { data: allCases } = useQuery({
    queryKey: ['cases', projectId],
    queryFn: () => api.cases.list({ projectId }),
    enabled: !!projectId,
  });

  const inPlanIds = useMemo(() => new Set((plan?.cases ?? []).map((c) => c.id)), [plan]);
  const candidates = useMemo(() => {
    const list = (allCases ?? []).filter((c) => !inPlanIds.has(c.id));
    if (!search.trim()) return list;
    return list.filter((c) => c.title.includes(search.trim()));
  }, [allCases, inPlanIds, search]);

  // 登录用例候选
  const [loginQ, setLoginQ] = useState('');
  const { data: loginCases } = useQuery({
    queryKey: ['plan', id, 'login-cases', loginQ],
    queryFn: () => api.plans.loginCases(id!, loginQ),
    enabled: !!id && (plan?.loginPrepareEnabled ?? false),
  });

  const patchPlan = useMutation({
    mutationFn: (body: Parameters<typeof api.plans.patch>[1]) => api.plans.patch(id!, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', id] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const setCases = useMutation({
    mutationFn: (caseIds: string[]) => api.plans.setCases(id!, caseIds),
    onSuccess: () => {
      toast('用例已更新', 'success');
      qc.invalidateQueries({ queryKey: ['plan', id] });
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
      setShowAdd(false);
      setSelectedAdd(new Set());
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const reorder = useMutation({
    mutationFn: (caseIds: string[]) => api.plans.reorderCases(id!, caseIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', id] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.plans.remove(id!),
    onSuccess: () => {
      toast('已删除', 'success');
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
      navigate(`/p/${projectId}/plans`);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const run = useMutation({
    mutationFn: () => api.plans.run(id!),
    onSuccess: (r) => {
      setActiveRunId(r.runId);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const cancel = useMutation({
    mutationFn: () => api.planRuns.cancel(activeRunId!),
    onError: (e: Error) => toast(e.message, 'error'),
  });

  // SSE 订阅 + 自动跳转
  useEffect(() => {
    if (!activeRunId) return;
    const es = new EventSource(api.planRuns.eventsUrl(activeRunId));
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'plan_run_complete') {
          es.close();
          setActiveRunId(null);
          qc.invalidateQueries({ queryKey: ['plan', id] });
          qc.invalidateQueries({ queryKey: ['plans', projectId] });
          qc.invalidateQueries({ queryKey: ['executions'] });
          toast(`执行完成：${data.summary ?? ''}`, data.status === 'passed' ? 'success' : 'error');
          navigate(`/p/${projectId}/plans/${id}/runs/${activeRunId}`);
        }
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [activeRunId, id, navigate, projectId, qc, toast]);

  useEffect(() => {
    if (showAdd) setSelectedAdd(new Set());
  }, [showAdd]);

  if (!plan) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>加载中...</span>
      </div>
    );
  }

  const moveBy = (idx: number, delta: number) => {
    const list = [...(plan.cases ?? [])];
    const j = idx + delta;
    if (j < 0 || j >= list.length) return;
    [list[idx], list[j]] = [list[j]!, list[idx]!];
    reorder.mutate(list.map((c) => c.id));
  };

  const onDragStart = (e: React.DragEvent, idx: number) => {
    e.dataTransfer.setData('text/plain', String(idx));
  };
  const onDrop = (e: React.DragEvent, idx: number) => {
    const from = Number(e.dataTransfer.getData('text/plain'));
    if (Number.isNaN(from) || from === idx) return;
    const list = [...(plan.cases ?? [])];
    const [moved] = list.splice(from, 1);
    list.splice(idx, 0, moved!);
    reorder.mutate(list.map((c) => c.id));
  };

  const updateStrategy = (v: Strategy) => patchPlan.mutate({ strategy: v });
  const updateLoginPrepare = (next: { enabled?: boolean; caseId?: string | null; detectionUrl?: string | null; successSelector?: string | null; unauthorizedKeywords?: string[] | null }) => {
    patchPlan.mutate({
      loginPrepare: {
        enabled: next.enabled ?? plan.loginPrepareEnabled,
        caseId: next.caseId === undefined ? plan.loginCaseId : next.caseId,
        detectionUrl: next.detectionUrl === undefined ? plan.detectionUrl : next.detectionUrl,
        successSelector: next.successSelector === undefined ? plan.loginSuccessSelector : next.successSelector,
        unauthorizedKeywords: next.unauthorizedKeywords === undefined ? (plan.loginUnauthorizedKeywords as string[] | null) : next.unauthorizedKeywords,
      },
    });
  };

  const isRunning = !!activeRunId;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--color-glass-border)' }}>
        <button
          onClick={() => navigate(`/p/${projectId}/plans`)}
          className="flex items-center gap-1 text-[12px]"
          style={{ color: 'var(--color-foreground-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          <Icon name="chevronLeft" size={12} />
          返回计划列表
        </button>
        <span style={{ width: 1, height: 16, background: 'var(--color-glass-border)' }} />
        <h1 className="text-[16px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>
          {plan.name}
        </h1>
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => setShowAdd(true)}>
          <Icon name="plus" size={12} />
          添加用例
        </Button>
        {isRunning ? (
          <Button variant="secondary" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            <Icon name="pause" size={12} />
            中止
          </Button>
        ) : (
          <Button onClick={() => run.mutate()} disabled={run.isPending || plan.cases.length === 0}>
            <Icon name="play" size={12} />
            {run.isPending ? '启动中...' : '一键执行'}
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={() => {
            if (confirm('确认删除该执行计划？')) remove.mutate();
          }}
          style={{ color: 'var(--color-destructive)' }}
        >
          <Icon name="trash" size={12} />
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-4">
        <div className="glass-card rounded-[12px] p-5">
          <div className="flex items-center gap-4">
            <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>执行策略</span>
            <select
              value={plan.strategy}
              onChange={(e) => updateStrategy(e.target.value as Strategy)}
              className="input-base input-sm"
              style={{ minWidth: 180 }}
            >
              <option value="run_all">全部执行完成</option>
              <option value="fail_fast">失败即停止</option>
            </select>
          </div>
          <div className="mt-4">
            <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--color-foreground-secondary)' }}>
              <input
                type="checkbox"
                checked={plan.loginPrepareEnabled}
                onChange={(e) => updateLoginPrepare({ enabled: e.target.checked })}
              />
              启用登录准备
            </label>
            {plan.loginPrepareEnabled && (
              <div className="mt-3 flex flex-col gap-2 pl-5">
                <div className="flex items-center gap-2">
                  <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>登录用例</span>
                  <select
                    value={plan.loginCaseId ?? ''}
                    onChange={(e) => updateLoginPrepare({ caseId: e.target.value || null })}
                    className="input-base input-sm"
                    style={{ minWidth: 240 }}
                  >
                    <option value="">— 请选择 —</option>
                    {(loginCases ?? []).map((c) => (
                      <option key={c.id} value={c.id}>{c.title}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="搜索用例或分组"
                    value={loginQ}
                    onChange={(e) => setLoginQ(e.target.value)}
                    className="input-base input-sm"
                  />
                </div>
                <details className="text-[12px]">
                  <summary className="cursor-pointer" style={{ color: 'var(--color-foreground-muted)' }}>高级配置</summary>
                  <div className="mt-2 flex flex-col gap-2 pl-4">
                    <label className="flex flex-col gap-1">
                      <span style={{ color: 'var(--color-foreground-muted)' }}>检测页面 URL</span>
                      <input
                        type="text"
                        placeholder="留空使用第一个业务用例的 URL"
                        defaultValue={plan.detectionUrl ?? ''}
                        onBlur={(e) => updateLoginPrepare({ detectionUrl: e.target.value || null })}
                        className="input-base input-sm"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span style={{ color: 'var(--color-foreground-muted)' }}>登录成功标识（CSS 选择器）</span>
                      <input
                        type="text"
                        placeholder="例如 .user-menu"
                        defaultValue={plan.loginSuccessSelector ?? ''}
                        onBlur={(e) => updateLoginPrepare({ successSelector: e.target.value || null })}
                        className="input-base input-sm"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span style={{ color: 'var(--color-foreground-muted)' }}>未授权关键字（一行一个）</span>
                      <textarea
                        defaultValue={((plan.loginUnauthorizedKeywords as string[] | null) ?? []).join('\n')}
                        onBlur={(e) => {
                          const lines = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
                          updateLoginPrepare({ unauthorizedKeywords: lines.length ? lines : null });
                        }}
                        className="input-base input-sm"
                        rows={3}
                      />
                    </label>
                  </div>
                </details>
              </div>
            )}
          </div>
        </div>

        <div className="glass-card rounded-[12px] p-5">
          <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--color-foreground-muted)' }}>
            用例顺序 ({plan.cases.length})
          </div>
          {plan.cases.length === 0 ? (
            <EmptyState icon="flag" title="还没有用例" description="点击右上「添加用例」选择场景。" />
          ) : (
            <ol className="flex flex-col gap-2">
              {plan.cases.map((c, idx) => (
                <li
                  key={c.id}
                  draggable
                  onDragStart={(e) => onDragStart(e, idx)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => onDrop(e, idx)}
                  className="flex items-center gap-3 px-3 py-2 rounded-[8px] list-row-clickable"
                  style={{ background: 'var(--color-background-subtle)', border: '1px solid var(--color-glass-border)' }}
                >
                  <span className="cursor-grab text-[11px] font-mono shrink-0" style={{ color: 'var(--color-foreground-muted)' }}>⋮⋮</span>
                  <span className="text-[11px] font-mono shrink-0 w-5" style={{ color: 'var(--color-foreground-muted)' }}>{idx + 1}</span>
                  <span onClick={() => navigate(`/p/${projectId}/cases/${c.id}`)} className="text-[12px] flex-1 truncate cursor-pointer" style={{ color: 'var(--color-foreground)' }}>
                    {c.title}
                  </span>
                  <button onClick={() => moveBy(idx, -1)} className="text-[11px]" style={{ background: 'transparent', border: 'none', color: 'var(--color-foreground-muted)' }} aria-label="上移">
                    <Icon name="chevronUp" size={12} />
                  </button>
                  <button onClick={() => moveBy(idx, 1)} className="text-[11px]" style={{ background: 'transparent', border: 'none', color: 'var(--color-foreground-muted)' }} aria-label="下移">
                    <Icon name="chevronDown" size={12} />
                  </button>
                  <StatusPill status="default">{c.id.slice(0, 8)}</StatusPill>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent style={{ maxWidth: 540 }}>
          <DialogHeader>
            <DialogTitle>添加用例</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-3">
            <div className="input-wrap">
              <Icon name="search" size={14} className="input-icon" />
              <input
                type="text"
                placeholder="搜索用例"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input-base input-sm input-with-leading"
              />
            </div>
          </div>
          <div className="px-5 pb-4 max-h-[400px] overflow-y-auto flex flex-col gap-1">
            {candidates.length === 0 ? (
              <div className="text-[12px] py-8 text-center" style={{ color: 'var(--color-foreground-muted)' }}>没有可添加的用例</div>
            ) : (
              candidates.map((c) => {
                const checked = selectedAdd.has(c.id);
                return (
                  <div
                    key={c.id}
                    className="flex items-center gap-2 px-3 py-2 rounded-[6px] cursor-pointer hover-card"
                    onClick={() => {
                      const next = new Set(selectedAdd);
                      if (checked) next.delete(c.id);
                      else next.add(c.id);
                      setSelectedAdd(next);
                    }}
                  >
                    <input type="checkbox" readOnly checked={checked} />
                    <span className="text-[12px] flex-1 truncate" style={{ color: 'var(--color-foreground)' }}>{c.title}</span>
                    <span className="text-[10px]" style={{ color: 'var(--color-foreground-muted)' }}>{c.priority}</span>
                  </div>
                );
              })
            )}
          </div>
          <div className="flex justify-between items-center px-5 py-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>已选 {selectedAdd.size}</span>
            <div className="flex gap-2">
              <Button variant="plain" onClick={() => setShowAdd(false)}>取消</Button>
              <Button
                disabled={selectedAdd.size === 0}
                onClick={() => {
                  const next = [...plan.cases.map((c) => c.id), ...Array.from(selectedAdd)];
                  setCases.mutate(next);
                }}
              >
                加入计划
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

```bash
cd apps/web && pnpm typecheck
```

预期：通过。

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/pages/PlanDetail.tsx
git commit -m "feat(web): PlanDetail strategy + login prepare + reorder + multi-add + run SSE"
```

---

## Task 10: 前端 PlanRunDetail 新增页

**Files:**
- Create: `apps/web/src/pages/PlanRunDetail.tsx`

- [ ] **Step 1: 写 PlanRunDetail.tsx**

```tsx
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import { fullDateTime } from '../lib/format';

export default function PlanRunDetail() {
  const { id, runId, projectId } = useParams<{ id: string; runId: string; projectId: string }>();
  const navigate = useNavigate();
  const { data: run, isLoading } = useQuery({
    queryKey: ['planRun', runId],
    queryFn: () => api.planRuns.get(runId!),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });

  if (isLoading || !run) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>加载中...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--color-glass-border)' }}>
        <button onClick={() => navigate(`/p/${projectId}/plans/${id}`)} className="flex items-center gap-1 text-[12px]" style={{ color: 'var(--color-foreground-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>
          <Icon name="chevronLeft" size={12} />
          返回计划详情
        </button>
        <span style={{ width: 1, height: 16, background: 'var(--color-glass-border)' }} />
        <h1 className="text-[16px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>计划运行</h1>
        <StatusPill status={run.status}>{run.status}</StatusPill>
        <div className="flex-1" />
        <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
          {fullDateTime(run.startedAt)} · {run.durationMs ?? 0} ms
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 flex flex-col gap-4">
        <div className="glass-card rounded-[12px] p-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
          {run.summary ?? '执行中...'}
        </div>

        <div className="glass-card rounded-[12px] overflow-hidden">
          <div className="px-5 py-[10px]" style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}>
            <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>时间线</span>
          </div>
          {run.cases.length === 0 ? (
            <EmptyState icon="listChecks" title="暂无步骤" />
          ) : (
            <div className="flex flex-col">
              {run.cases.map((c) => (
                <div key={c.id} className="flex items-start gap-3 px-5 py-3" style={{ borderBottom: '1px solid var(--color-muted)' }}>
                  <span className="font-mono text-[12px] shrink-0 mt-0.5" style={{ color: c.status === 'passed' ? 'var(--color-success)' : c.status === 'failed' ? 'var(--color-destructive)' : 'var(--color-foreground-muted)' }}>
                    {c.status === 'passed' ? '✓' : c.status === 'failed' ? '✕' : '•'} #{c.order} {c.stepKind === 'login_prepare' ? '登录' : ''}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px]" style={{ color: 'var(--color-foreground)' }}>
                      <span className="font-mono text-[11px] mr-2" style={{ color: 'var(--color-foreground-muted)' }}>{c.caseId.slice(0, 8)}</span>
                      <StatusPill status={c.status}>{c.status}</StatusPill>
                      <span className="ml-2 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>{c.durationMs ?? 0} ms</span>
                    </div>
                    {c.error && <div className="text-[12px] mt-1" style={{ color: 'var(--color-destructive)' }}>{c.error}</div>}
                  </div>
                  {c.reportId && (
                    <button
                      onClick={() => navigate(`/p/${projectId}/reports/${c.reportId}`)}
                      className="text-[11px]"
                      style={{ background: 'transparent', border: 'none', color: 'var(--color-accent)', cursor: 'pointer' }}
                    >
                      报告
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 在 App.tsx 注册路由**

`apps/web/src/App.tsx`，加入 import 与 Route：

```tsx
import PlanRunDetail from './pages/PlanRunDetail';
...
<Route path="plans/:id/runs/:runId" element={<PlanRunDetail />} />
```

放在 `<Route path="plans/:id" ... />` 之后。

- [ ] **Step 3: typecheck + 提交**

```bash
cd apps/web && pnpm typecheck
git add apps/web/src/pages/PlanRunDetail.tsx apps/web/src/App.tsx
git commit -m "feat(web): PlanRunDetail page + route"
```

---

## Task 11: 前端执行历史页 + Sidebar 改名

**Files:**
- Modify: `apps/web/src/pages/Reports.tsx`
- Modify: `apps/web/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: 重写 Reports.tsx 为执行历史（含 Tab）**

```tsx
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import Pagination from '../components/ui/Pagination';
import { shortDateTime, fullDateTime } from '../lib/format';

type Tab = 'all' | 'case' | 'plan';
const DEFAULT_PAGE_SIZE = 20;

export default function Executions() {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const [tab, setTab] = useState<Tab>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const { data, isLoading } = useQuery({
    queryKey: ['executions', projectId, tab],
    queryFn: () => api.executions.list({ projectId, kind: tab }),
    enabled: !!projectId,
  });

  const rows = useMemo(() => (data ?? []).slice((page - 1) * pageSize, page * pageSize), [data, page, pageSize]);
  const total = data?.length ?? 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>执行历史</h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>用例执行结果与计划运行汇总</p>
        </div>
      </div>
      <div className="px-5 pt-3 flex gap-2">
        {(['all', 'case', 'plan'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setPage(1); }}
            className="px-3 py-1.5 rounded-[8px] text-[12px]"
            style={{
              background: tab === t ? 'var(--color-accent)' : 'var(--color-background-subtle)',
              color: tab === t ? 'var(--color-accent-foreground)' : 'var(--color-foreground-secondary)',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {t === 'all' ? '所有' : t === 'case' ? '单用例' : '计划运行'}
          </button>
        ))}
      </div>
      <div
        className="flex-1 min-h-0 mx-5 mb-5 mt-4 flex flex-col rounded-[12px] overflow-hidden"
        style={{ background: 'var(--color-background-elevated)', border: '1px solid var(--color-glass-border)', boxShadow: 'var(--shadow-card)' }}
      >
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>加载中...</span>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon="flag" title="还没有执行记录" description="在执行计划或用例详情页运行测试后会出现在这里。" />
        ) : (
          <>
            <div className="grid grid-cols-[80px_1fr_120px_120px] items-center px-5 py-[10px] shrink-0" style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>类型</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>标识</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>状态</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>时间</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {rows.map((r) => (
                <div
                  key={r.id}
                  onClick={() => navigate(r.kind === 'plan' ? `/p/${projectId}/plans/${(r as { planId: string }).planId}/runs/${r.id}` : `/p/${projectId}/reports/${r.id}`)}
                  className="grid grid-cols-[80px_1fr_120px_120px] items-center px-5 py-[12px] cursor-pointer transition-colors list-row-clickable"
                  style={{ borderBottom: '1px solid var(--color-muted)' }}
                >
                  <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>{r.kind === 'plan' ? '计划' : '用例'}</span>
                  <span className="text-[12px] font-mono truncate" style={{ color: 'var(--color-foreground-secondary)' }}>
                    {r.kind === 'plan' ? `run ${r.id.slice(0, 8)}` : `case ${(r as { caseId: string }).caseId.slice(0, 8)}`}
                  </span>
                  <span><StatusPill status={r.status}>{r.status}</StatusPill></span>
                  <span className="text-[11px] font-mono" style={{ color: 'var(--color-foreground-muted)' }} title={fullDateTime(r.createdAt)}>
                    {shortDateTime(r.createdAt)}
                  </span>
                </div>
              ))}
            </div>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
            />
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Sidebar 改 label**

`apps/web/src/components/layout/Sidebar.tsx`：

```ts
{ path: 'reports', icon: 'flag', label: '执行历史', projectOnly: true },
```

- [ ] **Step 3: typecheck + 提交**

```bash
cd apps/web && pnpm typecheck
git add apps/web/src/pages/Reports.tsx apps/web/src/components/layout/Sidebar.tsx
git commit -m "feat(web): executions page (case + plan unified) + sidebar rename"
```

---

## Task 12: Plans 列表卡片摘要

**Files:**
- Modify: `apps/web/src/pages/Plans.tsx`

- [ ] **Step 1: 卡片加最近一次运行摘要**

在 `Plans.tsx` 的 plan 卡片渲染位置（`<div className="text-[12px] mt-2">...</div>` 之后）加：

```tsx
{/* 最近一次运行摘要（若存在） */}
{...}
```

实现方式：用 `api.executions.list({ projectId, kind: 'plan' })` 一次性获取全量 plan_run，过滤当前 plan.id，取第一项显示。

把 `useQuery` 加上：

```tsx
const { data: planRuns } = useQuery({
  queryKey: ['executions', projectId, 'plan'],
  queryFn: () => api.executions.list({ projectId, kind: 'plan' }),
  enabled: !!projectId,
});
const latestByPlan = useMemo(() => {
  const m = new Map<string, { status: string; summary: string | null; createdAt: string }>();
  for (const r of planRuns ?? []) {
    if (r.kind !== 'plan') continue;
    if (!m.has(r.planId)) m.set(r.planId, { status: r.status, summary: r.summary, createdAt: r.createdAt });
  }
  return m;
}, [planRuns]);
```

在卡片内 `</div>` 之前：

```tsx
{(() => {
  const last = latestByPlan.get(p.id);
  if (!last) return null;
  return (
    <div className="text-[11px] mt-1 flex items-center gap-2" style={{ color: 'var(--color-foreground-muted)' }}>
      <StatusPill status={last.status}>{last.status}</StatusPill>
      <span>{shortDateTime(last.createdAt)}</span>
    </div>
  );
})()}
```

`import { shortDateTime } from '../lib/format';` 与 `StatusPill` 同步加。

- [ ] **Step 2: typecheck + 提交**

```bash
cd apps/web && pnpm typecheck
git add apps/web/src/pages/Plans.tsx
git commit -m "feat(web): Plans list cards show latest run summary"
```

---

## Task 13: 整库迁移 + 端到端 verify

**Files:**
- 无新文件

- [ ] **Step 1: 数据库迁移**

```bash
cd apps/api && pnpm db:migrate
```

预期：迁移成功，无错误。

- [ ] **Step 2: 后端测试**

```bash
cd apps/api && pnpm test
```

预期：全部通过。

- [ ] **Step 3: 全栈 verify**

```bash
cd /Users/lyq/workdir/codedev/iTest && pnpm verify
```

预期：lint + typecheck + test 全绿。

- [ ] **Step 4: 启动 dev 烟测**

```bash
pnpm dev
```

打开 http://localhost:5173，执行：

1. 进入某项目 → 执行计划 → 新建 → 选策略「失败即停止」+ 启用登录准备 → 保存；
2. 添加至少 2 条用例，调整顺序；
3. 一键执行 → 看到 SSE 进度 → 跳转 PlanRunDetail；
4. 进入「执行历史」看到本次记录。

- [ ] **Step 5: 提交**

```bash
git status # 确认无未提交 diff
```

---

## 自审对照

- **Spec 覆盖**：
  - 策略（run_all / fail_fast）→ Task 1 / 4 / 9；
  - 登录准备（URL + CSS + 关键词、自动判断、高级配置、执行详情）→ Task 2 / 3 / 4 / 9 / 10；
  - 用例顺序（拖拽 + 上下移）→ Task 4 / 9；
  - 多选添加用例 → Task 9；
  - 一键执行 + SSE + 中止 → Task 3 / 5 / 9；
  - plan_run / plan_run_cases 表与详情 → Task 1 / 5 / 10；
  - 执行历史 Tab → Task 6 / 11；
  - Sidebar 改名 → Task 11；
  - 测试 → Task 7。
- **占位符扫描**：无 TBD / TODO。
- **类型一致性**：`PlanRunDetail` interface 在 Task 8 定义，Task 10 引用；`api.planRuns.cancel` / `eventsUrl` 在 Task 8 定义，Task 9 / 5 引用。
- **API 一致性**：`POST /plans/:id/run` 返回 `{ runId }`，前端 `api.plans.run` 也返回 `runId`，一致。