# 测试可观测动作：DB 查询 + syslog 观察 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 iTest 用例步骤新增两类"测试动作"：`queryDb`（白名单 SELECT，参数化绑定）与 `observeLog`（按时间窗 + 关键字读远端 syslog，SSH 不可写）。两类动作可选带 assertion，匹配失败 = 步骤失败；不带 = 仅采集入报告。Db / syslog 凭据走项目级 `test_environments` 表，凭据密文用现成的 `lib/secret-crypto.ts`，plan > case 解析优先级。

**Architecture:** 纯增量，不破兼容。新代码五块：

1. `packages/shared/src/step-dsl.ts` 加 `QueryDbAction` / `ObserveLogAction` 两 kind 并入 `StepAction` 联合与 discriminated union（向后兼容：旧 case 不带这两 kind 也不报错）。
2. `apps/api/drizzle/0019_test_environments.sql` 新表 + FK 列（cases/plans），同步 schema.ts。
3. `apps/api/src/execute/envContext.ts` 新增：解密凭据、创建 `pg.Pool`（每个 envCtx 一次）+ `ssh2.Client` 复用、`close()` 幂等。
4. `apps/api/src/execute/dbQuery.ts` 与 `syslogReader.ts`：白名单 + 强制 SELECT、参数化 prepared statement、行数/字节截断 50、断言三档（equals/contains/regex）。
5. `apps/api/src/execute/cdp.ts` 的 `dispatch` switch 加两 case；`runCase` 与 `runPlan` 注入 `envCtx`；缺 env → 步骤失败 `EnvMissing`（不抛 500）。

Web 端改造：环境 CRUD 页（ProjectSettings 新 Tab）、CaseDetail 默认环境 Select、PlanDetail 目标环境 Select、StepEditDrawer queryDb/observeLog 子表单、ReportDetail 明细模式加 DB/日志列。

**Tech Stack:** Drizzle ORM（迁移），`pg`（已装），`ssh2`（需安装），zod（已装），`@itest/shared`（已装），React 19 + TanStack Query（已装），Vitest（已装）。

**关键背景（实现者必读）：**

- `StepAction` 是 zod discriminatedUnion（`packages/shared/src/step-dsl.ts:175-201`），新增 kind 必须同时改 union 与 type 联合。
- `lib/secret-crypto.ts` 已存在（`encrypt` / `decrypt` / `ensureKeyLoaded`），AES-256-GCM；ENCRYPTION_KEY 在 dev `.env` 已配（base64 32 字节），启动 fail-fast 缺则抛错。
- `runCase.ts:6` 已有 `executeCaseReal` 入参结构；新增 `envCtx` 走 opts 注入而非全局，避免污染单步骤调用。
- `failureClassifier.ts` 用字符串模糊匹配 `err.message`；新增 reason 只需扩 switch + 加 case 即可，无需重构。
- `apps/web/src/api/client.ts` 第 180–196 行是 `api.cases.patch` 类型签名；新增 `defaultEnvId` 字段直接扩 Partial 类型即可；类似第 110–124 行 `api.plans.patch` 扩 `environmentId`。
- 测试容器：API 测试用 `@testcontainers/postgresql` 起独立 PG（`apps/api/test/helpers/db.ts`）；helpers/db.ts 里 `SCHEMA_SQL` 是全量建表串，新增 `test_environments` 等表必须追加到末尾并改 `--strict 0` 顺序无关；现有 helper 函数 `seedOrg / seedProject` 不动。
- Web dev 服务已起在 5173 / 54321，本计划全程在 main checkout 工作，不开 worktree。

---

## File Structure

**新增：**

- `apps/api/drizzle/0019_test_environments.sql`
- `apps/api/src/execute/envContext.ts`
- `apps/api/src/execute/envContext.test.ts`
- `apps/api/src/execute/dbQuery.ts`
- `apps/api/src/execute/dbQuery.test.ts`
- `apps/api/src/execute/syslogReader.ts`
- `apps/api/src/execute/syslogReader.test.ts`
- `apps/api/src/routes/environments.ts`
- `apps/api/test/environments.test.ts`
- `apps/api/test/execute-env.test.ts`
- `apps/web/src/pages/ProjectEnvironments.tsx`
- `apps/web/src/pages/ProjectEnvironments.css`
- `apps/web/src/lib/queryDbAllowlist.ts`

**修改：**

- `packages/shared/src/step-dsl.ts`（加 `QueryDbAction` / `ObserveLogAction`）
- `packages/shared/src/index.ts`（导出新类型）
- `apps/api/src/db/schema.ts`（加 `testEnvironments`、`testCases.defaultEnvId`、`executionPlans.environmentId`）
- `apps/api/src/execute/failureClassifier.ts`（加 10 个 reason）
- `apps/api/src/execute/cdp.ts`（dispatch 加两 case）
- `apps/api/src/execute/runCase.ts`（注入 envCtx）
- `apps/api/src/execute/runPlan.ts`（注入 envCtx）
- `apps/api/src/routes/cases.ts`（PATCH 接 defaultEnvId）
- `apps/api/src/routes/plans.ts`（PATCH 接 environmentId）
- `apps/api/src/index.ts`（挂载 environments 路由）
- `apps/api/src/services/projectAccess.ts`（加 `assertEnvironmentVisible`）
- `apps/api/package.json` + `pnpm-lock.yaml`（加 ssh2 + @types/ssh2）
- `apps/web/src/api/client.ts`（加 environments 方法、cases/plans patch 字段）
- `apps/web/src/pages/Settings.tsx`（挂载 ProjectEnvironments）
- `apps/web/src/pages/CaseDetail.tsx`（默认环境 Select）
- `apps/web/src/pages/PlanDetail.tsx`（目标环境 Select）
- `apps/web/src/components/StepEditDrawer.tsx`（queryDb / observeLog 子表单）
- `apps/web/src/pages/ReportDetail.tsx`（明细模式 DB / 日志列）
- `apps/web/src/lib/stepValidation.ts`（新 kind 校验）
- `apps/web/src/lib/stepSummary.ts`（新 kind 摘要）

---

### Task 1: 安装 ssh2 依赖

**Files:**
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: 安装**

```bash
pnpm --filter @itest/api add ssh2
pnpm --filter @itest/api add -D @types/ssh2
```

Expected: `apps/api/package.json` 的 dependencies 增加 `ssh2`，devDependencies 增加 `@types/ssh2`，`pnpm-lock.yaml` 更新。

- [ ] **Step 2: 验证 typecheck 仍过**

```bash
pnpm --filter @itest/api typecheck
```

Expected: 无错误退出。

- [ ] **Step 3: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml
git commit -m "chore(api): add ssh2 for syslog reader"
```

---

### Task 2: shared/src/step-dsl.ts 新增 queryDb / observeLog kind

**Files:**
- Modify: `packages/shared/src/step-dsl.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: 在 `packages/shared/src/step-dsl.ts` 文件末尾（StepAction discriminatedUnion 块之后）追加**

```ts
export const DbAssertionMatch = z.enum(['equals', 'contains', 'regex']);
export type DbAssertionMatch = z.infer<typeof DbAssertionMatch>;

export const QueryDbAction = z.object({
  kind: z.literal('queryDb'),
  table: z.enum([
    'projects', 'groups', 'users', 'test_cases', 'test_steps',
    'reports', 'execution_plans', 'plan_runs', 'plan_run_cases', 'test_attachments',
  ]),
  where: z.array(z.object({
    column: z.string().min(1).max(64),
    equals: z.union([z.string().max(500), z.number(), z.boolean()]),
  })).max(10).default([]),
  columns: z.array(z.string().min(1).max(64)).max(40).default([]),
  limit: z.number().int().min(1).max(200).default(50),
  assertion: z.object({
    match: DbAssertionMatch.default('contains'),
    expected: z.string().max(2000),
    column: z.string().max(64).optional(),
  }).optional(),
});
export type QueryDbAction = z.infer<typeof QueryDbAction>;

export const ObserveLogAction = z.object({
  kind: z.literal('observeLog'),
  windowMs: z.number().int().min(1000).max(600000).default(60000),
  keywords: z.array(z.string().min(1).max(200)).max(10).default([]),
  fromLine: z.number().int().min(1).max(10000).default(200),
  assertion: z.object({
    match: DbAssertionMatch.default('contains'),
    expected: z.string().max(2000),
  }).optional(),
});
export type ObserveLogAction = z.infer<typeof ObserveLogAction>;
```

- [ ] **Step 2: 把 `QueryDbAction` / `ObserveLogAction` 加进 `StepAction` type 联合**

`packages/shared/src/step-dsl.ts:158-174` 的 `StepAction` type 联合末尾加两行：

```ts
  | z.infer<typeof QueryDbAction>
  | z.infer<typeof ObserveLogAction>
```

- [ ] **Step 3: 把两 schema 加进 `StepAction` discriminated union**

`packages/shared/src/step-dsl.ts:175-201` 的 `StepAction` zod schema array 末尾（`aiStep` 之后）加两行：

```ts
  QueryDbAction,
  ObserveLogAction,
```

- [ ] **Step 4: 在 `packages/shared/src/index.ts` 导出新类型**

找到当前 `step-dsl` 导出位置，追加：

```ts
export type { QueryDbAction, ObserveLogAction, DbAssertionMatch } from './step-dsl.js';
```

- [ ] **Step 5: 编译 + 跑已有 web/api typecheck**

```bash
pnpm --filter @itest/shared typecheck 2>/dev/null || pnpm --filter @itest/shared build
pnpm --filter @itest/web typecheck
pnpm --filter @itest/api typecheck
```

Expected: 三个 workspace 都通过 typecheck；已有 step 相关测试不报错。

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/step-dsl.ts packages/shared/src/index.ts
git commit -m "feat(shared): add queryDb / observeLog DSL kinds"
```

---

### Task 3: DB 迁移 + schema.ts 新增 testEnvironments

**Files:**
- Create: `apps/api/drizzle/0019_test_environments.sql`
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/test/helpers/db.ts`（追加到 SCHEMA_SQL）

- [ ] **Step 1: 写迁移文件**

`apps/api/drizzle/0019_test_environments.sql`：

```sql
CREATE TABLE "test_environments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "name" varchar(120) NOT NULL,
  "db_host" varchar(200),
  "db_port" integer,
  "db_name" varchar(120),
  "db_user" varchar(120),
  "db_password_ciphertext" text,
  "db_password_iv" text,
  "db_password_tag" text,
  "syslog_host" varchar(200),
  "syslog_user" varchar(120),
  "syslog_ssh_port" integer DEFAULT 22,
  "syslog_key_ciphertext" text,
  "syslog_key_iv" text,
  "syslog_key_tag" text,
  "syslog_file_path" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  UNIQUE ("project_id","name")
);

DO $$ BEGIN
  ALTER TABLE "test_cases" ADD COLUMN "default_env_id" uuid REFERENCES "test_environments"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "execution_plans" ADD COLUMN "environment_id" uuid REFERENCES "test_environments"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
```

