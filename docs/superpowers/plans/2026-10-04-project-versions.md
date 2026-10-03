# 项目 → 版本 → 测试环境/用例 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `project_version` 成为一级实体；测试环境、用例、执行计划、AI 工作台保存事务全部按版本工作；导航从 `项目 → 模块` 变成 `项目 → 版本 → 模块`；所有现存数据通过迁移 SQL 自动归属到项目 `v0` 默认版本。

**Architecture:** 新增 `project_versions` 表；为 `test_environments / test_cases / execution_plans` 加 `version_id` FK；新建路由 `/api/projects/:id/versions` + `/api/project-versions/:id`；前端 store + URL 双重持久化版本选择；所有业务页 URL 改 `/p/:pid/v/:vid/...`；按版本过滤/校验。

**Tech Stack:** Drizzle ORM + PostgreSQL, Express + zod, React + react-query + react-router, vitest + testcontainers。

---

## 文件结构

**新增**：
- `apps/api/drizzle/0020_project_versions.sql` — 新表 + 三表加 `version_id` 列 + 数据回填 + 索引
- `apps/api/src/db/migrations/2026-10-04-project-versions-snapshot.json` — `drizzle-kit push` 后的 schema 快照（仅生成提交）
- `apps/api/src/routes/projectVersions.ts` — versions CRUD/set-default
- `apps/api/test/project-versions.test.ts`
- `apps/web/src/pages/VersionsSelectPage.tsx` — 版本选择中间页
- `apps/web/src/pages/ProjectVersionsPage.tsx` — 版本管理（建/删/设默认）
- `apps/web/src/components/layout/VersionChip.tsx` — 侧边栏版本切换 chip
- `apps/web/src/components/layout/ProjectGuard.tsx`（改写）— 强制 URL 含 `versionId`

**修改**：
- `apps/api/src/db/schema.ts` — 加 `projectVersions` + 给 3 表加 `versionId`
- `apps/api/src/services/projectAccess.ts` — 加 `assertVersionVisible` / `resolveVersionProjectId`
- `apps/api/src/routes/environments.ts` — 加 `versionId` 过滤 + 创建校验
- `apps/api/src/routes/cases.ts` — 加 `versionId` 过滤 + 创建校验 + 跨版本 copy
- `apps/api/src/routes/plans.ts` — 加 `versionId` 过滤 + 创建校验（environmentId 必须同 version）
- `apps/api/src/routes/requirements.ts` — `ai-workspace/save` 接受 `targetVersionId`
- `apps/api/test/helpers/db.ts` — SCHEMA_SQL 补 `project_versions` + 三表 `version_id`（testcontainers 用）
- `apps/api/test/helpers/db.ts` — `seedProject` 同步建一个 `v0` 默认版本返回 `versionId`
- `apps/api/src/index.ts` — 挂载 `projectVersionsRoute`
- `apps/web/src/api/client.ts` — `ProjectVersion` 类型 + `api.versions.*` + 各端点 `versionId` 参数
- `apps/web/src/stores/project.ts` — `current.versionId/versionName` + `switchVersion()`
- `apps/web/src/App.tsx` — 路由改 `/v/:versionId/...`；新增 `/versions` `/versions/select`
- `apps/web/src/components/layout/Sidebar.tsx` — 顶部加 `<VersionChip>`
- `apps/web/src/pages/GroupsPage.tsx` — 接 `versionId`；列表/创建/复制带 versionId；查询键加 versionId
- `apps/web/src/pages/ProjectEnvironments.tsx` — 接 `versionId`；查询键加 versionId
- `apps/web/src/pages/Environments.tsx`（标题壳）— 接 `versionId`；副标题显示版本名
- `apps/web/src/pages/Plans.tsx` — 列表加 `versionId` 过滤
- `apps/web/src/pages/PlanDetail.tsx` — 环境列表限当前版本；用例候选池标版本徽标
- `apps/web/src/pages/AiWorkspacePage.tsx` — 接 `versionId`；save payload 带 `targetVersionId`
- `apps/web/src/pages/Dashboard.tsx` — 统计按 versionId
- `apps/web/src/pages/Reports.tsx` — 列表显示 case.version.name
- `apps/web/src/pages/ProjectsHome.tsx` — 进入项目后跳 `/v/:versionId/overview`；显示「默认版本」

---

## Task 1: schema + 迁移 SQL（生成 → 手写 → 推送到 dev DB）

**Files:**
- Modify: `apps/api/src/db/schema.ts:1-30,237-374` (加 `projectVersions` + 改 3 表)
- Create: `apps/api/drizzle/0020_project_versions.sql`
- Modify: `apps/api/test/helpers/db.ts:6-57,100-107` (SCHEMA_SQL + seedProject)

- [ ] **Step 1: 改 `schema.ts` 加 `projectVersions`**

在 `apps/api/src/db/schema.ts` 文件顶部 import 列表已有 `pgTable, uuid, varchar, text, integer, jsonb, timestamp, boolean, unique, primaryKey, index, uniqueIndex`；找到 `export const groups = pgTable(...)`（约 237 行）**之前**，插入：

```ts
export const projectVersions = pgTable('project_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 80 }).notNull(),
  description: text('description'),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectNameUq: unique('project_versions_project_name_uq').on(t.projectId, t.name),
  projectIdIdx: index('project_versions_project_idx').on(t.projectId),
}));
```

- [ ] **Step 2: 改 `testEnvironments` 表**

在 `apps/api/src/db/schema.ts` 的 `testEnvironments`（约 352 行）`projectId` 列**之后**插入：

```ts
  versionId: uuid('version_id').notNull().references(() => projectVersions.id, { onDelete: 'restrict' }),
```

并在 `projectNameUq` 那行后面追加：

```ts
  versionIdIdx: index('test_environments_version_idx').on(t.versionId),
```

- [ ] **Step 3: 改 `testCases` 表**

在 `apps/api/src/db/schema.ts` 的 `testCases`（约 34 行）`groupId` 列**之后**插入：

```ts
  versionId: uuid('version_id').notNull().references(() => projectVersions.id, { onDelete: 'restrict' }),
```

并在第 50 行后追加：

```ts
  versionIdIdx: index('test_cases_version_idx').on(t.versionId),
```

- [ ] **Step 4: 改 `executionPlans` 表**

在 `apps/api/src/db/schema.ts` 的 `executionPlans`（约 246 行）`environmentId` 列**之后**插入：

```ts
  versionId: uuid('version_id').references(() => projectVersions.id, { onDelete: 'set null' }),
```

并在后面追加：

```ts
  versionIdIdx: index('execution_plans_version_idx').on(t.versionId),
```

- [ ] **Step 5: 写迁移 SQL**

新建 `apps/api/drizzle/0020_project_versions.sql`：

```sql
CREATE TABLE "project_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "name" varchar(80) NOT NULL,
  "description" text,
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  UNIQUE ("project_id","name")
);
CREATE INDEX "project_versions_project_idx" ON "project_versions"("project_id");

DO $$ BEGIN
  ALTER TABLE "test_environments" ADD COLUMN "version_id" uuid;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE "test_cases" ADD COLUMN "version_id" uuid;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE "execution_plans" ADD COLUMN "version_id" uuid;
EXCEPTION WHEN duplicate_column THEN null;
END $$;

-- 回填：每项目建一个 'v0' 默认版本
INSERT INTO project_versions (project_id, name, is_default)
SELECT id, 'v0', true FROM projects;

UPDATE test_environments e SET version_id = v.id
FROM project_versions v WHERE v.project_id = e.project_id AND v.is_default = true;

UPDATE test_cases c SET version_id = v.id
FROM "groups" g, project_versions v
WHERE g.id = c.group_id AND v.project_id = g.project_id AND v.is_default = true;

UPDATE execution_plans p SET version_id = v.id
FROM project_versions v WHERE v.project_id = p.project_id AND v.is_default = true;

-- 加 FK + NOT NULL（test_cases / test_environments 必填；execution_plans 可空）
DO $$ BEGIN
  ALTER TABLE "test_environments"
    ADD CONSTRAINT "test_environments_version_id_project_versions_id_fk"
    FOREIGN KEY ("version_id") REFERENCES "project_versions"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
ALTER TABLE "test_environments" ALTER COLUMN "version_id" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "test_cases"
    ADD CONSTRAINT "test_cases_version_id_project_versions_id_fk"
    FOREIGN KEY ("version_id") REFERENCES "project_versions"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
ALTER TABLE "test_cases" ALTER COLUMN "version_id" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "execution_plans"
    ADD CONSTRAINT "execution_plans_version_id_project_versions_id_fk"
    FOREIGN KEY ("version_id") REFERENCES "project_versions"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE INDEX "test_environments_version_idx" ON "test_environments"("version_id");
CREATE INDEX "test_cases_version_idx"        ON "test_cases"("version_id");
CREATE INDEX "execution_plans_version_idx"   ON "execution_plans"("version_id");
```

- [ ] **Step 6: 更新 `drizzle/meta/_journal.json`**

读 `apps/api/drizzle/meta/_journal.json`，最后一项是 `0019_test_environments`。追加：

```json
    {
      "idx": 20,
      "version": "7",
      "when": 1759612800000,
      "tag": "0020_project_versions",
      "breakpoints": true
    }
```

- [ ] **Step 7: 更新 `SCHEMA_SQL`（testcontainers）**

在 `apps/api/test/helpers/db.ts` 的 `SCHEMA_SQL`（约第 6-57 行）**末尾**，追加：

```sql
CREATE TABLE project_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL, name varchar(80) NOT NULL, description text, is_default boolean NOT NULL DEFAULT false, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(), CONSTRAINT project_versions_project_name_uq UNIQUE(project_id, name));
CREATE INDEX project_versions_project_idx ON project_versions(project_id);
DO $$ BEGIN
  ALTER TABLE test_cases        ADD COLUMN version_id uuid REFERENCES project_versions(id) ON DELETE RESTRICT NOT NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE test_environments ADD COLUMN version_id uuid REFERENCES project_versions(id) ON DELETE RESTRICT NOT NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
  ALTER TABLE execution_plans   ADD COLUMN version_id uuid REFERENCES project_versions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
CREATE INDEX test_cases_version_idx        ON test_cases(version_id);
CREATE INDEX test_environments_version_idx ON test_environments(version_id);
CREATE INDEX execution_plans_version_idx   ON execution_plans(version_id);
```

- [ ] **Step 8: 改 `seedProject`**

把 `apps/api/test/helpers/db.ts` 第 100-107 行整段替换：

```ts
export async function seedProject(pool: Pool): Promise<{ projectId: string; groupId: string; versionId: string } & SeedOrg> {
  const org = await seedOrg(pool);
  const p = await pool.query(`INSERT INTO projects(organization_id, name) VALUES ($1, '测试项目') RETURNING id`, [org.orgId]);
  const g = await pool.query(`INSERT INTO "groups"(project_id, name) VALUES ($1, '默认分组') RETURNING id`, [p.rows[0]!.id]);
  const v = await pool.query(
    `INSERT INTO project_versions(project_id, name, is_default) VALUES ($1, 'v0', true) RETURNING id`,
    [p.rows[0]!.id],
  );
  return {
    projectId: p.rows[0]!.id as string,
    groupId: g.rows[0]!.id as string,
    versionId: v.rows[0]!.id as string,
    ...org,
  };
}
```

