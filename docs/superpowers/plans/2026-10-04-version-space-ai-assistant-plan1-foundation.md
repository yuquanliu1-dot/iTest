# 版本空间 AI 助手 — Plan 1:后端地基(版本级线程体系)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立版本空间 AI 助手的后端地基:`ai_threads` 双类型扩展(迁移 0027)、人审挂起机制(confirm gate)、按版本 ref 的 repo 沙箱、版本空间上下文摘要、版本级线程 supervisor 与 `/api/assistant/*` HTTP+SSE 契约。

**Architecture:** 与现有 requirement 级 pi 体系(`src/pi/session.ts`+`router.ts`)**并列**新建 `src/pi/space/`。会话机制、SSE 事件形状、react-pi 契约完全复刻现有实现,仅把绑定实体从 requirementId 换成 versionId(一线程一 session、一版本多线程)。平台工具(manage_cases 等)属 Plan 2,本计划只留 `buildSpaceTools` 接缝(注入 repo 沙箱工具)。

**Tech Stack:** Express 5、Drizzle ORM + PostgreSQL、@earendil-works/pi-coding-agent(`createAgentSession` + `defineTool`)、SSE(`sse/agentRunStream.ts` 工具)、vitest + testcontainers + supertest。

**Spec:** `docs/superpowers/specs/2026-10-04-version-space-ai-assistant-design.md`(本计划覆盖其 §3 后端、§5 confirm gate、§7 迁移;§4 工具面属 Plan 2,§6 前端属 Plan 3)

---

## 基线假设与约定

- 工作区可能有其他未提交改动。**每个任务的 commit 步骤只 `git add` 本任务列出的文件**,绝不 `git add -A`。
- 测试依赖 Docker(testcontainers 起 postgres:16-alpine)。
- 测试引导范式(照抄 `test/cases.test.ts` / `test/pi-router.test.ts`):testcontainer → `DATABASE_URL` 指向容器 → `pool.query(SCHEMA_SQL)` → **动态** `import` 被测模块 → 注入 `managerUserOf` 身份中间件。
- 运行单测文件:`pnpm -C apps/api test test/<file>`;类型检查:`pnpm -C apps/api typecheck`。
- 与 spec 的一处偏差:spec §7 写的是部分唯一索引 `WHERE kind='requirement'`;实现改为**普通唯一索引** `UNIQUE(requirement_id)` — Postgres 唯一索引对 NULL 不去重,version 线程(requirement_id=NULL)天然可多条,效果等同且避免 drizzle partial-index API 风险。

## 文件结构

```
apps/api/
  drizzle/0027_ai_threads_version_threads.sql      [新建] 迁移
  src/db/schema.ts                                  [修改] aiThreads 加 kind/version_id/title
  test/helpers/db.ts                                [修改] SCHEMA_SQL 同步(建表挪到 project_versions 之后)
  src/pi/repo.ts                                    [修改] +checkoutRepoForVersion;fetchAndReset 支持 tag
  src/pi/session.ts                                 [修改] 仅 export synthesizeModel/ENV_BY_PROVIDER 供复用
  src/pi/space/confirm.ts                           [新建] 人审挂起注册表
  src/pi/space/summary.ts                           [新建] 版本空间上下文摘要
  src/pi/space/tools.ts                             [新建] 工具接缝(Plan 1 仅 repo 工具)
  src/pi/space/session.ts                           [新建] 版本级线程 supervisor
  src/pi/space/router.ts                            [新建] /api/assistant 契约
  src/index.ts                                      [修改] 挂载
  test/space-confirm.test.ts                        [新建]
  test/space-repo-version.test.ts                   [新建]
  test/space-summary.test.ts                        [新建]
  test/space-session.test.ts                        [新建]
  test/space-router.test.ts                         [新建]
```

---

### Task 1: 迁移 0027 + schema + 测试 SCHEMA_SQL

**Files:**
- Create: `apps/api/drizzle/0027_ai_threads_version_threads.sql`
- Modify: `apps/api/src/db/schema.ts`(aiThreads 定义,约 65-71 行)
- Modify: `apps/api/test/helpers/db.ts`(SCHEMA_SQL,ai_threads 在第 41 行,project_versions 在第 61 行)

- [ ] **Step 1: 写迁移 SQL**

创建 `apps/api/drizzle/0027_ai_threads_version_threads.sql`:

```sql
-- 0027: ai_threads 双类型线程。存量行 kind='requirement' 语义不变(一需求一线程);
-- 新增 version 级空间助手线程(一版本多线程,可空 requirement_id,带标题)。
ALTER TABLE ai_threads ADD COLUMN kind varchar(20) NOT NULL DEFAULT 'requirement';
ALTER TABLE ai_threads ADD COLUMN version_id uuid REFERENCES project_versions(id) ON DELETE CASCADE;
ALTER TABLE ai_threads ADD COLUMN title text;
ALTER TABLE ai_threads ALTER COLUMN requirement_id DROP NOT NULL;
ALTER TABLE ai_threads DROP CONSTRAINT ai_threads_requirement_id_key;
CREATE UNIQUE INDEX ai_threads_requirement_uq ON ai_threads(requirement_id);
CREATE INDEX ai_threads_version_idx ON ai_threads(version_id);
```

注意:约束名 `ai_threads_requirement_id_key` 是 Postgres 对列级 `UNIQUE` 的默认命名,迁移与测试 SCHEMA_SQL 两侧一致。

- [ ] **Step 2: 更新 `src/db/schema.ts` 的 aiThreads**

将(约 65-71 行):

```ts
export const aiThreads = pgTable('ai_threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  requirementId: uuid('requirement_id').notNull().unique().references(() => requirements.id, { onDelete: 'cascade' }),
  piThreadId: text('pi_thread_id').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

替换为:

```ts
export const aiThreads = pgTable('ai_threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 'requirement'(存量需求级生成会话)| 'version'(版本空间助手线程)。 */
  kind: varchar('kind', { length: 20 }).notNull().default('requirement'),
  // requirement 线程 1:1 需求;version 线程此列为 NULL(Postgres 唯一索引不约束 NULL,多条 version 线程合法)
  requirementId: uuid('requirement_id').references(() => requirements.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').references(() => projectVersions.id, { onDelete: 'cascade' }),
  title: text('title'),
  piThreadId: text('pi_thread_id').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  requirementUq: uniqueIndex('ai_threads_requirement_uq').on(t.requirementId),
  versionIdx: index('ai_threads_version_idx').on(t.versionId),
}));
```

确认文件顶部 import:pg-core 的 import 里需有 `uniqueIndex` 和 `index`(若缺则补)。`projectVersions` 在文件后部定义,箭头函数惰性求值,无需挪动定义顺序。

- [ ] **Step 3: 同步 `test/helpers/db.ts` 的 SCHEMA_SQL**

删除原第 41 行:

```sql
CREATE TABLE ai_threads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requirement_id uuid REFERENCES requirements(id) ON DELETE CASCADE NOT NULL UNIQUE, pi_thread_id text NOT NULL, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
```

在 `CREATE INDEX project_versions_project_idx ...`(原第 62 行)之后追加(FK 引用的 project_versions 已存在):

```sql
CREATE TABLE ai_threads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind varchar(20) NOT NULL DEFAULT 'requirement', requirement_id uuid REFERENCES requirements(id) ON DELETE CASCADE, version_id uuid REFERENCES project_versions(id) ON DELETE CASCADE, title text, pi_thread_id text NOT NULL, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE UNIQUE INDEX ai_threads_requirement_uq ON ai_threads(requirement_id);
CREATE INDEX ai_threads_version_idx ON ai_threads(version_id);
```

- [ ] **Step 4: 验证 — 全量测试回归(现有测试覆盖老线程读写)**

Run: `pnpm -C apps/api test`
Expected: 全部 PASS(无 ai_threads 相关失败;`pi-router.test.ts`、`ai-threads.test.ts` 是重点观察对象)

Run: `pnpm -C apps/api typecheck`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add apps/api/drizzle/0027_ai_threads_version_threads.sql apps/api/src/db/schema.ts apps/api/test/helpers/db.ts
git commit -m "feat(api): ai_threads 双类型扩展,支持版本级助手线程(0027)"
```