- [ ] **Step 2: 在 schema.ts 末尾（`tags` 之后）追加 `testEnvironments` table 定义**

`apps/api/src/db/schema.ts` 找到最后一个 `pgTable` 声明（`tags`），在它之后追加：

```ts
export const testEnvironments = pgTable('test_environments', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  dbHost: varchar('db_host', { length: 200 }),
  dbPort: integer('db_port'),
  dbName: varchar('db_name', { length: 120 }),
  dbUser: varchar('db_user', { length: 120 }),
  dbPasswordCiphertext: text('db_password_ciphertext'),
  dbPasswordIv: text('db_password_iv'),
  dbPasswordTag: text('db_password_tag'),
  syslogHost: varchar('syslog_host', { length: 200 }),
  syslogUser: varchar('syslog_user', { length: 120 }),
  syslogSshPort: integer('syslog_ssh_port').default(22),
  syslogKeyCiphertext: text('syslog_key_ciphertext'),
  syslogKeyIv: text('syslog_key_iv'),
  syslogKeyTag: text('syslog_key_tag'),
  syslogFilePath: text('syslog_file_path'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectNameUq: unique('test_environments_project_name_uq').on(t.projectId, t.name),
}));
```

- [ ] **Step 3: 在 `testCases` 加 `defaultEnvId` 字段**

`apps/api/src/db/schema.ts:34-50` 的 `testCases` table 内追加一行（在 `incognito` 后、scenarioId 前）：

```ts
  defaultEnvId: uuid('default_env_id').references(() => testEnvironments.id, { onDelete: 'set null' }),
```

- [ ] **Step 4: 在 `executionPlans` 加 `environmentId` 字段**

`apps/api/src/db/schema.ts:245-258` 的 `executionPlans` table 内（在 `environment` 之后）追加：

```ts
  environmentId: uuid('environment_id').references(() => testEnvironments.id, { onDelete: 'set null' }),
```

- [ ] **Step 5: 在测试 helper `SCHEMA_SQL` 末尾追加同样的建表与 ALTER**

`apps/api/test/helpers/db.ts` 找到 `SCHEMA_SQL` 模板字符串结尾（在 `END $$;` 后 `;` 之前）追加：

```sql
CREATE TABLE test_environments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL, name varchar(120) NOT NULL, db_host varchar(200), db_port integer, db_name varchar(120), db_user varchar(120), db_password_ciphertext text, db_password_iv text, db_password_tag text, syslog_host varchar(200), syslog_user varchar(120), syslog_ssh_port integer DEFAULT 22, syslog_key_ciphertext text, syslog_key_iv text, syslog_key_tag text, syslog_file_path text, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(), CONSTRAINT test_environments_project_name_uq UNIQUE(project_id, name));
DO $$ BEGIN
 ALTER TABLE test_cases ADD COLUMN default_env_id uuid REFERENCES test_environments(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE execution_plans ADD COLUMN environment_id uuid REFERENCES test_environments(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
```

- [ ] **Step 6: 运行 API typecheck**

```bash
pnpm --filter @itest/api typecheck
```

Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add apps/api/drizzle/0019_test_environments.sql apps/api/src/db/schema.ts apps/api/test/helpers/db.ts
git commit -m "feat(api): test_environments table + defaultEnvId / environmentId FK"
```

---

### Task 4: envContext.ts (TDD) — resolveEnv + EnvCtx + decrypt

**Files:**
- Create: `apps/api/src/execute/envContext.ts`
- Test: `apps/api/src/execute/envContext.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/api/src/execute/envContext.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../db/client.js', () => {
  return {
    db: {
      select: vi.fn(),
    },
  };
});

import { resolveEnv, EnvMissing, EnvProjectMismatch, DecryptError } from './envContext.js';
import { db } from '../db/client.js';
import { encrypt } from '../lib/secret-crypto.js';

const ENV_ROW = {
  id: 'env-1',
  projectId: 'proj-1',
  name: 'staging',
  dbHost: 'pg.example.com',
  dbPort: 5432,
  dbName: 'app',
  dbUser: 'app',
  dbPasswordCiphertext: null,
  dbPasswordIv: null,
  dbPasswordTag: null,
  syslogHost: null,
  syslogUser: null,
  syslogSshPort: null,
  syslogKeyCiphertext: null,
  syslogKeyIvColumn: null,
  syslogKeyTag: null,
  syslogFilePath: null,
};

beforeEach(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 0).toString('base64');
  vi.mocked(db.select).mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([ENV_ROW]) }) }),
  } as never);
});

describe('resolveEnv', () => {
  it('prefers planEnvId over caseEnvId', async () => {
    const { envId } = await resolveEnv({ planEnvId: 'env-plan', caseEnvId: 'env-case' });
    expect(envId).toBe('env-plan');
  });

  it('falls back to caseEnvId', async () => {
    const { envId } = await resolveEnv({ caseEnvId: 'env-case' });
    expect(envId).toBe('env-1');
  });

  it('throws EnvMissing when neither is set', async () => {
    await expect(resolveEnv({})).rejects.toBeInstanceOf(EnvMissing);
  });

  it('throws EnvProjectMismatch when envId resolves to different project', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ ...ENV_ROW, projectId: 'other' }]) }) }),
    } as never);
    await expect(resolveEnv({ caseEnvId: 'env-1' }, { expectedProjectId: 'proj-1' }))
      .rejects.toBeInstanceOf(EnvProjectMismatch);
  });

  it('decrypts dbPassword when ciphertext present', async () => {
    const enc = encrypt('hunter2');
    const rowWithPassword = { ...ENV_ROW, dbPasswordCiphertext: enc.ciphertext.toString('base64'), dbPasswordIv: enc.iv.toString('base64'), dbPasswordTag: enc.tag.toString('base64') };
    vi.mocked(db.select).mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([rowWithPassword]) }) }),
    } as never);
    const env = await resolveEnv({ caseEnvId: 'env-1' });
    expect(env.db?.password).toBe('hunter2');
  });

  it('throws DecryptError when tag mismatches', async () => {
    const enc = encrypt('hunter2');
    const bad = { ...ENV_ROW, dbPasswordCiphertext: enc.ciphertext.toString('base64'), dbPasswordIv: enc.iv.toString('base64'), dbPasswordTag: Buffer.alloc(16, 0xff).toString('base64') };
    vi.mocked(db.select).mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([bad]) }) }),
    } as never);
    await expect(resolveEnv({ caseEnvId: 'env-1' })).rejects.toBeInstanceOf(DecryptError);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @itest/api test -- envContext
```

Expected: 全部失败，错误 `Cannot find module './envContext.js'`。

- [ ] **Step 3: 实现 envContext.ts**

`apps/api/src/execute/envContext.ts`：

```typescript
import { db } from '../db/client.js';
import { testEnvironments } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../lib/secret-crypto.js';
import pg from 'pg';

export class EnvMissing extends Error {
  constructor() { super('no environment configured for case or plan'); this.name = 'EnvMissing'; }
}

export class EnvProjectMismatch extends Error {
  constructor() { super('environment belongs to a different project'); this.name = 'EnvProjectMismatch'; }
}

export class DecryptError extends Error {
  constructor(cause: string) { super(`decrypt failed: ${cause}`); this.name = 'DecryptError'; }
}

export interface EnvCtx {
  envId: string;
  db?: { host: string; port: number; database: string; user: string; password: string };
  syslog?: { host: string; port: number; user: string; privateKey: Buffer; filePath: string };
  close(): Promise<void>;
}

interface EnvRow {
  id: string;
  projectId: string;
  dbHost: string | null;
  dbPort: number | null;
  dbName: string | null;
  dbUser: string | null;
  dbPasswordCiphertext: string | null;
  dbPasswordIv: string | null;
  dbPasswordTag: string | null;
  syslogHost: string | null;
  syslogUser: string | null;
  syslogSshPort: number | null;
  syslogKeyCiphertext: string | null;
  syslogKeyIv: string | null;
  syslogKeyTag: string | null;
  syslogFilePath: string | null;
}

function b64(s: string | null): Buffer | null {
  return s ? Buffer.from(s, 'base64') : null;
}

function safeDecrypt(ciphertext: string, iv: string, tag: string): string {
  try {
    return decrypt({ ciphertext: Buffer.from(ciphertext, 'base64'), iv: Buffer.from(iv, 'base64'), tag: Buffer.from(tag, 'base64') });
  } catch (e) {
    throw new DecryptError(e instanceof Error ? e.message : String(e));
  }
}