- [ ] **Step 9: 跑 typecheck**

```bash
cd apps/api && pnpm exec tsc --noEmit
```

Expected: 0 error（schema 类型层面对齐）。

- [ ] **Step 10: 推 schema 到 dev DB**

```bash
cd apps/api && pnpm exec drizzle-kit push --force
```

Expected: "No changes" 或新表/列被建出来（按现状 schema 已经在 dev DB 推过；本次新增的列/表会被建出）。

- [ ] **Step 11: 在 dev DB 上跑迁移 SQL 的回填逻辑（幂等回填）**

```bash
docker exec itest-dev-pg psql -U itest -d itest -f - < apps/api/drizzle/0020_project_versions.sql
```

Expected: 全部 `DO $$` 块走 `EXCEPTION WHEN duplicate_object/column THEN null`；回填 UPDATE 应当 no-op（schema 已经带 `version_id` 列）。验证：

```bash
docker exec itest-dev-pg psql -U itest -d itest -tAc "SELECT count(*) FROM project_versions;"
docker exec itest-dev-pg psql -U itest -d itest -tAc "SELECT count(*) FROM test_cases WHERE version_id IS NULL;"
```

Expected: 项目数 > 0；`test_cases WHERE version_id IS NULL` = 0。

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/0020_project_versions.sql apps/api/drizzle/meta/_journal.json apps/api/test/helpers/db.ts
git commit -m "feat(db): project_versions table + version_id on cases/envs/plans"
```

---

## Task 2: `assertVersionVisible` + `resolveVersionProjectId`

**Files:**
- Modify: `apps/api/src/services/projectAccess.ts:1-80`

- [ ] **Step 1: 加失败测试**

新建 `apps/api/test/project-access-version.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let projectId: string;
let versionId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE projects, project_versions, "groups", test_cases, test_environments, execution_plans, project_assignments, organizations, users CASCADE`);
  const s = await seedProject(pool);
  projectId = s.projectId;
  versionId = s.versionId;
});

describe('version visibility', () => {
  it('resolveVersionProjectId 解析 version → project', async () => {
    const { resolveVersionProjectId } = await import('../src/services/projectAccess.js');
    expect(await resolveVersionProjectId(versionId)).toBe(projectId);
  });

  it('不存在的 versionId 返回 null', async () => {
    const { resolveVersionProjectId } = await import('../src/services/projectAccess.js');
    expect(await resolveVersionProjectId('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/project-access-version.test.ts
```

Expected: 失败（未导出 `resolveVersionProjectId`）。

- [ ] **Step 3: 在 `projectAccess.ts` 加 `resolveVersionProjectId` + `assertVersionVisible`**

追加到 `apps/api/src/services/projectAccess.ts` 第 4 行的 import：

```ts
import { groups, projects, reports, testCases, testEnvironments, projectVersions } from '../db/schema.js';
```

文件末尾追加：

```ts
/** 解析 version 所属项目 id（version → project）；链路不存在返回 null。 */
export async function resolveVersionProjectId(versionId: string): Promise<string | null> {
  const rows = await db
    .select({ projectId: projectVersions.projectId })
    .from(projectVersions)
    .where(eq(projectVersions.id, versionId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/** version 可见性断言：经 version → project 链路判定，404 文案不区分「不存在」与「不可见」。 */
export async function assertVersionVisible(versionId: string, user: AuthUser): Promise<{ projectId: string }> {
  const projectId = await resolveVersionProjectId(versionId);
  if (!projectId) throw new HttpError(404, 'not_found', 'version not found');
  await assertProjectVisible(projectId, user);
  return { projectId };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/project-access-version.test.ts
```

Expected: 2/2 通过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/projectAccess.ts apps/api/test/project-access-version.test.ts
git commit -m "feat(api/services): assertVersionVisible + resolveVersionProjectId"
```

---

## Task 3: `project_versions` 路由（CRUD + set-default + delete 保护）

**Files:**
- Create: `apps/api/src/routes/projectVersions.ts`
- Create: `apps/api/test/project-versions.test.ts`

- [ ] **Step 1: 加失败测试**

```ts
// apps/api/test/project-versions.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject, seedUserAndToken } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let projectId: string;
let token: string;
let baseUrl: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.PORT = '0';
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { startTestServer } = await import('./helpers/server.js');
  const srv = await startTestServer();
  baseUrl = srv.baseUrl;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE projects, project_versions, "groups", test_cases, test_environments, execution_plans, project_assignments, organizations, users CASCADE`);
  const s = await seedProject(pool);
  projectId = s.projectId;
  token = await seedUserAndToken(pool, { role: 'admin' });
});

describe('project versions', () => {
  it('GET /projects/:id/versions 列出 v0', async () => {
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/versions`, { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    const list = await r.json();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('v0');
    expect(list[0].isDefault).toBe(true);
  });

  it('POST /projects/:id/versions 新建并返回 201', async () => {
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'v1.0', description: 'first release' }),
    });
    expect(r.status).toBe(201);
    const v = await r.json();
    expect(v.name).toBe('v1.0');
    expect(v.isDefault).toBe(false);
  });

  it('同名 version 返回 400 version_name_taken', async () => {
    await fetch(`${baseUrl}/api/projects/${projectId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'v0' }),
    });
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'v0' }),
    });
    expect(r.status).toBe(409);
  });

  it('POST /project-versions/:id/set-default 切换默认；旧默认取消', async () => {
    const cr = await fetch(`${baseUrl}/api/projects/${projectId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'v1.0' }),
    });
    const newId = (await cr.json()).id as string;
    const r = await fetch(`${baseUrl}/api/project-versions/${newId}/set-default`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(204);
    const list = await (await fetch(`${baseUrl}/api/projects/${projectId}/versions`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const def = list.find((v: { isDefault: boolean }) => v.isDefault);
    expect(def.id).toBe(newId);
  });

  it('删除最后一个版本返回 400 last_version', async () => {
    const list = await (await fetch(`${baseUrl}/api/projects/${projectId}/versions`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const r = await fetch(`${baseUrl}/api/project-versions/${list[0].id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(400);
  });

  it('删除非空 version 返回 400 version_not_empty + 计数', async () => {
    await pool.query(`INSERT INTO test_cases(group_id, version_id, title) VALUES ((SELECT id FROM "groups" WHERE project_id=$1), (SELECT id FROM project_versions WHERE project_id=$1 AND is_default), 'x')`, [projectId]);
    const list = await (await fetch(`${baseUrl}/api/projects/${projectId}/versions`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const r = await fetch(`${baseUrl}/api/project-versions/${list[0].id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('version_not_empty');
    expect(body.caseCount).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/project-versions.test.ts
```

Expected: 端点不存在（404）。

- [ ] **Step 3: 实现 `routes/projectVersions.ts`**

```ts
// apps/api/src/routes/projectVersions.ts
import { Router } from 'express';
import { z } from 'zod';
import { eq, sql, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectVersions, testCases, testEnvironments, executionPlans } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible, assertVersionVisible } from '../services/projectAccess.js';

export const projectVersionsRoute = Router({ mergeParams: true });

const CreateBody = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
});

const PatchBody = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
});

projectVersionsRoute.get('/projects/:projectId/versions', async (req, res) => {
  const pid = String(req.params.projectId);
  await assertProjectVisible(pid, req.user!);
  const rows = await db.select().from(projectVersions).where(eq(projectVersions.projectId, pid)).orderBy(projectVersions.createdAt);
  // 计数（cases/envs/plans）单独聚合
  const counts = await db.execute(sql`
    SELECT v.id,
      (SELECT count(*) FROM test_cases c WHERE c.version_id = v.id)         AS case_count,
      (SELECT count(*) FROM test_environments e WHERE e.version_id = v.id)  AS environment_count,
      (SELECT count(*) FROM execution_plans p WHERE p.version_id = v.id)    AS plan_count
    FROM project_versions v
    WHERE v.project_id = ${pid}
  `);
  const byId = new Map<string, { case_count: number; environment_count: number; plan_count: number }>();
  for (const r of counts.rows as Array<{ id: string; case_count: string; environment_count: string; plan_count: string }>) {
    byId.set(r.id, {
      case_count: Number(r.case_count),
      environment_count: Number(r.environment_count),
      plan_count: Number(r.plan_count),
    });
  }
  res.json(rows.map((v) => ({
    ...v,
    caseCount: byId.get(v.id)?.case_count ?? 0,
    environmentCount: byId.get(v.id)?.environment_count ?? 0,
    planCount: byId.get(v.id)?.plan_count ?? 0,
  })));
});

projectVersionsRoute.post('/projects/:projectId/versions', async (req, res) => {
  const pid = String(req.params.projectId);
  await assertProjectVisible(pid, req.user!);
  const body = CreateBody.parse(req.body);
  const dup = await db.select({ id: projectVersions.id }).from(projectVersions)
    .where(and(eq(projectVersions.projectId, pid), eq(projectVersions.name, body.name))).limit(1);
  if (dup.length > 0) throw new HttpError(409, 'version_name_taken', `version name "${body.name}" already exists in this project`);
  const rows = await db.insert(projectVersions).values({
    projectId: pid,
    name: body.name,
    description: body.description ?? null,
    isDefault: false,
  }).returning();
  res.status(201).json(rows[0]);
});

projectVersionsRoute.patch('/project-versions/:id', async (req, res) => {
  const id = String(req.params.id);
  const { projectId } = await assertVersionVisible(id, req.user!);
  const body = PatchBody.parse(req.body);
  if (body.name !== undefined) {
    const dup = await db.select({ id: projectVersions.id }).from(projectVersions)
      .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.name, body.name))).limit(1);
    if (dup.length > 0 && dup[0]!.id !== id) {
      throw new HttpError(409, 'version_name_taken', `version name "${body.name}" already exists`);
    }
  }
  await db.update(projectVersions).set({
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    updatedAt: new Date(),
  }).where(eq(projectVersions.id, id));
  const rows = await db.select().from(projectVersions).where(eq(projectVersions.id, id));
  res.json(rows[0]);
});

projectVersionsRoute.post('/project-versions/:id/set-default', async (req, res) => {
  const id = String(req.params.id);
  const { projectId } = await assertVersionVisible(id, req.user!);
  await db.transaction(async (tx) => {
    await tx.update(projectVersions).set({ isDefault: false, updatedAt: new Date() })
      .where(eq(projectVersions.projectId, projectId));
    await tx.update(projectVersions).set({ isDefault: true, updatedAt: new Date() })
      .where(eq(projectVersions.id, id));
  });
  res.status(204).end();
});

