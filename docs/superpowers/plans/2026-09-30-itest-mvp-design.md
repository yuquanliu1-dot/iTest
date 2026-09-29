# iTest MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 iTest 自动化测试平台 MVP 框架，端到端跑通需求→用例→脚本→录制补充→执行报告五条链路（Agent 输出与脚本执行均为 Mock）。

**Architecture:** Turborepo monorepo。`apps/api`（Node + Express + Drizzle + PG）暴露 REST + SSE + WebSocket，`apps/web`（React + Vite + Tailwind v4）作为中台，`apps/recorder`（Manifest V3 Chrome 扩展）通过 WS 推录制步骤到后端，`packages/shared` 装步骤 DSL 与 Zod schema，`packages/ui` 装设计令牌与共享组件。Agent 调用走自研 `Workflow = Steps[]` 模型，LLM provider 可切换（mock/openai/anthropic/google）。

**Tech Stack:** Node 22 + TypeScript 5.6+、React 18、Vite 5、Tailwind v4、Radix UI、Drizzle ORM、PostgreSQL 16、ioredis、Zustand、Vitest、ws、Express 5（执行时从 4 升级：Express 4 不转发 async handler 错误，Task 14 测试证实必需）、Zod、pino。

**Spec:** `docs/superpowers/specs/2026-09-30-itest-mvp-design.md`

**端口约定：** API `127.0.0.1:54321`、Web `127.0.0.1:5173`、PostgreSQL `127.0.0.1:5432`（容器映射）、Redis `127.0.0.1:6379`。

---

## 文件结构总览

**根级配置（Task 1-3）**：`package.json`、`turbo.json`、`tsconfig.base.json`、`infra/docker-compose.yml`、`.env.example`、`.gitignore`

**packages/shared（Task 4-6）**：`packages/shared/{package.json,tsconfig.json,src/step-dsl.ts,src/index.ts,test/step-dsl.test.ts}`

**packages/ui（Task 7-9）**：`packages/ui/{package.json,tsconfig.json,src/index.ts,src/tokens.css,src/glass.css}`

**apps/api（Task 10-25）**：详见各 Task 文件清单

**apps/web（Task 26-37）**：详见各 Task 文件清单

**apps/recorder（Task 38-43）**：详见各 Task 文件清单

**文档（Task 44）**：`README.md`

---

## Task 顺序

10 个里程碑，44 个 Task，按"基础 → 后端骨架 → 数据层 → Agent → API → 前端 → 录制器 → 收尾"组织。

| Milestone | Task | 目标 |
|---|---|---|
| M1 仓库骨架 | 1-3 | workspaces 跑通，docker 起 PG/Redis |
| M2 共享包 | 4-9 | DSL 类型 + 设计令牌可用 |
| M3 后端骨架 | 10-13 | Express 起，schema 迁移，错误中间件 |
| M4 业务路由 | 14-18 | settings/requirements/cases/reports CRUD 完整 |
| M5 Agent | 19-22 | 两个 Workflow + Mock LLM provider |
| M6 录制后端 | 23-25 | WS + Mock 执行 + 报告写入 |
| M7 前端骨架 | 26-30 | Vite 起，AppShell + 路由 + Settings 页 |
| M8 前端业务 | 31-37 | 需求/用例/报告页 + Agent SSE 联动 |
| M9 录制器 | 38-43 | Manifest V3 扩展端到端 |
| M10 文档与收尾 | 44 | README、verify 全绿 |

---

## M1 仓库骨架（Task 1-3）

### Task 1: 初始化 Turborepo + npm workspaces

**Files:**

- Create: `package.json`、`turbo.json`、`tsconfig.base.json`、`.gitignore`、`.env.example`

- [ ] **Step 1: 根 `package.json`**

```json
{
  "name": "itest",
  "private": true,
  "version": "0.0.1",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "turbo run dev --parallel",
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "verify": "pnpm run lint && pnpm run typecheck && pnpm run test"
  },
  "devDependencies": {
    "turbo": "^2.3.0",
    "typescript": "^5.6.3"
  },
  "packageManager": "pnpm@9.12.0"
}
```

- [ ] **Step 2: `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "dev": { "cache": false, "persistent": true },
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["build"] },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

- [ ] **Step 3: `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true
  }
}
```

- [ ] **Step 4: `.gitignore`**

```
node_modules
dist
.turbo
.env
.env.local
*.log
coverage
.DS_Store
apps/api/screenshots
```

- [ ] **Step 5: `.env.example`**

```
DATABASE_URL=postgres://itest:itest@localhost:5432/itest
REDIS_URL=redis://localhost:6379
API_PORT=54321
WEB_PORT=5173
RECORDER_TOKEN_SECRET=dev-secret-change-me
LLM_PROVIDER=mock
LLM_API_KEY=
LLM_MODEL=
```

- [ ] **Step 6: 安装并提交**

```bash
cd /Users/lyq/workdir/codedev/iTest
pnpm install
git add -A && git commit -m "chore: initialize turborepo workspaces"
```

---

### Task 2: docker-compose 起 PG + Redis

**Files:**

- Create: `infra/docker-compose.yml`

- [ ] **Step 1: 创建 `infra/docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: itest-pg
    environment:
      POSTGRES_USER: itest
      POSTGRES_PASSWORD: itest
      POSTGRES_DB: itest
    ports:
      - "5432:5432"
    volumes:
      - itest-pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U itest"]
      interval: 2s
      timeout: 5s
      retries: 20
  redis:
    image: redis:7-alpine
    container_name: itest-redis
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 5s
      retries: 20
volumes:
  itest-pg-data:
```

- [ ] **Step 2: 启动并验证**

```bash
cd /Users/lyq/workdir/codedev/iTest
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
docker exec itest-pg psql -U itest -d itest -c "SELECT 1;"
```

期望：两个服务 `running`，SQL 返回 `1`。

- [ ] **Step 3: 提交**

```bash
git add infra/docker-compose.yml
git commit -m "chore: add docker-compose for postgres and redis"
```

---

### Task 3: 验证 npm 私有包

> 已确认：plan 采用自研 Workflow 引擎，不依赖 `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai`。

**Files:** 无。

- [ ] **Step 1: 探测 npm 包可见性（仅记录）**

```bash
npm view @earendil-works/pi-agent-core version 2>&1 | head -5
npm view @earendil-works/pi-ai version 2>&1 | head -5
```

- [ ] **Step 2: 决策记录（无论是否可用）**

若不可用，写：

```bash
mkdir -p docs/superpowers/decisions
cat > docs/superpowers/decisions/pi-agent-core-unavailable.md <<'EOF'
# 决策：跳过 pi-agent-core，使用自研 Workflow 引擎

**原因**：本 plan 自始即采用自研最小 `LLMClient` + `runWorkflow` 引擎（见 Task 19、20），
不依赖 `@earendil-works/pi-agent-core` 或 `@earendil-works/pi-ai`。原因：
1. 私有 npm 包对外部不可访问
2. Workflow 引擎仅 ~80 行 TS，自研比外部依赖更可控
3. 后续如需替换可平滑迁移到 pi-agent-core（接口兼容 AgentTool + WorkflowSpec）
EOF
git add docs/superpowers/decisions
git commit -m "docs: record decision to use self-rolled workflow engine"
```

若可用：跳过此 Task，不提交。

---

## M2 共享包（Task 4-9）

### Task 4: 创建 `packages/shared`

**Files:** `packages/shared/{package.json,tsconfig.json,src/index.ts}`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@itest/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "zod": "^3.23.8" },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 2: `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 3: `src/index.ts`**

