# 项目·分组·执行计划 — 后端 Implementation Plan（Part 1/2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 projects → groups → cases 数据模型、迁移、全部后端 API（项目/分组/复制/执行计划），测试全绿。前端在 Part 2  plan 中跟进（`2026-09-30-projects-groups-part2-frontend.md`）。

**Architecture:** Drizzle schema 加 4 张新表 + 两个存量表加列；用 drizzle-kit 三段迁移（建表+加列 → custom 回填 → NOT NULL）保证存量数据安全；Express 新增 projects/groups/plans 三个 route 文件，cases 扩展 groupId/url/过滤/复制；执行计划运行抽取 `runCase` 服务复用单用例执行链路。

**Tech Stack:** Express 5, Drizzle ORM, PostgreSQL (testcontainers), zod, vitest, supertest

**Spec:** `docs/superpowers/specs/2026-09-30-projects-groups-design.md`

**运行测试的统一约定：** 在 `apps/api` 目录下执行 `TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run <file>`。全部测试命令都以此为准。

---

### Task 1: Schema + 三段迁移 + 迁移测试

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0001_*.sql`（drizzle-kit 生成）
- Create: `apps/api/drizzle/0002_*.sql`（custom 回填）
- Create: `apps/api/drizzle/0003_*.sql`（drizzle-kit 生成）
- Test: `apps/api/test/migration.test.ts`

- [ ] **Step 1: schema.ts 加新表（新列先声明为 nullable）**

在 `apps/api/src/db/schema.ts` 中，`settings` 表之后追加：

```ts
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  defaultUrl: text('default_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const groups = pgTable('groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  defaultUrl: text('default_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const executionPlans = pgTable('execution_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  environment: varchar('environment', { length: 100 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const planCases = pgTable('plan_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id').notNull().references(() => executionPlans.id, { onDelete: 'cascade' }),
  caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
  order: integer('order').notNull(),
});
```

`test_cases` 表内追加两列（**注意先 nullable**，Step 5 才改 notNull）：

```ts
  requirementId: uuid('requirement_id').references(() => requirements.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').references(() => groups.id, { onDelete: 'cascade' }),
  url: text('url'),
  title: varchar('title', { length: 200 }).notNull(),
```

`requirements` 表内追加（同样先 nullable）：

```ts
  content: text('content').notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
```

- [ ] **Step 2: 生成 0001（建表 + 加列，列保持 nullable）**

```bash
cd apps/api && pnpm db:generate
```

Expected: 生成 `drizzle/0001_<tag>.sql`，含 4 张 CREATE TABLE + `ALTER TABLE test_cases ADD COLUMN group_id/url` + `ALTER TABLE requirements ADD COLUMN project_id`（均不带 NOT NULL）；`meta/_journal.json` 多一条 entry。**不要**执行 db:migrate。

- [ ] **Step 3: 生成 0002（custom 回填迁移）**

```bash
cd apps/api && pnpm drizzle-kit generate --custom --name backfill-default-project
```

Expected: 生成 `drizzle/0002_backfill-default-project.sql`（基本为空）。将其内容替换为：

```sql
--> statement-breakpoint
WITH "dp" AS (
  INSERT INTO "projects" ("name") VALUES ('默认项目') RETURNING "id"
),
"dg" AS (
  INSERT INTO "groups" ("project_id", "name") SELECT "id", '默认分组' FROM "dp" RETURNING "id"
)
UPDATE "test_cases" SET "group_id" = (SELECT "id" FROM "dg") WHERE "group_id" IS NULL;
--> statement-breakpoint
UPDATE "requirements" SET "project_id" = (SELECT "id" FROM "projects" ORDER BY "created_at" ASC LIMIT 1) WHERE "project_id" IS NULL;
```

- [ ] **Step 4: schema 改回 notNull，生成 0003**

把 Step 1 中三个列改为 notNull：

```ts
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
```

```ts
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
```

```bash
cd apps/api && pnpm db:generate
```

Expected: 生成 `drizzle/0003_<tag>.sql`，内容只有两条 `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL`（test_cases.group_id、requirements.project_id）。

- [ ] **Step 5: 对开发库执行迁移**

```bash
cd apps/api && pnpm db:migrate
```

Expected: `migrations applied successfully`。用 `docker exec itest-pg psql -U itest -d itest -c "\d test_cases"` 确认 group_id 为 not null；`psql -c "select name from projects"` 能看到「默认项目」。

- [ ] **Step 6: 写迁移测试（先跑 0000、造存量、再跑 0001-0003）**

创建 `apps/api/test/migration.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;
let pool: Pool;

const MIGRATIONS_DIR = new URL('../drizzle/', import.meta.url).pathname;

function migrationFile(prefix: string): string {
  const f = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith(prefix) && n.endsWith('.sql'));
  if (f.length !== 1) throw new Error(`expected exactly one ${prefix}*.sql, got ${f.join(',')}`);
  return f[0]!;
}

async function applyMigration(prefix: string) {
  const sql = readFileSync(join(MIGRATIONS_DIR, migrationFile(prefix)), 'utf8');
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const s = stmt.trim();
    if (s) await pool.query(s);
  }
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe('migrations', () => {
  it('0001-0003 backfill legacy rows into default project/group', async () => {
    await applyMigration('0000');
    // 存量数据：迁移前 schema 里没有 project/group 概念
    await pool.query(`INSERT INTO requirements(title, content) VALUES ('legacy req', 'content')`);
    await pool.query(`INSERT INTO test_cases(title) VALUES ('legacy case')`);

    await applyMigration('0001');
    await applyMigration('0002');
    await applyMigration('0003');

    const projects = await pool.query(`SELECT * FROM projects`);
    expect(projects.rows).toHaveLength(1);
    expect(projects.rows[0]!.name).toBe('默认项目');
    const groups = await pool.query(`SELECT * FROM groups`);
    expect(groups.rows[0]!.name).toBe('默认分组');
    expect(groups.rows[0]!.project_id).toBe(projects.rows[0]!.id);

    const cases = await pool.query(`SELECT * FROM test_cases`);
    expect(cases.rows[0]!.group_id).toBe(groups.rows[0]!.id);
    const reqs = await pool.query(`SELECT * FROM requirements`);
    expect(reqs.rows[0]!.project_id).toBe(projects.rows[0]!.id);
  });
});
```

- [ ] **Step 7: 跑迁移测试**

Run: `TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/migration.test.ts`
Expected: PASS（1 test）

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/test/migration.test.ts
git commit -m "feat(api): projects/groups/plans schema with 3-step migration"
```

---

### Task 2: cases 路由扩展（groupId/url/resolvedUrl/过滤）+ 测试 schema helper

**Files:**
- Create: `apps/api/test/helpers/db.ts`（共享建表 SQL + seed 函数）
- Modify: `apps/api/src/routes/cases.ts`
- Create: `apps/api/src/lib/resolve-url.ts`
- Modify: `apps/api/src/routes/recorder.ts`（session 响应带 resolvedUrl）
- Modify: `apps/api/test/cases.test.ts`、`apps/api/test/agentRuns.test.ts`、`apps/api/test/reports.test.ts`、`apps/api/test/requirements.test.ts`

- [ ] **Step 1: 共享测试 helper**

创建 `apps/api/test/helpers/db.ts`（最终态 schema，与迁移完成后的库一致）：

```ts
import type { Pool } from 'pg';

/** 与迁移完成后一致的全量建表 SQL（测试容器用，不走迁移）。 */
export const SCHEMA_SQL = `
CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(200) NOT NULL, default_url text, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE "groups" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL, name varchar(200) NOT NULL, default_url text, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE requirements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL, title varchar(200) NOT NULL, content text NOT NULL, status varchar(20) NOT NULL DEFAULT 'draft', created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE test_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requirement_id uuid REFERENCES requirements(id) ON DELETE CASCADE, group_id uuid REFERENCES "groups"(id) ON DELETE CASCADE NOT NULL, url text, title varchar(200) NOT NULL, description text, priority varchar(20) NOT NULL DEFAULT 'P1', status varchar(20) NOT NULL DEFAULT 'draft', created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE test_steps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, "order" integer NOT NULL, source varchar(20) NOT NULL, action jsonb NOT NULL, assertion jsonb, created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE agent_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_type varchar(30) NOT NULL, target_id uuid NOT NULL, status varchar(20) NOT NULL, prompt text NOT NULL, result jsonb, error text, started_at timestamp NOT NULL DEFAULT now(), finished_at timestamp);
CREATE TABLE reports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, agent_run_id uuid REFERENCES agent_runs(id), status varchar(20) NOT NULL, duration_ms integer, step_results jsonb NOT NULL, summary text, created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE settings (key varchar(100) PRIMARY KEY, value jsonb NOT NULL, updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE execution_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL, name varchar(200) NOT NULL, environment varchar(100), created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE plan_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid REFERENCES execution_plans(id) ON DELETE CASCADE NOT NULL, case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, "order" integer NOT NULL);
`;

/** 造一个项目+默认分组，返回 id 对。所有需要 group_id/project_id 的测试都用它。 */
export async function seedProject(pool: Pool): Promise<{ projectId: string; groupId: string }> {
  const p = await pool.query(`INSERT INTO projects(name) VALUES ('测试项目') RETURNING id`);
  const g = await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, '默认分组') RETURNING id`, [
    p.rows[0]!.id,
  ]);
  return { projectId: p.rows[0]!.id as string, groupId: g.rows[0]!.id as string };
}
```

- [ ] **Step 2: cases.test.ts 换用 helper**

把 `cases.test.ts` 的 `beforeAll` 里那段 `pool.query(\`CREATE TABLE ...\`)` 整体替换为：

```ts
import { SCHEMA_SQL, seedProject } from './helpers/db.js';
// beforeAll 内：
await pool.query(SCHEMA_SQL);
```

`afterAll` 保持不变。`POST /api/cases creates` 测试改为先 seed 再带 groupId：

```ts
it('POST /api/cases creates', async () => {
  const { groupId } = await seedProject(pool);
  const r = await request(app).post('/api/cases').send({ title: '登录成功', priority: 'P1', groupId });
  expect(r.status).toBe(200);
  expect(r.body.title).toBe('登录成功');
});
```

`GET /api/cases/:id` 与 steps 相关测试同理：每个 `post('/api/cases')` 前 `const { groupId } = await seedProject(pool);` 并把 `groupId` 放进 body。`POST /api/cases/:id/steps appends` 等 4 个测试逐一照改。

- [ ] **Step 3: cases 路由 — CreateBody 加 groupId/url，GET 加过滤，detail 加 resolvedUrl**

`apps/api/src/routes/cases.ts` 全文替换为：

```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { testCases, testSteps, groups } from '../db/schema.js';
import { eq, asc, inArray } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';
import { resolveCaseUrl } from '../lib/resolve-url.js';

export const casesRoute = Router();

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P1'),
  requirementId: z.string().uuid().optional(),
  groupId: z.string().uuid(),
  url: z.string().optional(),
});

casesRoute.get('/', async (req, res) => {
  const { priority, groupId, projectId } = req.query as Record<string, string | undefined>;
  let rows;
  if (projectId) {
    const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
    const gids = gs.map((g) => g.id);
    rows = gids.length
      ? await db.select().from(testCases).where(inArray(testCases.groupId, gids))
      : [];
  } else if (groupId) {
    rows = await db.select().from(testCases).where(eq(testCases.groupId, groupId));
  } else {
    rows = await db.select().from(testCases);
  }
  if (priority) rows = rows.filter((r) => r.priority === priority);
  res.json(rows);
});

casesRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const g = await db.select().from(groups).where(eq(groups.id, body.groupId));
  if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
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
  const resolvedUrl = await resolveCaseUrl(rows[0]!);
  res.json({ ...rows[0], steps, resolvedUrl });
});

casesRoute.patch('/:id', async (req, res) => {
  const body = CreateBody.partial().parse(req.body);
  if (body.groupId) {
    const g = await db.select().from(groups).where(eq(groups.id, body.groupId));
    if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  }
  const rows = await db
    .update(testCases)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(testCases.id, req.params.id))
    .returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  res.json(rows[0]);
});
```

注意：detail 路由 `/:id` 会挡住后面的 `/copy` 路由——Express 按注册顺序匹配，`GET /:id` 只匹配 GET，`POST /:id/copy` 是两段路径不冲突；Task 6 的 `POST /copy` 与 `POST /:id/copy` 也不冲突（段数不同）。无需调整顺序。

- [ ] **Step 4: resolve-url.ts**

创建 `apps/api/src/lib/resolve-url.ts`：

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groups, projects } from '../db/schema.js';