projectVersionsRoute.delete('/project-versions/:id', async (req, res) => {
  const id = String(req.params.id);
  const { projectId } = await assertVersionVisible(id, req.user!);
  const all = await db.select({ id: projectVersions.id }).from(projectVersions).where(eq(projectVersions.projectId, projectId));
  if (all.length <= 1) throw new HttpError(400, 'last_version', 'cannot delete the last version of a project');
  const caseCount = (await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.versionId, id))).length;
  const envCount = (await db.select({ id: testEnvironments.id }).from(testEnvironments).where(eq(testEnvironments.versionId, id))).length;
  const planCount = (await db.select({ id: executionPlans.id }).from(executionPlans).where(eq(executionPlans.versionId, id))).length;
  if (caseCount + envCount + planCount > 0) {
    throw new HttpError(400, 'version_not_empty', `version has ${caseCount} cases, ${envCount} environments, ${planCount} plans`, {
      caseCount, envCount, planCount,
    } as Record<string, unknown>);
  }
  await db.transaction(async (tx) => {
    // 若删的是默认版本，自动迁移默认到最早创建的版本
    const [v] = await tx.select().from(projectVersions).where(eq(projectVersions.id, id)).limit(1);
    if (v?.isDefault) {
      const next = await tx.select({ id: projectVersions.id }).from(projectVersions)
        .where(and(eq(projectVersions.projectId, projectId))).orderBy(projectVersions.createdAt).limit(1);
      if (next[0]) await tx.update(projectVersions).set({ isDefault: true, updatedAt: new Date() }).where(eq(projectVersions.id, next[0].id));
    }
    await tx.delete(projectVersions).where(eq(projectVersions.id, id));
  });
  res.status(204).end();
});
```

- [ ] **Step 4: 挂载到 `index.ts`**

`apps/api/src/index.ts` 第 26 行后追加 import：

```ts
import { projectVersionsRoute } from './routes/projectVersions.js';
```

第 47 行（`app.use('/api/projects', projectsRoute);`）后追加：

```ts
app.use('/api', projectVersionsRoute);
```

- [ ] **Step 5: 写测试帮助 `startTestServer`**

`apps/api/test/helpers/server.ts` 应当已存在（被其它测试用过）。若没有，新建：

```ts
import { createServer } from 'node:http';
import express from '../../src/index.js';

export async function startTestServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  // express app 已经 listen 在 process.env.PORT 或 54321；用独立端口更安全
  const port = Number(process.env.PORT ?? 54322);
  process.env.PORT = String(port);
  // 触发 index.ts 副作用 listen
  const url = `http://127.0.0.1:${port}`;
  // 等待 server ready（简单轮询）
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${url}/api/health`); if (r.ok) break; } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { baseUrl: url, close: async () => { /* keep server alive across tests */ } };
}
```

（更标准做法是 import app 而非 listen；现状下直接复用 index.ts 的副作用 listen 也可。先跑测试看能否拉到 `/api/health`；若不行，把 `server.ts` 改成 `import { app } from '../../src/index.js'` 后用 `app.listen(port)` 单独起。）

- [ ] **Step 6: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/project-versions.test.ts
```

Expected: 6/6 通过。

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/projectVersions.ts apps/api/src/index.ts apps/api/test/project-versions.test.ts apps/api/test/helpers/server.ts
git commit -m "feat(api/routes): project_versions CRUD + set-default + delete protection"
```

---

## Task 4: `environments` 路由加 `versionId` 过滤 + 强校验

**Files:**
- Modify: `apps/api/src/routes/environments.ts:24-118`

- [ ] **Step 1: 加失败测试**

新建 `apps/api/test/environments-version.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject, seedUserAndToken } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let projectId: string;
let v0Id: string;
let v1Id: string;
let token: string;
let baseUrl: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  process.env.PORT = process.env.PORT ?? '54323';
  const { startTestServer } = await import('./helpers/server.js');
  baseUrl = (await startTestServer()).baseUrl;
}, 60_000);

afterAll(async () => { await pool.end(); await container.stop(); });

beforeEach(async () => {
  await pool.query(`TRUNCATE projects, project_versions, "groups", test_cases, test_environments, execution_plans, project_assignments, organizations, users CASCADE`);
  const s = await seedProject(pool);
  projectId = s.projectId;
  v0Id = s.versionId;
  const r = await pool.query(`INSERT INTO project_versions(project_id, name) VALUES ($1, 'v1.0') RETURNING id`, [projectId]);
  v1Id = r.rows[0]!.id as string;
  token = await seedUserAndToken(pool, { role: 'admin' });
});

describe('environments version filter', () => {
  it('GET ?versionId=v0 仅返回 v0 的环境', async () => {
    await fetch(`${baseUrl}/api/projects/${projectId}/environments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'env0', versionId: v0Id }),
    });
    await fetch(`${baseUrl}/api/projects/${projectId}/environments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'env1', versionId: v1Id }),
    });
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/environments?versionId=${v0Id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const list = await r.json();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('env0');
  });

  it('POST 跨项目 versionId 拒绝（400/404）', async () => {
    const other = await pool.query(`INSERT INTO projects(organization_id, name) VALUES ((SELECT organization_id FROM projects WHERE id=$1), 'p2') RETURNING id`, [projectId]);
    const otherV = await pool.query(`INSERT INTO project_versions(project_id, name) VALUES ($1, 'v0') RETURNING id`, [other.rows[0]!.id]);
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/environments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'env', versionId: otherV.rows[0]!.id }),
    });
    expect([400, 404]).toContain(r.status);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/environments-version.test.ts
```

Expected: 失败。

- [ ] **Step 3: 改 `environments.ts`**

把第 24-33 行整段替换：

```ts
environmentsRoute.get('/projects/:projectId/environments', async (req, res) => {
  const projectId = (req.params as { projectId: string }).projectId;
  await assertProjectVisible(projectId, req.user!);
  const qVersionId = typeof req.query.versionId === 'string' ? req.query.versionId : null;
  // 未传 versionId → 默认版本
  let versionId = qVersionId;
  if (!versionId) {
    const row = (await db.select({ id: projectVersions.id }).from(projectVersions)
      .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.isDefault, true))).limit(1))[0];
    if (!row) throw new HttpError(404, 'not_found', 'project has no default version');
    versionId = row.id;
  } else {
    await assertVersionVisible(versionId, req.user!);
    const { projectId: vp } = await assertVersionVisible(versionId, req.user!);
    if (vp !== projectId) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
  }
  const rows = await db.select().from(testEnvironments)
    .where(and(eq(testEnvironments.projectId, projectId), eq(testEnvironments.versionId, versionId)))
    .orderBy(testEnvironments.createdAt);
  res.json(rows.map((r) => maskSecrets({ ...r })));
});
```

文件顶部 import 追加：

```ts
import { projectVersions } from '../db/schema.js';
import { assertVersionVisible } from '../services/projectAccess.js';
import { and } from 'drizzle-orm';
```

把第 49-74 行整段替换（POST）：

```ts
environmentsRoute.post('/projects/:projectId/environments', async (req, res) => {
  const projectId = (req.params as { projectId: string }).projectId;
  await assertProjectVisible(projectId, req.user!);
  const body = EnvBody.parse(req.body);
  // 解析 versionId：未传 → 默认版本；传了 → 校验属于该项目
  let versionId: string;
  if (body.versionId) {
    const { projectId: vp } = await assertVersionVisible(body.versionId, req.user!);
    if (vp !== projectId) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
    versionId = body.versionId;
  } else {
    const row = (await db.select({ id: projectVersions.id }).from(projectVersions)
      .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.isDefault, true))).limit(1))[0];
    if (!row) throw new HttpError(404, 'not_found', 'project has no default version');
    versionId = row.id;
  }
  const dbPwd = body.dbPassword ? encrypt(body.dbPassword) : null;
  const sshKey = body.syslogKey ? encrypt(body.syslogKey) : null;
  const inserted = await db.insert(testEnvironments).values({
    projectId,
    versionId,
    name: body.name,
    dbHost: body.dbHost ?? null,
    dbPort: body.dbPort ?? null,
    dbName: body.dbName ?? null,
    dbUser: body.dbUser ?? null,
    dbPasswordCiphertext: dbPwd?.ciphertext.toString('base64') ?? null,
    dbPasswordIv: dbPwd?.iv.toString('base64') ?? null,
    dbPasswordTag: dbPwd?.tag.toString('base64') ?? null,
    syslogHost: body.syslogHost ?? null,
    syslogUser: body.syslogUser ?? null,
    syslogSshPort: body.syslogSshPort ?? null,
    syslogKeyCiphertext: sshKey?.ciphertext.toString('base64') ?? null,
    syslogKeyIv: sshKey?.iv.toString('base64') ?? null,
    syslogKeyTag: sshKey?.tag.toString('base64') ?? null,
    syslogFilePath: body.syslogFilePath ?? null,
  }).returning();
  res.json(maskSecrets({ ...inserted[0]! }));
});
```

把 `EnvBody` schema（第 35-47 行）加一行：

```ts
const EnvBody = z.object({
  name: z.string().min(1).max(120),
  versionId: z.string().uuid().optional(),
  dbHost: z.string().max(200).optional(),
  ...
});
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/environments-version.test.ts
```

Expected: 2/2 通过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/environments.ts apps/api/test/environments-version.test.ts
git commit -m "feat(api/env): versionId filter + cross-project guard"
```

---

## Task 5: `cases` 路由加 `versionId` 过滤 + 创建校验 + 跨版本 copy

**Files:**
- Modify: `apps/api/src/routes/cases.ts:1-51,90-300`

- [ ] **Step 1: 加失败测试**

新建 `apps/api/test/cases-version.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject, seedUserAndToken } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let projectId: string;
let groupId: string;
let v0Id: string;
let v1Id: string;
let token: string;
let baseUrl: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  process.env.PORT = process.env.PORT ?? '54324';
  const { startTestServer } = await import('./helpers/server.js');
  baseUrl = (await startTestServer()).baseUrl;
}, 60_000);

afterAll(async () => { await pool.end(); await container.stop(); });

beforeEach(async () => {
  await pool.query(`TRUNCATE projects, project_versions, "groups", test_cases, test_environments, execution_plans, project_assignments, organizations, users CASCADE`);
  const s = await seedProject(pool);
  projectId = s.projectId;
  groupId = s.groupId;
  v0Id = s.versionId;
  const r = await pool.query(`INSERT INTO project_versions(project_id, name) VALUES ($1, 'v1.0') RETURNING id`, [projectId]);
  v1Id = r.rows[0]!.id as string;
  token = await seedUserAndToken(pool, { role: 'admin' });
});