```ts
export * from './step-dsl.js';
```

- [ ] **Step 4: 安装并提交**

```bash
pnpm install
git add packages/shared
git commit -m "feat(shared): scaffold package"
```

---

### Task 5: 实现步骤 DSL

**Files:** `packages/shared/src/step-dsl.ts`

- [ ] **Step 1: 完整实现**

```ts
import { z } from 'zod';

export const LocatorStrategy = z.enum(['role', 'text', 'testId', 'css', 'xpath']);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

export const Locator = z.object({
  strategy: LocatorStrategy,
  value: z.string().min(1),
});
export type Locator = z.infer<typeof Locator>;

export const NavigateAction = z.object({ kind: z.literal('navigate'), url: z.string().url() });
export const ClickAction = z.object({ kind: z.literal('click'), locator: z.array(Locator).min(1) });
export const FillAction = z.object({
  kind: z.literal('fill'),
  locator: z.array(Locator).min(1),
  value: z.string(),
});
export const HoverAction = z.object({ kind: z.literal('hover'), locator: z.array(Locator).min(1) });
export const WaitForAction = z.object({
  kind: z.literal('waitFor'),
  locator: z.array(Locator).min(1),
  timeoutMs: z.number().int().positive().optional(),
});
export const AssertTextAction = z.object({
  kind: z.literal('assertText'),
  locator: z.array(Locator).min(1),
  equals: z.string(),
});
export const AssertVisibleAction = z.object({
  kind: z.literal('assertVisible'),
  locator: z.array(Locator).min(1),
});
export const ScreenshotAction = z.object({ kind: z.literal('screenshot'), name: z.string() });

export const StepAction = z.discriminatedUnion('kind', [
  NavigateAction,
  ClickAction,
  FillAction,
  HoverAction,
  WaitForAction,
  AssertTextAction,
  AssertVisibleAction,
  ScreenshotAction,
]);
export type StepAction = z.infer<typeof StepAction>;
```

- [ ] **Step 2: 提交**

```bash
git add packages/shared/src/step-dsl.ts
git commit -m "feat(shared): define step DSL types with zod"
```

---

### Task 6: step-dsl 单测

**Files:** `packages/shared/test/step-dsl.test.ts`

- [ ] **Step 1: 测试代码**

```ts
import { describe, it, expect } from 'vitest';
import { StepAction, Locator } from '../src/step-dsl.js';

describe('step-dsl', () => {
  it('accepts valid click action', () => {
    const r = StepAction.safeParse({
      kind: 'click',
      locator: [{ strategy: 'role', value: 'button[name="Submit"]' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects click action with empty locator array', () => {
    const r = StepAction.safeParse({ kind: 'click', locator: [] });
    expect(r.success).toBe(false);
  });

  it('accepts valid fill action', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'testId', value: 'email' }],
      value: 'a@b.com',
    });
    expect(r.success).toBe(true);
  });

  it('rejects fill action without value', () => {
    const r = StepAction.safeParse({
      kind: 'fill',
      locator: [{ strategy: 'testId', value: 'email' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects navigate with non-URL string', () => {
    const r = StepAction.safeParse({ kind: 'navigate', url: 'not-a-url' });
    expect(r.success).toBe(false);
  });

  it('accepts locator with all strategies', () => {
    for (const s of ['role', 'text', 'testId', 'css', 'xpath'] as const) {
      const r = Locator.safeParse({ strategy: s, value: 'foo' });
      expect(r.success).toBe(true);
    }
  });

  it('rejects locator with unknown strategy', () => {
    const r = Locator.safeParse({ strategy: 'bogus', value: 'foo' });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行**

```bash
pnpm --filter @itest/shared test
```

期望：7 个 PASS。

- [ ] **Step 3: 提交**

```bash
git add packages/shared/test
git commit -m "test(shared): add step-dsl zod schema tests"
```

---

### Task 7: 创建 `packages/ui`

**Files:** `packages/ui/{package.json,tsconfig.json,src/index.ts}`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@itest/ui",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./tokens.css": "./src/tokens.css",
    "./glass.css": "./src/glass.css"
  },
  "scripts": { "typecheck": "tsc --noEmit" },
  "peerDependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "typescript": "^5.6.3"
  }
}
```

- [ ] **Step 2: `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx" },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: `src/index.ts`**

```ts
export {};
```

- [ ] **Step 4: 安装并提交**

```bash
pnpm install
git add packages/ui
git commit -m "feat(ui): scaffold package"
```

---

### Task 8: 设计令牌

**Files:** `packages/ui/src/tokens.css`

- [ ] **Step 1: 内容**

```css
@theme {
  --color-background: #EEF0FF;
  --color-surface: rgba(255, 255, 255, 0.62);
  --color-surface-strong: rgba(255, 255, 255, 0.75);

  --color-primary: #7C5CFC;
  --color-primary-hover: #6A4AE0;
  --color-secondary: #af52de;

  --color-success: #12B76A;
  --color-destructive: #F04438;
  --color-warning: #F79009;
  --color-info: #06AED4;

  --color-text-primary: #232038;
  --color-text-secondary: #6E6A8A;
  --color-text-muted: #9B97B5;

  --font-sans: "DM Sans", "Inter", system-ui, sans-serif;
  --radius-md: 12px;
  --radius-lg: 16px;
  --shadow-glass: 0 8px 32px rgba(124, 92, 252, 0.12);
}
```

- [ ] **Step 2: 提交**

```bash
git add packages/ui/src/tokens.css
git commit -m "feat(ui): add design tokens (violet glass theme)"
```

---

### Task 9: glass-panel 工具类

**Files:** `packages/ui/src/glass.css`

- [ ] **Step 1: 内容**

```css
.glass-panel {
  background: var(--color-surface);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-glass);
}

.glass-panel-strong {
  background: var(--color-surface-strong);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-glass);
}
```

- [ ] **Step 2: 提交**

```bash
git add packages/ui/src/glass.css
git commit -m "feat(ui): add glass-panel utility classes"
```

---

## M3 后端骨架（Task 10-13）

### Task 10: `apps/api` 包结构

**Files:** `apps/api/{package.json,tsconfig.json}`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@itest/api",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "lint": "eslint src --ext .ts",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "@itest/shared": "workspace:*",
    "drizzle-orm": "^0.36.0",
    "express": "^4.21.1",
    "ioredis": "^5.4.1",
    "pg": "^8.13.1",
    "pino": "^9.5.0",
    "pino-pretty": "^11.3.0",
    "ws": "^8.18.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^10.13.2",
    "@types/express": "^5.0.0",
    "@types/node": "^22.9.0",
    "@types/pg": "^8.11.10",
    "@types/ws": "^8.5.13",
    "@types/supertest": "^6.0.2",
    "drizzle-kit": "^0.28.0",
    "eslint": "^9.14.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 2: `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: 安装并提交**

```bash
pnpm install
git add apps/api/package.json apps/api/tsconfig.json pnpm-lock.yaml
git commit -m "feat(api): scaffold package with deps"
```

---

### Task 11: Drizzle schema + 迁移

**Files:** `apps/api/drizzle.config.ts`、`apps/api/src/db/{schema.ts,client.ts}`

- [ ] **Step 1: `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://itest:itest@localhost:5432/itest',
  },
});
```

- [ ] **Step 2: `src/db/schema.ts`**