/** 默认域名解析链：用例.url → 分组.default_url → 项目.default_url。 */
export async function resolveCaseUrl(caseRow: { url: string | null; groupId: string }): Promise<string | null> {
  if (caseRow.url) return caseRow.url;
  const g = (await db.select().from(groups).where(eq(groups.id, caseRow.groupId)))[0];
  if (!g) return null;
  if (g.defaultUrl) return g.defaultUrl;
  const p = (await db.select().from(projects).where(eq(projects.id, g.projectId)))[0];
  return p?.defaultUrl ?? null;
}
```

- [ ] **Step 5: recorder session 响应带 resolvedUrl**

`apps/api/src/routes/recorder.ts` 的 `/sessions` 处理器中，`res.json({...})` 之前加解析（用例必属于某分组）：

```ts
import { testCases, testSteps } from '../db/schema.js'; // 顶部已部分存在，补全
import { resolveCaseUrl } from '../lib/resolve-url.js';

// createSession 之前：
const caseRow = (await db.select().from(testCases).where(eq(testCases.id, body.caseId)))[0]!;
const resolvedUrl = await resolveCaseUrl(caseRow);
// res.json 改为：
res.json({
  sessionId: session.sessionId,
  wsToken: process.env.RECORDER_TOKEN_SECRET ?? 'dev-secret-change-me',
  wsUrl: `ws://127.0.0.1:${process.env.API_PORT ?? 54321}/recorder`,
  resolvedUrl,
});
```

（原有 `exists` 校验保留，直接用 `exists[0]` 即可，把上面 `caseRow` 查询合并进 `exists` 变量复用。）

- [ ] **Step 6: 其余三个测试文件换 helper + 修 seed**

`agentRuns.test.ts` / `reports.test.ts` / `requirements.test.ts` 的 `beforeAll` 建表 SQL 同样替换为 `await pool.query(SCHEMA_SQL)`（import 同 Step 2）。

`agentRuns.test.ts` 中两处 `INSERT INTO requirements(title, content)` 改为先 seed：

```ts
const { projectId } = await seedProject(pool);
const req = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('t','c',$1) RETURNING id`, [projectId]);
```