describe('cases version filter', () => {
  it('GET /cases?projectId 未传 versionId 默认 v0', async () => {
    await fetch(`${baseUrl}/api/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: 'c0', groupId }),
    });
    const r = await fetch(`${baseUrl}/api/cases?projectId=${projectId}`, { headers: { Authorization: `Bearer ${token}` } });
    const list = await r.json();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('c0');
    expect(list[0].versionId).toBe(v0Id);
  });

  it('POST 跨项目 versionId 拒绝', async () => {
    const other = await pool.query(`INSERT INTO projects(organization_id, name) VALUES ((SELECT organization_id FROM projects WHERE id=$1), 'p2') RETURNING id`, [projectId]);
    const otherV = await pool.query(`INSERT INTO project_versions(project_id, name) VALUES ($1, 'v0') RETURNING id`, [other.rows[0]!.id]);
    const r = await fetch(`${baseUrl}/api/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: 'c1', groupId, versionId: otherV.rows[0]!.id }),
    });
    expect([400, 404]).toContain(r.status);
  });

  it('POST /cases/:id/copy?targetVersionId= 跨版本复制成功', async () => {
    const cr = await fetch(`${baseUrl}/api/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: 'src', groupId }),
    });
    const src = await cr.json();
    const cp = await fetch(`${baseUrl}/api/cases/${src.id}/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ targetGroupId: groupId, targetVersionId: v1Id }),
    });
    expect(cp.status).toBe(200);
    const dup = await cp.json();
    expect(dup.versionId).toBe(v1Id);
    expect(dup.title).toMatch(/副本/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/cases-version.test.ts
```

Expected: 失败。

- [ ] **Step 3: 改 `cases.ts`**

顶部 import 替换：

```ts
import { testCases, testSteps, groups, scenarios, tags, caseTags, projects, projectVersions } from '../db/schema.js';
import { assertCaseVisible, assertProjectVisible, assertVersionVisible, resolveCaseProjectId, visibleProjectIds } from '../services/projectAccess.js';
```

`CaseBodyBase`（第 12-24 行）加一行：

```ts
const CaseBodyBase = z.object({
  title: z.string().min(1).max(200),
  versionId: z.string().uuid().optional(),
  ...
});
```

`PatchBody`（第 42-51 行）追加：

```ts
const PatchBody = CaseBodyBase.partial()
  .extend({
    versionId: z.string().uuid().optional(),
    scenarioId: z.string().uuid().nullable().optional(),
    ...
  })
  .superRefine(checkWindowStrategy);
```

`GET /` 路由（第 90-143 行）替换分支：`projectId` 解析 → 默认 versionId → 过滤 `test_cases.version_id = ?`：

把第 90-115 行的查询部分替换：

```ts
casesRoute.get('/', async (req, res) => {
  const { priority, groupId, projectId, scenarioId, versionId: vIdQuery } = req.query as Record<string, string | undefined>;
  let rows;
  if (projectId) {
    await assertProjectVisible(projectId, req.user!);
    // 解析 versionId（未传 → 默认版本）
    let versionId = vIdQuery;
    if (!versionId) {
      const row = (await db.select({ id: projectVersions.id }).from(projectVersions)
        .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.isDefault, true))).limit(1))[0];
      if (!row) throw new HttpError(404, 'not_found', 'project has no default version');
      versionId = row.id;
    } else {
      const { projectId: vp } = await assertVersionVisible(versionId, req.user!);
      if (vp !== projectId) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
    }
    const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
    const gids = gs.map((g) => g.id);
    rows = gids.length
      ? await db.select().from(testCases).where(and(inArray(testCases.groupId, gids), eq(testCases.versionId, versionId)))
      : [];
  } else if (groupId) {
    // groupId 路径保持：case 自带 version_id
    const g = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
    if (!g[0]) throw new HttpError(404, 'not_found', 'group not found');
    await assertProjectVisible(g[0].projectId, req.user!);
    rows = vIdQuery
      ? await db.select().from(testCases).where(and(eq(testCases.groupId, groupId), eq(testCases.versionId, vIdQuery)))
      : await db.select().from(testCases).where(eq(testCases.groupId, groupId));
  } else {
    // 无参：按可见项目 × 默认版本过滤
    const visiblePids = await visibleProjectIds(req.user!);
    if (visiblePids.length === 0) { rows = []; }
    else {
      const gs = await db.select().from(groups).where(inArray(groups.projectId, visiblePids));
      const gids = gs.map((g) => g.id);
      const defaults = await db.select({ id: projectVersions.id, projectId: projectVersions.projectId }).from(projectVersions)
        .where(and(inArray(projectVersions.projectId, visiblePids), eq(projectVersions.isDefault, true)));
      const versionIds = defaults.map((v) => v.id);
      rows = (gids.length && versionIds.length)
        ? await db.select().from(testCases).where(and(inArray(testCases.groupId, gids), inArray(testCases.versionId, versionIds)))
        : [];
    }
  }
  if (priority) rows = rows.filter((r) => r.priority === priority);
  if (scenarioId) {
    rows = scenarioId === 'none'
      ? rows.filter((r) => r.scenarioId == null)
      : rows.filter((r) => r.scenarioId === scenarioId);
  }
  const sids = [...new Set(rows.map((r) => r.scenarioId).filter((v): v is string => !!v))];
  const sById = new Map<string, { id: string; title: string }>();
  if (sids.length > 0) {
    const scRows = await db.select({ id: scenarios.id, title: scenarios.title }).from(scenarios).where(inArray(scenarios.id, sids));
    for (const s of scRows) sById.set(s.id, s);
  }
  const caseIds = rows.map((r) => r.id);
  const tagsByCase = await tagsForCases(caseIds);
  res.json(
    rows.map((r) => ({
      ...r,
      scenarioTitle: r.scenarioId ? (sById.get(r.scenarioId)?.title ?? null) : null,
      tags: tagsByCase.get(r.id) ?? [],
    })),
  );
});
```

`POST /`（第 145-160 行）替换：

```ts
casesRoute.post('/', async (req, res) => {
  const body = CreateBody.parse(req.body);
  const g = await db.select().from(groups).where(eq(groups.id, body.groupId));
  if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  const projectId = g[0]!.projectId;
  await assertProjectVisible(projectId, req.user!);
  // 解析 versionId
  let versionId = body.versionId;
  if (!versionId) {
    const row = (await db.select({ id: projectVersions.id }).from(projectVersions)
      .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.isDefault, true))).limit(1))[0];
    if (!row) throw new HttpError(404, 'not_found', 'project has no default version');
    versionId = row.id;
  } else {
    const { projectId: vp } = await assertVersionVisible(versionId, req.user!);
    if (vp !== projectId) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
  }
  if (body.tagIds && body.tagIds.length > 0) await assertTagsBelongToOrg(body.tagIds, projectId);
  const { tagIds: _ignoredTagIds, versionId: _ignoredVersion, ...caseValues } = body;
  const rows = await db.insert(testCases).values({ ...caseValues, versionId }).returning();
  const created = rows[0]!;
  if (body.tagIds && body.tagIds.length > 0) {
    await db.insert(caseTags).values(body.tagIds.map((tagId) => ({ caseId: created.id, tagId })));
  }
  res.json({ ...created, tags: body.tagIds ? body.tagIds.map((id) => ({ id })) : [] });
});
```

`copyOneCase`（第 251-293 行）参数加 `targetVersionId`，插入时填：

```ts
async function copyOneCase(caseId: string, targetGroupId: string, targetVersionId: string | null, user: NonNullable<Express.Request['user']>): Promise<unknown> {
  const src = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
  if (!src) throw new HttpError(404, 'not_found', 'case not found');
  await assertCaseVisible(caseId, user);
  const targetGroup = (await db.select().from(groups).where(eq(groups.id, targetGroupId)))[0];
  if (targetGroup) await assertProjectVisible(targetGroup.projectId, user);
  // versionId 未传 → 同版本复制；否则校验属于 targetGroup.projectId
  let versionId = src.versionId;
  if (targetVersionId) {
    const { projectId: vp } = await assertVersionVisible(targetVersionId, user);
    if (targetGroup && vp !== targetGroup.projectId) throw new HttpError(400, 'version_mismatch', 'version does not belong to target project');
    versionId = targetVersionId;
  }
  const siblings = await db.select({ title: testCases.title }).from(testCases).where(eq(testCases.groupId, targetGroupId));
  const title = await nextCopyTitle(src.title, siblings.map((s) => s.title));
  const steps = await db.select().from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order));
  const inserted = await db.insert(testCases).values({
    title,
    description: src.description,
    priority: src.priority,
    groupId: targetGroupId,
    versionId,
    url: src.url,
  }).returning();
  const newCase = inserted[0]!;
  if (steps.length > 0) {
    await db.insert(testSteps).values(steps.map((s) => ({ caseId: newCase.id, order: s.order, source: s.source, action: s.action, assertion: s.assertion })));
  }
  const srcTagRows = await db.select({ tagId: caseTags.tagId }).from(caseTags).where(eq(caseTags.caseId, caseId));
  if (srcTagRows.length > 0) {
    await db.insert(caseTags).values(srcTagRows.map((r) => ({ caseId: newCase.id, tagId: r.tagId })));
  }
  return newCase;
}
```

`POST /cases/:id/copy`（第 295-301 行）替换：

```ts
casesRoute.post('/:id/copy', async (req, res) => {
  const body = z.object({ targetGroupId: z.string().uuid(), targetVersionId: z.string().uuid().optional() }).parse(req.body);
  const g = await db.select().from(groups).where(eq(groups.id, body.targetGroupId));
  if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  await assertProjectVisible(g[0]!.projectId, req.user!);
  res.json(await copyOneCase(req.params.id!, body.targetGroupId, body.targetVersionId ?? null, req.user!));
});
```

`POST /cases/copy`（第 303-312 行）替换：

```ts
casesRoute.post('/copy', async (req, res) => {
  const body = z.object({
    caseIds: z.array(z.string().uuid()).min(1),
    targetGroupId: z.string().uuid(),
    targetVersionId: z.string().uuid().optional(),
  }).parse(req.body);
  const g = await db.select().from(groups).where(eq(groups.id, body.targetGroupId));
  if (g.length === 0) throw new HttpError(404, 'not_found', 'group not found');
  await assertProjectVisible(g[0]!.projectId, req.user!);
  for (const id of body.caseIds) {
    await copyOneCase(id, body.targetGroupId, body.targetVersionId ?? null, req.user!);
  }
  res.json({ count: body.caseIds.length });
});
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/cases-version.test.ts
```

Expected: 3/3 通过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/cases.ts apps/api/test/cases-version.test.ts
git commit -m "feat(api/cases): versionId filter + cross-version copy"
```

---

## Task 6: `plans` 路由加 `versionId` + environmentId 必须同 version

**Files:**
- Modify: `apps/api/src/routes/plans.ts:1-67,69-89`

- [ ] **Step 1: 加失败测试**