```ts
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
} from 'drizzle-orm/pg-core';

export const settings = pgTable('settings', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const requirements = pgTable('requirements', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: varchar('title', { length: 200 }).notNull(),
  content: text('content').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const testCases = pgTable('test_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  requirementId: uuid('requirement_id').references(() => requirements.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  priority: varchar('priority', { length: 20 }).notNull().default('P1'),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const testSteps = pgTable('test_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').references(() => testCases.id, { onDelete: 'cascade' }).notNull(),
  order: integer('order').notNull(),
  source: varchar('source', { length: 20 }).notNull(),
  action: jsonb('action').notNull(),
  assertion: jsonb('assertion'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  targetType: varchar('target_type', { length: 30 }).notNull(),
  targetId: uuid('target_id').notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  prompt: text('prompt').notNull(),
  result: jsonb('result'),
  error: text('error'),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  finishedAt: timestamp('finished_at'),
});

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').references(() => testCases.id, { onDelete: 'cascade' }).notNull(),
  agentRunId: uuid('agent_run_id').references(() => agentRuns.id),
  status: varchar('status', { length: 20 }).notNull(),
  durationMs: integer('duration_ms'),
  stepResults: jsonb('step_results').notNull(),
  summary: text('summary'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

- [ ] **Step 3: `src/db/client.ts`**

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const url = process.env.DATABASE_URL ?? 'postgres://itest:itest@localhost:5432/itest';
export const pool = new pg.Pool({ connectionString: url, max: 10 });
export const db = drizzle(pool, { schema });
```

- [ ] **Step 4: 生成并应用迁移**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api
pnpm db:generate
pnpm db:migrate
docker exec itest-pg psql -U itest -d itest -c "\dt"
```

期望：6 张表 `settings/requirements/test_cases/test_steps/agent_runs/reports`。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/db apps/api/drizzle.config.ts apps/api/drizzle
git commit -m "feat(api): drizzle schema and migration"
```

---

### Task 12: Logger + 错误中间件

**Files:** `apps/api/src/logger.ts`、`apps/api/src/middleware/errorHandler.ts`

- [ ] **Step 1: `src/logger.ts`**

```ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
});
```

- [ ] **Step 2: `src/middleware/errorHandler.ts`**

```ts
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../logger.js';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation_failed', details: err.flatten() });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
    return;
  }
  const pgCode = (err as { code?: string }).code;
  if (pgCode === '23505') {
    res.status(409).json({ error: 'conflict', message: (err as Error).message });
    return;
  }
  logger.error({ err, path: req.path }, 'unhandled error');
  res.status(500).json({ error: 'internal_error' });
};
```

- [ ] **Step 3: 提交**

```bash
git add apps/api/src/logger.ts apps/api/src/middleware
git commit -m "feat(api): pino logger and unified error handler"
```

---

### Task 13: Express 入口（空骨架）

**Files:** `apps/api/src/index.ts`

- [ ] **Step 1: 实现**

```ts
import express from 'express';
import { logger } from './logger.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use(errorHandler);

const port = Number(process.env.API_PORT ?? 54321);
app.listen(port, '127.0.0.1', () => {
  logger.info({ port }, 'api listening on 127.0.0.1');
});
```