case2script 测试里 `INSERT INTO test_cases(requirement_id, title) VALUES ($1, '用例A')` 改为：

```ts
const { projectId, groupId } = await seedProject(pool);
const c = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('s','t',$1) RETURNING id`, [projectId]);
const tc = await pool.query(`INSERT INTO test_cases(requirement_id, title, group_id) VALUES ($1, '用例A', $2) RETURNING id`, [c.rows[0]!.id, groupId]);
```

`reports.test.ts` 里 `INSERT INTO test_cases(title)` 改为 `INSERT INTO test_cases(title, group_id)`（先 `seedProject`）。

`requirements.test.ts` 里 `INSERT INTO requirements(...)` 若存在同理补 project_id（该文件若只有 CRUD 测试，统一在 beforeAll seed 一次，用例内引用 `projectId`）。

- [ ] **Step 7: cases.test.ts 补新测试**

在 `cases.test.ts` 追加：

```ts
it('POST /api/cases rejects unknown groupId', async () => {
  const r = await request(app).post('/api/cases').send({
    title: 'X',
    groupId: '00000000-0000-0000-0000-000000000000',
  });
  expect(r.status).toBe(404);
});

it('GET /api/cases?groupId filters', async () => {
  const a = await seedProject(pool);
  const b = await seedProject(pool);
  await request(app).post('/api/cases').send({ title: 'in A', groupId: a.groupId });
  await request(app).post('/api/cases').send({ title: 'in B', groupId: b.groupId });
  const r = await request(app).get(`/api/cases?groupId=${a.groupId}`);
  expect(r.body).toHaveLength(1);
  expect(r.body[0].title).toBe('in A');
});

it('GET /api/cases?projectId filters across groups', async () => {
  const { projectId, groupId } = await seedProject(pool);
  await request(app).post('/api/cases').send({ title: 'p1', groupId });
  const other = await seedProject(pool);
  await request(app).post('/api/cases').send({ title: 'p2', groupId: other.groupId });
  const r = await request(app).get(`/api/cases?projectId=${projectId}`);
  expect(r.body).toHaveLength(1);
  expect(r.body[0].title).toBe('p1');
});

it('GET /api/cases/:id resolves url by chain case > group > project', async () => {
  const { projectId, groupId } = await seedProject(pool);
  await pool.query(`UPDATE projects SET default_url = 'https://proj.test' WHERE id = $1`, [projectId]);
  const c1 = await request(app).post('/api/cases').send({ title: 'inherit', groupId });
  const d1 = await request(app).get(`/api/cases/${c1.body.id}`);
  expect(d1.body.resolvedUrl).toBe('https://proj.test');

  await pool.query(`UPDATE "groups" SET default_url = 'https://group.test' WHERE id = $1`, [groupId]);
  const d2 = await request(app).get(`/api/cases/${c1.body.id}`);
  expect(d2.body.resolvedUrl).toBe('https://group.test');

  const c2 = await request(app).post('/api/cases').send({ title: 'own', groupId, url: 'https://case.test' });
  const d3 = await request(app).get(`/api/cases/${c2.body.id}`);
  expect(d3.body.resolvedUrl).toBe('https://case.test');
});

it('PATCH /api/cases/:id moves case to another group', async () => {
  const a = await seedProject(pool);
  const b = await seedProject(pool);
  const c = await request(app).post('/api/cases').send({ title: 'move', groupId: a.groupId });
  const r = await request(app).patch(`/api/cases/${c.body.id}`).send({ groupId: b.groupId });
  expect(r.status).toBe(200);
  expect(r.body.groupId).toBe(b.groupId);
});
```

- [ ] **Step 8: 跑全部受影响测试**

Run: `TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/cases.test.ts test/agentRuns.test.ts test/reports.test.ts test/requirements.test.ts`
Expected: 全 PASS。（agentRuns 里的 requirement2cases 用例此时 saveCase 还没 groupId——见 Task 5。若 `requirement2cases run persists cases` 因 group_id NOT NULL 失败，**临时**在 saveCase 的 insert values 里加 `groupId: <seed 的第一个分组>` 不适用——正确做法是先跑其余文件，该用例失败属预期，Task 5 修复。）实际执行时若此用例红，确认报错为 `null value in column "group_id"` 即可继续 Task 5。

- [ ] **Step 9: Commit**

```bash
git add apps/api/test/helpers apps/api/src/routes/cases.ts apps/api/src/routes/recorder.ts apps/api/src/lib/resolve-url.ts apps/api/test/cases.test.ts apps/api/test/agentRuns.test.ts apps/api/test/reports.test.ts apps/api/test/requirements.test.ts
git commit -m "feat(api): cases belong to groups with url resolution chain"
```

---

### Task 3: requirements 按项目隔离

**Files:**
- Modify: `apps/api/src/routes/requirements.ts`
- Modify: `apps/api/src/routes/agentRuns.ts`（CreateBody 不受影响；仅 requirements 路由）
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/test/requirements.test.ts`

- [ ] **Step 1: requirements.test.ts 改为项目作用域**

`requirements.test.ts` 全文替换为：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;
let projectId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  ({ projectId } = await seedProject(pool));
  const { default: express } = await import('express');
  const { requirementsRoute } = await import('../src/routes/requirements.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/projects/:projectId/requirements', requirementsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('project requirements', () => {
  it('POST creates under project', async () => {
    const r = await request(app).post(`/api/projects/${projectId}/requirements`).send({ title: '登录需求', content: 'desc' });
    expect(r.status).toBe(200);
    expect(r.body.projectId).toBe(projectId);
  });

  it('GET lists only project requirements', async () => {
    const other = await seedProject(pool);
    await request(app).post(`/api/projects/${other.projectId}/requirements`).send({ title: 'other', content: 'x' });
    await request(app).post(`/api/projects/${projectId}/requirements`).send({ title: 'mine', content: 'y' });
    const r = await request(app).get(`/api/projects/${projectId}/requirements`);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].title).toBe('mine');
  });

  it('POST to unknown project returns 404', async () => {
    const r = await request(app)
      .post('/api/projects/00000000-0000-0000-0000-000000000000/requirements')
      .send({ title: 'x', content: 'y' });
    expect(r.status).toBe(404);
  });
});
```

（若原文件还有 `GET /:id` 用例，保留并挂 `app.use('/api/requirements', requirementsRoute)` 双挂载；detail 路由不限制项目。）

- [ ] **Step 2: requirements 路由重写**

`apps/api/src/routes/requirements.ts` 全文替换为：

```ts
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client.js';
import { requirements, projects } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { HttpError } from '../middleware/errorHandler.js';

export const requirementsRoute = Router({ mergeParams: true });

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
});

/** 挂载在 /projects/:projectId/requirements —— 写操作校验项目存在并打 projectId。 */
requirementsRoute.get('/', async (req, res) => {
  const rows = await db
    .select()
    .from(requirements)
    .where(eq(requirements.projectId, req.params.projectId))
    .orderBy(asc(requirements.createdAt));
  res.json(rows);
});

requirementsRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const p = await db.select().from(projects).where(eq(projects.id, req.params.projectId));
  if (p.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  const rows = await db
    .insert(requirements)
    .values({ ...body, projectId: req.params.projectId })
    .returning();
  res.json(rows[0]);
});

requirementsRoute.get('/:id', async (req, res) => {
  const rows = await db.select().from(requirements).where(eq(requirements.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'requirement not found');
  res.json(rows[0]);
});
```

`mergeParams: true` 让 `req.params.projectId` 可用。detail 路由 `/:id` 在双挂载（项目路径下 /api/projects/:pid/requirements/:id 与全局 /api/requirements/:id）时都能工作——项目挂载下 `/:id` 只消费一段，projectId 被忽略（detail 不校验项目归属，MVP 可接受）。

- [ ] **Step 3: index.ts 双挂载**

`apps/api/src/index.ts` 中把 `app.use('/api/requirements', requirementsRoute);` 替换为：

```ts
app.use('/api/requirements', requirementsRoute);
app.use('/api/projects/:projectId/requirements', requirementsRoute);
```

- [ ] **Step 4: 跑测试**

Run: `TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/requirements.test.ts test/agentRuns.test.ts`
Expected: PASS（agentRuns 的 requirement2cases 用例仍可能红——预期中，Task 5 修）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/requirements.ts apps/api/src/index.ts apps/api/test/requirements.test.ts
git commit -m "feat(api): requirements scoped to projects"
```

---

### Task 4: projects + groups + stats 路由

**Files:**
- Create: `apps/api/src/routes/projects.ts`
- Create: `apps/api/src/routes/groups.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/test/projects.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/projects.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { projectsRoute } = await import('../src/routes/projects.js');
  const { groupsRoute } = await import('../src/routes/groups.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRoute);
  app.use('/api/groups', groupsRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('projects', () => {
  it('POST creates, GET lists with caseCount', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'CueCast 官网', defaultUrl: 'https://cuecast.test' });
    expect(created.status).toBe(200);
    expect(created.body.name).toBe('CueCast 官网');

    await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, 'g1')`, [created.body.id]);
    const g = await pool.query(`SELECT id FROM "groups" WHERE project_id = $1`, [created.body.id]);
    await pool.query(
      `INSERT INTO test_cases(title, group_id) VALUES ('c1', $1), ('c2', $1)`,
      [g.rows[0]!.id],
    );

    const list = await request(app).get('/api/projects');
    const mine = list.body.find((p: { id: string }) => p.id === created.body.id);
    expect(mine.caseCount).toBe(2);
  });

  it('PATCH renames and updates defaultUrl', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'P' });
    const r = await request(app).patch(`/api/projects/${created.body.id}`).send({ name: 'P2', defaultUrl: 'https://x.test' });
    expect(r.body.name).toBe('P2');
    expect(r.body.defaultUrl).toBe('https://x.test');
  });

  it('DELETE rejects non-empty project with 409', async () => {
    const { projectId } = await seedProject(pool);
    const r = await request(app).delete(`/api/projects/${projectId}`);
    expect(r.status).toBe(409);
  });

  it('DELETE removes empty project', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'empty' });
    const r = await request(app).delete(`/api/projects/${created.body.id}`);
    expect(r.status).toBe(200);
  });
});

describe('groups', () => {
  it('POST/GET groups under project with caseCount', async () => {
    const p = await request(app).post('/api/projects').send({ name: 'GP' });
    const g = await request(app).post(`/api/projects/${p.body.id}/groups`).send({ name: '登录与账号' });
    expect(g.status).toBe(200);
    await pool.query(`INSERT INTO test_cases(title, group_id) VALUES ('c', $1)`, [g.body.id]);
    const list = await request(app).get(`/api/projects/${p.body.id}/groups`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].caseCount).toBe(1);
  });

  it('DELETE rejects group with cases', async () => {
    const { groupId } = await seedProject(pool);
    const r = await request(app).delete(`/api/groups/${groupId}`);
    expect(r.status).toBe(409);
  });
});

describe('project stats', () => {
  it('returns counts and per-group breakdown', async () => {
    const p = await request(app).post('/api/projects').send({ name: 'S' });
    const g = await request(app).post(`/api/projects/${p.body.id}/groups`).send({ name: 'g' });
    await pool.query(`INSERT INTO test_cases(title, group_id) VALUES ('a', $1), ('b', $1)`, [g.body.id]);
    const r = await request(app).get(`/api/projects/${p.body.id}/stats`);
    expect(r.status).toBe(200);
    expect(r.body.cases).toBe(2);
    expect(r.body.groups).toHaveLength(1);
    expect(r.body.groups[0].caseCount).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/projects.test.ts`
Expected: FAIL — `Cannot find module '../src/routes/projects.js'`

- [ ] **Step 3: 实现 projects 路由**

创建 `apps/api/src/routes/projects.ts`：

```ts
import { Router } from 'express';
import { z } from 'zod';
import { eq, asc, desc, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, groups, testCases, reports, requirements } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';

export const projectsRoute = Router({ mergeParams: true });

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  defaultUrl: z.string().optional(),
});

async function caseCountsByGroup(): Promise<Map<string, number>> {
  const rows = await db
    .select({ groupId: testCases.groupId, count: sql<number>`count(*)` })
    .from(testCases)
    .groupBy(testCases.groupId);
  return new Map(rows.map((r) => [r.groupId, Number(r.count)]));
}

projectsRoute.get('/', async (_req, res) => {
  const ps = await db.select().from(projects).orderBy(asc(projects.createdAt));
  const gs = await db.select().from(groups);
  const counts = await caseCountsByGroup();
  const byProject = new Map<string, number>();
  for (const g of gs) {
    byProject.set(g.projectId, (byProject.get(g.projectId) ?? 0) + (counts.get(g.id) ?? 0));
  }
  res.json(ps.map((p) => ({ ...p, caseCount: byProject.get(p.id) ?? 0 })));
});

projectsRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const rows = await db.insert(projects).values(body).returning();
  res.json(rows[0]);
});

projectsRoute.get('/:id', async (req, res) => {
  const rows = await db.select().from(projects).where(eq(projects.id, req.params.id));
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  res.json(rows[0]);
});

projectsRoute.patch('/:id', async (req, res) => {
  const body = CreateBody.partial().parse(req.body);
  const rows = await db
    .update(projects)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(projects.id, req.params.id))
    .returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  res.json(rows[0]);
});