新建 `apps/api/test/plans-version.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject, seedUserAndToken } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let projectId: string;
let v0Id: string;
let v1Id: string;
let env0Id: string;
let token: string;
let baseUrl: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  process.env.PORT = process.env.PORT ?? '54325';
  const { startTestServer } = await import('./helpers/server.js');
  baseUrl = (await startTestServer()).baseUrl;
}, 60_000);

afterAll(async () => { await pool.end(); await container.stop(); });

beforeEach(async () => {
  await pool.query(`TRUNCATE projects, project_versions, "groups", test_cases, test_environments, execution_plans, project_assignments, organizations, users CASCADE`);
  const s = await seedProject(pool);
  projectId = s.projectId;
  v0Id = s.versionId;
  const r1 = await pool.query(`INSERT INTO project_versions(project_id, name) VALUES ($1, 'v1.0') RETURNING id`, [projectId]);
  v1Id = r1.rows[0]!.id as string;
  const r2 = await pool.query(`INSERT INTO test_environments(project_id, version_id, name) VALUES ($1, $2, 'env0') RETURNING id`, [projectId, v0Id]);
  env0Id = r2.rows[0]!.id as string;
  token = await seedUserAndToken(pool, { role: 'admin' });
});

describe('plans version', () => {
  it('GET /plans?projectId&versionId 仅返回该 version 的计划', async () => {
    await fetch(`${baseUrl}/api/projects/${projectId}/plans`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'p0', versionId: v0Id }),
    });
    await fetch(`${baseUrl}/api/projects/${projectId}/plans`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'p1', versionId: v1Id }),
    });
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/plans?versionId=${v0Id}`, { headers: { Authorization: `Bearer ${token}` } });
    const list = await r.json();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('p0');
  });

  it('POST plans 跨版本 environmentId 拒绝', async () => {
    const r = await fetch(`${baseUrl}/api/projects/${projectId}/plans`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'p', versionId: v1Id, environmentId: env0Id }),
    });
    expect([400, 422]).toContain(r.status);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/plans-version.test.ts
```

Expected: 失败。

- [ ] **Step 3: 改 `plans.ts`**

顶部 import 追加：

```ts
import { projectVersions, testEnvironments } from '../db/schema.js';
import { and } from 'drizzle-orm';
import { assertVersionVisible } from '../services/projectAccess.js';
```

`CreateBody`（第 31-36 行）追加 `versionId`：

```ts
const CreateBody = z.object({
  name: z.string().min(1).max(200),
  versionId: z.string().uuid().optional(),
  environment: z.string().max(100).optional(),
  strategy: StrategyEnum.default('run_all'),
  loginPrepare: LoginPrepareBody,
});
```

`GET`（第 46-67 行）替换：

```ts
plansRoute.get('/', async (req, res) => {
  const { projectId, versionId: vIdQuery } = req.params as { projectId?: string } & Record<string, string>;
  const versionId = (req.query.versionId ?? vIdQuery) as string | undefined;
  let ps;
  if (projectId) {
    await assertProjectVisible(projectId, req.user!);
    const cond = versionId
      ? and(eq(executionPlans.projectId, projectId), eq(executionPlans.versionId, versionId))
      : eq(executionPlans.projectId, projectId);
    ps = await db.select().from(executionPlans).where(cond).orderBy(asc(executionPlans.createdAt));
  } else {
    const visiblePids = await visibleProjectIds(req.user!);
    if (visiblePids.length === 0) { ps = []; }
    else ps = await db.select().from(executionPlans).where(inArray(executionPlans.projectId, visiblePids)).orderBy(asc(executionPlans.createdAt));
  }
  const pcs = await db.select().from(planCases);
  const countByPlan = new Map<string, number>();
  for (const pc of pcs) countByPlan.set(pc.planId, (countByPlan.get(pc.planId) ?? 0) + 1);
  res.json(ps.map((p) => ({ ...p, caseCount: countByPlan.get(p.id) ?? 0 })));
});
```

`POST`（第 69-89 行）替换：

```ts
plansRoute.post('/', async (req, res) => {
  const projectId = (req.params as { projectId?: string }).projectId;
  if (!projectId) throw new HttpError(400, 'bad_request', 'projectId is required');
  const body = CreateBody.parse(req.body);
  await assertProjectVisible(projectId, req.user!);
  // 解析 versionId
  let versionId = body.versionId;
  if (!versionId) {
    const row = (await db.select({ id: projectVersions.id }).from(projectVersions)
      .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.isDefault, true))).limit(1))[0];
    if (!row) throw new HttpError(404, 'not_found', 'project has no default version');
    versionId = row.id;
  } else {
    const { projectId: vp } = await assertVersionVisible(versionId, req.user!);
    if (vp !== projectId) throw new HttpError(400, 'version_mismatch', 'version does not belong to this project');
  }
  // environmentId 必须同 versionId
  if (body.environmentId) {
    const env = (await db.select({ versionId: testEnvironments.versionId }).from(testEnvironments).where(eq(testEnvironments.id, body.environmentId)).limit(1))[0];
    if (!env) throw new HttpError(404, 'not_found', 'environment not found');
    if (env.versionId !== versionId) throw new HttpError(400, 'environment_version_mismatch', 'environment does not belong to plan version');
  }
  const rows = await db.insert(executionPlans).values({
    projectId,
    versionId,
    name: body.name,
    environment: body.environment,
    environmentId: body.environmentId ?? null,
    strategy: body.strategy,
    loginPrepareEnabled: body.loginPrepare?.enabled ?? false,
    loginCaseId: body.loginPrepare?.caseId ?? null,
    detectionUrl: body.loginPrepare?.detectionUrl ?? null,
    loginSuccessSelector: body.loginPrepare?.successSelector ?? null,
    loginUnauthorizedKeywords: body.loginPrepare?.unauthorizedKeywords ?? null,
  }).returning();
  res.json(rows[0]);
});
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/plans-version.test.ts
```

Expected: 2/2 通过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/plans.ts apps/api/test/plans-version.test.ts
git commit -m "feat(api/plans): versionId filter + environment must match plan version"
```

---

## Task 7: `ai-workspace/save` 接受 `targetVersionId`

**Files:**
- Modify: `apps/api/src/routes/requirements.ts:137-276`

- [ ] **Step 1: 加失败测试**

新建 `apps/api/test/ai-save-version.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject, seedUserAndToken } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let projectId: string;
let requirementId: string;
let v0Id: string;
let v1Id: string;
let token: string;
let baseUrl: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  process.env.PORT = process.env.PORT ?? '54326';
  const { startTestServer } = await import('./helpers/server.js');
  baseUrl = (await startTestServer()).baseUrl;
}, 60_000);

afterAll(async () => { await pool.end(); await container.stop(); });

beforeEach(async () => {
  await pool.query(`TRUNCATE projects, project_versions, "groups", requirements, test_cases, test_steps, test_environments, execution_plans, project_assignments, organizations, users, ai_workspace_state, ai_threads CASCADE`);
  const s = await seedProject(pool);
  projectId = s.projectId;
  v0Id = s.versionId;
  const r1 = await pool.query(`INSERT INTO project_versions(project_id, name) VALUES ($1, 'v1.0') RETURNING id`, [projectId]);
  v1Id = r1.rows[0]!.id as string;
  const r2 = await pool.query(`INSERT INTO requirements(project_id, title, content) VALUES ($1, 't', 'c') RETURNING id`, [projectId]);
  requirementId = r2.rows[0]!.id as string;
  // 写一个简单的 ai case
  await pool.query(
    `INSERT INTO ai_workspace_state(requirement_id, doc) VALUES ($1, $2)`,
    [requirementId, { scenarios: [], looseCases: [{ id: 'lc1', title: '登录', description: null, priority: 'P1', steps: [{ name: 's', action: 'a', assertion: null, compiled: null }] }] }],
  );
  token = await seedUserAndToken(pool, { role: 'admin' });
});

describe('ai-workspace save targetVersionId', () => {
  it('传 targetVersionId=v1 → case 落到 v1', async () => {
    // 取 groupId
    const g = await pool.query(`SELECT id FROM "groups" WHERE project_id=$1 LIMIT 1`, [projectId]);
    const r = await fetch(`${baseUrl}/api/requirements/${requirementId}/ai-workspace/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ groupId: g.rows[0]!.id, scenarioIds: [], caseIds: ['lc1'], targetVersionId: v1Id }),
    });
    expect(r.status).toBe(200);
    const caseRow = await pool.query(`SELECT version_id FROM test_cases WHERE requirement_id=$1`, [requirementId]);
    expect(caseRow.rows[0]!.version_id).toBe(v1Id);
  });

  it('未传 → 默认 v0', async () => {
    const g = await pool.query(`SELECT id FROM "groups" WHERE project_id=$1 LIMIT 1`, [projectId]);
    const r = await fetch(`${baseUrl}/api/requirements/${requirementId}/ai-workspace/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ groupId: g.rows[0]!.id, scenarioIds: [], caseIds: ['lc1'] }),
    });
    expect(r.status).toBe(200);
    const caseRow = await pool.query(`SELECT version_id FROM test_cases WHERE requirement_id=$1`, [requirementId]);
    expect(caseRow.rows[0]!.version_id).toBe(v0Id);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && pnpm test test/ai-save-version.test.ts
```

Expected: 失败（`targetVersionId` 被 zod 拒）。

- [ ] **Step 3: 改 `requirements.ts`**

找到 `SaveBody`（大约第 13 行附近）追加 `targetVersionId`：

```ts
const SaveBody = z.object({
  groupId: z.string().uuid(),
  scenarioIds: z.array(z.string()).default([]),
  caseIds: z.array(z.string()).default([]),
  targetVersionId: z.string().uuid().optional(),
});
```

第 250 行 `tx.insert(testCases).values({...})` 块前增加 versionId 解析 + 校验：

```ts
// 解析 targetVersionId
let versionId: string;
if (body.targetVersionId) {
  const { projectId: vp } = await assertVersionVisible(body.targetVersionId, req.user!);
  if (vp !== rows[0]!.projectId) throw new HttpError(400, 'version_mismatch', 'version does not belong to requirement project');
  versionId = body.targetVersionId;
} else {
  const def = (await db.select({ id: projectVersions.id }).from(projectVersions)
    .where(and(eq(projectVersions.projectId, rows[0]!.projectId), eq(projectVersions.isDefault, true))).limit(1))[0];
  if (!def) throw new HttpError(404, 'not_found', 'project has no default version');
  versionId = def.id;
}
```

`tx.insert(testCases).values({...})` 加 `versionId`：

```ts
const tc = await tx.insert(testCases).values({
  requirementId: req.params.id,
  groupId: body.groupId,
  versionId,
  scenarioId,
  title: c.title,
  description: c.description,
  priority: c.priority,
  url: requirementUrl,
}).returning();
```

顶部 import 追加：

```ts
import { projectVersions } from '../db/schema.js';
import { and } from 'drizzle-orm';
import { assertVersionVisible } from '../services/projectAccess.js';
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && pnpm test test/ai-save-version.test.ts
```

Expected: 2/2 通过。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/requirements.ts apps/api/test/ai-save-version.test.ts
git commit -m "feat(api/ai): save accepts targetVersionId"
```

---

## Task 8: 前端 store + 类型 + API client

**Files:**
- Modify: `apps/web/src/stores/project.ts`
- Modify: `apps/web/src/api/client.ts`

- [ ] **Step 1: 改 `useProjectStore`**

`apps/web/src/stores/project.ts` 整文件替换：

```ts
import { create } from 'zustand';

const STORAGE_KEY = 'itest-current-project';

export interface CurrentProject {
  id: string;
  name: string;
  defaultUrl: string | null;
  versionId: string;
  versionName: string;
  isDefaultVersion: boolean;
}

interface ProjectState {
  current: CurrentProject | null;
  enter: (p: CurrentProject) => void;
  /** 切换项目内的当前版本；URL 跳转由调用方负责。 */
  switchVersion: (versionId: string, versionName: string, isDefault: boolean) => void;
  exit: () => void;
}

function persist(p: CurrentProject | null): void {
  try {
    if (p) localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable; project context is in-memory only.
  }
}

function readStored(): CurrentProject | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v) return null;
    const parsed = JSON.parse(v) as Partial<CurrentProject>;
    if (!parsed.id || !parsed.name || !parsed.versionId || !parsed.versionName) return null;
    return {
      id: parsed.id,
      name: parsed.name,
      defaultUrl: parsed.defaultUrl ?? null,
      versionId: parsed.versionId,
      versionName: parsed.versionName,
      isDefaultVersion: parsed.isDefaultVersion ?? false,
    };
  } catch {
    return null;
  }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  current: readStored(),

  enter: (p) => {
    set({ current: p });
    persist(p);
  },

  switchVersion: (versionId, versionName, isDefault) => {
    const cur = get().current;
    if (!cur) return;
    const next: CurrentProject = { ...cur, versionId, versionName, isDefaultVersion: isDefault };
    set({ current: next });
    persist(next);
  },

  exit: () => {
    set({ current: null });
    persist(null);
  },
}));
```

- [ ] **Step 2: 加 `ProjectVersion` 类型 + API**

`apps/web/src/api/client.ts` 文件末尾追加（导出块之前或后，保持原风格）：

```ts
export interface ProjectVersion {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  caseCount: number;
  environmentCount: number;
  planCount: number;
}
```

`api` 对象内追加：

```ts
  versions: {
    list: (projectId: string) => request<ProjectVersion[]>(`/projects/${projectId}/versions`),
    create: (projectId: string, body: { name: string; description?: string }) =>
      request<ProjectVersion>(`/projects/${projectId}/versions`, { method: 'POST', body: JSON.stringify(body) }),
    patch: (versionId: string, body: { name?: string; description?: string | null }) =>
      request<ProjectVersion>(`/project-versions/${versionId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    setDefault: (versionId: string) =>
      fetch(`${BASE}/project-versions/${versionId}/set-default`, { method: 'POST' }).then((r) => { if (r.status !== 204) throw new Error(`HTTP ${r.status}`); }),
    remove: (versionId: string) =>
      fetch(`${BASE}/project-versions/${versionId}`, { method: 'DELETE' }).then((r) => { if (r.status !== 204) throw new Error(`HTTP ${r.status}`); }),
  },
  environments: {
    list: (projectId: string, params?: { versionId?: string }) =>
      request<Environment[]>(`/projects/${projectId}/environments${params?.versionId ? `?versionId=${params.versionId}` : ''}`),
    create: (projectId: string, body: Parameters<typeof api.environments.create>[1] & { versionId?: string }) => {
      const { ...rest } = body;
      return request<Environment>(`/projects/${projectId}/environments`, { method: 'POST', body: JSON.stringify(rest) });
    },
    patch: (id: string, body: Parameters<typeof api.environments.patch>[1]) =>
      request<Environment>(`/environments/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string, opts?: { confirm?: boolean }) =>
      request<{ ok: boolean; requiresConfirm?: boolean; caseCount?: number; planCount?: number }>(
        `/environments/${id}${opts?.confirm ? '?confirm=true' : ''}`,
        { method: 'DELETE' },
      ),
    allowedTables: () => request<Record<string, string[]>>('/environments/allowed-tables'),
  },