- [ ] **Step 2: 验证**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api
pnpm dev &
sleep 3
curl -s http://127.0.0.1:54321/api/health
kill %1
```

期望：`{"ok":true}`

- [ ] **Step 3: 提交**

```bash
git add apps/api/src/index.ts
git commit -m "feat(api): express skeleton with /api/health"
```

---

## M4 业务路由（Task 14-18）

### Task 14: Settings KV

**Files:** `apps/api/src/routes/settings.ts`、`apps/api/test/settings.test.ts`、`apps/api/src/index.ts`

- [ ] **Step 1: 失败测试 `apps/api/test/settings.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(`
    CREATE TABLE settings (key varchar(100) PRIMARY KEY, value jsonb NOT NULL, updated_at timestamp NOT NULL DEFAULT now())
  `);
  const { default: express } = await import('express');
  const { settingsRoute } = await import('../src/routes/settings.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe('settings KV', () => {
  it('GET /api/settings returns empty initially', async () => {
    const r = await request(app).get('/api/settings');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });

  it('PUT /api/settings creates a key', async () => {
    const r = await request(app).put('/api/settings').send({ key: 'llm_provider', value: 'mock' });
    expect(r.status).toBe(200);
    expect(r.body.key).toBe('llm_provider');
  });

  it('GET /api/settings/:key returns the value', async () => {
    const r = await request(app).get('/api/settings/llm_provider');
    expect(r.status).toBe(200);
    expect(r.body.value).toBe('mock');
  });

  it('PUT same key upserts', async () => {
    await request(app).put('/api/settings').send({ key: 'llm_provider', value: 'openai' });
    const r = await request(app).get('/api/settings/llm_provider');
    expect(r.body.value).toBe('openai');
  });

  it('PUT rejects missing key', async () => {
    const r = await request(app).put('/api/settings').send({ value: 'x' });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: 运行，期望失败**

```bash
pnpm test
```

- [ ] **Step 3: 实现 `apps/api/src/routes/settings.ts`**

```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';

export const settingsRoute = Router();

const PutBody = z.object({
  key: z.string().min(1).max(100),
  value: z.unknown(),
});

settingsRoute.get('/', async (_req, res) => {
  const rows = await db.select().from(settings);
  const out: Record<string, unknown> = {};
  for (const row of rows) out[row.key] = row.value;
  res.json(out);
});

settingsRoute.get('/:key', async (req, res) => {
  const rows = await db.select().from(settings).where(eq(settings.key, req.params.key));
  if (rows.length === 0) throw new HttpError(404, 'not_found', `key ${req.params.key} not found`);
  res.json({ key: rows[0]!.key, value: rows[0]!.value, updatedAt: rows[0]!.updatedAt });
});

settingsRoute.put('/', async (req, res) => {
  const body = PutBody.parse(req.body);
  const rows = await db
    .insert(settings)
    .values({ key: body.key, value: body.value as object })
    .onConflictDoUpdate({ target: settings.key, set: { value: body.value as object, updatedAt: new Date() } })
    .returning();
  res.json({ key: rows[0]!.key, value: rows[0]!.value });
});
```

- [ ] **Step 4: 注册到 `apps/api/src/index.ts`**

```ts
import express from 'express';
import { logger } from './logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { settingsRoute } from './routes/settings.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/settings', settingsRoute);
app.use(errorHandler);

const port = Number(process.env.API_PORT ?? 54321);
app.listen(port, '127.0.0.1', () => {
  logger.info({ port }, 'api listening on 127.0.0.1');
});
```

- [ ] **Step 5: 运行，期望通过**

```bash
pnpm test
```

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/routes/settings.ts apps/api/src/index.ts apps/api/test/settings.test.ts
git commit -m "feat(api): settings KV CRUD with tests"
```

---

### Task 15: Requirements CRUD

**Files:** `apps/api/src/routes/requirements.ts`、`apps/api/test/requirements.test.ts`、`apps/api/src/index.ts`

- [ ] **Step 1: 失败测试**

```ts
// apps/api/test/requirements.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(`
    CREATE TABLE requirements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title varchar(200) NOT NULL,
      content text NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'draft',
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  const { default: express } = await import('express');
  const { requirementsRoute } = await import('../src/routes/requirements.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/requirements', requirementsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe('requirements CRUD', () => {
  it('POST creates', async () => {
    const r = await request(app).post('/api/requirements').send({ title: '登录功能', content: '手机号+密码' });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('登录功能');
    expect(r.body.id).toBeTruthy();
  });

  it('GET list returns created', async () => {
    const r = await request(app).get('/api/requirements');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBeGreaterThan(0);
  });

  it('GET /:id returns detail', async () => {
    const c = await request(app).post('/api/requirements').send({ title: '注册', content: '手机号注册' });
    const r = await request(app).get(`/api/requirements/${c.body.id}`);
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('注册');
  });

  it('POST rejects empty title', async () => {
    const r = await request(app).post('/api/requirements').send({ title: '', content: 'x' });
    expect(r.status).toBe(400);
  });

  it('GET /:id 404 for missing', async () => {
    const r = await request(app).get('/api/requirements/00000000-0000-0000-0000-000000000000');
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行，期望失败**

```bash
pnpm test requirements
```

- [ ] **Step 3: 实现 `apps/api/src/routes/requirements.ts`**

```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { requirements } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';

export const requirementsRoute = Router();

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
});

requirementsRoute.get('/', async (_req, res) => {
  const rows = await db.select().from(requirements).orderBy(requirements.createdAt);
  res.json(rows);
});

requirementsRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const rows = await db.insert(requirements).values(body).returning();
  res.json(rows[0]);
});

requirementsRoute.get('/:id', async (req, res) => {
  const rows = await db.select().from(requirements).where(eq(requirements.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'requirement not found');
  res.json(rows[0]);
});
```

- [ ] **Step 4: 注册**

在 `index.ts` 加：

```ts
import { requirementsRoute } from './routes/requirements.js';
app.use('/api/requirements', requirementsRoute);
```

- [ ] **Step 5: 运行，期望通过**

```bash
pnpm test
```

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/routes/requirements.ts apps/api/src/index.ts apps/api/test/requirements.test.ts
git commit -m "feat(api): requirements CRUD with tests"
```

---

### Task 16: Cases + Steps

**Files:** `apps/api/src/routes/cases.ts`、`apps/api/src/routes/steps.ts`、`apps/api/test/cases.test.ts`、`apps/api/src/index.ts`

- [ ] **Step 1: 失败测试**

```ts
// apps/api/test/cases.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(`
    CREATE TABLE requirements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title varchar(200) NOT NULL, content text NOT NULL, status varchar(20) NOT NULL DEFAULT 'draft', created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE test_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requirement_id uuid REFERENCES requirements(id) ON DELETE CASCADE, title varchar(200) NOT NULL, description text, priority varchar(20) NOT NULL DEFAULT 'P1', status varchar(20) NOT NULL DEFAULT 'draft', created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE test_steps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, "order" integer NOT NULL, source varchar(20) NOT NULL, action jsonb NOT NULL, assertion jsonb, created_at timestamp NOT NULL DEFAULT now());
  `);
  const { default: express } = await import('express');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { stepsRoute } = await import('../src/routes/steps.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/cases', casesRoute);
  app.use('/api/cases', stepsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe('cases + steps', () => {
  it('POST /api/cases creates', async () => {
    const r = await request(app).post('/api/cases').send({ title: '登录成功', priority: 'P1' });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('登录成功');
  });

  it('GET /api/cases/:id returns case with steps', async () => {
    const c = await request(app).post('/api/cases').send({ title: 'X' });
    const r = await request(app).get(`/api/cases/${c.body.id}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.steps)).toBe(true);
    expect(r.body.steps).toEqual([]);
  });

  it('POST /api/cases/:id/steps appends', async () => {
    const c = await request(app).post('/api/cases').send({ title: 'Y' });
    const r = await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [
        { order: 1, source: 'agent', action: { kind: 'navigate', url: 'https://example.com/login' } },
        { order: 2, source: 'agent', action: { kind: 'click', locator: [{ strategy: 'role', value: 'button[name="登录"]' }] } },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
  });

  it('POST /api/cases/:id/steps validates DSL', async () => {
    const c = await request(app).post('/api/cases').send({ title: 'Z' });
    const r = await request(app).post(`/api/cases/${c.body.id}/steps`).send({
      steps: [{ order: 1, source: 'agent', action: { kind: 'click', locator: [] } }],
    });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: 运行，期望失败**

```bash
pnpm test cases
```

- [ ] **Step 3: 实现 `apps/api/src/routes/cases.ts`**

```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testCases, testSteps } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';

export const casesRoute = Router();

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P1'),
  requirementId: z.string().uuid().optional(),
});

casesRoute.get('/', async (req, res) => {
  const priority = req.query.priority as string | undefined;
  const rows = priority
    ? await db.select().from(testCases).where(eq(testCases.priority, priority))
    : await db.select().from(testCases);
  res.json(rows);
});

casesRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const rows = await db.insert(testCases).values(body).returning();
  res.json(rows[0]);
});

casesRoute.get('/:id', async (req, res) => {
  const rows = await db.select().from(testCases).where(eq(testCases.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  const steps = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, req.params.id))
    .orderBy(asc(testSteps.order));
  res.json({ ...rows[0], steps });
});

casesRoute.patch('/:id', async (req, res) => {
  const body = CreateBody.partial().parse(req.body);
  const rows = await db
    .update(testCases)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(testCases.id, req.params.id))
    .returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  res.json(rows[0]);
});
```

- [ ] **Step 4: 实现 `apps/api/src/routes/steps.ts`**

```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testSteps, testCases } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { StepAction } from '@itest/shared';
import { HttpError } from '../middleware/errorHandler.js';

export const stepsRoute = Router();

const AppendBody = z.object({
  steps: z
    .array(
      z.object({
        order: z.number().int().nonnegative(),
        source: z.enum(['agent', 'recorder', 'manual']),
        action: StepAction,
        assertion: z.unknown().optional(),
      }),
    )
    .min(1),
});

stepsRoute.post('/:caseId/steps', async (req, res) => {
  const body = AppendBody.parse(req.body);
  const exists = await db.select().from(testCases).where(eq(testCases.id, req.params.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  const rows = await db
    .insert(testSteps)
    .values(
      body.steps.map((s) => ({
        caseId: req.params.caseId,
        order: s.order,
        source: s.source,
        action: s.action as object,
        assertion: (s.assertion ?? null) as object | null,
      })),
    )
    .returning();
  const sorted = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, req.params.caseId))
    .orderBy(asc(testSteps.order));
  res.json({ count: rows.length, steps: sorted });
});
```

- [ ] **Step 5: 注册**

```ts
import { casesRoute } from './routes/cases.js';
import { stepsRoute } from './routes/steps.js';
app.use('/api/cases', casesRoute);
app.use('/api/cases', stepsRoute);
```

- [ ] **Step 6: 运行，期望通过**

```bash
pnpm test
```

- [ ] **Step 7: 提交**

```bash
git add apps/api/src/routes/cases.ts apps/api/src/routes/steps.ts apps/api/src/index.ts apps/api/test/cases.test.ts
git commit -m "feat(api): cases and steps CRUD with DSL validation"
```

---

### Task 17: Reports 路由

**Files:** `apps/api/src/routes/reports.ts`、`apps/api/test/reports.test.ts`、`apps/api/src/index.ts`

- [ ] **Step 1: 失败测试**

```ts
// apps/api/test/reports.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(`
    CREATE TABLE test_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title varchar(200) NOT NULL, created_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE reports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL,
      status varchar(20) NOT NULL,
      duration_ms integer,
      step_results jsonb NOT NULL,
      summary text,
      created_at timestamp NOT NULL DEFAULT now()
    );
  `);
  const { default: express } = await import('express');
  const { reportsRoute } = await import('../src/routes/reports.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/reports', reportsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe('reports', () => {
  it('GET list returns array', async () => {
    const r = await request(app).get('/api/reports');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it('GET /:id 404 for missing', async () => {
    const r = await request(app).get('/api/reports/00000000-0000-0000-0000-000000000000');
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行，期望失败**

```bash
pnpm test reports
```

- [ ] **Step 3: 实现 `apps/api/src/routes/reports.ts`**

```ts
import { Router } from 'express';
import { db } from '../db/client.js';
import { reports } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';

export const reportsRoute = Router();

reportsRoute.get('/', async (_req, res) => {
  const rows = await db.select().from(reports).orderBy(desc(reports.createdAt));
  res.json(rows);
});

reportsRoute.get('/:id', async (req, res) => {
  const rows = await db.select().from(reports).where(eq(reports.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'report not found');
  res.json(rows[0]);
});
```

- [ ] **Step 4: 注册**

```ts
import { reportsRoute } from './routes/reports.js';
app.use('/api/reports', reportsRoute);
```

- [ ] **Step 5: 运行，期望通过**

```bash
pnpm test
```

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/routes/reports.ts apps/api/src/index.ts apps/api/test/reports.test.ts
git commit -m "feat(api): reports list and detail routes"
```

---

### Task 18: curl smoke

**Files:** 仅修改 `apps/api/src/index.ts`

- [ ] **Step 1: 完整 `apps/api/src/index.ts`**

```ts
import express from 'express';
import { logger } from './logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { settingsRoute } from './routes/settings.js';
import { requirementsRoute } from './routes/requirements.js';
import { casesRoute } from './routes/cases.js';
import { stepsRoute } from './routes/steps.js';
import { reportsRoute } from './routes/reports.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/settings', settingsRoute);
app.use('/api/requirements', requirementsRoute);
app.use('/api/cases', casesRoute);
app.use('/api/cases', stepsRoute);
app.use('/api/reports', reportsRoute);
app.use(errorHandler);

const port = Number(process.env.API_PORT ?? 54321);
app.listen(port, '127.0.0.1', () => {
  logger.info({ port }, 'api listening on 127.0.0.1');
});
```

- [ ] **Step 2: 启动 + curl smoke**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/api
pnpm dev &
sleep 3
curl -s -X PUT http://127.0.0.1:54321/api/settings -H 'Content-Type: application/json' -d '{"key":"llm_provider","value":"mock"}'
curl -s http://127.0.0.1:54321/api/settings/llm_provider
curl -s -X POST http://127.0.0.1:54321/api/requirements -H 'Content-Type: application/json' -d '{"title":"smoke","content":"x"}' | jq -r .id
CASE_ID=$(curl -s -X POST http://127.0.0.1:54321/api/cases -H 'Content-Type: application/json' -d '{"title":"smoke case"}' | jq -r .id)
curl -s -X POST "http://127.0.0.1:54321/api/cases/$CASE_ID/steps" -H 'Content-Type: application/json' -d '{"steps":[{"order":1,"source":"manual","action":{"kind":"navigate","url":"https://example.com"}}]}'
curl -s "http://127.0.0.1:54321/api/cases/$CASE_ID" | jq '.steps | length'
kill %1
```

期望：`.steps | length` 输出 `1`。

- [ ] **Step 3: 提交（如有变更）**

```bash
git add apps/api/src/index.ts
git diff --cached --quiet || git commit -m "chore(api): consolidate route registration"
```

---

## M5 Agent（Task 19-22）

### Task 19: LLM Client + Mock Provider

**Files:** `apps/api/src/agent/llm-client.ts`、`apps/api/test/llm-client.test.ts`

- [ ] **Step 1: 失败测试**

```ts
// apps/api/test/llm-client.test.ts
import { describe, it, expect } from 'vitest';
import { getLlmClient, listProviders } from '../src/agent/llm-client.js';

describe('llm-client', () => {
  it('listProviders returns four providers', () => {
    expect(listProviders()).toEqual(['mock', 'openai', 'anthropic', 'google']);
  });

  it('getLlmClient with provider=mock returns a client', () => {
    const c = getLlmClient({ provider: 'mock', apiKey: '', model: '' });
    expect(c.provider).toBe('mock');
  });

  it('mock client returns structured JSON for requirement scenarios', async () => {
    const c = getLlmClient({ provider: 'mock', apiKey: '', model: '' });
    const out = await c.complete({ systemPrompt: '', userMessage: 'requirement: 用户登录功能' });
    expect(out.kind).toBe('json');
    if (out.kind === 'json') {
      expect(Array.isArray(out.value.cases)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 运行，期望失败**

```bash
pnpm test llm-client
```

- [ ] **Step 3: 实现 `apps/api/src/agent/llm-client.ts`**

```ts
export type LLMProvider = 'mock' | 'openai' | 'anthropic' | 'google';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
}

export type LLMCompleteResult =
  | { kind: 'json'; value: Record<string, unknown> }
  | { kind: 'text'; value: string };

export interface LLMClient {
  provider: LLMProvider;
  complete(req: { systemPrompt: string; userMessage: string }): Promise<LLMCompleteResult>;
}

export function listProviders(): LLMProvider[] {
  return ['mock', 'openai', 'anthropic', 'google'];
}

class MockClient implements LLMClient {
  provider = 'mock' as const;

  async complete({ userMessage }: { systemPrompt: string; userMessage: string }): Promise<LLMCompleteResult> {
    if (userMessage.includes('requirement') || userMessage.includes('需求')) {
      return {
        kind: 'json',
        value: {
          cases: [
            {
              title: 'mock 生成的用例',
              description: 'mock provider 自动产出',
              priority: 'P1',
              steps: [
                { order: 1, action: { kind: 'navigate', url: 'https://example.com' } },
                {
                  order: 2,
                  action: { kind: 'click', locator: [{ strategy: 'role', value: 'button[name="登录"]' }] },
                },
              ],
            },
          ],
        },
      };
    }
    if (userMessage.includes('case') || userMessage.includes('用例')) {
      return {
        kind: 'json',
        value: {
          steps: [
            { order: 99, action: { kind: 'assertVisible', locator: [{ strategy: 'role', value: 'main' }] } },
          ],
        },
      };
    }
    return { kind: 'text', value: '[mock] no specific response for this input' };
  }
}

export function getLlmClient(config: LLMConfig): LLMClient {
  if (config.provider === 'mock') return new MockClient();
  throw new Error(`LLM provider ${config.provider} not implemented in MVP. Use 'mock'.`);
}
```

- [ ] **Step 4: 运行，期望通过**

```bash
pnpm test
```

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/agent/llm-client.ts apps/api/test/llm-client.test.ts
git commit -m "feat(agent): llm-client with mock provider"
```

---

### Task 20: Workflow 引擎 + 内置工具

**Files:** `apps/api/src/agent/agentFactory.ts`、`apps/api/src/agent/builtinTools.ts`、`apps/api/test/workflow.test.ts`

- [ ] **Step 1: 失败测试**

```ts
// apps/api/test/workflow.test.ts
import { describe, it, expect } from 'vitest';
import { runWorkflow } from '../src/agent/agentFactory.js';
import { getLlmClient } from '../src/agent/llm-client.js';

describe('workflow', () => {
  it('runs a two-step workflow sequentially', async () => {
    const client = getLlmClient({ provider: 'mock', apiKey: '', model: '' });
    const events: string[] = [];
    const result = await runWorkflow({
      workflowId: 'test',
      steps: [
        { id: 'a', prompt: 'step A uses {{userMessage}}', tools: [] },
        { id: 'b', prompt: 'step B uses {{previousOutput}}', tools: [] },
      ],
      llmClient: client,
      initialMessage: 'hello',
      onEvent: (e) => events.push(e.type),
    });
    expect(result).toBeTruthy();
    expect(events).toContain('step_start');
    expect(events).toContain('workflow_complete');
  });

  it('stops on first error', async () => {
    const client = {
      provider: 'mock' as const,
      complete: async () => {
        throw new Error('boom');
      },
    };
    await expect(
      runWorkflow({
        workflowId: 'fail',
        steps: [{ id: 'a', prompt: 'x', tools: [] }],
        llmClient: client,
        initialMessage: 'y',
        onEvent: () => {},
      }),
    ).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: 运行，期望失败**

```bash
pnpm test workflow
```

- [ ] **Step 3: 实现 `apps/api/src/agent/builtinTools.ts`**

```ts
export interface AgentTool {
  name: string;
  description: string;
  handler: (input: unknown) => Promise<unknown>;
}

export function createSaveCaseTool(opts: { requirementId?: string }): AgentTool {
  return {
    name: 'saveCase',
    description: '保存生成的测试用例到数据库',
    handler: async () => ({ ok: true, requirementId: opts.requirementId }),
  };
}

export function createSaveStepsTool(): AgentTool {
  return { name: 'saveSteps', description: '保存生成的步骤', handler: async (input) => ({ ok: true, input }) };
}

export function createSaveReportTool(): AgentTool {
  return { name: 'saveReport', description: '保存执行报告', handler: async (input) => ({ ok: true, input }) };
}

export function createGetCaseTool(): AgentTool {
  return { name: 'getCase', description: '获取用例当前步骤', handler: async () => ({ ok: true }) };
}
```

- [ ] **Step 4: 实现 `apps/api/src/agent/agentFactory.ts`**

```ts
import type { LLMClient } from './llm-client.js';
import type { AgentTool } from './builtinTools.js';

export interface WorkflowStep {
  id: string;
  prompt: string;
  tools: AgentTool[];
}

export interface WorkflowSpec {
  workflowId: string;
  steps: WorkflowStep[];
}

export interface RunOptions {
  workflowId: string;
  steps: WorkflowStep[];
  llmClient: LLMClient;
  initialMessage: string;
  onEvent: (e: AgentEvent) => void;
}

export type AgentEvent =
  | { type: 'step_start'; stepId: string }
  | { type: 'step_text'; stepId: string; delta: string }
  | { type: 'step_complete'; stepId: string; output: unknown }
  | { type: 'workflow_complete'; runId: string; result: unknown }
  | { type: 'workflow_error'; runId: string; error: string; code: 'llm' | 'schema' | 'db' | 'unknown' };

function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

export async function runWorkflow(opts: RunOptions): Promise<unknown> {
  const runId = crypto.randomUUID();
  let previousOutput = '';
  const result: unknown[] = [];
  for (const step of opts.steps) {
    opts.onEvent({ type: 'step_start', stepId: step.id });
    const userMessage = fillTemplate(step.prompt, { userMessage: opts.initialMessage, previousOutput });
    try {
      const r = await opts.llmClient.complete({ systemPrompt: '', userMessage });
      const output = r.kind === 'json' ? r.value : r.value;
      result.push(output);
      previousOutput = typeof output === 'string' ? output : JSON.stringify(output);
      opts.onEvent({ type: 'step_text', stepId: step.id, delta: previousOutput });
      opts.onEvent({ type: 'step_complete', stepId: step.id, output });
    } catch (e) {
      opts.onEvent({
        type: 'workflow_error',
        runId,
        error: e instanceof Error ? e.message : String(e),
        code: 'llm',
      });
      throw e;
    }
  }
  opts.onEvent({ type: 'workflow_complete', runId, result });
  return result;
}
```

- [ ] **Step 5: 运行，期望通过**

```bash
pnpm test
```

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/agent/agentFactory.ts apps/api/src/agent/builtinTools.ts apps/api/test/workflow.test.ts
git commit -m "feat(agent): workflow engine and builtin tools"
```

---

### Task 21: Workflow A — Requirement → Cases

**Files:** `apps/api/src/agent/prompts/requirement-decompose.ts`、`apps/api/src/agent/prompts/case-review.ts`、`apps/api/src/agent/workflows/requirement2cases.ts`

- [ ] **Step 1: prompts**

`apps/api/src/agent/prompts/requirement-decompose.ts`：

```ts
export const REQUIREMENT_DECOMPOSE_PROMPT = `你是资深测试工程师。请根据用户提供的需求文本，拆解出 2-5 个测试用例。
输出必须是严格 JSON，格式：
{ "cases": [{ "title": string, "description": string, "priority": "P0"|"P1"|"P2", "steps": [{ "order": number, "action": StepAction }] }] }
StepAction 见共享类型定义。`;
```

`apps/api/src/agent/prompts/case-review.ts`：

```ts
export const CASE_REVIEW_PROMPT = `你是测试评审。请对上一轮产出的候选用例做去重与优先级调整，输出与上一轮结构一致的 JSON。`;
```

- [ ] **Step 2: workflow**

`apps/api/src/agent/workflows/requirement2cases.ts`：

```ts
import type { WorkflowSpec } from '../agentFactory.js';
import { createSaveCaseTool } from '../builtinTools.js';
import { REQUIREMENT_DECOMPOSE_PROMPT } from '../prompts/requirement-decompose.js';
import { CASE_REVIEW_PROMPT } from '../prompts/case-review.js';

export const requirement2CasesWorkflow: WorkflowSpec = {
  workflowId: 'requirement2cases',
  steps: [
    {
      id: 'decompose',
      prompt: REQUIREMENT_DECOMPOSE_PROMPT + '\n\nrequirement:\n{{userMessage}}',
      tools: [createSaveCaseTool({})],
    },
    {
      id: 'review',
      prompt: CASE_REVIEW_PROMPT + '\n\ncandidates:\n{{previousOutput}}',
      tools: [],
    },
  ],
};
```

- [ ] **Step 3: 提交**

```bash
git add apps/api/src/agent/prompts apps/api/src/agent/workflows
git commit -m "feat(agent): requirement2cases workflow with prompts"
```

---

### Task 22: Workflow B — Case → Script

**Files:** `apps/api/src/agent/prompts/case-to-script.ts`、`apps/api/src/agent/prompts/script-selfcheck.ts`、`apps/api/src/agent/workflows/case2script.ts`

- [ ] **Step 1: prompts**

`apps/api/src/agent/prompts/case-to-script.ts`：

```ts
export const CASE_TO_SCRIPT_PROMPT = `你是自动化测试架构师。根据用例标题、描述、已有步骤，补充缺失的步骤 DSL。
优先使用 role 与 testId 定位器，避免 CSS。
输出 JSON: { "steps": [{ "order": number, "action": StepAction }] }`;
```

`apps/api/src/agent/prompts/script-selfcheck.ts`：

```ts
export const SCRIPT_SELFCHECK_PROMPT = `你是脚本自检。检查步骤 DSL 是否缺断言、缺等待、定位器多重。
输出 JSON: { "issues": [{ "stepOrder": number, "issue": string }] }`;
```

- [ ] **Step 2: workflow**

`apps/api/src/agent/workflows/case2script.ts`：

```ts
import type { WorkflowSpec } from '../agentFactory.js';
import { createSaveStepsTool, createGetCaseTool } from '../builtinTools.js';
import { CASE_TO_SCRIPT_PROMPT } from '../prompts/case-to-script.js';
import { SCRIPT_SELFCHECK_PROMPT } from '../prompts/script-selfcheck.js';

export const case2ScriptWorkflow: WorkflowSpec = {
  workflowId: 'case2script',
  steps: [
    {
      id: 'generate',
      prompt: CASE_TO_SCRIPT_PROMPT + '\n\ncase:\n{{userMessage}}',
      tools: [createSaveStepsTool(), createGetCaseTool()],
    },
    {
      id: 'selfcheck',
      prompt: SCRIPT_SELFCHECK_PROMPT + '\n\ngenerated:\n{{previousOutput}}',
      tools: [],
    },
  ],
};
```

- [ ] **Step 3: 提交**

```bash
git add apps/api/src/agent/prompts/case-to-script.ts apps/api/src/agent/prompts/script-selfcheck.ts apps/api/src/agent/workflows/case2script.ts
git commit -m "feat(agent): case2script workflow with prompts"
```

---

## M6 录制后端 + Mock 执行（Task 23-25）

### Task 23: Agent Run 路由 + SSE

**Files:** `apps/api/src/sse/agentRunStream.ts`、`apps/api/src/routes/agentRuns.ts`、`apps/api/test/agentRuns.test.ts`、`apps/api/src/index.ts`

- [ ] **Step 1: 失败测试**

```ts
// apps/api/test/agentRuns.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(`
    CREATE TABLE requirements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title varchar(200) NOT NULL, content text NOT NULL, created_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE test_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requirement_id uuid REFERENCES requirements(id) ON DELETE CASCADE, title varchar(200) NOT NULL, priority varchar(20) NOT NULL DEFAULT 'P1', created_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE test_steps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, "order" integer NOT NULL, source varchar(20) NOT NULL, action jsonb NOT NULL, created_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE agent_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_type varchar(30) NOT NULL, target_id uuid NOT NULL, status varchar(20) NOT NULL, prompt text NOT NULL, result jsonb, error text, started_at timestamp NOT NULL DEFAULT now(), finished_at timestamp);
  `);
  const { default: express } = await import('express');
  const { agentRunsRoute } = await import('../src/routes/agentRuns.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/agent-runs', agentRunsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe('agent-runs', () => {
  it('POST creates run and returns id', async () => {
    const req = await pool.query(`INSERT INTO requirements(title, content) VALUES ('t','c') RETURNING id`);
    const r = await request(app)
      .post('/api/agent-runs')
      .send({ targetType: 'requirement2cases', targetId: req.rows[0].id, prompt: 't' });
    expect(r.status).toBe(200);
    expect(r.body.id).toBeTruthy();
  });

  it('GET /:id returns detail after finish', async () => {
    const r0 = await pool.query(`INSERT INTO requirements(title, content) VALUES ('x','y') RETURNING id`);
    const created = await request(app)
      .post('/api/agent-runs')
      .send({ targetType: 'requirement2cases', targetId: r0.rows[0].id, prompt: 'p' });
    await new Promise((r) => setTimeout(r, 500));
    const detail = await request(app).get(`/api/agent-runs/${created.body.id}`);
    expect(detail.body.status).toBe('success');
  });
});
```

- [ ] **Step 2: SSE helper**

`apps/api/src/sse/agentRunStream.ts`：

```ts
import type { Response } from 'express';
import type { AgentEvent } from '../agent/agentFactory.js';

export function sseHeaders(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

export function sseSend(res: Response, event: AgentEvent) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
```

- [ ] **Step 3: 实现 `apps/api/src/routes/agentRuns.ts`**

```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentRuns, requirements, testCases, testSteps } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { runWorkflow } from '../agent/agentFactory.js';
import { getLlmClient } from '../agent/llm-client.js';
import { requirement2CasesWorkflow } from '../agent/workflows/requirement2cases.js';
import { case2ScriptWorkflow } from '../agent/workflows/case2script.js';
import { sseHeaders, sseSend } from '../sse/agentRunStream.js';
import { StepAction } from '@itest/shared';

export const agentRunsRoute = Router();

const CreateBody = z.object({
  targetType: z.enum(['requirement2cases', 'case2script']),
  targetId: z.string().uuid(),
  prompt: z.string().min(1),
});

agentRunsRoute.get('/', async (_req, res) => {
  const rows = await db.select().from(agentRuns).orderBy(desc(agentRuns.startedAt)).limit(50);
  res.json(rows);
});

agentRunsRoute.get('/:id', async (req, res) => {
  const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'agent run not found');
  res.json(rows[0]);
});

agentRunsRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const rows = await db
    .insert(agentRuns)
    .values({ targetType: body.targetType, targetId: body.targetId, status: 'running', prompt: body.prompt })
    .returning();
  res.json(rows[0]);
});

agentRunsRoute.get('/:id/events', async (req, res) => {
  sseHeaders(res);
  const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, req.params.id));
  if (rows.length === 0) {
    res.end();
    return;
  }
  const run = rows[0]!;
  const client = getLlmClient({ provider: 'mock', apiKey: '', model: '' });
  const wf = run.targetType === 'requirement2cases' ? requirement2CasesWorkflow : case2ScriptWorkflow;
  try {
    const result = (await runWorkflow({
      workflowId: wf.workflowId,
      steps: wf.steps,
      llmClient: client,
      initialMessage: run.prompt,
      onEvent: (e) => sseSend(res, e),
    })) as unknown[];
    await db
      .update(agentRuns)
      .set({ status: 'success', result: result as object, finishedAt: new Date() })
      .where(eq(agentRuns.id, run.id));
    if (run.targetType === 'requirement2cases') {
      const reqData = (await db.select().from(requirements).where(eq(requirements.id, run.targetId)))[0];
      const finalJson = result[result.length - 1] as {
        cases?: Array<{ title: string; description?: string; priority?: string; steps?: Array<{ order: number; action: unknown }> }>;
      };
      if (reqData && finalJson?.cases) {
        for (const c of finalJson.cases) {
          const caseRows = await db
            .insert(testCases)
            .values({
              requirementId: reqData.id,
              title: c.title,
              description: c.description,
              priority: (c.priority ?? 'P1') as 'P0' | 'P1' | 'P2' | 'P3',
            })
            .returning();
          if (c.steps && c.steps.length > 0) {
            await db.insert(testSteps).values(
              c.steps.map((s) => {
                StepAction.parse(s.action);
                return {
                  caseId: caseRows[0]!.id,
                  order: s.order,
                  source: 'agent' as const,
                  action: s.action as object,
                };
              }),
            );
          }
        }
      }
    }
  } catch (e) {
    await db
      .update(agentRuns)
      .set({ status: 'failed', error: e instanceof Error ? e.message : String(e), finishedAt: new Date() })
      .where(eq(agentRuns.id, run.id));
    sseSend(res, { type: 'workflow_error', runId: run.id, error: e instanceof Error ? e.message : String(e), code: 'unknown' });
  } finally {
    res.end();
  }
});
```

- [ ] **Step 4: 注册**

```ts
import { agentRunsRoute } from './routes/agentRuns.js';
app.use('/api/agent-runs', agentRunsRoute);
```

- [ ] **Step 5: 运行测试**

```bash
pnpm test
```

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/routes/agentRuns.ts apps/api/src/sse apps/api/src/index.ts apps/api/test/agentRuns.test.ts
git commit -m "feat(agent): agent-runs CRUD + SSE workflow execution"
```

---

### Task 24: Recorder WS + 步骤接收

**Files:** `apps/api/src/recorder/ws.ts`、`apps/api/src/routes/recorder.ts`、`apps/api/src/index.ts`

- [ ] **Step 1: 实现 `apps/api/src/recorder/ws.ts`**

```ts
import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';

export interface RecorderSession {
  sessionId: string;
  caseId: string;
  steps: unknown[];
  ws?: WebSocket;
}

const sessions = new Map<string, RecorderSession>();
const secret = process.env.RECORDER_TOKEN_SECRET ?? 'dev-secret-change-me';

export function attachRecorderWs(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/recorder') return;
    const sessionId = url.searchParams.get('sessionId');
    const token = url.searchParams.get('token');
    if (!sessionId || !token || token !== secret) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = sessions.get(sessionId);
      if (!session) {
        ws.close(1008, 'unknown session');
        return;
      }
      session.ws = ws;
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'step') session.steps.push(msg.step);
          if (msg.type === 'finish') ws.close(1000);
        } catch {
          // ignore malformed
        }
      });
      ws.on('close', () => {
        if (session.ws === ws) session.ws = undefined;
      });
    });
  });
}

export function createSession(caseId: string): RecorderSession {
  const session: RecorderSession = { sessionId: crypto.randomUUID(), caseId, steps: [] };
  sessions.set(session.sessionId, session);
  return session;
}

export function getSession(id: string) {
  return sessions.get(id);
}
```

- [ ] **Step 2: 实现 `apps/api/src/routes/recorder.ts`**

```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testCases, testSteps } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { StepAction } from '@itest/shared';
import { createSession, getSession } from '../recorder/ws.js';

export const recorderRoute = Router();

const CreateBody = z.object({ caseId: z.string().uuid() });

recorderRoute.post('/sessions', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const exists = await db.select().from(testCases).where(eq(testCases.id, body.caseId));
  if (exists.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  const session = createSession(body.caseId);
  res.json({
    sessionId: session.sessionId,
    wsToken: process.env.RECORDER_TOKEN_SECRET ?? 'dev-secret-change-me',
    wsUrl: `ws://127.0.0.1:${process.env.API_PORT ?? 54321}/recorder`,
  });
});

recorderRoute.post('/sessions/:id/finish', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) throw new HttpError(404, 'not_found', 'session not found');
  session.ws?.close(1000, 'finished');
  let inserted = 0;
  const existing = await db.select().from(testSteps).where(eq(testSteps.caseId, session.caseId));
  let nextOrder = existing.length > 0 ? Math.max(...existing.map((s) => s.order)) + 1 : 1;
  for (const step of session.steps) {
    const action = (step as { action: unknown }).action;
    StepAction.parse(action);
    await db.insert(testSteps).values({
      caseId: session.caseId,
      order: nextOrder++,
      source: 'recorder',
      action: action as object,
    });
    inserted++;
  }
  res.json({ inserted });
});
```

- [ ] **Step 3: 修改 `apps/api/src/index.ts` 接入 WS**

```ts
// apps/api/src/index.ts （完整）
import express from 'express';
import { logger } from './logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { settingsRoute } from './routes/settings.js';
import { requirementsRoute } from './routes/requirements.js';
import { casesRoute } from './routes/cases.js';
import { stepsRoute } from './routes/steps.js';
import { reportsRoute } from './routes/reports.js';
import { agentRunsRoute } from './routes/agentRuns.js';
import { recorderRoute } from './routes/recorder.js';
import { attachRecorderWs } from './recorder/ws.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/settings', settingsRoute);
app.use('/api/requirements', requirementsRoute);
app.use('/api/cases', casesRoute);
app.use('/api/cases', stepsRoute);
app.use('/api/reports', reportsRoute);
app.use('/api/agent-runs', agentRunsRoute);
app.use('/api/recorder', recorderRoute);
app.use(errorHandler);

const port = Number(process.env.API_PORT ?? 54321);
const server = app.listen(port, '127.0.0.1', () => {
  logger.info({ port }, 'api listening on 127.0.0.1');
});
attachRecorderWs(server);
```

- [ ] **Step 4: 提交**

```bash
git add apps/api/src/recorder apps/api/src/routes/recorder.ts apps/api/src/index.ts
git commit -m "feat(recorder): WS endpoint and session HTTP routes"
```

---

### Task 25: Mock 执行 + 报告生成

**Files:** `apps/api/src/execute/screenshot.ts`、`apps/api/src/execute/mock.ts`、`apps/api/src/routes/execute.ts`、`apps/api/src/index.ts`

- [ ] **Step 1: `apps/api/src/execute/screenshot.ts`**

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
  'base64',
);

export async function writePlaceholderScreenshot(reportId: string, stepIndex: number): Promise<string> {
  const dir = join(SCREENSHOTS_DIR, reportId);
  await mkdir(dir, { recursive: true });
  const filename = `step-${stepIndex}.png`;
  await writeFile(join(dir, filename), TRANSPARENT_PNG);
  return `/screenshots/${reportId}/${filename}`;
}
```

- [ ] **Step 2: `apps/api/src/execute/mock.ts`**

```ts
import { db } from '../db/client.js';
import { testCases, testSteps, reports } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { writePlaceholderScreenshot } from './screenshot.js';

export async function mockExecuteCase(caseId: string): Promise<{ reportId: string }> {
  const caseRow = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!caseRow) throw new Error('case not found');
  const steps = await db.select().from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order));
  const startedAt = Date.now();
  const tempResults: Array<{ order: number; status: string; durationMs: number; error?: string }> = [];
  let failed = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const isFail = Math.random() < 0.2;
    if (isFail) failed++;
    tempResults.push({
      order: step.order,
      status: isFail ? 'failed' : 'passed',
      durationMs: Math.floor(Math.random() * 100) + 20,
      error: isFail ? 'mock failure (CDP not wired in MVP)' : undefined,
    });
  }
  const durationMs = Date.now() - startedAt;
  const status = failed === 0 ? 'passed' : 'failed';
  const inserted = await db
    .insert(reports)
    .values({
      caseId,
      status,
      durationMs,
      stepResults: tempResults as object,
      summary: `${steps.length} steps, ${steps.length - failed} passed, ${failed} failed`,
    })
    .returning();
  const reportId = inserted[0]!.id;
  const realResults = await Promise.all(
    tempResults.map(async (r, i) => ({
      ...r,
      screenshot: await writePlaceholderScreenshot(reportId, i + 1),
    })),
  );
  await db.update(reports).set({ stepResults: realResults as object }).where(eq(reports.id, reportId));
  return { reportId };
}
```

- [ ] **Step 3: `apps/api/src/routes/execute.ts`**

```ts
import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/errorHandler.js';
import { mockExecuteCase } from '../execute/mock.js';

export const executeRoute = Router();

const Body = z.object({ caseId: z.string().uuid() });

executeRoute.post('/cases/:caseId/execute', async (req, res) => {
  const { caseId } = Body.parse({ caseId: req.params.caseId });
  if (caseId !== req.params.caseId) throw new HttpError(400, 'bad_request', 'caseId mismatch');
  const { reportId } = await mockExecuteCase(caseId);
  res.json({ reportId });
});
```

- [ ] **Step 4: 注册**

```ts
import { executeRoute } from './routes/execute.js';
app.use('/api', executeRoute);
```

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/execute apps/api/src/routes/execute.ts apps/api/src/index.ts
git commit -m "feat(execute): mock execution with placeholder screenshots"
```

---

> **本计划前半部分（M1-M6）结束。** 接下来 Task 26-44（M7 前端骨架 + M8 前端业务 + M9 录制器 + M10 收尾）写在 plan 的 Part 2，文件 `docs/superpowers/plans/2026-09-30-itest-mvp-part2.md`。