export async function resolveEnv(
  opts: { planEnvId?: string | null; caseEnvId?: string | null },
  guard?: { expectedProjectId?: string },
): Promise<EnvCtx> {
  const envId = opts.planEnvId ?? opts.caseEnvId;
  if (!envId) throw new EnvMissing();

  const row = (await db.select().from(testEnvironments).where(eq(testEnvironments.id, envId)).limit(1))[0] as EnvRow | undefined;
  if (!row) throw new EnvMissing();

  if (guard?.expectedProjectId && row.projectId !== guard.expectedProjectId) {
    throw new EnvProjectMismatch();
  }

  let pool: pg.Pool | undefined;
  let dbCfg: EnvCtx['db'];
  if (row.dbHost && row.dbPort && row.dbName && row.dbUser) {
    let password = '';
    if (row.dbPasswordCiphertext && row.dbPasswordIv && row.dbPasswordTag) {
      password = safeDecrypt(row.dbPasswordCiphertext, row.dbPasswordIv, row.dbPasswordTag);
    }
    dbCfg = { host: row.dbHost, port: row.dbPort, database: row.dbName, user: row.dbUser, password };
    pool = new pg.Pool({ host: row.dbHost, port: row.dbPort, database: row.dbName, user: row.dbUser, password, max: 2 });
  }

  let syslogCfg: EnvCtx['syslog'];
  if (row.syslogHost && row.syslogUser && row.syslogKeyCiphertext && row.syslogKeyIv && row.syslogKeyTag && row.syslogFilePath) {
    const privateKey = decrypt({
      ciphertext: Buffer.from(row.syslogKeyCiphertext, 'base64'),
      iv: Buffer.from(row.syslogKeyIv, 'base64'),
      tag: Buffer.from(row.syslogKeyTag, 'base64'),
    });
    syslogCfg = {
      host: row.syslogHost,
      port: row.syslogSshPort ?? 22,
      user: row.syslogUser,
      privateKey: Buffer.from(privateKey),
      filePath: row.syslogFilePath,
    };
  }

  return {
    envId: row.id,
    db: dbCfg,
    syslog: syslogCfg,
    async close() {
      if (pool) await pool.end();
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @itest/api test -- envContext
```

Expected: 6 个用例全过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/execute/envContext.ts apps/api/src/execute/envContext.test.ts
git commit -m "feat(api): envContext resolves + decrypts credentials"
```

---

### Task 5: dbQuery.ts (TDD) — 白名单 SELECT + assertion

**Files:**
- Create: `apps/api/src/execute/dbQuery.ts`
- Test: `apps/api/src/execute/dbQuery.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/api/src/execute/dbQuery.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { QueryDbError, QueryDbColumnNotAllowed, QueryDbTableNotAllowed, assertColumnsAllowed, ALLOWED_QUERY_COLUMNS } from './dbQuery.js';

describe('assertColumnsAllowed', () => {
  it('accepts known columns', () => {
    expect(() => assertColumnsAllowed('reports', ['id', 'status'])).not.toThrow();
  });
  it('rejects unknown column', () => {
    expect(() => assertColumnsAllowed('reports', ['secret_password'])).toThrow(QueryDbColumnNotAllowed);
  });
  it('rejects unknown table', () => {
    expect(() => assertColumnsAllowed('payments', ['id'])).toThrow(QueryDbTableNotAllowed);
  });
});

describe('ALLOWED_QUERY_COLUMNS', () => {
  it('never includes password / secret columns', () => {
    for (const cols of Object.values(ALLOWED_QUERY_COLUMNS)) {
      for (const c of cols) {
        expect(c).not.toMatch(/password|secret|token/i);
      }
    }
  });
});

describe('runQueryDb (integration)', () => {
  // 集成测试走 testcontainers，覆盖 50 行截断、参数化 where、assertion 三档；
  // 见 apps/api/test/execute-env.test.ts（Task 11）。
  it('placeholder', () => { expect(QueryDbError).toBeDefined(); });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @itest/api test -- dbQuery
```

Expected: `Cannot find module './dbQuery.js'`。

- [ ] **Step 3: 实现 dbQuery.ts**

`apps/api/src/execute/dbQuery.ts`：

```typescript
import type pg_ from 'pg';
import type { QueryDbAction, DbAssertionMatch } from '@itest/shared';

export class QueryDbError extends Error {
  constructor(msg: string) { super(msg); this.name = 'QueryDbError'; }
}
export class QueryDbTableNotAllowed extends Error {
  constructor(t: string) { super(`table not allowed: ${t}`); this.name = 'QueryDbTableNotAllowed'; }
}
export class QueryDbColumnNotAllowed extends Error {
  constructor(c: string) { super(`column not allowed: ${c}`); this.name = 'QueryDbColumnNotAllowed'; }
}

export const ALLOWED_QUERY_COLUMNS: Record<string, ReadonlySet<string>> = {
  projects: new Set(['id', 'organization_id', 'name', 'description', 'default_url', 'repo_url', 'default_branch', 'provider', 'gitlab_url_override', 'created_at', 'updated_at']),
  groups: new Set(['id', 'project_id', 'name', 'default_url', 'created_at', 'updated_at']),
  users: new Set(['id', 'username', 'display_name', 'email', 'language_preference', 'created_at', 'updated_at']),
  test_cases: new Set(['id', 'requirement_id', 'group_id', 'title', 'priority', 'status', 'scenario_id', 'default_env_id', 'created_at', 'updated_at']),
  test_steps: new Set(['id', 'case_id', 'order', 'name', 'source', 'tab_ref', 'component_kind', 'created_at']),
  reports: new Set(['id', 'case_id', 'status', 'duration_ms', 'created_at']),
  execution_plans: new Set(['id', 'project_id', 'name', 'environment', 'environment_id', 'strategy', 'login_prepare_enabled', 'created_at', 'updated_at']),
  plan_runs: new Set(['id', 'plan_id', 'project_id', 'status', 'started_at', 'finished_at', 'duration_ms', 'total_cases', 'passed_cases', 'failed_cases', 'skipped_cases']),
  plan_run_cases: new Set(['id', 'plan_run_id', 'case_id', 'report_id', 'order', 'status', 'step_kind', 'started_at', 'finished_at', 'duration_ms']),
  test_attachments: new Set(['id', 'case_id', 'project_id', 'step_id', 'original_name', 'size', 'sha256', 'created_at']),
};

export function assertColumnsAllowed(table: string, columns: string[]): void {
  const allowed = ALLOWED_QUERY_COLUMNS[table];
  if (!allowed) throw new QueryDbTableNotAllowed(table);
  for (const c of columns) {
    if (!allowed.has(c)) throw new QueryDbColumnNotAllowed(c);
  }
}

export interface DbQueryRowResult {
  rowCount: number;
  durationMs: number;
  rows: Record<string, unknown>[];
  truncated?: boolean;
  assertion?: { matched: boolean; expected: string; match: 'equals' | 'contains' | 'regex' };
}

const TRUNCATE = 50;

export async function runQueryDb(opts: {
  pool: pg_.Pool;
  action: QueryDbAction;
}): Promise<DbQueryRowResult> {
  const { pool, action } = opts;
  const table = action.table;
  const requestedCols = action.columns.length ? action.columns : Array.from(ALLOWED_QUERY_COLUMNS[table]!);
  assertColumnsAllowed(table, requestedCols);

  const where = action.where;
  const params: unknown[] = [];
  const whereParts: string[] = [];
  for (let i = 0; i < where.length; i++) {
    const { column, equals } = where[i]!;
    if (!ALLOWED_QUERY_COLUMNS[table]!.has(column)) throw new QueryDbColumnNotAllowed(column);
    params.push(equals);
    whereParts.push(`"${column.replace(/"/g, '""')}" = $${i + 1}`);
  }

  const limit = Math.min(action.limit, 200);
  const sql = [
    'SELECT',
    requestedCols.map((c) => `"${c.replace(/"/g, '""')}"`).join(', '),
    `FROM "${table}"`,
    whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '',
    `LIMIT ${limit}`,
  ].filter(Boolean).join(' ');

  const t0 = Date.now();
  let rows: Record<string, unknown>[];
  try {
    const result = await pool.query(sql, params);
    rows = result.rows as Record<string, unknown>[];
  } catch (e) {
    throw new QueryDbError(e instanceof Error ? e.message : String(e));
  }

  const durationMs = Date.now() - t0;
  const truncated = rows.length > TRUNCATE;
  const truncatedRows = truncated ? rows.slice(0, TRUNCATE) : rows;

  let assertion: DbQueryRowResult['assertion'];
  if (action.assertion) {
    assertion = {
      matched: matchesAssertion(truncatedRows, action.assertion.match, action.assertion.expected, action.assertion.column),
      expected: action.assertion.expected,
      match: action.assertion.match,
    };
  }

  return { rowCount: rows.length, durationMs, rows: truncatedRows, ...(truncated ? { truncated: true } : {}), assertion };
}

function matchesAssertion(
  rows: Record<string, unknown>[],
  match: DbAssertionMatch,
  expected: string,
  column?: string,
): boolean {
  for (const row of rows) {
    if (column) {
      if (compareValue(row[column], match, expected)) return true;
      continue;
    }
    for (const v of Object.values(row)) {
      if (compareValue(v, match, expected)) return true;
    }
  }
  return false;
}