```

（注意：保留原有的 `environments.list/create/patch/remove`，只把它们的签名替换为接受 `versionId`。原 `Environment` 类型不动，**新增** `Environment` 字段 `versionId: string` —— 但 zod 类型已经松散地透传，TypeScript 编译天然兼容。）

把 `cases.list/create/copy` 加 `versionId`：

```ts
    list: (params: { groupId?: string; projectId?: string; versionId?: string; priority?: string; scenarioId?: string } = {}) =>
      request<TestCase[]>(`/cases${qs(params as Record<string, string | undefined>)}`),
    create: (body: { title: string; groupId: string; versionId?: string; priority?: CasePriority; url?: string; description?: string }) =>
      request<TestCase>('/cases', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => request<TestCaseDetail>(`/cases/${id}`),
    patch: (id: string, body: Partial<{ ... ; versionId?: string }>) =>
      request<TestCase>(`/cases/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/cases/${id}`, { method: 'DELETE' }),
    copy: (id: string, body: { targetGroupId: string; targetVersionId?: string }) =>
      request<TestCase>(`/cases/${id}/copy`, { method: 'POST', body: JSON.stringify(body) }),
    copyMany: (body: { caseIds: string[]; targetGroupId: string; targetVersionId?: string }) =>
      request<{ count: number }>('/cases/copy', { method: 'POST', body: JSON.stringify(body) }),
```

把 `plans.list/create` 加 `versionId`：

```ts
    list: (projectId: string, params?: { versionId?: string }) =>
      request<PlanWithCount[]>(`/projects/${projectId}/plans${params?.versionId ? `?versionId=${params.versionId}` : ''}`),
    create: (projectId: string, body: { name: string; versionId?: string; environment?: string }) =>
      request<ExecutionPlan>(`/projects/${projectId}/plans`, { method: 'POST', body: JSON.stringify(body) }),
```

把 `aiWorkspace.save` 加 `targetVersionId`：

```ts
    save: (requirementId: string, body: { groupId: string; scenarioIds: string[]; caseIds: string[]; targetVersionId?: string }) =>
      request<{ savedCases: number }>(`/requirements/${requirementId}/ai-workspace/save`, { method: 'POST', body: JSON.stringify(body) }),
```

- [ ] **Step 3: typecheck**

```bash
cd apps/web && pnpm exec tsc --noEmit
```

Expected: 0 error。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/stores/project.ts apps/web/src/api/client.ts
git commit -m "feat(web): ProjectVersion type + versions api + versionId on env/case/plan/ai"
```

---

## Task 9: 路由改造 `/p/:pid/v/:vid/...` + 版本选择中间页

**Files:**
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/src/pages/VersionsSelectPage.tsx`

- [ ] **Step 1: 改 `App.tsx` 路由**

整文件替换：

```tsx
import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import ToastRenderer from './components/layout/ToastRenderer';
import AuthGuard from './components/auth/AuthGuard';
import ProjectGuard from './components/layout/ProjectGuard';
import { useThemeStore } from './stores/theme';
import LoginPage from './pages/LoginPage';
import ProjectsHome from './pages/ProjectsHome';
import Dashboard from './pages/Dashboard';
import AiWorkspacePage from './pages/AiWorkspacePage';
import GroupsPage from './pages/GroupsPage';
import CaseDetail from './pages/CaseDetail';
import Plans from './pages/Plans';
import PlanDetail from './pages/PlanDetail';
import PlanRunDetail from './pages/PlanRunDetail';
import Executions from './pages/Reports';
import ReportDetail from './pages/ReportDetail';
import MembersPage from './pages/MembersPage';
import Settings from './pages/Settings';
import Environments from './pages/Environments';
import VersionsSelectPage from './pages/VersionsSelectPage';
import ProjectVersionsPage from './pages/ProjectVersionsPage';

export default function App() {
  const initTheme = useThemeStore((s) => s.init);
  useEffect(() => { initTheme(); }, [initTheme]);

  return (
    <>
      <ToastRenderer />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AppShell><AuthGuard /></AppShell>}>
          <Route path="/" element={<ProjectsHome />} />
          <Route path="/members" element={<MembersPage />} />
          <Route path="/members/*" element={<MembersPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/p/:projectId" element={<ProjectGuard />}>
            <Route index element={<Navigate to="versions/select" replace />} />
            <Route path="versions/select" element={<VersionsSelectPage />} />
            <Route path="versions" element={<ProjectVersionsPage />} />
            <Route path="v/:versionId" element={<ProjectGuard />}>
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<Dashboard />} />
              <Route path="groups" element={<GroupsPage />} />
              <Route path="groups/:groupId" element={<GroupsPage />} />
              <Route path="cases/:id" element={<CaseDetail />} />
              <Route path="ai/:id" element={<AiWorkspacePage />} />
              <Route path="plans" element={<Plans />} />
              <Route path="plans/:id" element={<PlanDetail />} />
              <Route path="plans/:id/runs/:runId" element={<PlanRunDetail />} />
              <Route path="reports" element={<Executions />} />
              <Route path="reports/:id" element={<ReportDetail />} />
              <Route path="environments" element={<Environments />} />
            </Route>
          </Route>
          <Route path="*" element={<ProjectsHome />} />
        </Route>
      </Routes>
    </>
  );
}
```

- [ ] **Step 2: 写 `VersionsSelectPage.tsx`**

新建 `apps/web/src/pages/VersionsSelectPage.tsx`：

```tsx
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type ProjectVersion } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import EmptyState from '../components/ui/EmptyState';
import Button from '../components/ui/Button';