---

### Task 2: 人审挂起注册表(pi/space/confirm.ts)

**Files:**
- Create: `apps/api/src/pi/space/confirm.ts`
- Test: `apps/api/test/space-confirm.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/space-confirm.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { requestConfirmation, resolveConfirmation, pendingCountForTesting } from '../src/pi/space/confirm.js';

describe('confirm gate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('用户确认 → promise resolve(true),pending 清空', async () => {
    const events: Record<string, unknown>[] = [];
    const p = requestConfirmation(
      { threadId: 't1', toolName: 'manage_cases', action: 'delete', summary: '删除用例「登录-正常」', risk: 'delete' },
      (e) => events.push(e),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'confirm_request', threadId: 't1', summary: '删除用例「登录-正常」', risk: 'delete' });
    const confirmId = events[0]!.confirmId as string;
    expect(confirmId).toBeTruthy();
    resolveConfirmation(confirmId, true);
    await expect(p).resolves.toBe(true);
    expect(pendingCountForTesting()).toBe(0);
  });

  it('用户取消 → resolve(false)', async () => {
    const events: Record<string, unknown>[] = [];
    const p = requestConfirmation(
      { threadId: 't1', toolName: 'manage_environments', action: 'set_secret', summary: '设置 db 密码(值已隐藏)', risk: 'secret' },
      (e) => events.push(e),
    );
    resolveConfirmation(events[0]!.confirmId as string, false);
    await expect(p).resolves.toBe(false);
  });

  it('5 分钟超时 → 自动 resolve(false)', async () => {
    const p = requestConfirmation(
      { threadId: 't1', toolName: 'manage_cases', action: 'delete', summary: 'x', risk: 'delete' },
      () => {},
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await expect(p).resolves.toBe(false);
    expect(pendingCountForTesting()).toBe(0);
  });

  it('未知 confirmId → resolveConfirmation 返回 false', () => {
    expect(resolveConfirmation('nonexistent', true)).toBe(false);
  });

  it('并发挂起互不串扰', async () => {
    const events: Record<string, unknown>[] = [];
    const pa = requestConfirmation({ threadId: 't1', toolName: 'a', action: 'delete', summary: 'a', risk: 'delete' }, () => {});
    const pb = requestConfirmation({ threadId: 't1', toolName: 'b', action: 'delete', summary: 'b', risk: 'delete' }, () => {});
    const pc = requestConfirmation({ threadId: 't2', toolName: 'c', action: 'update', summary: 'c', risk: 'update' }, (e) => events.push(e));
    expect(pendingCountForTesting()).toBe(3);
    resolveConfirmation(events[0]!.confirmId as string, true);
    await expect(pc).resolves.toBe(true);
    expect(pendingCountForTesting()).toBe(2);
    // 其余两个用取消收尾,验证 id 各自独立(不误触发 pc 已验证)
    expect(resolveConfirmation('bogus', true)).toBe(false);
    void pa; void pb;
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C apps/api test test/space-confirm.test.ts`
Expected: FAIL — `Cannot find module '../src/pi/space/confirm.js'`

- [ ] **Step 3: 实现 confirm.ts**

创建 `apps/api/src/pi/space/confirm.ts`:

```ts
/**
 * 人审挂起注册表(confirm gate)。
 * 敏感工具 action 在执行前调 requestConfirmation:向线程 SSE 订阅者广播 confirm_request,
 * 然后 await 用户在确认卡上的决定(POST /api/assistant/threads/:id/confirm)。
 * 对 LLM 就是一次"较慢的正常工具调用",不改动 pi 会话协议。
 * 挂起态仅存内存(上限 CONFIRM_TIMEOUT_MS):API 重启丢一个挂起轮次 = 该轮报错、用户重说,不建表。
 */
import { randomUUID } from 'node:crypto';

export type ConfirmRisk = 'update' | 'delete' | 'secret';

export interface ConfirmRequestInput {
  threadId: string;
  toolName: string;
  action: string;
  /** 确认卡主文案,如「删除用例「登录-正常」」;密钥类不得含明文值。 */
  summary: string;
  /** 人类可读 diff 文本(update 类);缺省无。 */
  diff?: string;
  risk: ConfirmRisk;
}

type Resolver = (approved: boolean) => void;

interface PendingEntry {
  resolve: Resolver;
  timer: NodeJS.Timeout;
}

export const CONFIRM_TIMEOUT_MS = 5 * 60_000;

const pending = new Map<string, PendingEntry>();

/**
 * 发起一次确认并挂起。emit 负责把 confirm_request 事件扇出到线程 SSE
 * (session.ts 的 emitThreadEvent);事件体自动带 confirmId。
 * 超时/取消一律 resolve(false),调用方把它当 { ok:false, error:'用户取消了该操作' } 返回给 LLM。
 */
export function requestConfirmation(req: ConfirmRequestInput, emit: (e: Record<string, unknown>) => void): Promise<boolean> {
  const confirmId = randomUUID();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(confirmId);
      resolve(false);
    }, CONFIRM_TIMEOUT_MS);
    pending.set(confirmId, {
      resolve: (approved) => {
        clearTimeout(timer);
        resolve(approved);
      },
      timer,
    });
    emit({ type: 'confirm_request', confirmId, ...req });
  });
}

/** 落确认结果;confirmId 不存在(已超时/已处理/伪造)返回 false。 */
export function resolveConfirmation(confirmId: string, approved: boolean): boolean {
  const entry = pending.get(confirmId);
  if (!entry) return false;
  pending.delete(confirmId);
  entry.resolve(approved);
  return true;
}

export function pendingCountForTesting(): number {
  return pending.size;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C apps/api test test/space-confirm.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/space/confirm.ts apps/api/test/space-confirm.test.ts
git commit -m "feat(api): 版本助手人审挂起注册表(confirm gate)"
```

---

### Task 3: 版本级 repo 沙箱(checkoutRepoForVersion)

**Files:**
- Modify: `apps/api/src/pi/repo.ts`
- Test: `apps/api/test/space-repo-version.test.ts`

背景:`checkoutRepo(requirementId)`(repo.ts:316)按项目 `defaultBranch` clone/fetch。版本级会话需要按 `project_versions.ref`(branch/tag)checkout,沙箱目录独立于需求级(`v-<versionId>`)。tag 与 branch 的通用做法:`fetch --depth 1 origin <ref>` + `reset --hard FETCH_HEAD`。

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/space-repo-version.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