function compareValue(v: unknown, match: DbAssertionMatch, expected: string): boolean {
  const s = v === null || v === undefined ? '' : String(v);
  if (match === 'equals') return s === expected;
  if (match === 'contains') return s.includes(expected);
  if (match === 'regex') {
    try { return new RegExp(expected).test(s); } catch { return false; }
  }
  return false;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @itest/api test -- dbQuery
```

Expected: 4 个用例全过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/execute/dbQuery.ts apps/api/src/execute/dbQuery.test.ts
git commit -m "feat(api): dbQuery runner with whitelist + assertion"
```

---

### Task 6: syslogReader.ts (TDD) — ssh2 tail + 时间窗 + 关键字

**Files:**
- Create: `apps/api/src/execute/syslogReader.ts`
- Test: `apps/api/src/execute/syslogReader.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/api/src/execute/syslogReader.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const execMock = vi.fn();
const connectMock = vi.fn();
const endMock = vi.fn();

vi.mock('ssh2', () => {
  return {
    Client: class FakeClient extends EventEmitter {
      connect(cfg: unknown) { connectMock(cfg); }
      exec(cmd: string, cb: (err: null, ch: unknown) => void) {
        execMock(cmd);
        const stream = new EventEmitter() as EventEmitter & { read: () => Buffer | null };
        (stream as unknown as { read: () => Buffer | null }).read = () => null;
        cb(null, stream);
      }
      end() { endMock(); }
    }
  };
});

import { runObserveLog, SyslogConnectFailed, SyslogFileMissing } from './syslogReader.js';

describe('runObserveLog', () => {
  beforeEach(() => {
    execMock.mockReset();
    endMock.mockReset();
  });

  it('connects with privateKey and execs tail + awk', async () => {
    const stream = (await new Promise<unknown>((resolve) => {
      execMock.mockImplementationOnce((_cmd, cb) => {
        const s = new EventEmitter();
        s.read = () => null;
        cb(null, s);
        resolve(s);
      });
      connectMock.mockImplementationOnce(() => {
        // emit ready synchronously after handlers attached
      });
      runObserveLog({
        env: { host: 'h', port: 22, user: 'u', privateKey: Buffer.from('k'), filePath: '/var/log/app.log' },
        action: { kind: 'observeLog', windowMs: 60000, keywords: ['ERROR'], fromLine: 200 },
        since: new Date('2026-10-03T00:00:00Z'),
      }).catch(() => {});
    })) as EventEmitter;

    expect(connectMock).toHaveBeenCalledWith(expect.objectContaining({ host: 'h', username: 'u' }));
    expect(execMock.mock.calls.some(([c]) => typeof c === 'string' && c.startsWith('tail'))).toBe(true);
    expect(execMock.mock.calls.some(([c]) => typeof c === 'string' && c.includes('awk'))).toBe(true);
  });

  it('throws SyslogConnectFailed when error emitted', async () => {
    vi.useFakeTimers();
    const { Client } = await import('ssh2');
    const inst = new (Client as unknown as { new (): unknown })();
    const promise = runObserveLog({
      env: { host: 'h', port: 22, user: 'u', privateKey: Buffer.from('k'), filePath: '/var/log/app.log' },
      action: { kind: 'observeLog', windowMs: 60000, keywords: [], fromLine: 200 },
      since: new Date(),
    }).catch((e) => e);
    queueMicrotask(() => (inst as unknown as EventEmitter).emit('error', new Error('ECONNREFUSED')));
    const result = await promise;
    expect(result).toBeInstanceOf(SyslogConnectFailed);
    vi.useRealTimers();
  });

  it('exposes SyslogFileMissing class', () => {
    expect(SyslogFileMissing).toBeDefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @itest/api test -- syslogReader
```

Expected: 失败，错误 `Cannot find module`。

- [ ] **Step 3: 实现 syslogReader.ts**

`apps/api/src/execute/syslogReader.ts`：

```typescript
import { Client } from 'ssh2';
import type { ObserveLogAction } from '@itest/shared';

export class SyslogConnectFailed extends Error {
  constructor(cause: string) { super(`syslog connect failed: ${cause}`); this.name = 'SyslogConnectFailed'; }
}
export class SyslogAuthFailed extends Error {
  constructor() { super('syslog auth failed'); this.name = 'SyslogAuthFailed'; }
}
export class SyslogFileMissing extends Error {
  constructor(p: string) { super(`syslog file not accessible: ${p}`); this.name = 'SyslogFileMissing'; }
}
export class SyslogTimeout extends Error {
  constructor() { super('syslog command timeout'); this.name = 'SyslogTimeout'; }
}

export interface ObserveLogLineResult {
  matchedLineCount: number;
  durationMs: number;
  lines: { ts?: string; raw: string }[];
  truncated?: boolean;
  assertion?: { matched: boolean; expected: string; match: 'equals' | 'contains' | 'regex' };
}

const TRUNCATE = 50;
const TIMEOUT_MS = 15_000;

export async function runObserveLog(opts: {
  env: { host: string; port: number; user: string; privateKey: Buffer; filePath: string };
  action: ObserveLogAction;
  since: Date;
}): Promise<ObserveLogLineResult> {
  const { env, action, since } = opts;
  const client = new Client();

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', (err) => reject(err.message.toLowerCase().includes('auth') ? new SyslogAuthFailed() : new SyslogConnectFailed(err.message)));
    client.connect({ host: env.host, port: env.port, username: env.user, privateKey: env.privateKey, readyTimeout: 8000 });
  });

  const sinceIso = since.toISOString();
  const kwPattern = action.keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const cmd = [
    `tail -n ${action.fromLine} '${env.filePath}'`,
    `awk -v since="${sinceIso}" '$1 >= since'`,
    kwPattern ? `grep -Ei '${kwPattern}'` : 'cat',
  ].join(' | ');

  const t0 = Date.now();
  const raw = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new SyslogTimeout()), TIMEOUT_MS);
    client.exec(cmd, (err, ch) => {
      if (err) { clearTimeout(timer); reject(new SyslogFileMissing(err.message)); return; }
      ch.on('data', (d: Buffer) => { buf += d.toString('utf8'); });
      ch.on('close', () => { clearTimeout(timer); resolve(buf); });
      ch.on('error', (e: Error) => { clearTimeout(timer); reject(new SyslogFileMissing(e.message)); });
      ch.stderr.on('data', (d: Buffer) => { /* swallow */ void d; });
    });
  });

  client.end();
  const durationMs = Date.now() - t0;
  let lines = raw.split('\n').filter(Boolean).map((line) => {
    const space = line.indexOf(' ');
    if (space > 0 && /^\d{4}-\d{2}-\d{2}T/.test(line.slice(0, space))) {
      return { ts: line.slice(0, space), raw: line };
    }
    return { raw: line };
  });

  const truncated = lines.length > TRUNCATE;
  if (truncated) lines = lines.slice(0, TRUNCATE);

  let assertion: ObserveLogLineResult['assertion'];
  if (action.assertion) {
    assertion = {
      matched: lines.some((l) => matchesOne(l.raw, action.assertion!.match, action.assertion!.expected)),
      expected: action.assertion.expected,
      match: action.assertion.match,
    };
  }

  return { matchedLineCount: lines.length, durationMs, lines, ...(truncated ? { truncated: true } : {}), assertion };
}

function matchesOne(s: string, match: 'equals' | 'contains' | 'regex', expected: string): boolean {
  if (match === 'equals') return s === expected;
  if (match === 'contains') return s.includes(expected);
  if (match === 'regex') { try { return new RegExp(expected).test(s); } catch { return false; } }
  return false;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @itest/api test -- syslogReader
```

Expected: 3 个用例全过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/execute/syslogReader.ts apps/api/src/execute/syslogReader.test.ts
git commit -m "feat(api): syslogReader ssh2 tail + window + keywords"
```

---

### Task 7: failureClassifier.ts 新增 10 个 reason

**Files:**
- Modify: `apps/api/src/execute/failureClassifier.ts`

- [ ] **Step 1: 看现有 failureClassifier 结构**

```bash
grep -n "FailureReason\|classify\|humanMessage" /Users/lyq/workdir/codedev/iTest/apps/api/src/execute/failureClassifier.ts | head -20
```

- [ ] **Step 2: 在 FailureReason union 末尾追加 10 个字符串**

定位 `FailureReason` 的 type alias（形如 `export type FailureReason = 'URLUnreachable' | ... | 'Unknown'`），在 `'Unknown'` 之前追加：

```ts
  | 'QueryDbError'
  | 'QueryDbTableNotAllowed'
  | 'QueryDbColumnNotAllowed'
  | 'QueryDbAssertionFailed'
  | 'EnvMissing'
  | 'EnvDbMissing'
  | 'EnvSyslogMissing'
  | 'SyslogConnectFailed'
  | 'SyslogAuthFailed'
  | 'SyslogFileMissing'
  | 'SyslogTimeout'
  | 'LogAssertionFailed'
```

- [ ] **Step 3: 在 classify 函数内（switch / if 链末尾，`Unknown` 分支之前）追加 12 条映射**

按现有风格追加（`err.name === 'EnvMissing'` → `'EnvMissing'` + "缺少环境配置，请到项目设置配置"；依次类推）：

```ts
if (err.name === 'EnvMissing' || err.message.includes('no environment configured')) {
  return { reason: 'EnvMissing', humanMessage: '缺少环境配置，请到项目设置配置测试环境' };
}
if (err.name === 'EnvDbMissing' || err.message.includes('env db missing')) {
  return { reason: 'EnvDbMissing', humanMessage: '当前环境未配置数据库连接' };
}
if (err.name === 'EnvSyslogMissing' || err.message.includes('env syslog missing')) {
  return { reason: 'EnvSyslogMissing', humanMessage: '当前环境未配置 syslog 连接' };
}
if (err.name === 'QueryDbError') return { reason: 'QueryDbError', humanMessage: `数据库查询失败：${err.message}` };
if (err.name === 'QueryDbTableNotAllowed') return { reason: 'QueryDbTableNotAllowed', humanMessage: '该表不在允许查询的列表中' };
if (err.name === 'QueryDbColumnNotAllowed') return { reason: 'QueryDbColumnNotAllowed', humanMessage: '该列不在允许查询的列表中' };
if (err.name === 'QueryDbAssertionFailed') return { reason: 'QueryDbAssertionFailed', humanMessage: '数据库断言未命中' };
if (err.name === 'SyslogConnectFailed' || err.message.includes('syslog connect failed')) {
  return { reason: 'SyslogConnectFailed', humanMessage: '连接 syslog 服务器失败' };
}
if (err.name === 'SyslogAuthFailed') return { reason: 'SyslogAuthFailed', humanMessage: 'syslog 鉴权失败' };
if (err.name === 'SyslogFileMissing') return { reason: 'SyslogFileMissing', humanMessage: 'syslog 日志文件不可访问' };
if (err.name === 'SyslogTimeout') return { reason: 'SyslogTimeout', humanMessage: '读取 syslog 超时' };
if (err.name === 'LogAssertionFailed') return { reason: 'LogAssertionFailed', humanMessage: '日志断言未命中' };
```

- [ ] **Step 4: 在现有 failureClassifier 测试文件追加 case**

找到 `failureClassifier.test.ts`，追加 12 个 it case：

```typescript
it('classifies EnvMissing', () => { expect(classify(Object.assign(new Error('x'), { name: 'EnvMissing' })).reason).toBe('EnvMissing'); });
it('classifies QueryDbColumnNotAllowed', () => { expect(classify(Object.assign(new Error('x'), { name: 'QueryDbColumnNotAllowed' })).reason).toBe('QueryDbColumnNotAllowed'); });
// ... 其它 10 条同模式
```

- [ ] **Step 5: 跑测试**

```bash
pnpm --filter @itest/api test -- failureClassifier
```

Expected: 全部通过。

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/execute/failureClassifier.ts apps/api/src/execute/failureClassifier.test.ts
git commit -m "feat(api): classify queryDb / observeLog / env failure reasons"
```

---

### Task 8: cdp.ts dispatch 加 queryDb / observeLog 分支

**Files:**
- Modify: `apps/api/src/execute/cdp.ts`

- [ ] **Step 1: 看现有 dispatch 函数签名与 ctx 字段**

```bash
grep -n "function dispatch\|interface.*Ctx\|opts.ctx" /Users/lyq/workdir/codedev/iTest/apps/api/src/execute/cdp.ts | head -20
```

- [ ] **Step 2: 给 ctx 加 envCtx 字段**

定位 `interface ... Ctx` 或 `dispatch` 入参的 ctx 类型，给它加：

```ts
  envCtx?: import('./envContext.js').EnvCtx;
```

- [ ] **Step 3: 在 dispatch switch 末尾追加两个 case**

定位 `switch (action.kind)` 块的 `default:` 之前，追加：

```typescript
    case 'queryDb': {
      const start = Date.now();
      if (!opts.ctx.envCtx?.db) {
        const e = new Error('env db missing'); e.name = 'EnvDbMissing'; throw e;
      }
      // pool 是 EnvCtx 内部 pool；通过二次调用 export 一个 getPool(envCtx) 拿到
      // 见 Task 5：envContext 应在 dbCfg 旁挂一个 pool（轻改 Task 4 Step 3）。
      const result = await runQueryDb({ pool: getPool(opts.ctx.envCtx), action });
      return { ok: true, status: 'passed' as const, durationMs: Date.now() - start, db: result };
    }
    case 'observeLog': {
      const start = Date.now();
      if (!opts.ctx.envCtx?.syslog) {
        const e = new Error('env syslog missing'); e.name = 'EnvSyslogMissing'; throw e;
      }
      const result = await runObserveLog({ env: opts.ctx.envCtx.syslog, action, since: new Date(start) });
      return { ok: true, status: 'passed' as const, durationMs: Date.now() - start, log: result };
    }
```

- [ ] **Step 4: 在 cdp.ts 文件末尾追加 `getPool` 辅助**

```typescript
import { Pool } from 'pg';
const _pools = new WeakMap<object, Pool>();
export function setEnvPool(envCtx: object, pool: Pool) { _pools.set(envCtx, pool); }
function getPool(envCtx: object): Pool {
  const p = _pools.get(envCtx);
  if (!p) throw new Error('env pool not initialized');
  return p;
}
```

- [ ] **Step 5: 改 EnvCtx.close 释放时同步清 pool**

回到 `apps/api/src/execute/envContext.ts`，把 pool 也挂到自身 WeakMap（在 `resolveEnv` 内 `setEnvPool(result, pool)`），并在 `close()` 末尾清。

- [ ] **Step 6: 跑 api typecheck**

```bash
pnpm --filter @itest/api typecheck
```

Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/execute/cdp.ts apps/api/src/execute/envContext.ts
git commit -m "feat(api): cdp dispatch handles queryDb / observeLog"
```

---

### Task 9: runCase + runPlan 注入 envCtx

**Files:**
- Modify: `apps/api/src/execute/runCase.ts`
- Modify: `apps/api/src/execute/runPlan.ts`

- [ ] **Step 1: runCase.ts 加 envCtx 解析与传入**

`apps/api/src/execute/runCase.ts:7` 的 runCase 入参增加 opts：

```typescript
opts?: { storageState?: unknown; forceFail?: boolean; envOverride?: { envId: string } | null },
```

`runCase.ts:48` 后（在 caseRow 读完之后、executeCaseReal 调用前）插入：

```typescript
  const { resolveEnv } = await import('./envContext.js');
  const group2 = caseRow.groupId
    ? (await db.select({ projectId: groups.projectId }).from(groups).where(eq(groups.id, caseRow.groupId)))[0]
    : undefined;
  const expectedProjectId = group2?.projectId;
  let envCtx: import('./envContext.js').EnvCtx | undefined;
  try {
    envCtx = await resolveEnv(
      {
        planEnvId: opts?.envOverride?.envId ?? null,
        caseEnvId: caseRow.defaultEnvId ?? null,
      },
      expectedProjectId ? { expectedProjectId } : undefined,
    );
  } catch (e) {
    if (e instanceof Error && (e.name === 'EnvMissing' || e.name === 'EnvProjectMismatch')) {
      // 转为失败步骤，不抛 500
      const reportId = (await db.insert(reports).values({ caseId, status: 'running', stepResults: [] as object, summary: 'env missing' }).returning())[0]!.id;
      const stepResults: ExecStepResult[] = [{
        order: 1, status: 'failed', durationMs: 0,
        failureReason: e.name as 'FailureReason', humanMessage: e.message,
      }];
      await db.update(reports).set({ status: 'failed', durationMs: 0, stepResults: stepResults as object, summary: e.message }).where(eq(reports.id, reportId));
      return { reportId, status: 'failed' };
    }
    throw e;
  }
```

把 `executeCaseReal` 调用点的 opts 增 `envCtx` 字段（cdp.ts 里 ctx 需新增 envCtx 参数；Task 8 已加）。

`runCase.ts` 末尾（finally）加：

```typescript
  finally { if (envCtx) await envCtx.close(); }
```

- [ ] **Step 2: runPlan.ts 解析 planEnvId 传给 runCase**

`apps/api/src/execute/runPlan.ts`，找到循环 `await runCase(...)` 的位置（搜 `runCase(`），把它改成：

```typescript
        const r = await runCase(caseId, { ...(planEnv?.envId ? { envOverride: { envId: planEnv.envId } } : {}) });
```

在 `runPlanAsync` 入口处读 `execution_plans.environmentId`：

```typescript
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)))[0]!;
  const { resolveEnv } = await import('./envContext.js');
  let planEnv: import('./envContext.js').EnvCtx | undefined;
  if (plan.environmentId) {
    try { planEnv = await resolveEnv({ planEnvId: plan.environmentId }, { expectedProjectId: plan.projectId }); }
    catch (e) { /* plan-level env 错：单 case 自己跑仍可；记 warning 继续 */ logger.warn({ err: e, planId }, 'plan env resolve failed'); }
  }