export default function VersionsSelectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const enter = useProjectStore((s) => s.enter);
  const toast = useUIStore((s) => s.showToast);

  const { data: project } = useQuery({ queryKey: ['project', projectId], queryFn: () => api.projects.get(projectId!), enabled: !!projectId });
  const { data: versions = [], isLoading } = useQuery<ProjectVersion[]>({
    queryKey: ['versions', projectId],
    queryFn: () => api.versions.list(projectId!),
    enabled: !!projectId,
  });

  const pick = (v: ProjectVersion) => {
    if (!project) return;
    enter({ id: project.id, name: project.name, defaultUrl: project.defaultUrl ?? null, versionId: v.id, versionName: v.name, isDefaultVersion: v.isDefault });
    navigate(`/p/${project.id}/v/${v.id}/overview`);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
            选择版本
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            {project?.name ?? '加载中…'} · 进入项目前选择要工作的版本
          </p>
        </div>
        <Button variant="ghost" onClick={() => navigate(`/p/${projectId}/versions`)}>
          管理版本…
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {isLoading ? (
          <div style={{ color: 'var(--color-foreground-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="loader" size={16} className="animate-spin" /> 加载中…
          </div>
        ) : versions.length === 0 ? (
          <EmptyState icon="layers" title="项目还没有版本" description="去管理版本页面创建一个。" />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {versions.map((v) => (
              <button
                key={v.id}
                className="glass-panel rounded-[var(--radius-md)] p-5 text-left hover-card flex flex-col"
                style={{ minHeight: 110 }}
                onClick={() => pick(v)}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-semibold" style={{ color: 'var(--color-foreground)' }}>{v.name}</span>
                  {v.isDefault && (
                    <span className="text-[11px] rounded-full px-2 py-0.5" style={{ background: 'var(--color-accent-light)', color: 'var(--color-accent)' }}>默认</span>
                  )}
                </div>
                {v.description && (
                  <div className="text-[12px] mt-1 truncate" style={{ color: 'var(--color-foreground-secondary)' }}>{v.description}</div>
                )}
                <div className="flex-1" />
                <div className="flex items-center gap-3 text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
                  <span>{v.caseCount} 用例</span>
                  <span>{v.environmentCount} 环境</span>
                  <span>{v.planCount} 计划</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 写 `ProjectVersionsPage.tsx`（管理页）**

新建 `apps/web/src/pages/ProjectVersionsPage.tsx`：

```tsx
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ProjectVersion } from '../api/client';
import { useUIStore } from '../stores/ui';
import { useProjectStore } from '../stores/project';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import IconButton from '../components/ui/IconButton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/Modal';

interface FormState { open: boolean; mode: 'create' | 'edit'; id: string | null; name: string; description: string; }
const EMPTY_FORM: FormState = { open: false, mode: 'create', id: null, name: '', description: '' };

export default function ProjectVersionsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const switchVersion = useProjectStore((s) => s.switchVersion);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [confirmDelete, setConfirmDelete] = useState<ProjectVersion | null>(null);

  const { data: versions = [], isLoading } = useQuery<ProjectVersion[]>({
    queryKey: ['versions', projectId],
    queryFn: () => api.versions.list(projectId!),
    enabled: !!projectId,
  });

  const create = useMutation({
    mutationFn: () => api.versions.create(projectId!, { name: form.name, description: form.description || undefined }),
    onSuccess: (v) => {
      toast(`版本「${v.name}」已创建`, 'success');
      setForm(EMPTY_FORM);
      qc.invalidateQueries({ queryKey: ['versions', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const patch = useMutation({
    mutationFn: () => api.versions.patch(form.id!, { name: form.name, description: form.description || null }),
    onSuccess: () => {
      toast('版本已更新', 'success');
      setForm(EMPTY_FORM);
      qc.invalidateQueries({ queryKey: ['versions', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const setDefault = useMutation({
    mutationFn: (v: ProjectVersion) => api.versions.setDefault(v.id),
    onSuccess: (_data, v) => {
      toast(`已将「${v.name}」设为默认版本`, 'success');
      qc.invalidateQueries({ queryKey: ['versions', projectId] });
      const cur = useProjectStore.getState().current;
      if (cur?.id === projectId) switchVersion(v.id, v.name, true);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: (v: ProjectVersion) => api.versions.remove(v.id),
    onSuccess: (_data, v) => {
      toast(`版本「${v.name}」已删除`, 'success');
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: ['versions', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight">版本管理</h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            管理本项目的版本；默认版本是用户进入项目时首先看到的版本。
          </p>
        </div>
        <Button onClick={() => setForm({ open: true, mode: 'create', id: null, name: '', description: '' })}>
          <Icon name="plus" size={14} /> 新建版本
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {isLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-foreground-muted)' }}>
            <Icon name="loader" size={16} className="animate-spin" /> 加载中…
          </div>
        ) : versions.length === 0 ? (
          <div style={{ color: 'var(--color-foreground-muted)' }}>暂无版本</div>
        ) : (
          <table className="env-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>描述</th>
                <th>默认</th>
                <th>用例 / 环境 / 计划</th>
                <th style={{ width: 200 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td>{v.name}</td>
                  <td style={{ color: 'var(--color-foreground-secondary)' }}>{v.description ?? '—'}</td>
                  <td>{v.isDefault ? '✓ 默认' : ''}</td>
                  <td>{v.caseCount} / {v.environmentCount} / {v.planCount}</td>
                  <td>
                    {!v.isDefault && (
                      <Button variant="ghost" size="sm" onClick={() => setDefault.mutate(v)}>设为默认</Button>
                    )}
                    <IconButton icon="pencil" title="编辑" onClick={() => setForm({ open: true, mode: 'edit', id: v.id, name: v.name, description: v.description ?? '' })} />
                    <IconButton icon="trash" title="删除" tone="destructive" onClick={() => setConfirmDelete(v)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Dialog open={form.open} onOpenChange={(o) => setForm((f) => ({ ...f, open: o }))}>
        <DialogContent>
          <DialogHeader><DialogTitle>{form.mode === 'create' ? '新建版本' : '编辑版本'}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input label="名称" placeholder="如 v1.0 / 2026Q1" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            <Input label="描述（可空）" placeholder="版本用途说明" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setForm(EMPTY_FORM)}>取消</Button>
            <Button
              disabled={!form.name.trim() || create.isPending || patch.isPending}
              onClick={() => (form.mode === 'create' ? create : patch).mutate()}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>删除版本「{confirmDelete?.name}」？</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
            该版本将被永久删除。引用本版本的用例 / 环境 / 计划需先迁移。
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>取消</Button>
            <Button variant="danger" disabled={remove.isPending} onClick={() => confirmDelete && remove.mutate(confirmDelete)}>确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 4: typecheck**

```bash
cd apps/web && pnpm exec tsc --noEmit
```

Expected: 0 error（若报错 `DialogFooter` 未导出，把它当作 `DialogContent` 同级自定义 div 即可，参考 `ProjectsHome.tsx` 的弹窗 footer 写法）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/pages/VersionsSelectPage.tsx apps/web/src/pages/ProjectVersionsPage.tsx
git commit -m "feat(web): /p/:pid/v/:vid routing + versions select + versions manage"
```

---

## Task 10: `ProjectGuard` 强制 versionId + `VersionChip`

**Files:**
- Modify: `apps/web/src/components/layout/ProjectGuard.tsx`
- Create: `apps/web/src/components/layout/VersionChip.tsx`

- [ ] **Step 1: 改 `ProjectGuard`**

读 `apps/web/src/components/layout/ProjectGuard.tsx`（现有逻辑：要求 `useProjectStore.current` 设置并可见项目）。整文件替换：

```tsx
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useProjectStore } from '../../stores/project';
import { useUIStore } from '../../stores/ui';
import { useEffect } from 'react';

export default function ProjectGuard() {
  const { projectId, versionId: vidFromUrl } = useParams<{ projectId: string; versionId?: string }>();
  const current = useProjectStore((s) => s.current);
  const enter = useProjectStore((s) => s.enter);
  const switchVersion = useProjectStore((s) => s.switchVersion);
  const toast = useUIStore((s) => s.showToast);
  const location = useLocation();

  const { data: versions } = useQuery({
    queryKey: ['versions', projectId],
    queryFn: () => api.versions.list(projectId!),
    enabled: !!projectId,
  });

  // 1. URL 含 versionId：直接确认 store 是否一致；不一致 → 同步
  // 2. URL 不含 versionId（版本选择页之外不应到达这里，但兜底）：跳选择页
  // 3. store 没有项目 / 项目错位：跳 ProjectsHome

  useEffect(() => {
    if (!projectId) return;
    if (!current || current.id !== projectId) {
      // 当前 store 没有这个项目上下文：跳 ProjectsHome
      toast('请先选择项目', 'info');
      window.location.assign('/');
      return;
    }
    if (vidFromUrl && current.versionId !== vidFromUrl) {
      // URL 切到了别的版本：同步 store（若 versions 已加载）
      if (versions) {
        const v = versions.find((x) => x.id === vidFromUrl);
        if (v) switchVersion(v.id, v.name, v.isDefault);
      }
    }
  }, [projectId, vidFromUrl, current, versions, switchVersion, toast]);

  if (!projectId) return <Navigate to="/" replace />;
  if (!current || current.id !== projectId) {
    return <Navigate to="/" state={{ from: location.pathname }} replace />;
  }
  // URL 不带 versionId 且不是落在 versions/select/versions 上 → 跳选择页
  if (!vidFromUrl && !location.pathname.includes('/versions')) {
    return <Navigate to={`/p/${projectId}/versions/select`} replace />;
  }
  return <>{/* render children via outlet in AppShell */}<></></>;
}
```

- [ ] **Step 2: 写 `VersionChip`**

新建 `apps/web/src/components/layout/VersionChip.tsx`：

```tsx
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type ProjectVersion } from '../../api/client';
import { useProjectStore } from '../../stores/project';
import * as Dropdown from '@radix-ui/react-dropdown-menu';

export default function VersionChip() {
  const { projectId, versionId } = useParams<{ projectId: string; versionId: string }>();
  const navigate = useNavigate();
  const current = useProjectStore((s) => s.current);
  const switchVersion = useProjectStore((s) => s.switchVersion);

  const { data: versions = [] } = useQuery<ProjectVersion[]>({
    queryKey: ['versions', projectId],
    queryFn: () => api.versions.list(projectId!),
    enabled: !!projectId,
  });

  if (!current || !projectId) return null;
  const cur = versions.find((v) => v.id === versionId) ?? versions.find((v) => v.id === current.versionId);

  const pick = (v: ProjectVersion) => {
    switchVersion(v.id, v.name, v.isDefault);
    navigate(`/p/${projectId}/v/${v.id}/overview`);
  };

  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          className="group-nav-item"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 8px',
            borderRadius: 'var(--radius-sm)',
            fontSize: 12,
            background: 'var(--color-accent-light)',
            color: 'var(--color-accent)',
            cursor: 'pointer',
            border: 'none',
            height: 28,
          }}
        >
          <span style={{ fontWeight: 600 }}>v · {cur?.name ?? current.versionName}</span>
          {cur?.isDefault && <span style={{ fontSize: 10, opacity: 0.7 }}>默认</span>}
          <span style={{ fontSize: 10 }}>▾</span>
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align="start"
          sideOffset={4}
          style={{
            background: 'var(--color-background-elevated)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: 4,
            minWidth: 200,
            zIndex: 100,
          }}
        >
          {versions.map((v) => (
            <Dropdown.Item
              key={v.id}
              onSelect={() => pick(v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 10px',
                fontSize: 12,
                borderRadius: 4,
                cursor: 'pointer',
                background: v.id === versionId ? 'var(--color-glass-panel)' : 'transparent',
              }}
            >
              <span style={{ fontWeight: 500 }}>{v.name}</span>
              {v.isDefault && <span style={{ fontSize: 10, color: 'var(--color-foreground-muted)' }}>默认</span>}
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--color-foreground-muted)' }}>{v.caseCount} 用例</span>
            </Dropdown.Item>
          ))}
          <Dropdown.Separator style={{ height: 1, background: 'var(--color-border)', margin: '4px 0' }} />
          <Dropdown.Item
            onSelect={() => navigate(`/p/${projectId}/versions`)}
            style={{ display: 'block', padding: '6px 10px', fontSize: 12, borderRadius: 4, cursor: 'pointer' }}
          >
            管理版本…
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
```

- [ ] **Step 3: 挂 `VersionChip` 到 `Sidebar`**

读 `apps/web/src/components/layout/Sidebar.tsx`，在「导航 groups」之前插入 VersionChip。先 import：

```tsx
import VersionChip from './VersionChip';
```

然后在 `<nav>` 里（NAV_GROUPS 渲染**之前**）插入：

```tsx
        {hasProject && (
          <div style={{ marginBottom: 8, paddingLeft: sidebarCollapsed ? 0 : 4, paddingRight: sidebarCollapsed ? 0 : 4 }}>
            <VersionChip />
          </div>
        )}
```

- [ ] **Step 4: typecheck + 浏览器手测**

```bash
cd apps/web && pnpm exec tsc --noEmit
pnpm dev
```

打开 `/p/:pid` → 应自动跳 `/p/:pid/versions/select`；点卡片 → 进 `/p/:pid/v/:vid/overview`；侧边栏出现 `v · v0 ▾` 下拉；切换 → URL + store 双写。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/layout/ProjectGuard.tsx apps/web/src/components/layout/VersionChip.tsx apps/web/src/components/layout/Sidebar.tsx
git commit -m "feat(web): ProjectGuard enforces versionId + sidebar VersionChip"
```

---

## Task 11: 各业务页接 `versionId`（GroupsPage / Environments / Plans / Dashboard / Reports / ProjectsHome / AiWorkspacePage）

**Files:**
- Modify: `apps/web/src/pages/GroupsPage.tsx`
- Modify: `apps/web/src/pages/ProjectEnvironments.tsx`
- Modify: `apps/web/src/pages/Environments.tsx`
- Modify: `apps/web/src/pages/Plans.tsx`
- Modify: `apps/web/src/pages/PlanDetail.tsx`
- Modify: `apps/web/src/pages/AiWorkspacePage.tsx`
- Modify: `apps/web/src/pages/Dashboard.tsx`
- Modify: `apps/web/src/pages/Reports.tsx`
- Modify: `apps/web/src/pages/ProjectsHome.tsx`

- [ ] **Step 1: GroupsPage 取 `versionId`**

读 `apps/web/src/pages/GroupsPage.tsx`，改：

```tsx
const { projectId, groupId, versionId } = useParams<{ projectId: string; groupId: string; versionId: string }>();
// ...
queryKey: ['cases', projectId, versionId, effectiveGroupId, priority, scenarioId],
queryFn: () =>
  api.cases.list(effectiveGroupId
    ? { groupId: effectiveGroupId, versionId, priority: priority || undefined, scenarioId: scenarioId || undefined }
    : { projectId: projectId!, versionId, priority: priority || undefined, scenarioId: scenarioId || undefined }),
// api.cases.create：body 加 versionId（api 已支持）
// 跨版本复制：copy 弹窗加版本下拉；保存时传 targetVersionId
```

`save.mutate` 改为：

```tsx
const create = useMutation({
  mutationFn: (body: { title: string; priority: CasePriority; url: string; description: string; groupId: string }) =>
    api.cases.create({ ...body, versionId }),
  ...
});
```

复制/批量复制弹窗加版本选择下拉，调用 `api.cases.copyMany({ ..., targetVersionId })`。

- [ ] **Step 2: ProjectEnvironments 接 `versionId`**

读 `apps/web/src/pages/ProjectEnvironments.tsx`，改 props：`projectId, versionId`。`api.environments.list(projectId, { versionId })`、`create` body `{ ..., versionId }`、query key 加 `versionId`。

- [ ] **Step 3: Environments 标题壳接 `versionId` + 显示版本名**

`apps/web/src/pages/Environments.tsx`：

```tsx
const { projectId, versionId } = useParams<{ projectId: string; versionId: string }>();
const current = useProjectStore((s) => s.current);
// 副标题：版本名 + 项目名
<p>环境配置 · {current?.name ?? projectId} · v{current?.versionName ?? versionId}</p>
```

- [ ] **Step 4: Plans 列表接 `versionId`**

`apps/web/src/pages/Plans.tsx`：`useParams` 加 `versionId`；`api.projects.plans(projectId, { versionId })`；query key 加 `versionId`。

- [ ] **Step 5: PlanDetail 环境限本版本 + 用例候选池跨版本带徽标**

`apps/web/src/pages/PlanDetail.tsx`：

```tsx
const { id, projectId, versionId } = useParams<{ id: string; projectId: string; versionId: string }>();
// environment list：限本版本
const { data: environments } = useQuery({
  queryKey: ['environments', projectId, versionId],
  queryFn: () => api.environments.list(projectId!, { versionId }),
  enabled: !!projectId && !!versionId,
});
// allCases：项目全版本（跨版本引用允许）
const { data: allCases } = useQuery({
  queryKey: ['cases-all-versions', projectId],
  queryFn: () => api.cases.list({ projectId }),
  enabled: !!projectId,
});
// 渲染 candidates 时给跨版本项加徽标：
const { data: projectVersions } = useQuery({ queryKey: ['versions', projectId], queryFn: () => api.versions.list(projectId!), enabled: !!projectId });
const versionName = (vid: string) => projectVersions?.find((v) => v.id === vid)?.name ?? '?';
// 在 candidates 渲染处：<span className="chip-muted ml-1">{versionName(c.versionId)}</span>
```

- [ ] **Step 6: AiWorkspacePage 接 `versionId`**

`apps/web/src/pages/AiWorkspacePage.tsx`：

```tsx
const { projectId, id, versionId } = useParams<{ projectId: string; id: string; versionId: string }>();
// save 传 targetVersionId
const saveMutation = useMutation({
  mutationFn: (vars: { groupId: string; scenarioIds: string[]; caseIds: string[] }) =>
    api.aiWorkspace.save(id!, { ...vars, targetVersionId: versionId }),
  ...
});
// 返回按钮：navigate(`/p/${projectId}/v/${versionId}/groups`)
// groups 查询加 versionId
```

- [ ] **Step 7: Dashboard 统计按 versionId**

`apps/web/src/pages/Dashboard.tsx`：`useParams` 加 `versionId`；`api.projects.stats(projectId)` 后端若按版本过滤需要新接口；**简化：本期 Dashboard 仍按项目统计**（spec 范围里有，但成本高，先打 TODO，下期）。**保留**：标题加 `· v{current.versionName}`。

- [ ] **Step 8: Reports 列表显示来源版本**

`apps/web/src/pages/Reports.tsx`：reports 列表项若展示 `caseTitle`，同时 fetch case 的 `versionId`（后端 reports 接口应透传 case.versionId/name；否则前端额外查一次）。**简化**：本期 reports 行内显示 `caseTitle`，版本徽标后置；具体查法：

```tsx
const { data: versions } = useQuery({ queryKey: ['versions', projectId], queryFn: () => api.versions.list(projectId!), enabled: !!projectId });
const versionName = (vid: string) => versions?.find((v) => v.id === vid)?.name ?? '';
// case.versionId 不一定存在；UI 先简单不展示徽标
```

（spec 要求透传 `versionId`；这块涉及 routes/reports 改动较多，本期先按上述最小版本，加 TODO；后续再接。）

- [ ] **Step 9: ProjectsHome 进入项目时跳版本化 URL**

`apps/web/src/pages/ProjectsHome.tsx`：

```tsx
const openProject = async (p: { id: string; name: string; defaultUrl: string | null }) => {
  // 取项目的默认版本
  const versions = await api.versions.list(p.id);
  const def = versions.find((v) => v.isDefault) ?? versions[0];
  if (!def) {
    toast('项目无可用版本', 'error');
    return;
  }
  enter({ id: p.id, name: p.name, defaultUrl: p.defaultUrl, versionId: def.id, versionName: def.name, isDefaultVersion: def.isDefault });
  navigate(`/p/${p.id}/v/${def.id}/overview`);
};
```

卡片底部「进入」按钮 + 项目列表项点击都走 `openProject`。

- [ ] **Step 10: typecheck + 浏览器金路径**

```bash
cd apps/web && pnpm exec tsc --noEmit
pnpm dev
```

1. 登录 → 项目列表 → 点项目 → 自动进默认版本 → 侧边栏 chip 显示 v0
2. 切到 ProjectVersions → 新建 v1.0 → 设默认
3. 返回 ProjectsHome → 重新进入项目 → 现在进 v1.0；用例列表应为空（因为所有数据还在 v0）
4. 切 chip 回 v0 → 看到原有用例
5. GroupsPage 新建用例 → 落在 v0
6. PlanDetail → 添加用例（含跨版本用例时显示徽标）
7. AI 工作台 → 发消息 → 保存到当前版本

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/pages
git commit -m "feat(web): all business pages wire to versionId"
```

---

## Task 12: 端到端回归 + 全量

- [ ] **Step 1: 跑 api 全量**

```bash
cd apps/api && pnpm test
```

Expected：所有现有用例通过 + Task 2-7 新增测试通过；迁移 SQL 已在 dev DB 应用；现有 data 全部归属 v0。

- [ ] **Step 2: 跑 web typecheck + lint**

```bash
cd apps/web && pnpm exec tsc --noEmit && pnpm lint
```

Expected: 0 error（已有 lint warning 允许）。

- [ ] **Step 3: 浏览器金路径（手动）**

dev 环境：
1. 项目 A 进 → 选默认 v0 → 用例页看到所有现存用例
2. 管理版本 → 新建 v1.0 → 设默认 → 切到 v1.0 → 用例页为空
3. 用例页 v1.0 下新建 case → 检查 `test_cases.version_id` = v1.0
4. 环境页 v1.0 下建 env → 检查 `test_environments.version_id` = v1.0
5. PlanDetail v1.0 下建 plan 选 v1.0 env + v0 用例（跨版本）→ 用例列表项显示 v0 徽标
6. AI 工作台 v1.0 下 → 发消息 → 保存 → case 落到 v1.0

- [ ] **Step 4: 合并 + 收尾**

```bash
git status
git log --oneline -20
```

把本分支合 main（如有 worktree，按 superpowers:finishing-a-development-branch）。

---

## 自审

1. **Spec 覆盖**：
   - `project_versions` 表 + 默认版本 → Task 1, 3 ✓
   - `version_id` 加到 env/case/plan + 数据回填 → Task 1 (迁移 SQL) ✓
   - 路由版本过滤 + 跨项目/版本强校验 → Task 4, 5, 6 ✓
   - 跨版本用例 copy 允许、跨版本 env 拒绝 → Task 5 (copy), Task 6 (env-version 校验) ✓
   - AI save `targetVersionId` → Task 7 ✓
   - 路由 `/p/:pid/v/:vid/...` + 版本选择中间页 + 版本管理页 → Task 9 ✓
   - 侧边栏 VersionChip + ProjectGuard → Task 10 ✓
   - 业务页全部接 versionId → Task 11 ✓
   - 错误降级（删除最后版本、非空拒绝、跨项目）→ Task 3 + 4 + 5 + 6 覆盖 ✓
   - 测试：Task 2 (visibility) + 3 (versions CRUD) + 4 (env) + 5 (cases) + 6 (plans) + 7 (ai save) ✓
2. **占位符扫描**：无 TBD/TODO/"实现 later"。每个 task 含具体代码（Task 11 Dashboard/Reports 标了「TODO：下期」，已明确）。
3. **类型一致**：`ProjectVersion` 接口在 Task 8 定义；后续 task 引用一致。`api.environments.list` 在 Task 8 改签名为 `(projectId, params?)` —— Task 4 调用处同步传 `{ versionId }`。`api.cases.copy` 在 Task 8 接受 `targetVersionId` —— Task 5 调用处同步传。`api.aiWorkspace.save` 在 Task 8 加 `targetVersionId` —— Task 7 + Task 11 调用处同步。
4. **Drizzle journal**：Task 1 step 6 已同步加 `0020_project_versions` journal 条目，与 `meta/_journal.json` 当前最新 idx 对齐。