const GIT = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.PI_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-space-repo-'));
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function makeFixtureRepo(): Promise<string> {
  const bareParent = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-remote-'));
  const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-seed-'));
  GIT('git init -b main .', seed);
  await fs.writeFile(path.join(seed, 'app.txt'), 'main-content');
  GIT("git add -A && git -c user.email=t@t -c user.name=t commit -m main", seed);
  GIT('git checkout -b feature', seed);
  await fs.writeFile(path.join(seed, 'app.txt'), 'feature-content');
  GIT("git add -A && git -c user.email=t@t -c user.name=t commit -m feature", seed);
  GIT(`git clone --bare . ${bareParent}/repo.git`, seed);
  return `${bareParent}/repo.git`;
}

describe('checkoutRepoForVersion', () => {
  it('version.ref 优先于项目默认分支;meta 记录实际 ref', async () => {
    const repoUrl = await makeFixtureRepo();
    const { orgId } = await seedOrg(pool);
    const projectId = (await pool.query(
      `INSERT INTO projects(organization_id, name, repo_url, provider, default_branch) VALUES ($1,'p',$2,'github','main') RETURNING id`,
      [orgId, `file://${repoUrl}`],
    )).rows[0]!.id as string;
    const versionId = (await pool.query(
      `INSERT INTO project_versions(project_id, name, ref, ref_kind) VALUES ($1,'v1','feature','branch') RETURNING id`,
      [projectId],
    )).rows[0]!.id as string;

    const { checkoutRepoForVersion } = await import('../src/pi/repo.js');
    const cwd = await checkoutRepoForVersion(versionId);
    expect(await fs.readFile(path.join(cwd, 'app.txt'), 'utf8')).toBe('feature-content');
    const meta = JSON.parse(await fs.readFile(path.join(cwd, '.itest-sandbox.json'), 'utf8')) as { branch: string };
    expect(meta.branch).toBe('feature');

    // 二次 checkout 走 fetch+reset 分支,结果幂等
    const cwd2 = await checkoutRepoForVersion(versionId);
    expect(cwd2).toBe(cwd);
  });

  it('version.ref 为空 → 回落项目默认分支;项目无 repoUrl → no_repo', async () => {
    const repoUrl = await makeFixtureRepo();
    const { orgId } = await seedOrg(pool);
    const p1 = (await pool.query(
      `INSERT INTO projects(organization_id, name, repo_url, provider, default_branch) VALUES ($1,'p1',$2,'github','main') RETURNING id`,
      [orgId, `file://${repoUrl}`],
    )).rows[0]!.id as string;
    const v1 = (await pool.query(
      `INSERT INTO project_versions(project_id, name) VALUES ($1,'v-default') RETURNING id`,
      [p1],
    )).rows[0]!.id as string;
    const p2 = (await pool.query(
      `INSERT INTO projects(organization_id, name) VALUES ($1,'p2') RETURNING id`,
      [orgId],
    )).rows[0]!.id as string;
    const v2 = (await pool.query(
      `INSERT INTO project_versions(project_id, name) VALUES ($1,'v-norepo') RETURNING id`,
      [p2],
    )).rows[0]!.id as string;

    const { checkoutRepoForVersion, RepoUnavailableError } = await import('../src/pi/repo.js');
    const cwd = await checkoutRepoForVersion(v1);
    expect(await fs.readFile(path.join(cwd, 'app.txt'), 'utf8')).toBe('main-content');
    await expect(checkoutRepoForVersion(v2)).rejects.toBeInstanceOf(RepoUnavailableError);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C apps/api test test/space-repo-version.test.ts`
Expected: FAIL — `checkoutRepoForVersion` 未导出

- [ ] **Step 3: 实现**

`apps/api/src/pi/repo.ts` 三处修改:

3a. 顶部 schema import 加入 `projectVersions`(第 9 行):

```ts
import { projects, projectVersions, requirements } from '../db/schema.js';
```

3b. `fetchAndReset`(repo.ts:287)改为接受 ref 参数,reset 用 FETCH_HEAD(兼容 tag):

```ts
async function fetchAndReset(target: string, info: ProjectRepo, ref: string): Promise<string> {
  // 1. dirty 检查:tracked 修改 / untracked 文件 → stash
  const status = await runGitIn(target, ['status', '--porcelain']).catch(() => '');
  let stashRef: string | null = null;
  if (status.trim().length > 0) {
    const stashOut = await runGitIn(target, ['stash', 'push', '--include-untracked', '-m', `itest-auto-${Date.now()}`]);
    stashRef = stashOut.match(/refs\/stash\{\d+\}/)?.[0] ?? stashOut.trim();
  }
  // 2. fetch + reset(FETCH_HEAD 对 branch/tag 通用)
  try {
    await runGitIn(target, ['fetch', '--depth', '1', 'origin', ref]);
    await runGitIn(target, ['reset', '--hard', 'FETCH_HEAD']);
  } catch (e) {
    const msg = (e as Error).message;
    throw new RepoUnavailableError(/401|403/i.test(msg) ? 'auth_failed' : 'fetch_failed', msg);
  }
  // 3. 写 meta
  const commit = (await runGitIn(target, ['rev-parse', 'HEAD'])).trim();
  await fs.writeFile(path.join(target, '.itest-sandbox.json'), JSON.stringify({
    provider: info.provider,
    branch: ref,
    commit,
    fetchedAt: new Date().toISOString(),
    ...(stashRef ? { stashRef } : {}),
  }, null, 2));
  return target;
}
```

3c. `checkoutRepo`(repo.ts:316)内两处调用改为传 `info.branch`,并新增版本级函数。在文件末尾(`checkoutRepo` 函数之后)追加:

```ts
async function loadVersionRepo(versionId: string): Promise<ProjectRepo | null> {
  const row = (await db
    .select({
      repoUrl: projects.repoUrl,
      branch: projects.defaultBranch,
      provider: projects.provider,
      pat: projects.patOverride,
      gitlabOverride: projects.gitlabUrlOverride,
      versionRef: projectVersions.ref,
    })
    .from(projectVersions)
    .innerJoin(projects, eq(projectVersions.projectId, projects.id))
    .where(eq(projectVersions.id, versionId))
    .limit(1))[0];
  if (!row || !row.repoUrl) return null;
  return { repoUrl: row.repoUrl, branch: row.versionRef ?? row.branch, provider: row.provider, pat: row.pat, gitlabOverride: row.gitlabOverride };
}

/** 版本级 checkout:沙箱目录 v-<versionId> 与需求级隔离;ref 取 version.ref,缺省回落项目默认分支。tag 亦可用(fetch FETCH_HEAD)。 */
export async function checkoutRepoForVersion(versionId: string): Promise<string> {
  const info = await loadVersionRepo(versionId);
  if (!info) throw new RepoUnavailableError('no_repo', 'project has no repoUrl configured');

  await fs.mkdir(REPOS_ROOT, { recursive: true });
  const target = path.join(REPOS_ROOT, `v-${versionId}`);

  if (await dirExists(target)) {
    try {
      const release = await lockfile.lock(target, { retries: 0, stale: 30_000 });
      try { return await fetchAndReset(target, info, info.branch); } finally { await release(); }
    } catch (e) {
      if ((e as { code?: string }).code === 'ELOCKED') throw new LockTimeoutError('another fetch in progress');
      throw e;
    }
  }
  await fs.mkdir(target, { recursive: true });
  const release = await lockfile.lock(target, { retries: 0, stale: 30_000 }).catch(() => null);
  try {
    await cloneFirst(target, info);
    return await fetchAndReset(target, info, info.branch);
  } finally { if (release) await release(); }
}
```

同时把 `checkoutRepo` 内两处 `fetchAndReset(target, info)` 改为 `fetchAndReset(target, info, info.branch)`(约 327 与 337 行)。

- [ ] **Step 4: 运行测试**

Run: `pnpm -C apps/api test test/space-repo-version.test.ts test/repo-sandbox.test.ts test/repo.test.ts`
Expected: 全部 PASS(新版测试 + 存量 repo 回归)

Run: `pnpm -C apps/api typecheck`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/repo.ts apps/api/test/space-repo-version.test.ts
git commit -m "feat(api): 版本级 repo 沙箱,按 version.ref checkout(fetch FETCH_HEAD 兼容 tag)"
```

---

### Task 4: 版本空间上下文摘要(pi/space/summary.ts)

**Files:**
- Create: `apps/api/src/pi/space/summary.ts`
- Test: `apps/api/test/space-summary.test.ts`

摘要注入方式:发到线程的**首条用户消息**前缀(与 requirement 流把需求文本放进用户消息同思路),避免依赖 pi 内部 system-prompt 注入点。密钥永不出现在摘要里(环境对象只计数量)。

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/space-summary.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('buildSpaceSummary', () => {
  it('拼出项目/版本/ref、环境、分组、需求与计数,且不含密钥', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    await pool.query(`UPDATE project_versions SET ref='release-1', ref_kind='tag' WHERE id=$1`, [versionId]);
    await pool.query(`INSERT INTO test_environments(project_id, name, base_url, is_default) VALUES ($1,'生产','https://prod.example.com',true), ($1,'灰度','https://gray.example.com',false)`, [projectId]);
    await pool.query(`INSERT INTO environment_objects(environment_id, object_type, payload) SELECT id,'db',$2 FROM test_environments WHERE project_id=$1 LIMIT 1`, [projectId, JSON.stringify({ host: 'h', password: 'SUPER-SECRET' })]);
    await pool.query(`INSERT INTO requirements(project_id, title, content) VALUES ($1,'登录模块','内容'), ($1,'支付模块','内容')`, [projectId]);
    await pool.query(`INSERT INTO test_cases(group_id, version_id, title) VALUES ($1,$2,'用例A'), ($1,$2,'用例B')`, [groupId, versionId]);
    await pool.query(`INSERT INTO execution_plans(project_id, version_id, name) VALUES ($1,$2,'冒烟计划')`, [projectId, versionId]);

    const { buildSpaceSummary } = await import('../src/pi/space/summary.js');
    const s = await buildSpaceSummary(versionId);
    expect(s.projectId).toBe(projectId);
    expect(s.text).toContain('生产');
    expect(s.text).toContain('https://prod.example.com');
    expect(s.text).toContain('release-1');
    expect(s.text).toContain('登录模块');
    expect(s.text).toContain('用例 2 条');
    expect(s.text).toContain('执行计划 1 个');
    expect(s.text).not.toContain('SUPER-SECRET');
  });

  it('version 不存在 → 抛错', async () => {
    const { buildSpaceSummary } = await import('../src/pi/space/summary.js');
    await expect(buildSpaceSummary('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C apps/api test test/space-summary.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 summary.ts**

创建 `apps/api/src/pi/space/summary.ts`:

```ts
/**
 * 版本空间上下文摘要:随线程首条用户消息注入,让 AI 免查直答"有哪些环境/分组/需求"。
 * 上限防 prompt 膨胀;密钥只计数量,绝不进摘要。
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { executionPlans, groups, projectVersions, projects, requirements, testCases, testEnvironments } from '../../db/schema.js';

export interface SpaceSummary {
  projectId: string;
  text: string;
}

const MAX_ENVS = 20;
const MAX_GROUPS = 40;
const MAX_REQS = 20;

export async function buildSpaceSummary(versionId: string): Promise<SpaceSummary> {
  const v = (await db
    .select({
      versionName: projectVersions.name,
      ref: projectVersions.ref,
      refKind: projectVersions.refKind,
      projectId: projectVersions.projectId,
      projectName: projects.name,
    })
    .from(projectVersions)
    .innerJoin(projects, eq(projectVersions.projectId, projects.id))
    .where(eq(projectVersions.id, versionId))
    .limit(1))[0];
  if (!v) throw new Error('version not found');

  const lines: string[] = [];
  const refText = v.ref ? `(${v.refKind === 'tag' ? 'tag' : 'branch'} ${v.ref})` : '';
  lines.push(`项目:${v.projectName} / 版本:${v.versionName}${refText}`);

  const envs = await db
    .select({ name: testEnvironments.name, baseUrl: testEnvironments.baseUrl, isDefault: testEnvironments.isDefault })
    .from(testEnvironments)
    .where(eq(testEnvironments.projectId, v.projectId))
    .limit(MAX_ENVS + 1);
  if (envs.length === 0) {
    lines.push('环境:无');
  } else {
    const parts = envs.slice(0, MAX_ENVS).map((e) => `${e.name}${e.baseUrl ? `(${e.baseUrl})` : ''}${e.isDefault ? '[默认]' : ''}`);
    lines.push(`环境:${parts.join('、')}${envs.length > MAX_ENVS ? ' …' : ''}`);
  }

  const gs = await db
    .select({ name: groups.name })
    .from(groups)
    .where(eq(groups.projectId, v.projectId))
    .limit(MAX_GROUPS + 1);
  if (gs.length > 0) {
    lines.push(`用例分组:${gs.slice(0, MAX_GROUPS).map((g) => g.name).join('、')}${gs.length > MAX_GROUPS ? ' …' : ''}`);
  }

  // 场景从属需求(scenarios.requirement_id 非空),AI 操作场景前需要能对上需求 id
  const reqs = await db
    .select({ id: requirements.id, title: requirements.title })
    .from(requirements)
    .where(eq(requirements.projectId, v.projectId))
    .limit(MAX_REQS);
  if (reqs.length > 0) {
    lines.push(`需求(操作场景时引用其 id):${reqs.map((r) => `${r.title}=${r.id}`).join('、')}`);
  }

  const caseCount = (await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.versionId, versionId))).length;
  const planCount = (await db.select({ id: executionPlans.id }).from(executionPlans).where(eq(executionPlans.versionId, versionId))).length;
  lines.push(`统计:本版本用例 ${caseCount} 条,执行计划 ${planCount} 个。`);

  return { projectId: v.projectId, text: lines.join('\n') };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C apps/api test test/space-summary.test.ts`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/space/summary.ts apps/api/test/space-summary.test.ts
git commit -m "feat(api): 版本空间上下文摘要(环境/分组/需求/计数,密钥脱敏)"
```

---

### Task 5: 版本级线程 supervisor(pi/space/session.ts + tools.ts 接缝)

**Files:**
- Create: `apps/api/src/pi/space/tools.ts`
- Create: `apps/api/src/pi/space/session.ts`
- Modify: `apps/api/src/pi/session.ts`(仅把 `synthesizeModel`、`ENV_BY_PROVIDER` 加 `export`)
- Test: `apps/api/test/space-session.test.ts`

- [ ] **Step 1: 暴露复用点**

`apps/api/src/pi/session.ts` 两处小改(仅加 `export`,函数体不动):
- 第 227 行 `function synthesizeModel(` → `export function synthesizeModel(`
- 第 298 行 `const ENV_BY_PROVIDER` → `export const ENV_BY_PROVIDER`

- [ ] **Step 2: 写失败测试**

创建 `apps/api/test/space-session.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

interface Captured { ctx: unknown; prompts: string[]; }
const captured: Captured[] = [];

function makeFakeSession() {
  const listeners = new Set<(e: unknown) => void>();
  return {
    listeners,
    messages: [] as unknown[],
    prompts: [] as string[],
    subscribe(fn: (e: unknown) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    async prompt(text: string) { this.prompts.push(text); this.messages.push({ role: 'user', content: text }); },
    abort() {},
    async dispose() {},
    get isStreaming() { return false; },
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  await import('../src/db/client.js');
  const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
  setSpaceSessionFactory(async (ctx) => {
    const s = makeFakeSession();
    captured.push({ ctx, prompts: s.prompts });
    return s as never;
  });
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  captured.length = 0;
  const { resetSpaceSessions } = await import('../src/pi/space/session.js');
  resetSpaceSessions();
  await pool.query(`TRUNCATE ai_threads RESTART IDENTITY CASCADE`);
});

async function insertSpaceThread(versionId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,'')`, [id, versionId]);
  return id;
}

describe('space session supervisor', () => {
  it('ensureSpaceRecord 绑定版本上下文;no_repo 静默降级;首条消息注入摘要+落标题', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const threadId = await insertSpaceThread(versionId);
    const { ensureSpaceRecord, sendSpaceUserMessage } = await import('../src/pi/space/session.js');

    const rec = await ensureSpaceRecord(threadId);
    expect(rec.versionId).toBe(versionId);
    // 项目未配 repoUrl → RepoUnavailableError('no_repo') 被吞,工厂收到 repoAvailable=false
    expect(captured[0]!.ctx).toMatchObject({ threadId, versionId, projectId, repoAvailable: false, cwd: null });

    await sendSpaceUserMessage(threadId, '帮我建三个登录用例');
    const first = captured[0]!.prompts[0]!;
    expect(first).toContain('【版本空间上下文】');
    expect(first).toContain('帮我建三个登录用例');
    const row = (await pool.query(`SELECT title FROM ai_threads WHERE id=$1`, [threadId])).rows[0] as { title: string | null };
    expect(row.title).toBe('帮我建三个登录用例');

    // 第二条消息不再注入摘要
    await sendSpaceUserMessage(threadId, '再建一个');
    expect(captured[0]!.prompts[1]!).not.toContain('【版本空间上下文】');
  });

  it('requirement 线程不能走空间 supervisor', async () => {
    const { projectId } = await seedProject(pool);
    const req = (await pool.query(`INSERT INTO requirements(project_id, title, content) VALUES ($1,'r','c') RETURNING id`, [projectId])).rows[0]!.id as string;
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO ai_threads(id, kind, requirement_id, pi_thread_id) VALUES ($1,'requirement',$2,'')`, [id, req]);
    const { ensureSpaceRecord } = await import('../src/pi/space/session.js');
    await expect(ensureSpaceRecord(id)).rejects.toThrow();
  });

  it('emitThreadEvent 向订阅者广播并带 threadId+seq', async () => {
    const { versionId } = await seedProject(pool);
    const threadId = await insertSpaceThread(versionId);
    const { ensureSpaceRecord, emitThreadEvent, subscribeThread } = await import('../src/pi/space/session.js');
    await ensureSpaceRecord(threadId);
    const events: Record<string, unknown>[] = [];
    const unsub = subscribeThread(threadId, (e) => events.push(e as Record<string, unknown>), { includeSnapshot: true });
    expect(events[0]!.type).toBe('snapshot');
    emitThreadEvent(threadId, { type: 'confirm_request', confirmId: 'c1' });
    expect(events[1]).toMatchObject({ type: 'confirm_request', confirmId: 'c1', threadId });
    expect(typeof events[1]!.seq).toBe('number');
    unsub();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm -C apps/api test test/space-session.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 4: 实现 tools.ts 接缝**

创建 `apps/api/src/pi/space/tools.ts`:

```ts
/**
 * 空间助手工具接缝。Plan 1 仅注入 repo 沙箱工具;Plan 2 在这里追加
 * manage_cases / manage_scenarios / manage_environments / manage_plans / announce_plan。
 * 保持与 pi/tools.ts 相同的 ToolExecutor 形状(TypeBox schema + 可单测 execute)。
 */
import type { ToolExecutor } from '../tools.js';
import { buildRepoSandboxTools } from '../repo.js';

export interface SpaceToolsContext {
  threadId: string;
  versionId: string;
  projectId: string;
  cwd: string | null;
  repoAvailable: boolean;
  /** 向当前线程 SSE 订阅者广播自定义事件(confirm_request / 舞台对象等)。 */
  emit: (e: Record<string, unknown>) => void;
}

export function buildSpaceTools(ctx: SpaceToolsContext): ToolExecutor[] {
  const tools: ToolExecutor[] = [];
  if (ctx.repoAvailable && ctx.cwd) tools.push(...buildRepoSandboxTools(ctx.cwd));
  return tools;
}
```

- [ ] **Step 5: 实现 session.ts**

创建 `apps/api/src/pi/space/session.ts`(事件映射/fanOut/snapshot 复刻 `pi/session.ts`,绑定实体换成 versionId):

```ts
/**
 * 版本空间 AI 助手线程 supervisor(pi/space)。
 * 与 requirement 级 pi/session.ts 并列:绑定 versionId、一线程一 session、一版本可多线程。
 * 事件→react-pi 契约的映射与 pi/session.ts 保持一致;上下文摘要随首条用户消息注入。
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { aiThreads, projectVersions } from '../../db/schema.js';
import { buildSpaceTools } from './tools.js';
import { buildSpaceSummary } from './summary.js';
import { readLlmConfig } from '../modelBridge.js';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { checkoutRepoForVersion, RepoUnavailableError } from '../repo.js';
import { synthesizeModel, ENV_BY_PROVIDER } from '../session.js';

export interface SpaceSessionLike {
  subscribe(fn: (e: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): void;
  dispose(): Promise<void>;
  readonly isStreaming: boolean;
  messages: unknown[];
}

export interface SpaceThreadContext {
  threadId: string;
  versionId: string;
  projectId: string;
  cwd: string | null;
  repoAvailable: boolean;
}

export type SpaceSessionFactory = (ctx: SpaceThreadContext) => Promise<SpaceSessionLike>;

interface ThreadRecord {
  threadId: string;
  versionId: string;
  session: SpaceSessionLike;
  listeners: Set<(e: unknown) => void>;
  unsub: () => void;
  seq: number;
  turnIndex: number;
}

const records = new Map<string, ThreadRecord>();

let factory: SpaceSessionFactory = createSpaceSessionFactory;

export function setSpaceSessionFactory(f: SpaceSessionFactory): void { factory = f; }

export function resetSpaceSessions(): void {
  for (const r of records.values()) {
    try { void r.session.dispose(); } catch { /* ignore */ }
    try { r.unsub(); } catch { /* ignore */ }
  }
  records.clear();
}

/** 幂等加载 version 级线程的 session(已缓存直接返回;requirement 线程拒绝)。 */
export async function ensureSpaceRecord(threadId: string): Promise<ThreadRecord> {
  const cached = records.get(threadId);
  if (cached) return cached;
  const row = (await db.select().from(aiThreads).where(and(eq(aiThreads.id, threadId), eq(aiThreads.kind, 'version'))).limit(1))[0];
  if (!row || !row.versionId) throw new Error('space thread not found');
  const v = (await db.select({ projectId: projectVersions.projectId }).from(projectVersions).where(eq(projectVersions.id, row.versionId)).limit(1))[0];
  if (!v) throw new Error('space thread version missing');

  // repo 探测:no_repo 静默降级(与 requirement 流一致);其它错误抛出
  let cwd: string | null = null;
  let repoAvailable = false;
  try {
    cwd = await checkoutRepoForVersion(row.versionId);
    repoAvailable = true;
  } catch (e) {
    if (!(e instanceof RepoUnavailableError)) throw e;
  }

  const session = await factory({ threadId, versionId: row.versionId, projectId: v.projectId, cwd, repoAvailable });
  const rec: ThreadRecord = {
    threadId,
    versionId: row.versionId,
    session,
    listeners: new Set(),
    unsub: () => { /* assigned below */ },
    seq: 0,
    turnIndex: -1,
  };
  const unsub = session.subscribe((event) => fanOut(rec, event));
  rec.unsub = unsub;
  records.set(threadId, rec);
  return rec;
}

/** Pi AgentSession 事件 → react-pi body 的最小映射(与 pi/session.ts 一致)。 */
function mapSessionEvent(event: { type?: string } & Record<string, unknown>, ctx: { turnIndex: number }): Record<string, unknown> {
  switch (event.type) {
    case 'agent_start': return { type: 'agent_start' };
    case 'agent_settled': return { type: 'agent_settled' };
    case 'agent_end': return { type: 'agent_end', willRetry: event.willRetry };
    case 'turn_start': return { type: 'turn_start', turnIndex: ctx.turnIndex };
    case 'turn_end': return { type: 'turn_end', turnIndex: ctx.turnIndex };
    default: return event;
  }
}

function fanOut(rec: ThreadRecord, event: unknown): void {
  const raw = event as { type?: string } & Record<string, unknown>;
  if (raw.type === 'turn_start') rec.turnIndex += 1;
  const body = mapSessionEvent(raw, { turnIndex: rec.turnIndex });
  rec.seq += 1;
  const stamped = { ...body, threadId: rec.threadId, seq: rec.seq };
  for (const fn of rec.listeners) {
    try { fn(stamped); } catch { /* listener errors do not break the supervisor */ }
  }
}

/** 工具侧向线程 SSE 订阅者广播自定义事件(confirm_request 等);无活跃 session 时静默丢弃。 */
export function emitThreadEvent(threadId: string, e: Record<string, unknown>): void {
  const rec = records.get(threadId);
  if (!rec) return;
  rec.seq += 1;
  const stamped = { ...e, threadId, seq: rec.seq };
  for (const fn of rec.listeners) {
    try { fn(stamped); } catch { /* ignore */ }
  }
}

export interface ThreadSnapshot {
  metadata: { id: string; status: 'running' | 'idle'; messageCount: number };
  messages: unknown[];
}

export function snapshotOf(rec: ThreadRecord): ThreadSnapshot {
  return {
    metadata: {
      id: rec.threadId,
      status: rec.session.isStreaming ? 'running' : 'idle',
      messageCount: rec.session.messages.length,
    },
    messages: rec.session.messages,
  };
}

function snapshotEventOf(threadId: string, seq: number, snapshot: ThreadSnapshot): Record<string, unknown> {
  return { type: 'snapshot', snapshot, threadId, seq };
}

export function subscribeThread(
  threadId: string,
  fn: (e: unknown) => void,
  opts: { includeSnapshot?: boolean } = {},
): () => void {
  const rec = records.get(threadId);
  if (!rec) {
    if (opts.includeSnapshot === true) {
      fn(snapshotEventOf(threadId, 0, { metadata: { id: threadId, status: 'idle', messageCount: 0 }, messages: [] }));
    }
    return () => {};
  }
  if (opts.includeSnapshot === true) {
    fn(snapshotEventOf(rec.threadId, rec.seq, snapshotOf(rec)));
  }
  rec.listeners.add(fn);
  return () => { rec.listeners.delete(fn); };
}

export function snapshotOfThread(threadId: string): ThreadSnapshot | null {
  const rec = records.get(threadId);
  return rec ? snapshotOf(rec) : null;
}

export function threadStatus(threadId: string): 'running' | 'idle' | undefined {
  const rec = records.get(threadId);
  if (!rec) return undefined;
  return rec.session.isStreaming ? 'running' : 'idle';
}

export async function sendSpaceUserMessage(threadId: string, content: string): Promise<void> {
  const rec = records.get(threadId);
  if (!rec) throw new Error('thread not found');
  let out = content;
  if (rec.session.messages.length === 0) {
    const summary = await buildSpaceSummary(rec.versionId);
    out = `【版本空间上下文】\n${summary.text}\n\n【用户消息】\n${content}`;
  }
  // 首条消息落线程标题(取用户原文截断,不含注入的上下文块)
  const row = (await db.select({ title: aiThreads.title }).from(aiThreads).where(eq(aiThreads.id, threadId)).limit(1))[0];
  if (row && !row.title) {
    await db.update(aiThreads).set({ title: content.trim().slice(0, 40), updatedAt: new Date() }).where(eq(aiThreads.id, threadId));
  }
  await rec.session.prompt(out);
}

export function cancelThread(threadId: string): void {
  const rec = records.get(threadId);
  if (!rec) return;
  rec.session.abort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Real factory:注入空间工具(Plan 1 = repo 沙箱)并建 AgentSession
// ─────────────────────────────────────────────────────────────────────────────

async function createSpaceSessionFactory(ctx: SpaceThreadContext): Promise<SpaceSessionLike> {
  const cfg = await readLlmConfig();
  if (!cfg) throw new Error('LLM 未配置:请先到设置页配置模型');
  const { createAgentSession, SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all');
  const workspaceDir = process.env.PI_WORKSPACE_DIR ?? './.data/pi-sessions';
  await import('node:fs/promises').then((fs) => fs.mkdir(workspaceDir, { recursive: true }));

  type ToolRaw = {
    name: string; description: string; parameters: ReturnType<typeof Type.Object>;
    execute: (input: unknown) => Promise<{ ok: true; data?: string } | { ok: false; error: string }>;
    promptGuidelines?: string[];
  };
  const rawTools: ToolRaw[] = buildSpaceTools({ ...ctx, emit: (e) => emitThreadEvent(ctx.threadId, e) }) as ToolRaw[];
  const tools = rawTools.map((t) =>
    defineTool({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(t.promptGuidelines ? { promptGuidelines: t.promptGuidelines } : {}),
      execute: async (_callId, params, _signal, _onUpdate, _ctx) => {
        const r = await t.execute(params);
        return r.ok
          ? { content: [{ type: 'text', text: r.data ?? 'ok' }], details: undefined }
          : { content: [{ type: 'text', text: r.error }], details: undefined, isError: true };
      },
    }),
  );

  const base = (getBuiltinModel as unknown as (p: string, m: string) => Record<string, unknown> | undefined)(cfg.provider, cfg.model)
    ?? synthesizeModel(cfg.provider, cfg.model, cfg.baseUrl);
  const envKey = ENV_BY_PROVIDER[cfg.provider];
  if (envKey && !process.env[envKey]) process.env[envKey] = cfg.apiKey;
  const model = { ...base, ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}) } as never;

  const sessionManager = SessionManager.inMemory();
  const { session } = await createAgentSession({
    cwd: ctx.cwd ?? workspaceDir,
    noTools: 'builtin',
    customTools: tools,
    model,
    sessionManager,
  });

  await db.update(aiThreads).set({ piThreadId: session.sessionFile ?? '', updatedAt: new Date() }).where(eq(aiThreads.id, ctx.threadId));
  return session as unknown as SpaceSessionLike;
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm -C apps/api test test/space-session.test.ts`
Expected: 3 passed

Run: `pnpm -C apps/api test test/pi-session.test.ts test/pi-router.test.ts && pnpm -C apps/api typecheck`
Expected: 存量 pi 回归 PASS,typecheck 无错误(session.ts 只加了 export)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/pi/space/tools.ts apps/api/src/pi/space/session.ts apps/api/src/pi/session.ts apps/api/test/space-session.test.ts
git commit -m "feat(api): 版本级线程 supervisor(space/session),摘要随首条消息注入"
```

---

### Task 6: /api/assistant 契约路由 + 挂载

**Files:**
- Create: `apps/api/src/pi/space/router.ts`
- Modify: `apps/api/src/index.ts`(挂载,约 67 行 `app.use('/api/pi', piRoute)` 之后)
- Test: `apps/api/test/space-router.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/space-router.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

function makeFakeSession() {
  const listeners = new Set<(e: unknown) => void>();
  return {
    messages: [] as unknown[],
    listeners,
    subscribe(fn: (e: unknown) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    async prompt() { this.messages.push({ role: 'user' }); },
    abort() {},
    async dispose() {},
    get isStreaming() { return false; },
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: exp } = await import('express');
  app = exp();
  app.use(exp.json());
  const { spaceRoute } = await import('../src/pi/space/router.js');
  const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
  setSpaceSessionFactory(async () => makeFakeSession() as never);
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use((req, _res, next) => { req.user = managerUserOf(userId, username, orgId, orgPath); next(); });
  app.use('/api/assistant', spaceRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  const { resetSpaceSessions } = await import('../src/pi/space/session.js');
  resetSpaceSessions();
  await pool.query(`TRUNCATE ai_threads RESTART IDENTITY CASCADE`);
});

describe('space wire contract', () => {
  it('POST /threads 建版本线程并返回快照;每次调用新建一线程(多线程)', async () => {
    const { versionId } = await seedProject(pool);
    const a = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const b = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    expect(a.status).toBe(200);
    expect(a.body.metadata.id).toBeTruthy();
    expect(Array.isArray(a.body.messages)).toBe(true);
    expect(b.body.metadata.id).not.toBe(a.body.metadata.id);
  });

  it('POST /threads 缺 versionId 400;未知 version 404', async () => {
    expect((await request(app).post('/api/assistant/threads').send({})).status).toBe(400);
    const r = await request(app).post('/api/assistant/threads').send({ metadata: { versionId: '00000000-0000-0000-0000-000000000000' } });
    expect(r.status).toBe(404);
  });

  it('GET /threads?versionId= 返回该版本的线程列表(带标题/状态)', async () => {
    const { versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    await request(app).post(`/api/assistant/threads/${t.body.metadata.id}/messages`).send({ input: { content: '查一下环境' } });
    await new Promise((r) => setTimeout(r, 50)); // 等后台 ensure+prompt(stub factory 立即完成)
    const list = await request(app).get(`/api/assistant/threads?versionId=${versionId}`);
    expect(list.status).toBe(200);
    const row = list.body.find((x: { id: string }) => x.id === t.body.metadata.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe('idle');
    expect(row.title).toBe('查一下环境');
  });

  it('GET /threads/:id 返回快照;requirement 线程 404(本契约只管 version 线程)', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const g = await request(app).get(`/api/assistant/threads/${t.body.metadata.id}`);
    expect(g.status).toBe(200);
    expect(g.body.metadata.id).toBe(t.body.metadata.id);

    const req = (await pool.query(`INSERT INTO requirements(project_id, title, content) VALUES ($1,'r','c') RETURNING id`, [projectId])).rows[0]!.id as string;
    const rid = crypto.randomUUID();
    await pool.query(`INSERT INTO ai_threads(id, kind, requirement_id, pi_thread_id) VALUES ($1,'requirement',$2,'')`, [rid, req]);
    expect((await request(app).get(`/api/assistant/threads/${rid}`)).status).toBe(404);
  });

  it('POST /threads/:id/confirm 未知 confirmId 404;有效 confirmId 落地 resolve', async () => {
    const { versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const threadId = t.body.metadata.id as string;
    expect((await request(app).post(`/api/assistant/threads/${threadId}/confirm`).send({ confirmId: 'bogus', approved: true })).status).toBe(404);

    const { requestConfirmation } = await import('../src/pi/space/confirm.js');
    let confirmId = '';
    const p = requestConfirmation(
      { threadId, toolName: 'manage_cases', action: 'delete', summary: 's', risk: 'delete' },
      (e) => { confirmId = (e as { confirmId: string }).confirmId; },
    );
    const r = await request(app).post(`/api/assistant/threads/${threadId}/confirm`).send({ confirmId, approved: true });
    expect(r.status).toBe(204);
    await expect(p).resolves.toBe(true);
  });

  it('GET /threads/:id/events 是 SSE:先 snapshot,confirm_request 可扇出', async () => {
    const { versionId } = await seedProject(pool);
    const t = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    const threadId = t.body.metadata.id as string;
    await request(app).get(`/api/assistant/threads/${threadId}`); // 确保记录存在(工厂 stub 已注入)

    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/assistant/threads/${threadId}/events`);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(Buffer.from(first.value!).toString('utf8')).toContain('snapshot');

      const { emitThreadEvent } = await import('../src/pi/space/session.js');
      emitThreadEvent(threadId, { type: 'confirm_request', confirmId: 'c1' });
      const second = await reader.read();
      expect(Buffer.from(second.value!).toString('utf8')).toContain('confirm_request');
      await reader.cancel();
    } finally {
      // SSE 连接是长连接,closeAllConnections 确保 server.close() 不挂起
      server.close();
      server.closeAllConnections();
    }
  });

  it('GET /models 未配置时返回 []', async () => {
    expect((await request(app).get('/api/assistant/models')).body).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C apps/api test test/space-router.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 router.ts**

创建 `apps/api/src/pi/space/router.ts`:

```ts
/**
 * 版本空间 AI 助手 HTTP+SSE 契约(react-pi 兼容子集),挂载于 /api/assistant。
 * 与 /api/pi(requirement 级)并列,只服务 kind='version' 线程。
 * 事件通道与 pi/router.ts 同源:session fanOut(含 emitThreadEvent 的 confirm_request)。
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { aiThreads } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { assertVersionVisible } from '../../services/projectAccess.js';
import { sseHeaders, sseSend } from '../../sse/agentRunStream.js';
import type { AuthUser } from '../../services/auth.service.js';
import { readLlmConfig } from '../modelBridge.js';
import { resolveConfirmation } from './confirm.js';
import {
  cancelThread, ensureSpaceRecord, sendSpaceUserMessage, snapshotOfThread, subscribeThread, threadStatus,
} from './session.js';

export const spaceRoute = Router();

/** threadId → versionId;仅接受 kind='version'(requirement 线程归 /api/pi 管,这里一律 404)。 */
async function assertSpaceThreadVisible(threadId: string, user: AuthUser): Promise<string> {
  const row = (await db
    .select({ kind: aiThreads.kind, versionId: aiThreads.versionId })
    .from(aiThreads)
    .where(eq(aiThreads.id, threadId))
    .limit(1))[0];
  if (!row || row.kind !== 'version' || !row.versionId) throw new HttpError(404, 'not_found', 'thread not found');
  await assertVersionVisible(row.versionId, user);
  return row.versionId;
}

/** react-pi 契约:POST/GET threads 必须返回完整 PiThreadSnapshot。 */
function threadSnapshotResponse(threadId: string): unknown {
  const live = snapshotOfThread(threadId);
  return live ?? { metadata: { id: threadId, status: 'idle', messageCount: 0 }, messages: [] };
}

spaceRoute.post('/threads', async (req, res) => {
  const body = req.body as { metadata?: { versionId?: string } };
  const versionId = body.metadata?.versionId;
  if (!versionId) throw new HttpError(400, 'bad_request', 'metadata.versionId required');
  await assertVersionVisible(versionId, req.user as AuthUser);
  // 每次调用新建一线程(一版本多线程);行先落库,LLM 未配置时 session 建不起来也照常返回快照
  const threadId = randomUUID();
  await db.insert(aiThreads).values({ id: threadId, kind: 'version', versionId, piThreadId: '' });
  try { await ensureSpaceRecord(threadId); } catch { /* LLM 未配置等;前端经 SSE/快照感知 */ }
  res.json(threadSnapshotResponse(threadId));
});

spaceRoute.get('/threads', async (req, res) => {
  const versionId = (req.query.versionId as string | undefined) ?? '';
  if (!versionId) throw new HttpError(400, 'bad_request', 'versionId query required');
  await assertVersionVisible(versionId, req.user as AuthUser);
  const rows = await db
    .select({ id: aiThreads.id, title: aiThreads.title, createdAt: aiThreads.createdAt, updatedAt: aiThreads.updatedAt })
    .from(aiThreads)
    .where(and(eq(aiThreads.kind, 'version'), eq(aiThreads.versionId, versionId)))
    .orderBy(desc(aiThreads.updatedAt))
    .limit(20);
  res.json(rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: threadStatus(row.id) ?? 'idle',
    createdAt: row.createdAt?.toISOString(),
    updatedAt: row.updatedAt?.toISOString(),
  })));
});

spaceRoute.get('/threads/:id', async (req, res) => {
  // assertSpaceThreadVisible 已保证 kind='version' 且行存在(否则 404)
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  res.json(threadSnapshotResponse(req.params.id!));
});

spaceRoute.post('/threads/:id/messages', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const body = req.body as { input?: { content?: string } };
  const content = body.input?.content ?? '';
  // 不阻塞响应:先回 204,后台 ensure + 派发(与 requirement 流一致;LLM 未配置时静默,前端经快照感知)
  void (async () => {
    try {
      await ensureSpaceRecord(req.params.id!);
      await sendSpaceUserMessage(req.params.id!, content);
    } catch { /* ignore */ }
  })();
  res.status(204).end();
});

spaceRoute.post('/threads/:id/cancel', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  cancelThread(req.params.id!);
  res.status(204).end();
});

spaceRoute.post('/threads/:id/confirm', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  const body = req.body as { confirmId?: string; approved?: boolean };
  if (!body.confirmId || typeof body.approved !== 'boolean') {
    throw new HttpError(400, 'bad_request', 'confirmId and approved are required');
  }
  if (!resolveConfirmation(body.confirmId, body.approved)) {
    throw new HttpError(404, 'not_found', 'confirmation not found or expired');
  }
  res.status(204).end();
});

spaceRoute.get('/models', async (_req, res) => {
  const cfg = await readLlmConfig();
  if (!cfg) { res.json([]); return; }
  res.json([{ provider: cfg.provider, modelId: cfg.model }]);
});

spaceRoute.get('/threads/:id/events', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  sseHeaders(res);
  try {
    const send = (e: unknown) => sseSend(res, e as unknown as Parameters<typeof sseSend>[1]);
    // subscribeThread 自带 snapshot(无活跃 session 时发合法空快照);
    // confirm_request / 舞台事件经 emitThreadEvent 走同一 listeners 通道。
    const unsub = subscribeThread(req.params.id!, send, { includeSnapshot: true });
    req.on('close', () => { unsub(); });
  } catch {
    res.end();
  }
});
```

- [ ] **Step 4: 挂载**

`apps/api/src/index.ts` — 第 30 行附近加 import:

```ts
import { spaceRoute } from './pi/space/router.js';
```

第 67 行 `app.use('/api/pi', piRoute);` 之后:

```ts
app.use('/api/assistant', spaceRoute);
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm -C apps/api test test/space-router.test.ts`
Expected: 7 passed

- [ ] **Step 6: 全量回归 + 类型检查**

Run: `pnpm -C apps/api test && pnpm -C apps/api typecheck`
Expected: 全部 PASS;typecheck 无错误

- [ ] **Step 7: 手动冒烟(可选,需 dev 库 + LLM 配置)**

```bash
pnpm -C apps/api dev &
curl -s -X POST localhost:54321/api/assistant/threads -H 'Content-Type: application/json' \
  --data '{"metadata":{"versionId":"<dev版本id>"}}'   # 需带登录态 cookie/token
```
Expected: 返回 `{metadata:{id,...}}`;无 LLM 配置时同样返回快照。

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/pi/space/router.ts apps/api/src/index.ts apps/api/test/space-router.test.ts
git commit -m "feat(api): /api/assistant 版本助手契约(threads/SSE/confirm),挂载入口"
```

---

## 完成标准(Plan 1 Definition of Done)

- [ ] 迁移 0027 就位;schema.ts 与测试 SCHEMA_SQL 同步;存量 ai_threads 测试零回归
- [ ] confirm gate 单测通过(approve/reject/timeout/并发)
- [ ] `checkoutRepoForVersion` 按 version.ref checkout,tag 可用,存量 repo 测试零回归
- [ ] 摘要含环境/分组/需求/计数且密钥脱敏
- [ ] 空间线程全生命周期可用:建线程(多线程)→ 列表(标题)→ 发消息(stub 下验证摘要注入)→ SSE(snapshot + confirm_request 扇出)→ confirm 端点 → cancel
- [ ] `pnpm -C apps/api test` 全绿;`pnpm -C apps/api typecheck` 干净

## 后续

- **Plan 2**(本计划完成后编写):`buildSpaceTools` 接缝上追加领域工具(manage_cases/scenarios/environments/plans + announce_plan 泛化),含 service 层抽取与工具单测;届时以 Task 5 落地的 `SpaceToolsContext.emit` 为准。
- **Plan 3**:前端 AI-First 主视图(对话+舞台)、确认卡、线程管理。