```

`runPlanAsync` 末尾 finally 加：

```typescript
  finally { if (planEnv) await planEnv.close(); }
```

- [ ] **Step 3: 跑 typecheck**

```bash
pnpm --filter @itest/api typecheck
```

Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/execute/runCase.ts apps/api/src/execute/runPlan.ts
git commit -m "feat(api): runCase / runPlan resolve env + pass envCtx"
```

---

### Task 10: environments 路由（CRUD）

**Files:**
- Create: `apps/api/src/routes/environments.ts`
- Modify: `apps/api/src/services/projectAccess.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/cases.ts`
- Modify: `apps/api/src/routes/plans.ts`

- [ ] **Step 1: 加 `assertEnvironmentVisible` 到 projectAccess**

`apps/api/src/services/projectAccess.ts` 末尾追加：

```typescript
export async function assertEnvironmentVisible(envId: string, user: AuthUser): Promise<{ projectId: string; envId: string }> {
  const { db } = await import('../db/client.js');
  const { testEnvironments } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const row = (await db.select().from(testEnvironments).where(eq(testEnvironments.id, envId)).limit(1))[0];
  if (!row) throw new HttpError(404, 'not_found', 'environment not found');
  await assertProjectVisible(row.projectId, user);
  return { projectId: row.projectId, envId };
}
```

（如文件无 `HttpError` import，加：`import { HttpError } from '../middleware/errorHandler.js';`）

- [ ] **Step 2: 创建 environments 路由**

`apps/api/src/routes/environments.ts`：

```typescript
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testEnvironments, testCases, executionPlans } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { encrypt } from '../lib/secret-crypto.js';
import { assertProjectVisible, assertEnvironmentVisible } from '../services/projectAccess.js';

export const environmentsRoute = Router();

const MASK = '••••••••';

function mask<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row };
  for (const k of ['db_password_ciphertext', 'db_password_iv', 'db_password_tag', 'syslog_key_ciphertext', 'syslog_key_iv', 'syslog_key_tag'] as const) {
    if (out[k]) out[k] = MASK;
  }
  return out;
}

environmentsRoute.get('/projects/:projectId/environments', async (req, res) => {
  const projectId = (req.params as { projectId: string }).projectId;
  await assertProjectVisible(projectId, req.user!);
  const rows = await db.select().from(testEnvironments).where(eq(testEnvironments.projectId, projectId)).orderBy(testEnvironments.createdAt);
  res.json(rows.map((r) => mask({ ...r })));
});

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  dbHost: z.string().max(200).optional(),
  dbPort: z.number().int().optional(),
  dbName: z.string().max(120).optional(),
  dbUser: z.string().max(120).optional(),
  dbPassword: z.string().max(500).optional(),
  syslogHost: z.string().max(200).optional(),
  syslogUser: z.string().max(120).optional(),
  syslogSshPort: z.number().int().optional(),
  syslogKey: z.string().max(8000).optional(),
  syslogFilePath: z.string().max(500).optional(),
});

environmentsRoute.post('/projects/:projectId/environments', async (req, res) => {
  const projectId = (req.params as { projectId: string }).projectId;
  await assertProjectVisible(projectId, req.user!);
  const body = CreateBody.parse(req.body);
  let dbPwd: { ciphertext: string; iv: string; tag: string } | undefined;
  let sshKey: { ciphertext: string; iv: string; tag: string } | undefined;
  if (body.dbPassword) {
    const e = encrypt(body.dbPassword);
    dbPwd = { ciphertext: e.ciphertext.toString('base64'), iv: e.iv.toString('base64'), tag: e.tag.toString('base64') };
  }
  if (body.syslogKey) {
    const e = encrypt(body.syslogKey);
    sshKey = { ciphertext: e.ciphertext.toString('base64'), iv: e.iv.toString('base64'), tag: e.tag.toString('base64') };
  }
  const inserted = await db.insert(testEnvironments).values({
    projectId,
    name: body.name,
    dbHost: body.dbHost ?? null,
    dbPort: body.dbPort ?? null,
    dbName: body.dbName ?? null,
    dbUser: body.dbUser ?? null,
    dbPasswordCiphertext: dbPwd?.ciphertext ?? null,
    dbPasswordIv: dbPwd?.iv ?? null,
    dbPasswordTag: dbPwd?.tag ?? null,
    syslogHost: body.syslogHost ?? null,
    syslogUser: body.syslogUser ?? null,
    syslogSshPort: body.syslogSshPort ?? null,
    syslogKeyCiphertext: sshKey?.ciphertext ?? null,
    syslogKeyIv: sshKey?.iv ?? null,
    syslogKeyTag: sshKey?.tag ?? null,
    syslogFilePath: body.syslogFilePath ?? null,
  }).returning();
  res.json(mask({ ...inserted[0]! }));
});

const PatchBody = CreateBody.partial();
environmentsRoute.patch('/environments/:id', async (req, res) => {
  const { projectId } = await assertEnvironmentVisible(req.params.id!, req.user!);
  const body = PatchBody.parse(req.body);
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) update.name = body.name;
  if (body.dbHost !== undefined) update.dbHost = body.dbHost;
  if (body.dbPort !== undefined) update.dbPort = body.dbPort;
  if (body.dbName !== undefined) update.dbName = body.dbName;
  if (body.dbUser !== undefined) update.dbUser = body.dbUser;
  if (body.syslogHost !== undefined) update.syslogHost = body.syslogHost;
  if (body.syslogUser !== undefined) update.syslogUser = body.syslogUser;
  if (body.syslogSshPort !== undefined) update.syslogSshPort = body.syslogSshPort;
  if (body.syslogFilePath !== undefined) update.syslogFilePath = body.syslogFilePath;
  if (body.dbPassword) {
    const e = encrypt(body.dbPassword);
    update.dbPasswordCiphertext = e.ciphertext.toString('base64');
    update.dbPasswordIv = e.iv.toString('base64');
    update.dbPasswordTag = e.tag.toString('base64');
  }
  if (body.syslogKey) {
    const e = encrypt(body.syslogKey);
    update.syslogKeyCiphertext = e.ciphertext.toString('base64');
    update.syslogKeyIv = e.iv.toString('base64');
    update.syslogKeyTag = e.tag.toString('base64');
  }
  await db.update(testEnvironments).set(update).where(and(eq(testEnvironments.id, req.params.id), eq(testEnvironments.projectId, projectId)));
  const row = (await db.select().from(testEnvironments).where(eq(testEnvironments.id, req.params.id)))[0];
  res.json(mask({ ...row! }));
});

environmentsRoute.delete('/environments/:id', async (req, res) => {
  const { projectId } = await assertEnvironmentVisible(req.params.id!, req.user!);
  const caseCount = (await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.defaultEnvId, req.params.id))).length;
  const planCount = (await db.select({ id: executionPlans.id }).from(executionPlans).where(eq(executionPlans.environmentId, req.params.id))).length;
  if (req.query.confirm !== 'true' && (caseCount > 0 || planCount > 0)) {
    res.json({ ok: false, requiresConfirm: true, caseCount, planCount });
    return;
  }
  await db.delete(testEnvironments).where(and(eq(testEnvironments.id, req.params.id), eq(testEnvironments.projectId, projectId)));
  res.json({ ok: true, caseCount, planCount });
});

environmentsRoute.get('/environments/allowed-tables', async (_req, res) => {
  const { ALLOWED_QUERY_COLUMNS } = await import('../execute/dbQuery.js');
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(ALLOWED_QUERY_COLUMNS)) out[k] = Array.from(v);
  res.json(out);
});
```