projectsRoute.delete('/:id', async (req, res) => {
  const gs = await db.select().from(groups).where(eq(groups.projectId, req.params.id));
  if (gs.length > 0) {
    const counts = await caseCountsByGroup();
    const total = gs.reduce((sum, g) => sum + (counts.get(g.id) ?? 0), 0);
    if (total > 0) throw new HttpError(409, 'not_empty', 'project has cases');
  }
  const plans = await db.select().from(groups).where(eq(groups.projectId, req.params.id)); // groups 已查
  void plans;
  const deleted = await db.delete(projects).where(eq(projects.id, req.params.id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  res.json({ ok: true });
});

projectsRoute.get('/:id/groups', async (req, res) => {
  const gs = await db.select().from(groups).where(eq(groups.projectId, req.params.id)).orderBy(asc(groups.createdAt));
  const counts = await caseCountsByGroup();
  res.json(gs.map((g) => ({ ...g, caseCount: counts.get(g.id) ?? 0 })));
});

projectsRoute.post('/:id/groups', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const p = await db.select().from(projects).where(eq(projects.id, req.params.id));
  if (p.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  const rows = await db.insert(groups).values({ ...body, projectId: req.params.id }).returning();
  res.json(rows[0]);
});

projectsRoute.get('/:id/stats', async (req, res) => {
  const p = await db.select().from(projects).where(eq(projects.id, req.params.id));
  if (p.length === 0) throw new HttpError(404, 'not_found', 'project not found');
  const gs = await db.select().from(groups).where(eq(groups.projectId, req.params.id));
  const gids = gs.map((g) => g.id);
  const caseRows = gids.length
    ? await db.select().from(testCases).where(inArray(testCases.groupId, gids))
    : [];
  const caseIds = caseRows.map((c) => c.id);
  const reportRows = caseIds.length
    ? await db.select().from(reports).where(inArray(reports.caseId, caseIds)).orderBy(desc(reports.createdAt))
    : [];
  const counts = await caseCountsByGroup();
  const reqCount = (
    await db.select({ count: sql<number>`count(*)` }).from(requirements).where(eq(requirements.projectId, req.params.id))
  ).map((r) => Number(r.count))[0]!;
  res.json({
    requirements: reqCount,
    cases: caseRows.length,
    passes: reportRows.filter((r) => r.status === 'passed').length,
    failures: reportRows.filter((r) => r.status === 'failed').length,
    groups: gs.map((g) => ({ id: g.id, name: g.name, caseCount: counts.get(g.id) ?? 0 })),
    recentRuns: reportRows.slice(0, 6).map((r) => ({ id: r.id, caseId: r.caseId, status: r.status, createdAt: r.createdAt })),
  });
});
```

- [ ] **Step 4: 实现 groups 路由**

创建 `apps/api/src/routes/groups.ts`：

```ts
import { Router } from 'express';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groups, testCases } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';

export const groupsRoute = Router();

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  defaultUrl: z.string().optional(),
});

groupsRoute.patch('/:id', async (req, res) => {
  const body = PatchBody.parse(req.body);
  const rows = await db
    .update(groups)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(groups.id, req.params.id))
    .returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  res.json(rows[0]);
});

groupsRoute.delete('/:id', async (req, res) => {
  const count = (
    await db.select({ count: sql<number>`count(*)` }).from(testCases).where(eq(testCases.groupId, req.params.id))
  ).map((r) => Number(r.count))[0]!;
  if (count > 0) throw new HttpError(409, 'not_empty', 'group has cases');
  const deleted = await db.delete(groups).where(eq(groups.id, req.params.id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  res.json({ ok: true });
});
```

- [ ] **Step 5: index.ts 挂载**

`apps/api/src/index.ts` 顶部 import 处加：

```ts
import { projectsRoute } from './routes/projects.js';
import { groupsRoute } from './routes/groups.js';
```

挂载区加（在 requirements 双挂载之后）：

```ts
app.use('/api/projects', projectsRoute);
app.use('/api/projects/:projectId/requirements', requirementsRoute);
app.use('/api/groups', groupsRoute);
```

注意：`projectsRoute` 自身含 `/:id/requirements` 之外的子路由；`/api/projects/:projectId/requirements` 的独立挂载必须在 `app.use('/api/projects', projectsRoute)` **之后**注册（Express 先匹配 projectsRoute 的 `/:id`，但 `/:id` 是 GET 单条，GET/POST `/api/projects/x/requirements` 是两段路径，projectsRoute 内没有该模式，会 next 到后续挂载——顺序其实无关，但保持独立挂载在后，可读性更好）。

- [ ] **Step 6: 跑测试**

Run: `TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/projects.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/projects.ts apps/api/src/routes/groups.ts apps/api/src/index.ts apps/api/test/projects.test.ts
git commit -m "feat(api): projects/groups CRUD with stats and delete guards"
```

---

### Task 5: agentRuns 接 targetGroupId（AI 生成用例落分组）

**Files:**
- Modify: `apps/api/src/routes/agentRuns.ts`
- Modify: `apps/api/src/agent/workflows/requirement2cases.ts`
- Modify: `apps/api/src/agent/builtinTools.ts`
- Modify: `apps/api/test/agentRuns.test.ts`

- [ ] **Step 1: agentRuns.test.ts 补 targetGroupId**

`agentRuns.test.ts` 的 beforeAll 已换 SCHEMA_SQL（Task 2 Step 6）。修改两个 requirement2cases 用例：

```ts
it('requirement2cases run persists cases + steps via saveCase tool', async () => {
  const { projectId, groupId } = await seedProject(pool);
  const r0 = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('persist','req',$1) RETURNING id`, [projectId]);
  const created = await request(app)
    .post('/api/agent-runs')
    .send({ targetType: 'requirement2cases', targetId: r0.rows[0].id, prompt: 'requirement: login', targetGroupId: groupId });
  await new Promise((r) => setTimeout(r, 500));
  const detail = await request(app).get(`/api/agent-runs/${created.body.id}`);
  expect(detail.body.status).toBe('success');
  const cases = await pool.query(`SELECT * FROM test_cases WHERE requirement_id = $1`, [r0.rows[0].id]);
  expect(cases.rows.length).toBeGreaterThan(0);
  expect(cases.rows[0]!.group_id).toBe(groupId);
  const steps = await pool.query(`SELECT * FROM test_steps WHERE case_id = $1`, [cases.rows[0]!.id]);
  expect(steps.rows.length).toBeGreaterThan(0);
});
```

`GET /:id returns detail after finish` 用例同样补 `targetGroupId: groupId`（seed 一个）。再补一个缺省行为的用例：

```ts
it('requirement2cases without targetGroupId fails with clear error', async () => {
  const { projectId } = await seedProject(pool);
  const r0 = await pool.query(`INSERT INTO requirements(title, content, project_id) VALUES ('nog','req',$1) RETURNING id`, [projectId]);
  const created = await request(app)
    .post('/api/agent-runs')
    .send({ targetType: 'requirement2cases', targetId: r0.rows[0].id, prompt: 'requirement: x' });
  await new Promise((r) => setTimeout(r, 500));
  const detail = await request(app).get(`/api/agent-runs/${created.body.id}`);
  expect(detail.body.status).toBe('failed');
  expect(detail.body.error).toMatch(/group/i);
});
```

case2script 用例不动（已有 groupId 的 case）。

- [ ] **Step 2: workflow builder 加 groupId**

`apps/api/src/agent/workflows/requirement2cases.ts` 全文替换：

```ts
import type { WorkflowSpec } from '../agentFactory.js';
import { createSaveCaseTool } from '../builtinTools.js';
import { REQUIREMENT_DECOMPOSE_PROMPT } from '../prompts/requirement-decompose.js';
import { CASE_REVIEW_PROMPT } from '../prompts/case-review.js';

/** 每个 run 用 targetId（requirement id）+ groupId（落库分组）构建。 */
export function buildRequirement2CasesWorkflow(requirementId: string, groupId: string): WorkflowSpec {
  return {
    workflowId: 'requirement2cases',
    steps: [
      {
        id: 'decompose',
        prompt: REQUIREMENT_DECOMPOSE_PROMPT + '\n\nrequirement:\n{{userMessage}}',
        tools: [createSaveCaseTool({ requirementId, groupId })],
      },
      {
        id: 'review',
        prompt: CASE_REVIEW_PROMPT + '\n\ncandidates:\n{{previousOutput}}',
        tools: [],
      },
    ],
  };
}
```

- [ ] **Step 3: saveCase 工具带 groupId**

`apps/api/src/agent/builtinTools.ts` 中 `createSaveCaseTool` 改为：

```ts
/** 保存 LLM 输出的用例集：逐条插入 test_cases（可带步骤）。输入不符合形状时抛错终止 run。 */
export function createSaveCaseTool(opts: { requirementId: string; groupId: string }): AgentTool {
  return {
    name: 'saveCase',
    description: '保存生成的测试用例到数据库',
    handler: async (input) => {
      const { cases } = CasesOutput.parse(input);
      const caseIds: string[] = [];
      for (const c of cases) {
        const rows = await db
          .insert(testCases)
          .values({
            requirementId: opts.requirementId,
            groupId: opts.groupId,
            title: c.title,
            description: c.description,
            priority: c.priority ?? 'P1',
          })
          .returning();
        const caseId = rows[0]!.id;
        caseIds.push(caseId);
        if (c.steps && c.steps.length > 0) {
          await db.insert(testSteps).values(
            c.steps.map((s) => ({
              caseId,
              order: s.order,
              source: 'agent' as const,
              action: s.action as object,
            })),
          );
        }
      }
      return { ok: true, caseIds };
    },
  };
}
```

- [ ] **Step 4: agentRuns 路由传 groupId**

`apps/api/src/routes/agentRuns.ts` 中 `CreateBody` 加 `targetGroupId: z.string().uuid().optional()`；`executeRun(run, opts: { targetGroupId?: string })`；workflow 构建改为：

```ts
  const wf = run.targetType === 'requirement2cases'
    ? buildRequirement2CasesWorkflow(run.targetId, opts.targetGroupId ?? '')
    : buildCase2ScriptWorkflow(run.targetId);
```

`opts.targetGroupId ?? ''` 为空时 saveCase insert 触发 FK 违反 → run failed，错误信息含 "group"（PG 的 FK 报错提到 group_id 约束名）。为满足测试断言 `/group/i`，在构建处显式校验更干净：

```ts
  if (run.targetType === 'requirement2cases' && !opts.targetGroupId) {
    throw new HttpError(400, 'missing_group', 'targetGroupId is required for requirement2cases');
  }
```

放在 `executeRun` 的 try 外面会跳过 status 回写——放进 try 内、workflow 构建之前，让 catch 统一回写 failed：

```ts
  try {
    if (run.targetType === 'requirement2cases' && !opts.targetGroupId) {
      throw new Error('targetGroupId is required for requirement2cases');
    }
    logger.info(...);
    const result = ...
```

POST 处理器把 body 带进去：`void executeRun(run, { targetGroupId: body.targetGroupId });`

- [ ] **Step 5: 跑测试**

Run: `TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/agentRuns.test.ts test/workflow.test.ts`
Expected: PASS（agentRuns 5 tests + workflow 4 tests）。workflow.test 不受影响（直接调 runWorkflow，不走 saveCase）。

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agentRuns.ts apps/api/src/agent/workflows/requirement2cases.ts apps/api/src/agent/builtinTools.ts apps/api/test/agentRuns.test.ts
git commit -m "feat(api): requirement2cases persists into target group"
```

---

### Task 6: 用例复制（单条 + 批量 + 副本命名）

**Files:**
- Modify: `apps/api/src/routes/cases.ts`
- Test: `apps/api/test/cases-copy.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/cases-copy.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/cases', casesRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function makeCaseWithSteps(groupId: string, title: string) {
  const c = await request(app).post('/api/cases').send({ title, groupId });
  await request(app).post(`/api/cases/${c.body.id}/steps`).send({
    steps: [
      { order: 1, source: 'agent', action: { kind: 'navigate', url: 'https://x.test' } },
      { order: 2, source: 'recorder', action: { kind: 'click', locator: [{ strategy: 'css', value: '#btn' }] } },
    ],
  });
  return c.body as { id: string; title: string };
}

describe('case copy', () => {
  it('single copy clones steps and appends 副本', async () => {
    const { groupId } = await seedProject(pool);
    const src = await makeCaseWithSteps(groupId, '创建项目');
    const r = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: groupId });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('创建项目 副本');
    const detail = await request(app).get(`/api/cases/${r.body.id}`);
    expect(detail.body.steps).toHaveLength(2);
    expect(detail.body.requirementId).toBeNull();
  });

  it('copy naming increments 副本1, 副本2', async () => {
    const { groupId } = await seedProject(pool);
    const src = await makeCaseWithSteps(groupId, '登录');
    const c1 = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: groupId });
    const c2 = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: groupId });
    const c3 = await request(app).post(`/api/cases/${src.id}/copy`).send({ targetGroupId: groupId });
    expect(c1.body.title).toBe('登录 副本');
    expect(c2.body.title).toBe('登录 副本1');
    expect(c3.body.title).toBe('登录 副本2');
  });

  it('batch copy to another group', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    const c1 = await makeCaseWithSteps(a.groupId, 'A');
    const c2 = await makeCaseWithSteps(a.groupId, 'B');
    const r = await request(app).post('/api/cases/copy').send({ caseIds: [c1.id, c2.id], targetGroupId: b.groupId });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    const inB = await request(app).get(`/api/cases?groupId=${b.groupId}`);
    expect(inB.body).toHaveLength(2);
  });

  it('copy to unknown group returns 404', async () => {
    const { groupId } = await seedProject(pool);
    const src = await makeCaseWithSteps(groupId, 'X');
    const r = await request(app)
      .post(`/api/cases/${src.id}/copy`)
      .send({ targetGroupId: '00000000-0000-0000-0000-000000000000' });
    expect(r.status).toBe(404);
  });

  it('DELETE /api/cases/:id removes case and its steps', async () => {
    const { groupId } = await seedProject(pool);
    const src = await makeCaseWithSteps(groupId, '待删除');
    const r = await request(app).delete(`/api/cases/${src.id}`);
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/cases/${src.id}`);
    expect(detail.status).toBe(404);
    const steps = await pool.query(`SELECT * FROM test_steps WHERE case_id = $1`, [src.id]);
    expect(steps.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/cases-copy.test.ts`
Expected: FAIL — 404（路由不存在）

- [ ] **Step 3: 实现复制路由**

在 `apps/api/src/routes/cases.ts` 底部追加：

```ts
async function nextCopyTitle(base: string, existing: string[]): string {
  const taken = new Set(existing);
  const first = `${base} 副本`;
  if (!taken.has(first)) return first;
  let n = 1;
  while (taken.has(`${base} 副本${n}`)) n++;
  return `${base} 副本${n}`;
}

async function copyOneCase(caseId: string, targetGroupId: string): Promise<unknown> {
  const src = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!src) throw new HttpError(404, 'not_found', 'case not found');
  const siblings = await db.select({ title: testCases.title }).from(testCases).where(eq(testCases.groupId, targetGroupId));
  const title = await nextCopyTitle(src.title, siblings.map((s) => s.title));
  const steps = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, caseId))
    .orderBy(asc(testSteps.order));
  const inserted = await db
    .insert(testCases)
    .values({
      title,
      description: src.description,
      priority: src.priority,
      groupId: targetGroupId,
      url: src.url,
    })
    .returning();
  const newCase = inserted[0]!;
  if (steps.length > 0) {
    await db.insert(testSteps).values(
      steps.map((s) => ({
        caseId: newCase.id,
        order: s.order,
        source: s.source,
        action: s.action,
        assertion: s.assertion,
      })),
    );
  }
  return newCase;
}

casesRoute.post('/:id/copy', async (req, res) => {
  const body = z.object({ targetGroupId: z.string().uuid() }).parse(req.body);
  const g = await db.select().from(groups).where(eq(groups.id, body.targetGroupId));
  if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  res.json(await copyOneCase(req.params.id, body.targetGroupId));
});

casesRoute.post('/copy', async (req, res) => {
  const body = z.object({ caseIds: z.array(z.string().uuid()).min(1), targetGroupId: z.string().uuid() }).parse(req.body);
  const g = await db.select().from(groups).where(eq(groups.id, body.targetGroupId));
  if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  for (const id of body.caseIds) {
    await copyOneCase(id, body.targetGroupId);
  }
  res.json({ count: body.caseIds.length });
});

casesRoute.delete('/:id', async (req, res) => {
  const deleted = await db.delete(testCases).where(eq(testCases.id, req.params.id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'case not found');
  res.json({ ok: true });
});
```

注意 `POST /copy` 必须注册在 `POST /:id` 之前？`/:id` 是单段参数路由，`/copy` 也是单段——Express 先注册 `/:id` 的话 `POST /api/cases/copy` 会被 `/:id` 捕获！**必须**把这两个复制路由的注册代码放在 `casesRoute.post('/', ...)` 之后、`casesRoute.get('/:id', ...)` 之前的任何位置都不安全——因为 `/:id` 是 GET，`/copy` 是 POST，方法不同不相冲。真正要防的是 `POST /:id/copy`（两段）与 `POST /copy`（一段）——段数不同，安全。`POST /:id` 不存在。所以追加在文件底部即可。

- [ ] **Step 4: 跑测试**

Run: `TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/cases-copy.test.ts test/cases.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/cases.ts apps/api/test/cases-copy.test.ts
git commit -m "feat(api): copy cases single/batch with 副本 naming, case delete"
```

---

### Task 7: 抽取 runCase 服务（执行计划复用前置）

**Files:**
- Create: `apps/api/src/execute/runCase.ts`
- Modify: `apps/api/src/routes/execute.ts`

- [ ] **Step 1: 抽取 runCase**

把 `apps/api/src/routes/execute.ts` 中 route 处理器里「预写报告 → 执行 → 回写」的逻辑原样搬进 `apps/api/src/execute/runCase.ts`：

```ts
import { eq, asc } from 'drizzle-orm';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import { testCases, testSteps, reports } from '../db/schema.js';
import { executeCaseReal, writePlaceholderScreenshot, type ExecStepResult } from './cdp.js';

/**
 * 执行单条用例并落报告。真实 CDP 失败时降级 mock。
 * 返回 reportId 与最终状态，供单用例路由和执行计划共用。
 */
export async function runCase(caseId: string): Promise<{ reportId: string; status: string }> {
  const caseRow = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!caseRow) throw new Error('case not found');

  const steps = await db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, caseId))
    .orderBy(asc(testSteps.order));

  const inserted = await db
    .insert(reports)
    .values({ caseId, status: 'running', stepResults: [] as object, summary: 'execution in progress' })
    .returning();
  const reportId = inserted[0]!.id;

  const startedAt = Date.now();
  let stepResults: ExecStepResult[];
  let status: 'passed' | 'failed';
  try {
    stepResults = await executeCaseReal(
      caseId,
      steps.map((s) => ({ order: s.order, action: s.action })),
      { reportId },
    );
    const failed = stepResults.filter((r) => r.status === 'failed').length;
    status = failed === 0 ? 'passed' : 'failed';
  } catch (e) {
    logger.warn({ err: e, caseId, reportId }, 'CDP unavailable, falling back to mock execution');
    const mockResults: ExecStepResult[] = [];
    for (let i = 0; i < steps.length; i++) {
      const isFail = Math.random() < 0.2;
      const screenshot = await writePlaceholderScreenshot(reportId, i + 1);
      mockResults.push({
        order: steps[i]!.order,
        status: isFail ? 'failed' : 'passed',
        durationMs: Math.floor(Math.random() * 100) + 20,
        error: isFail ? 'CDP unavailable — mock fallback (install chromium for real path)' : undefined,
        screenshot,
      });
    }
    stepResults = mockResults;
    status = mockResults.some((r) => r.status === 'failed') ? 'failed' : 'passed';
  }

  const durationMs = Date.now() - startedAt;
  const passed = stepResults.filter((r) => r.status === 'passed').length;
  const summary = `${stepResults.length} steps, ${passed} passed, ${stepResults.length - passed} failed`;
  await db
    .update(reports)
    .set({ status, durationMs, stepResults: stepResults as object, summary })
    .where(eq(reports.id, reportId));

  return { reportId, status };
}
```

- [ ] **Step 2: execute.ts 改为薄路由**

`apps/api/src/routes/execute.ts` 全文替换为：

```ts
import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/errorHandler.js';
import { runCase } from '../execute/runCase.js';

export const executeRoute = Router();

const Body = z.object({ caseId: z.string().uuid() });

executeRoute.post('/cases/:caseId/execute', async (req, res) => {
  const { caseId } = Body.parse({ caseId: req.params.caseId });
  if (caseId !== req.params.caseId) throw new HttpError(400, 'bad_request', 'caseId mismatch');
  try {
    const { reportId } = await runCase(caseId);
    res.json({ reportId });
  } catch (e) {
    if (e instanceof Error && e.message === 'case not found') {
      throw new HttpError(404, 'not_found', 'case not found');
    }
    throw e;
  }
});
```

- [ ] **Step 3: 跑测试确认无回归**

Run: `TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/execute-cdp.test.ts test/reports.test.ts`
Expected: PASS（execute-cdp 4 tests mock playwright，不触 DB；reports 2 tests 只读路由）

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/execute/runCase.ts apps/api/src/routes/execute.ts
git commit -m "refactor(api): extract runCase service for plan runs"
```

---

### Task 8: 执行计划路由（CRUD + 设置用例 + 一键运行）

**Files:**
- Create: `apps/api/src/routes/plans.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/reports.ts`（加 projectId 过滤）
- Test: `apps/api/test/plans.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/plans.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { plansRoute } = await import('../src/routes/plans.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  app.use('/api/projects/:projectId/plans', plansRoute);
  app.use('/api/plans', plansRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function makeCase(groupId: string, title: string): Promise<string> {
  const c = await request(app).post('/api/cases').send({ title, groupId });
  return c.body.id as string;
}

describe('execution plans', () => {
  it('create/list under project', async () => {
    const { projectId } = await seedProject(pool);
    const created = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({ name: '预发冒烟', environment: '预发' });
    expect(created.status).toBe(200);
    const list = await request(app).get(`/api/projects/${projectId}/plans`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('预发冒烟');
    expect(list.body[0].caseCount).toBe(0);
  });

  it('PUT cases sets ordered list, detail returns cases in order', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P' });
    const c1 = await makeCase(groupId, 'c1');
    const c2 = await makeCase(groupId, 'c2');
    const r = await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c2, c1] });
    expect(r.status).toBe(200);
    const detail = await request(app).get(`/api/plans/${plan.body.id}`);
    expect(detail.body.cases.map((c: { id: string }) => c.id)).toEqual([c2, c1]);
  });

  it('PUT cases rejects cross-project case with 409', async () => {
    const a = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${a.projectId}/plans`).send({ name: 'P' });
    const b = await seedProject(pool);
    const foreign = await makeCase(b.groupId, 'foreign');
    const r = await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [foreign] });
    expect(r.status).toBe(409);
  });

  it('PATCH renames, DELETE removes', async () => {
    const { projectId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P' });
    const patched = await request(app).patch(`/api/plans/${plan.body.id}`).send({ name: 'P2' });
    expect(patched.body.name).toBe('P2');
    const deleted = await request(app).delete(`/api/plans/${plan.body.id}`);
    expect(deleted.status).toBe(200);
  });

  it('run executes all cases serially and returns per-case results', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'run' });
    const c1 = await makeCase(groupId, 'r1'); // 无步骤：vacuous pass，不触网络/浏览器
    const c2 = await makeCase(groupId, 'r2');
    await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1, c2] });
    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(2);
    for (const item of r.body.results) {
      expect(item.reportId).toBeTruthy();
      expect(['passed', 'failed']).toContain(item.status);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/plans.test.ts`
Expected: FAIL — `Cannot find module '../src/routes/plans.js'`

- [ ] **Step 3: 实现 plans 路由**

创建 `apps/api/src/routes/plans.ts`：

```ts
import { Router } from 'express';
import { z } from 'zod';
import { eq, asc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { executionPlans, planCases, testCases, groups } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { runCase } from '../execute/runCase.js';

export const plansRoute = Router({ mergeParams: true });

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  environment: z.string().max(100).optional(),
});

plansRoute.get('/', async (req, res) => {
  const ps = await db
    .select()
    .from(executionPlans)
    .where(eq(executionPlans.projectId, req.params.projectId))
    .orderBy(asc(executionPlans.createdAt));
  const pcs = await db.select().from(planCases);
  const countByPlan = new Map<string, number>();
  for (const pc of pcs) {
    countByPlan.set(pc.planId, (countByPlan.get(pc.planId) ?? 0) + 1);
  }
  res.json(ps.map((p) => ({ ...p, caseCount: countByPlan.get(p.id) ?? 0 })));
});

plansRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const rows = await db
    .insert(executionPlans)
    .values({ ...body, projectId: req.params.projectId })
    .returning();
  res.json(rows[0]);
});

plansRoute.get('/:id', async (req, res) => {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  const pcs = await db.select().from(planCases).where(eq(planCases.planId, plan.id)).orderBy(asc(planCases.order));
  const cases = pcs.length
    ? await db.select().from(testCases).where(inArray(testCases.id, pcs.map((p) => p.caseId)))
    : [];
  const byId = new Map(cases.map((c) => [c.id, c]));
  res.json({
    ...plan,
    cases: pcs.map((pc) => ({ id: pc.caseId, order: pc.order, title: byId.get(pc.caseId)?.title ?? 'unknown' })),
  });
});

plansRoute.patch('/:id', async (req, res) => {
  const body = CreateBody.partial().parse(req.body);
  const rows = await db
    .update(executionPlans)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(executionPlans.id, req.params.id))
    .returning();
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'plan not found');
  res.json(rows[0]);
});

plansRoute.delete('/:id', async (req, res) => {
  const deleted = await db.delete(executionPlans).where(eq(executionPlans.id, req.params.id)).returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'plan not found');
  res.json({ ok: true });
});

plansRoute.put('/:id/cases', async (req, res) => {
  const { caseIds } = z.object({ caseIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  const gs = await db.select().from(groups).where(eq(groups.projectId, plan.projectId));
  const validGids = new Set(gs.map((g) => g.id));
  const rows = await db.select().from(testCases).where(inArray(testCases.id, caseIds));
  if (rows.length !== caseIds.length || !rows.every((r) => validGids.has(r.groupId))) {
    throw new HttpError(409, 'cross_project', 'all cases must belong to the plan project');
  }
  await db.delete(planCases).where(eq(planCases.planId, plan.id));
  await db.insert(planCases).values(caseIds.map((caseId, i) => ({ planId: plan.id, caseId, order: i + 1 })));
  res.json({ ok: true });
});

plansRoute.post('/:id/run', async (req, res) => {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, req.params.id)))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  const pcs = await db.select().from(planCases).where(eq(planCases.planId, plan.id)).orderBy(asc(planCases.order));
  const results: Array<{ caseId: string; reportId: string; status: string }> = [];
  for (const pc of pcs) {
    const { reportId, status } = await runCase(pc.caseId);
    results.push({ caseId: pc.caseId, reportId, status });
  }
  res.json({ results });
});
```

- [ ] **Step 4: index.ts 挂载 + reports 加 projectId 过滤**

`apps/api/src/index.ts` 加 import 与挂载：

```ts
import { plansRoute } from './routes/plans.js';
// 挂载区：
app.use('/api/projects/:projectId/plans', plansRoute);
app.use('/api/plans', plansRoute);
```

`apps/api/src/routes/reports.ts` 的 `GET /` 改为支持 projectId 过滤（前端报告页按项目过滤用）：

```ts
import { eq, desc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { reports, testCases, groups } from '../db/schema.js';

reportsRoute.get('/', async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  if (projectId) {
    const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
    const caseRows = gs.length
      ? await db.select({ id: testCases.id }).from(testCases).where(inArray(testCases.groupId, gs.map((g) => g.id)))
      : [];
    const rows = caseRows.length
      ? await db.select().from(reports).where(inArray(reports.caseId, caseRows.map((c) => c.id))).orderBy(desc(reports.createdAt))
      : [];
    res.json(rows);
    return;
  }
  const rows = await db.select().from(reports).orderBy(desc(reports.createdAt));
  res.json(rows);
});
```

- [ ] **Step 5: 跑测试**

Run: `TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run test/plans.test.ts test/reports.test.ts`
Expected: PASS。注意 `run` 用例可能因本机有 chromium 而启动真实浏览器——用例没有步骤，不会发起导航，仅 about:blank，安全；无 chromium 环境自动走 mock。两者断言都只看 reportId/status 结构。

- [ ] **Step 6: 全量回归 + Commit**

Run: `cd apps/api && pnpm test`
Expected: 全 PASS

```bash
git add apps/api/src/routes/plans.ts apps/api/src/routes/reports.ts apps/api/src/index.ts apps/api/test/plans.test.ts
git commit -m "feat(api): execution plans CRUD, case membership, serial run-all"
```

---

## Part 1 完成标准

- `pnpm test`（apps/api）全绿
- `pnpm -r typecheck` 通过
- 迁移脚本对含存量数据的开发库可重复执行（drizzle journal 保证只跑一次）