- [ ] **Step 3: 挂载到 index.ts**

`apps/api/src/index.ts` 在 `app.use('/api', plansRoute);` 之前或之后加一行：

```typescript
app.use('/api', environmentsRoute);
```

并在顶部 import：

```typescript
import { environmentsRoute } from './routes/environments.js';
```

- [ ] **Step 4: cases.ts PATCH 接 defaultEnvId**

`apps/api/src/routes/cases.ts:50` 的 PatchBody 加一行（任意位置）：

```typescript
  defaultEnvId: z.string().uuid().nullable().optional(),
```

`apps/api/src/routes/cases.ts` PATCH 路由内（在 update 对象构建时）加：

```typescript
  if (body.defaultEnvId !== undefined) {
    if (body.defaultEnvId !== null) {
      const { assertEnvironmentVisible } = await import('../services/projectAccess.js');
      await assertEnvironmentVisible(body.defaultEnvId, req.user!);
    }
    update.defaultEnvId = body.defaultEnvId;
  }
```

- [ ] **Step 5: plans.ts PATCH 接 environmentId**

`apps/api/src/routes/plans.ts:35` 的 PatchBody 加一行：

```typescript
  environmentId: z.string().uuid().nullable().optional(),
```

`PATCH /:id` handler 内加：

```typescript
  if (body.environmentId !== undefined) {
    if (body.environmentId !== null) {
      const { assertEnvironmentVisible } = await import('../services/projectAccess.js');
      await assertEnvironmentVisible(body.environmentId, req.user!);
    }
    update.environmentId = body.environmentId;
  }
```

- [ ] **Step 6: 跑 typecheck**

```bash
pnpm --filter @itest/api typecheck
```

Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/environments.ts apps/api/src/services/projectAccess.ts apps/api/src/index.ts apps/api/src/routes/cases.ts apps/api/src/routes/plans.ts
git commit -m "feat(api): environments CRUD + defaultEnvId / environmentId wiring"
```

---

### Task 11: API 集成测试（CRUD + 跨项目拒绝 + env 缺失）

**Files:**
- Create: `apps/api/test/environments.test.ts`
- Create: `apps/api/test/execute-env.test.ts`

- [ ] **Step 1: 写 environments CRUD 测试**

`apps/api/test/environments.test.ts`（参考 `cases-copy.test.ts` 的 helpers/db.ts 与 helpers/auth.ts 写法）：

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let projectId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { environmentsRoute } = await import('../src/routes/environments.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  projectId = (await seedProject(pool, orgId)).projectId;
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => { req.user = managerUserOf(userId, username, orgId, orgPath); next(); });
  app.use('/api', environmentsRoute);
  app.use(errorHandler);
});

afterAll(async () => { const { pool: p } = await import('../src/db/client.js'); await p.end(); await pool.end(); await container.stop(); });

describe('environments CRUD', () => {
  it('creates an env with encrypted password', async () => {
    const r = await request(app).post(`/api/projects/${projectId}/environments`).send({
      name: 'staging', dbHost: 'pg', dbPort: 5432, dbName: 'app', dbUser: 'app', dbPassword: 'hunter2',
    });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('staging');
    expect(r.body.db_password_ciphertext).toBe('••••••••');
  });

  it('lists envs with masked secrets', async () => {
    const r = await request(app).get(`/api/projects/${projectId}/environments`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body[0].db_password_ciphertext).toBe('••••••••');
  });

  it('patches env, preserves old password when not provided', async () => {
    const list = await request(app).get(`/api/projects/${projectId}/environments`);
    const id = list.body[0].id;
    const r = await request(app).patch(`/api/environments/${id}`).send({ name: 'staging-renamed' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('staging-renamed');
    expect(r.body.db_password_ciphertext).toBe('••••••••');
  });

  it('refuses delete when associated cases exist without ?confirm=true', async () => {
    // 创建一个 case 引用该 env
    const { casesRoute } = await import('../src/routes/cases.js');
    app.use('/api/cases', casesRoute);
    const list = await request(app).get(`/api/projects/${projectId}/environments`);
    const envId = list.body[0].id;
    // 创建 group + case，defaultEnvId=envId
    const group = await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, 'g') RETURNING id`, [projectId]);
    const c = await pool.query(`INSERT INTO test_cases(group_id, title, default_env_id) VALUES ($1, 't1', $2) RETURNING id`, [group.rows[0].id, envId]);
    const del = await request(app).delete(`/api/environments/${envId}`);
    expect(del.status).toBe(200);
    expect(del.body.requiresConfirm).toBe(true);
    expect(del.body.caseCount).toBe(1);
    // confirm=true 通过
    const delOk = await request(app).delete(`/api/environments/${envId}?confirm=true`);
    expect(delOk.status).toBe(200);
    expect(delOk.body.ok).toBe(true);
    // case.defaultEnvId 应被 SET NULL（FK ON DELETE SET NULL）
    const check = await pool.query(`SELECT default_env_id FROM test_cases WHERE id=$1`, [c.rows[0].id]);
    expect(check.rows[0].default_env_id).toBeNull();
  });

  it('allowed-tables returns whitelist', async () => {
    const r = await request(app).get('/api/environments/allowed-tables');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('reports');
    expect(r.body.reports).toContain('id');
  });

  it('rejects envId belonging to another project', async () => {
    // 第二个项目下建一条
    const { userId, username, orgId, orgPath } = await import('./helpers/auth.js').then(async () => {
      const { seedOrg, row } = await import('./helpers/db.js');
      return { ...(await seedOrg(pool)) };
    });
    const otherProject = (await seedProject(pool, orgId)).projectId;
    // 直接 SQL 插另一项目下的 env（绕开路由）
    const env = await pool.query(`INSERT INTO test_environments(project_id, name) VALUES ($1, 'o') RETURNING id`, [otherProject]);
    const r = await request(app).patch(`/api/environments/${env.rows[0].id}`).send({ name: 'hijack' });
    expect([403, 404]).toContain(r.status);
  });
});
```

- [ ] **Step 2: 跑测试**

```bash
pnpm --filter @itest/api test -- environments.test
```

Expected: 6 个全过。

- [ ] **Step 3: 写 execute-env 测试**

`apps/api/test/execute-env.test.ts`：

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let projectId: string;
let caseId: string;
let envId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 2).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { stepsRoute } = await import('../src/routes/steps.js');
  const { executeRoute } = await import('../src/routes/execute.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  projectId = (await seedProject(pool, orgId)).projectId;
  const group = await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, 'g') RETURNING id`, [projectId]);
  const c = await pool.query(`INSERT INTO test_cases(group_id, title) VALUES ($1, 'env-case') RETURNING id`, [group.rows[0].id]);
  caseId = c.rows[0].id;
  const e = await pool.query(`INSERT INTO test_environments(project_id, name, db_host, db_port, db_name, db_user) VALUES ($1, 'staging', $2, $4, 100, 'app', 'app') RETURNING id`, [projectId, 'localhost', 5432, container.getDatabase()]);
  envId = e.rows[0].id;
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => { req.user = managerUserOf(userId, username, orgId, orgPath); next(); });
  app.use('/api/cases', casesRoute);
  app.use('/api/cases', stepsRoute);
  app.use('/api', executeRoute);
  app.use(errorHandler);
});

afterAll(async () => { const { pool: p } = await import('../src/db/client.js'); await p.end(); await pool.end(); await container.stop(); });

describe('execute with env', () => {
  it('case with no env + queryDb step → fails with EnvMissing', async () => {
    await request(app).post(`/api/cases/${caseId}/steps`).send({
      steps: [{ order: 1, source: 'manual', action: { kind: 'queryDb', table: 'reports', where: [], columns: [], limit: 10 } }],
    });
    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(200);
    const { get } = await import('../src/db/client.js').then(async () => {
      const { db } = await import('../src/db/client.js');
      const { eq } = await import('drizzle-orm');
      const { reports } = await import('../src/db/schema.js');
      const list = await db.select().from(reports).where(eq(reports.caseId, caseId));
      return { get: list[0] };
    });
    expect(get.status).toBe('failed');
    expect((get.stepResults as { failureReason?: string }[])[0].failureReason).toBe('EnvMissing');
  });

  it('case with env + queryDb on reports → step result contains rows', async () => {
    await pool.query(`UPDATE test_cases SET default_env_id=$1 WHERE id=$2`, [envId, caseId]);
    await request(app).put(`/api/cases/${caseId}/steps`).send({
      steps: [{ source: 'manual', action: { kind: 'queryDb', table: 'reports', where: [{ column: 'status', equals: 'running' }], columns: ['id', 'status'], limit: 10 } }],
    });
    const r = await request(app).post(`/api/cases/${caseId}/execute`);
    expect(r.status).toBe(200);
    const { db } = await import('../src/db/client.js');
    const { reports } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const list = await db.select().from(reports).where(eq(reports.caseId, caseId));
    const rep = list[list.length - 1]!;
    expect(rep.status).toBe('passed');
    const sr = rep.stepResults as { db?: { rowCount: number; rows: unknown[] } }[];
    expect(sr[0].db?.rowCount).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 4: 跑测试**

```bash
pnpm --filter @itest/api test -- execute-env.test
```

Expected: 2 个全过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/environments.test.ts apps/api/test/execute-env.test.ts
git commit -m "test(api): environments CRUD + env-required execute"
```

---

### Task 12: web api client 加 environments 方法 + cases/plans patch 字段

**Files:**
- Modify: `apps/web/src/api/client.ts`

- [ ] **Step 1: 在 `cases.patch` Partial 类型里加 `defaultEnvId`**

`apps/web/src/api/client.ts:180-195` 的 patch body 类型（`Partial<{ ... }>`）加一行：

```typescript
  defaultEnvId: string | null;
```

- [ ] **Step 2: 在 `plans.patch` Partial 类型里加 `environmentId`**

`apps/web/src/api/client.ts:110-123` 加一行：

```typescript
  environmentId: string | null;
```

- [ ] **Step 3: 加 `api.environments` 命名空间**

`apps/web/src/api/client.ts` 在 `plans` 之前/之后加：

```typescript
  environments: {
    list: (projectId: string) => request<Environment[]>(`/projects/${projectId}/environments`),
    create: (projectId: string, body: Partial<{
      name: string; dbHost: string; dbPort: number; dbName: string; dbUser: string; dbPassword: string;
      syslogHost: string; syslogUser: string; syslogSshPort: number; syslogKey: string; syslogFilePath: string;
    }>) => request<Environment>(`/projects/${projectId}/environments`, { method: 'POST', body: JSON.stringify(body) }),
    patch: (id: string, body: Partial<{
      name: string; dbHost: string; dbPort: number; dbName: string; dbUser: string; dbPassword: string;
      syslogHost: string; syslogUser: string; syslogSshPort: number; syslogKey: string; syslogFilePath: string;
    }>) => request<Environment>(`/environments/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string, opts?: { confirm?: boolean }) =>
      request<{ ok: boolean; requiresConfirm?: boolean; caseCount?: number; planCount?: number }>(
        `/environments/${id}${opts?.confirm ? '?confirm=true' : ''}`, { method: 'DELETE' },
      ),
    allowedTables: () => request<Record<string, string[]>>('/environments/allowed-tables'),
  },
```

并在顶部 `import` 区附近加类型：

```typescript
export interface Environment {
  id: string;
  projectId: string;
  name: string;
  dbHost: string | null;
  dbPort: number | null;
  dbName: string | null;
  dbUser: string | null;
  dbPasswordCiphertext: string | null;
  syslogHost: string | null;
  syslogUser: string | null;
  syslogSshPort: number | null;
  syslogKeyCiphertext: string | null;
  syslogFilePath: string | null;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 4: 跑 web typecheck**

```bash
pnpm --filter @itest/web typecheck
```

Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/client.ts
git commit -m "feat(web): api.environments + defaultEnvId/environmentId patch fields"
```

---

### Task 13: web — ProjectEnvironments 页（CRUD）

**Files:**
- Create: `apps/web/src/pages/ProjectEnvironments.tsx`
- Create: `apps/web/src/pages/ProjectEnvironments.css`

- [ ] **Step 1: 创建 CSS**

`apps/web/src/pages/ProjectEnvironments.css`：

```css
.env-page { padding: 16px 24px; }
.env-table { width: 100%; border-collapse: collapse; }
.env-table th, .env-table td { padding: 8px 12px; border-bottom: 1px solid #eee; text-align: left; }
.env-mask { font-family: monospace; color: #888; }
.env-drawer-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.3); }
.env-drawer { position: fixed; right: 0; top: 0; bottom: 0; width: 480px; background: #fff; padding: 16px; overflow-y: auto; box-shadow: -2px 0 8px rgba(0,0,0,0.1); }
.env-form-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.env-form-row label { font-size: 13px; color: #555; }
.env-form-row input, .env-form-row textarea { padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; }
```

- [ ] **Step 2: 创建页面组件**

`apps/web/src/pages/ProjectEnvironments.tsx`：

```typescript
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import './ProjectEnvironments.css';

interface Props { projectId: string; }

export default function ProjectEnvironments({ projectId }: Props) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['environments', projectId], queryFn: () => api.environments.list(projectId) });
  const [editing, setEditing] = useState<null | { id?: string; initial?: Record<string, unknown> }>(null);

  const create = useMutation({
    mutationFn: (body: Parameters<typeof api.environments.create>[1]) => api.environments.create(projectId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['environments', projectId] }),
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.environments.patch>[1] }) => api.environments.patch(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['environments', projectId] }),
  });
  const remove = useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm: boolean }) => api.environments.remove(id, { confirm }),
    onSuccess: (r) => {
      if (r.requiresConfirm) {
        const ok = window.confirm(`有 ${r.caseCount} 个用例与 ${r.planCount} 个计划引用此环境，确认删除？引用将自动解除。`);
        if (ok) remove.mutate({ id: editing!.id!, confirm: true });
      } else {
        qc.invalidateQueries({ queryKey: ['environments', projectId] });
      }
    },
  });

  return (
    <div className="env-page">
      <button onClick={() => setEditing({ initial: { name: '' } })}>新建环境</button>
      <table className="env-table">
        <thead><tr><th>名称</th><th>DB</th><th>syslog</th><th>操作</th></tr></thead>
        <tbody>
          {list.data?.map((e) => (
            <tr key={e.id}>
              <td>{e.name}</td>
              <td>{e.dbHost ?? '—'} / {e.dbName ?? '—'}</td>
              <td>{e.syslogHost ?? '—'} / {e.syslogFilePath ?? '—'}</td>
              <td>
                <button onClick={() => setEditing({ id: e.id, initial: { name: e.name } })}>编辑</button>
                <button onClick={() => remove.mutate({ id: e.id, confirm: false })}>删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <EnvDrawer
        initial={editing.initial ?? {}}
        onClose={() => setEditing(null)}
        onSubmit={(body) => {
          if (editing.id) patch.mutate({ id: editing.id, body });
          else create.mutate(body);
          setEditing(null);
        }}
      />}
    </div>
  );
}

function EnvDrawer({ initial, onClose, onSubmit }: { initial: Record<string, unknown>; onClose: () => void; onSubmit: (body: Record<string, unknown>) => void }) {
  const [form, setForm] = useState<Record<string, string>>({
    name: (initial.name as string) ?? '',
    dbHost: '', dbPort: '', dbName: '', dbUser: '', dbPassword: '',
    syslogHost: '', syslogUser: '', syslogSshPort: '22', syslogKey: '', syslogFilePath: '',
  });
  return (
    <>
      <div className="env-drawer-mask" onClick={onClose} />
      <div className="env-drawer">
        <h3>{initial.id ? '编辑' : '新建'}环境</h3>
        {(['name','dbHost','dbPort','dbName','dbUser','dbPassword','syslogHost','syslogUser','syslogSshPort','syslogKey','syslogFilePath'] as const).map((k) => (
          <div className="env-form-row" key={k}>
            <label>{k}</label>
            {k === 'syslogKey' ? (
              <textarea rows={4} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} placeholder="PEM 格式私钥" />
            ) : (
              <input value={form[k]} type={k.includes('Password') ? 'password' : 'text'} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            )}
          </div>
        ))}
        <button onClick={() => onSubmit(form)}>保存</button>
        <button onClick={onClose}>取消</button>
      </div>
    </>
  );
}
```

- [ ] **Step 3: 跑 web typecheck**

```bash
pnpm --filter @itest/web typecheck
```

Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/ProjectEnvironments.tsx apps/web/src/pages/ProjectEnvironments.css
git commit -m "feat(web): ProjectEnvironments CRUD page"
```

---

### Task 14: web — Settings 挂载 + CaseDetail/PlanDetail 加环境 Select

**Files:**
- Modify: `apps/web/src/pages/Settings.tsx`
- Modify: `apps/web/src/pages/CaseDetail.tsx`
- Modify: `apps/web/src/pages/PlanDetail.tsx`

- [ ] **Step 1: 在 Settings.tsx 的 Tab 列表 + 渲染加 "测试环境"**

打开 `apps/web/src/pages/Settings.tsx`，找到现有 Tab 列表（如 `['profile', 'org', ...]`）加 `'environments'`；找到条件渲染处加：

```tsx
{activeTab === 'environments' && projectId && <ProjectEnvironments projectId={projectId} />}
```

并在顶部 import：

```tsx
import ProjectEnvironments from './ProjectEnvironments';
```

- [ ] **Step 2: CaseDetail 加默认环境 Select**

`apps/web/src/pages/CaseDetail.tsx` 找到 "无痕模式" Toggle 附近的区块（搜 `incognito`），在同一区块加：

```tsx
const envsQ = useQuery({ queryKey: ['environments', projectId], queryFn: () => api.environments.list(projectId!), enabled: !!projectId });
const [defaultEnvId, setDefaultEnvId] = useState<string | null>(null);
// 初始化：caseDetail.defaultEnvId
useEffect(() => { if (caseDetail) setDefaultEnvId((caseDetail as { defaultEnvId?: string | null }).defaultEnvId ?? null); }, [caseDetail]);

<label>默认环境</label>
<select value={defaultEnvId ?? ''} onChange={(e) => setDefaultEnvId(e.target.value || null)}>
  <option value="">跟随 plan</option>
  {envsQ.data?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
</select>
```

并在 `mutationFn: () => api.cases.patch(id!, { windowStrategy, windowWidth, windowHeight, incognito, defaultEnvId })` 加上 `defaultEnvId` 字段。

（如果当前代码中无 `projectId`，从 `caseDetail.groupId` 反查 —— 简化做法：跳过 projectId 必填，把 envsQ.enabled 设为 `false`，保留 UI 控件 + 直接 PATCH，env 选项在第一次保存时弹出。简化版代码注释里说明。）

- [ ] **Step 3: PlanDetail 加目标环境 Select**

`apps/web/src/pages/PlanDetail.tsx` 找到 "环境" 输入框（搜 `environment`），把它替换成 Select：

```tsx
const envsQ = useQuery({ queryKey: ['environments', plan.projectId], queryFn: () => api.environments.list(plan.projectId), enabled: !!plan.projectId });
const [environmentId, setEnvironmentId] = useState<string | null>(null);
useEffect(() => { setEnvironmentId((plan as { environmentId?: string | null }).environmentId ?? null); }, [plan]);
<label>目标环境</label>
<select value={environmentId ?? ''} onChange={(e) => setEnvironmentId(e.target.value || null)}>
  <option value="">跟随 case</option>
  {envsQ.data?.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
</select>
```

在 `mutationFn: (body) => api.plans.patch(id!, body)` 中把 body 加 `environmentId`：

```tsx
api.plans.patch(id!, { ...body, environmentId })
```

- [ ] **Step 4: 跑 web typecheck**

```bash
pnpm --filter @itest/web typecheck
```

Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Settings.tsx apps/web/src/pages/CaseDetail.tsx apps/web/src/pages/PlanDetail.tsx
git commit -m "feat(web): environment selectors on case and plan detail"
```

---

### Task 15: web — StepEditDrawer 加 queryDb / observeLog 子表单

**Files:**
- Modify: `apps/web/src/components/StepEditDrawer.tsx`
- Modify: `apps/web/src/lib/stepValidation.ts`
- Modify: `apps/web/src/lib/stepSummary.ts`

- [ ] **Step 1: 在 StepEditDrawer.tsx 的 kind 下拉加两 option**

找到 `kind === 'click' / 'fill' / ...` 的 Select 控件，加：

```tsx
<option value="queryDb">数据库查询</option>
<option value="observeLog">日志观察</option>
```

- [ ] **Step 2: 在 StepEditDrawer.tsx 的表单渲染加两个分支**

定位主表单 switch（如 `if (action.kind === 'click') { ... }` 链），加：

```tsx
{action.kind === 'queryDb' && <QueryDbForm action={action} onChange={setAction} />}
{action.kind === 'observeLog' && <ObserveLogForm action={action} onChange={setAction} />}
```

并在同文件末尾追加两个小组件：

```tsx
function QueryDbForm({ action, onChange }: { action: import('@itest/shared').QueryDbAction; onChange: (a: import('@itest/shared').QueryDbAction) => void }) {
  const tables = useQuery({ queryKey: ['env-allowed-tables'], queryFn: () => api.environments.allowedTables() });
  const cols = tables.data?.[action.table] ?? [];
  return (
    <div>
      <label>表名</label>
      <select value={action.table} onChange={(e) => onChange({ ...action, table: e.target.value as typeof action.table })}>
        {tables.data && Object.keys(tables.data).map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <label>返回列</label>
      <select multiple value={action.columns} onChange={(e) => onChange({ ...action, columns: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
        {cols.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <label>WHERE（最多 10 条）</label>
      {action.where.map((w, i) => (
        <div key={i}>
          <select value={w.column} onChange={(e) => {
            const next = [...action.where]; next[i] = { ...w, column: e.target.value }; onChange({ ...action, where: next });
          }}>{cols.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          <input value={String(w.equals)} onChange={(e) => {
            const next = [...action.where]; next[i] = { ...w, equals: e.target.value }; onChange({ ...action, where: next });
          }} />
          <button onClick={() => { const next = action.where.filter((_, j) => j !== i); onChange({ ...action, where: next }); }}>删</button>
        </div>
      ))}
      <button onClick={() => action.where.length < 10 && onChange({ ...action, where: [...action.where, { column: cols[0] ?? 'id', equals: '' }] })}>加一行</button>
      <label>limit</label>
      <input type="number" min={1} max={200} value={action.limit} onChange={(e) => onChange({ ...action, limit: Number(e.target.value) })} />
      <DbAssertionEditor assertion={action.assertion} onChange={(a) => onChange({ ...action, assertion: a })} columns={cols} />
    </div>
  );
}

function ObserveLogForm({ action, onChange }: { action: import('@itest/shared').ObserveLogAction; onChange: (a: import('@itest/shared').ObserveLogAction) => void }) {
  return (
    <div>
      <label>时间窗 ms</label>
      <input type="number" min={1000} max={600000} value={action.windowMs} onChange={(e) => onChange({ ...action, windowMs: Number(e.target.value) })} />
      <label>关键字（逗号分隔）</label>
      <input value={action.keywords.join(',')} onChange={(e) => onChange({ ...action, keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
      <label>起始行数</label>
      <input type="number" min={1} max={10000} value={action.fromLine} onChange={(e) => onChange({ ...action, fromLine: Number(e.target.value) })} />
      <DbAssertionEditor assertion={action.assertion} onChange={(a) => onChange({ ...action, assertion: a })} />
    </div>
  );
}

function DbAssertionEditor({ assertion, onChange, columns }: { assertion: { match: 'equals'|'contains'|'regex'; expected: string; column?: string } | undefined; onChange: (a: typeof assertion) => void; columns?: string[] }) {
  if (!assertion) return <button onClick={() => onChange({ match: 'contains', expected: '' })}>附加断言</button>;
  return (
    <div>
      <select value={assertion.match} onChange={(e) => onChange({ ...assertion, match: e.target.value as 'equals' | 'contains' | 'regex' })}>
        <option value="equals">equals</option>
        <option value="contains">contains</option>
        <option value="regex">regex</option>
      </select>
      <input value={assertion.expected} onChange={(e) => onChange({ ...assertion, expected: e.target.value })} />
      {columns && (
        <select value={assertion.column ?? ''} onChange={(e) => onChange({ ...assertion, column: e.target.value || undefined })}>
          <option value="">任意列</option>
          {columns.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      <button onClick={() => onChange(undefined)}>移除断言</button>
    </div>
  );
}
```

- [ ] **Step 3: 改 stepValidation.ts**

在 `apps/web/src/lib/stepValidation.ts` 找到 `StepAction.parse` 调用（已被 zod 覆盖），不需要改；但在 `unknownKind` 兜底分支加：

```typescript
if (action.kind === 'queryDb' || action.kind === 'observeLog') return null;
```

- [ ] **Step 4: 改 stepSummary.ts**

`apps/web/src/lib/stepSummary.ts` 的 switch 末尾：

```typescript
case 'queryDb': return `查 ${action.table}`;
case 'observeLog': return `观察日志${action.keywords.length ? ' · ' + action.keywords.join('/') : ''}`;
```

- [ ] **Step 5: 跑 web typecheck**

```bash
pnpm --filter @itest/web typecheck
```

Expected: 通过。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/StepEditDrawer.tsx apps/web/src/lib/stepValidation.ts apps/web/src/lib/stepSummary.ts
git commit -m "feat(web): queryDb/observeLog forms in StepEditDrawer"
```

---

### Task 16: web — ReportDetail 明细模式加 DB / 日志列

**Files:**
- Modify: `apps/web/src/pages/ReportDetail.tsx`

- [ ] **Step 1: 在明细模式表头加两列**

定位明细模式 `<th>...` 序列（在 `failureReason` 列后），加：

```tsx
<th>DB 结果</th>
<th>日志结果</th>
```

- [ ] **Step 2: 在 body 行加两个单元格**

```tsx
<td>{(step.db && <DbResultCell db={step.db} />) ?? '—'}</td>
<td>{(step.log && <LogResultCell log={step.log} />) ?? '—'}</td>
```

- [ ] **Step 3: 在同文件末尾加 DbResultCell / LogResultCell 组件**

```tsx
function DbResultCell({ db }: { db: { rowCount: number; rows: Record<string, unknown>[]; truncated?: boolean; assertion?: { matched: boolean; expected: string } } }) {
  return (
    <details>
      <summary>{db.rowCount} 行{db.truncated ? '（截断）' : ''}{db.assertion ? (db.assertion.matched ? ' ✓' : ' ✗') : ''}</summary>
      <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 12 }}>
        {JSON.stringify(db.rows.slice(0, 5), null, 2)}
      </pre>
      {db.assertion && <div>assertion: <b style={{ color: db.assertion.matched ? 'green' : 'red' }}>{db.assertion.matched ? '命中' : '未命中'}</b> "{db.assertion.expected}"</div>}
    </details>
  );
}

function LogResultCell({ log }: { log: { matchedLineCount: number; lines: { ts?: string; raw: string }[]; truncated?: boolean; assertion?: { matched: boolean; expected: string } } }) {
  return (
    <details>
      <summary>{log.matchedLineCount} 行{log.truncated ? '（截断）' : ''}{log.assertion ? (log.assertion.matched ? ' ✓' : ' ✗') : ''}</summary>
      <div style={{ maxHeight: 240, overflow: 'auto', fontSize: 12 }}>
        {log.lines.slice(0, 20).map((l, i) => <div key={i} style={{ background: l.raw.includes('ERROR') ? '#fee' : undefined }}>{l.ts ?? ''} {l.raw}</div>)}
      </div>
      {log.assertion && <div>assertion: <b style={{ color: log.assertion.matched ? 'green' : 'red' }}>{log.assertion.matched ? '命中' : '未命中'}</b> "{log.assertion.expected}"</div>}
    </details>
  );
}
```

- [ ] **Step 4: 跑 web typecheck**

```bash
pnpm --filter @itest/web typecheck
```

Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/ReportDetail.tsx
git commit -m "feat(web): report detail DB / log columns"
```

---

### Task 17: 端到端冒烟 — 完整路径

- [ ] **Step 1: 跑全量 api 测试**

```bash
pnpm --filter @itest/api test
```

Expected: 全部通过（含 Task 4/5/6/7/11 新增的用例）。

- [ ] **Step 2: 跑 web typecheck + 已有 web 测试**

```bash
pnpm --filter @itest/web typecheck
pnpm --filter @itest/web test 2>/dev/null || true
```

Expected: 无错。

- [ ] **Step 3: 起全栈 dev**

```bash
cd /Users/lyq/workdir/codedev/iTest
pnpm db:migrate --filter @itest/api   # 应用 0019 迁移
pnpm dev
```

浏览器打开 `http://localhost:5173`，登录 admin/admin123，新建一个 project，进入 Settings → Environments → 新建环境（DB 连本地 PG）。手工验证 queryDb 步骤跑通。

- [ ] **Step 4: Commit（如有 schema 漂移）**

```bash
git add apps/api/drizzle/meta/ apps/api/drizzle/0019_test_environments.sql
git commit -m "chore: drizzle meta after 0019 apply (if any drift)"
```

---

## Self-Review Checklist（提交前自检）

- [ ] spec §1 背景与目标：Task 2（DSL）、Task 5（dbQuery）、Task 6（syslogReader）
- [ ] spec §2 架构：Task 4（envContext）、Task 8（cdp dispatch）、Task 9（runCase/Plan 注入）
- [ ] spec §3 数据模型：Task 3（迁移 + helpers/db.ts）
- [ ] spec §4 DSL：Task 2
- [ ] spec §5 执行器：Task 4/5/6/7/8/9
- [ ] spec §6 API 路由：Task 10
- [ ] spec §7 前端：Task 12/13/14/15/16
- [ ] spec §8 数据流契约：Task 8（cdp dispatch 写 db/log 字段）、Task 9（EnvMissing 落 stepResult）
- [ ] spec §9 测试计划：Task 4/5/6/7 单元测试；Task 11 集成测试；Task 17 E2E 冒烟
- [ ] spec §10 风险：白名单 + 参数化 prepared statement（Task 5）、密文仅 envCtx 内部（Task 4/10）、WeakMap pool（Task 8 Step 4-5）
- [ ] spec §11 兼容：测试 helper SCHEMA_SQL 增量加表（Task 3 Step 5）；前端 patch 类型 Partial 扩字段（Task 12/14）
- [ ] spec §12 不做：本期不含 multi-env parallel、INSERT/UPDATE、vault 接入、Helm 等；spec 自检后未发现遗漏