# AI 助手历史会话持久化 + 列表按时间分组 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 助手的对话消息落盘持久化（重启后可继续对话），并把左侧会话列表按「今天/昨天/7 天内/30 天内/更早」五段分组展示。

**Architecture:** 复用 pi 自带的 JSONL 文件持久化 —— 把 `SessionManager.inMemory()` 换成 `create(cwd, sessionDir)`，sessionDir 落 `.data` 共享卷。线程恢复靠 `ai_threads.pi_thread_id`（已存 sessionFile 绝对路径）作为句柄 open 回来。列表分组的时间数据由前端自持一份 `Map<threadId, updatedAt>`（因为 react-pi 的 `mapThreadMetadata` 丢弃了 `updatedAt`）。

**Tech Stack:** Node/TypeScript、Express、Drizzle ORM、Postgres（testcontainers）、Vitest、React 19、@assistant-ui/react 0.15.22 + react-pi 0.0.25、@earendil-works/pi-coding-agent。

**设计依据：** `docs/superpowers/specs/2026-10-19-assistant-history-persistence-design.md`

---

## File Structure

| 文件 | 责任 |
|---|---|
| `apps/api/src/pi/repo.ts` | 导出 `DATA_DIR`（新增一行 export） |
| `apps/api/src/pi/space/session.ts` | `SESSIONS_ROOT` 常量、SessionManager create/open 分叉、发消息刷 `updatedAt` |
| `apps/api/src/pi/space/router.ts` | `GET /threads` 过滤改文件存在性；DELETE 事务外 unlink |
| `apps/api/test/space-persistence.test.ts` | **新建**：真 pi factory 的持久化/恢复测试 |
| `apps/api/test/space-router.test.ts` | 改 1 条既有断言（过滤口径变更） |
| `apps/web/src/features/space-assistant/threadBuckets.ts` | **新建**：纯函数分桶 + 时间表加载 |
| `apps/web/src/features/space-assistant/threadBuckets.test.ts` | **新建**：分桶边界测试 |
| `apps/web/src/features/space-assistant/SpaceThreadList.tsx` | 分组渲染 + 段标题 |
| `apps/web/src/api/client.ts` | `api.assistant.listThreads(versionId)` |
| `apps/web/src/i18n/locales/{zh-CN,en-US}/assistant.json` | 5 个段标题键 |

---

## Task 1: 导出 DATA_DIR + 定义 SESSIONS_ROOT

**Files:**
- Modify: `apps/api/src/pi/repo.ts:14`
- Modify: `apps/api/src/pi/space/session.ts:24`

- [ ] **Step 1: 导出 DATA_DIR**

`apps/api/src/pi/repo.ts:14` 当前是：
```ts
const DATA_DIR = process.env.PI_DATA_DIR ?? path.resolve(process.cwd(), '.data');
```
改为：
```ts
export const DATA_DIR = process.env.PI_DATA_DIR ?? path.resolve(process.cwd(), '.data');
```

- [ ] **Step 2: 定义 SESSIONS_ROOT**

`apps/api/src/pi/space/session.ts:24` 的 import 行：
```ts
import { checkoutRepoForVersion, LockTimeoutError, RepoUnavailableError, REPOS_ROOT, WORKSPACES_ROOT } from '../repo.js';
```
改为：
```ts
import { checkoutRepoForVersion, LockTimeoutError, RepoUnavailableError, DATA_DIR, REPOS_ROOT, WORKSPACES_ROOT } from '../repo.js';
```

紧接着在 `SpacePromptImage` 接口声明之前插入常量：
```ts
/** pi 会话 JSONL 落盘目录。落 .data 共享卷(prod228 三副本共享),不能走 pi 默认的
 *  ~/.pi/agent/sessions(容器内本地盘,跨副本看不见)。 */
export const SESSIONS_ROOT = path.join(DATA_DIR, 'pi-sessions');
```

- [ ] **Step 3: 跑 typecheck 确认无编译错误**

Run: `cd apps/api && pnpm typecheck`
Expected: 无输出（成功退出 0）

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/pi/repo.ts apps/api/src/pi/space/session.ts
git commit -m "refactor(pi): 导出 DATA_DIR 并定义 SESSIONS_ROOT 常量"
```

---

## Task 2: SessionManager 改文件持久化 + 恢复分叉

这是核心任务。改完重启后消息不再丢。

**Files:**
- Modify: `apps/api/src/pi/space/session.ts:569`（`inMemory()` → create/open）
- Modify: `apps/api/src/pi/space/session.ts:432`（factory 签名需拿到 `piThreadId`）

**背景：** `createSpaceSessionFactory(ctx)` 的 `ctx: SpaceThreadContext` 目前不含线程已有的 `piThreadId`，恢复分支拿不到句柄。

- [ ] **Step 1: 给 SpaceThreadContext 加 piThreadId 字段**

在 `session.ts` 找到 `SpaceThreadContext` 接口定义（`createSpaceSessionFactory` 的参数类型），在其中加入：

```ts
  /** 已有会话的 JSONL 绝对路径(ai_threads.pi_thread_id)。非空且文件在 → 走 open 恢复;
   *  空串或文件缺失 → create 新会话。 */
  piThreadId?: string;
```

- [ ] **Step 2: 在 buildSpaceRecord 里取 piThreadId 并传给 factory**

`buildSpaceRecord`（`session.ts:131`）中，`row` 已经是 `db.select().from(aiThreads)` 的完整行，含 `piThreadId`。在调用 factory 的那行：

```ts
const session = await factory({ threadId, versionId: row.versionId, projectId: v.projectId, repo, createdByUserId: row.createdByUserId, lang, manager });
```
改为：
```ts
const session = await factory({ threadId, versionId: row.versionId, projectId: v.projectId, repo, createdByUserId: row.createdByUserId, lang, manager, piThreadId: row.piThreadId });
```

- [ ] **Step 3: 把 inMemory() 换成 create/open 分叉**

`session.ts:569` 当前：
```ts
  const sessionManager = SessionManager.inMemory();
```
替换为：
```ts
  // 恢复优先:piThreadId 指向的 JSONL 存在 → open 回历史消息(重启后续聊);
  // 缺失/损坏/为空 → 退新建。降级只记 warn——一条坏文件不该让整个列表接口失败。
  let sessionManager: InstanceType<typeof SessionManager>;
  if (ctx.piThreadId) {
    try {
      sessionManager = SessionManager.open(ctx.piThreadId, SESSIONS_ROOT, workspaceDir);
    } catch (err) {
      logger.warn({ err, sessionFile: ctx.piThreadId, threadId: ctx.threadId }, 'pi session open failed; recreating');
      sessionManager = SessionManager.create(workspaceDir, SESSIONS_ROOT);
    }
  } else {
    sessionManager = SessionManager.create(workspaceDir, SESSIONS_ROOT);
  }
```

- [ ] **Step 4: typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: 成功退出 0

若报 `SessionManager` 类型问题，改用 `ReturnType<typeof SessionManager.create>` 标注。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/space/session.ts
git commit -m "feat(pi): 会话消息落盘持久化——inMemory 改 create/open 按 piThreadId 恢复"
```

---

## Task 3: 发消息后刷新 updatedAt

不刷的话分桶按「建会话时间」而非「最后活跃时间」，与 DeepSeek 语义不符。

**Files:**
- Modify: `apps/api/src/pi/space/session.ts:337`（`sendSpaceUserMessage` 内 prompt 之后）

- [ ] **Step 1: 在 prompt 成功后更新 updatedAt**

`sendSpaceUserMessage` 中 `await rec.session.prompt(...)` 成功之后、`} catch (err) {` 之前插入：

```ts
    // 刷最后活跃时间:列表按 updatedAt 分桶(今天/昨天/7天内/…),
    // 不刷则分桶落到建会话那天,刚聊过的会话会留在旧桶里。
    await db.update(aiThreads).set({ updatedAt: new Date() }).where(eq(aiThreads.id, threadId));
```

- [ ] **Step 2: typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: 成功退出 0

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/pi/space/session.ts
git commit -m "feat(pi): 发消息后刷新 ai_threads.updatedAt 供列表分桶"
```

---

## Task 4: GET /threads 过滤改文件存在性

**易错点：** 判据必须是**文件存在性**，不能是 `piThreadId !== ''`。pi 的 `newSession()` 在 `persist=true` 时**立即**给 `sessionFile` 赋路径（`session-manager.js:713`），只有**落盘**是延迟的。所以草稿线程（建了会话但没发过消息）也有非空 `piThreadId`，用后者判会让草稿全进历史列表 —— 正是原过滤要防的事。

**Files:**
- Modify: `apps/api/src/pi/space/router.ts:94`

- [ ] **Step 1: 改过滤逻辑**

`router.ts:78-102` 的 `GET /threads`，把：
```ts
  const withRecords = rows.filter((row) => (snapshotOfThread(row.id)?.metadata.messageCount ?? 0) > 0);
```
改为：
```ts
  // 「有会话」判据 = session 文件真实存在。不能用 piThreadId !== '':pi 在 persist=true 时
  // 立即分配 sessionFile 路径(仅落盘延迟),草稿线程也有非空 piThreadId,会把没发过消息的
  // 空会话全放进历史列表——正是本过滤原本要防的。
  const exists = await Promise.all(rows.map((r) => fs.access(r.piThreadId).then(() => true).catch(() => false)));
  const withRecords = rows.filter((_, i) => exists[i]);
```

`rows` 的 select 需带上 `piThreadId`。把该路由的 select 从：
```ts
    .select({ id: aiThreads.id, title: aiThreads.title, createdAt: aiThreads.createdAt, updatedAt: aiThreads.updatedAt })
```
改为：
```ts
    .select({ id: aiThreads.id, title: aiThreads.title, piThreadId: aiThreads.piThreadId, createdAt: aiThreads.createdAt, updatedAt: aiThreads.updatedAt })
```

注意：`piThreadId` 为空串时 `fs.access('')` 会 reject → `exists=false`，语义正确。

- [ ] **Step 2: 加 fs import**

`router.ts` 顶部加：
```ts
import fs from 'node:fs/promises';
```

- [ ] **Step 3: 确认 snapshotOfThread 仍被使用**

`router.ts:49` 的 `threadSnapshotResponse` 仍在用 `snapshotOfThread`，import 保留即可，无需删除。

- [ ] **Step 4: typecheck + lint**

Run: `cd apps/api && pnpm typecheck && pnpm lint`
Expected: 均成功退出 0

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/space/router.ts
git commit -m "fix(pi): 列表过滤改 session 文件存在性判据——草稿线程不再进历史列表"
```

---

## Task 5: DELETE 清理 session 文件

**Files:**
- Modify: `apps/api/src/pi/space/router.ts:123-137`

- [ ] **Step 1: 在 dropSpaceRecord 后删文件**

`router.ts` 的 DELETE 路由末尾：
```ts
  dropSpaceRecord(threadId);
  res.status(204).end();
```
改为：
```ts
  dropSpaceRecord(threadId);
  // 事务外删会话文件:文件删除失败不应让 DB 回滚成「线程还在但文件没了」。
  // 先取 piThreadId 再删——上面的事务已把 ai_threads 行删掉,取不到了。
  res.status(204).end();
```

并在该事务**之前**插入取 `piThreadId` 的查询。完整改法：

```ts
spaceRoute.delete('/threads/:id', async (req, res) => {
  const threadId = req.params.id!;
  await assertSpaceThreadVisible(threadId, req.user as AuthUser);
  // 先取 session 文件路径:事务删完 ai_threads 行就取不到了
  const row = (await db.select({ piThreadId: aiThreads.piThreadId }).from(aiThreads).where(eq(aiThreads.id, threadId)).limit(1))[0];
  await db.transaction(async (tx) => {
    await tx.delete(aiStageCases).where(eq(aiStageCases.threadId, threadId));
    await tx.delete(aiStageCaseOps).where(eq(aiStageCaseOps.threadId, threadId));
    await tx.delete(aiStageScenarios).where(eq(aiStageScenarios.threadId, threadId));
    await tx.delete(aiStageEnvironments).where(eq(aiStageEnvironments.threadId, threadId));
    await tx.delete(aiStagePlans).where(eq(aiStagePlans.threadId, threadId));
    await tx.delete(aiStageDatasets).where(eq(aiStageDatasets.threadId, threadId));
    await tx.delete(aiThreads).where(eq(aiThreads.id, threadId));
  });
  dropSpaceRecord(threadId);
  // 事务外删会话文件:删除失败不该让 DB 回滚成「线程还在但文件没了」;文件不存在静默忽略
  if (row?.piThreadId) await fs.unlink(row.piThreadId).catch(() => {});
  res.status(204).end();
});
```

- [ ] **Step 2: typecheck + lint**

Run: `cd apps/api && pnpm typecheck && pnpm lint`
Expected: 均成功退出 0

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/pi/space/router.ts
git commit -m "feat(pi): 删除线程时一并清理落盘的会话文件"
```

---

## Task 6: api 持久化测试（新建文件）

**Files:**
- Create: `apps/api/test/space-persistence.test.ts`

**关键：** 必须用**真 factory**（不能注入假 session），否则测不到真实落盘。参照 `test/assistant-mcp-spike.test.ts` 的真 factory 用法：插 settings 造 LLM 配置 + 直接调 `createSpaceSessionFactory`。

- [ ] **Step 1: 写测试文件骨架 + 落盘用例**

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  // 工厂要求 readLlmConfig 非空;本文件只建会话 + 断言落盘/恢复,不依赖真实回复
  await pool.query(`INSERT INTO settings(key, value) VALUES
    ('llm_provider','"openai"'),
    ('llm_api_key','"sk-test"'),
    ('llm_model','"gpt-4o-mini"')`);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ai_threads RESTART IDENTITY CASCADE`);
});

describe('pi 会话文件持久化', () => {
  it('建会话即回写 pi_thread_id;发消息后 session 文件才落盘', async () => {
    const { ensureSpaceRecord, sendSpaceUserMessage, SESSIONS_ROOT } =
      await import('../src/pi/space/session.js');
    const { versionId } = await seedProject(pool);
    const threadId = crypto.randomUUID();
    await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,'')`, [threadId, versionId]);

    await ensureSpaceRecord(threadId);
    const file = (await pool.query(`SELECT pi_thread_id FROM ai_threads WHERE id=$1`, [threadId])).rows[0].pi_thread_id;
    // pi 在 persist=true 时立即分配 sessionFile 路径(仅落盘延迟)→ 建会话即回写非空路径
    expect(file).toBeTruthy();
    expect(file.startsWith(SESSIONS_ROOT)).toBe(true);
    // 草稿：路径已分配但磁盘无文件（这正是列表过滤要用文件存在性判据的原因）
    await expect(fs.access(file)).rejects.toThrow();

    // 发消息 → pi 首次落盘。prompt 可能因 sk-test 不可达抛错，但用户消息仍会落盘
    // （pi 的 _hasConversation 门从 user message 起写，见 session-manager.js 的注释）。
    await sendSpaceUserMessage(threadId, '你好').catch(() => {});
    await expect(fs.access(file)).resolves.toBeUndefined();
  }, 60_000);
});
```

**注意：** 落盘只能经 `sendSpaceUserMessage`（走 `session.prompt`）触发。直接 `session.messages.push(...)` **不会**落盘——`_persist` 是 pi 内部路径，外部改 messages 数组不经过它。

- [ ] **Step 2: 加「重启后恢复」用例（核心验收）**

```ts
  it('重启(resetSpaceSessions)后重新 ensure,消息从 session 文件恢复', async () => {
    const { ensureSpaceRecord, sendSpaceUserMessage, resetSpaceSessions } =
      await import('../src/pi/space/session.js');
    const { versionId } = await seedProject(pool);
    const threadId = crypto.randomUUID();
    await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,'')`, [threadId, versionId]);

    await ensureSpaceRecord(threadId);
    await sendSpaceUserMessage(threadId, '第一条消息');
    const before = (await import('../src/pi/space/session.js')).snapshotOfThread(threadId);
    expect(before!.metadata.messageCount).toBeGreaterThan(0);

    // 模拟进程重启:清内存记录（DB 行与磁盘文件都还在）
    resetSpaceSessions();

    const after = (await import('../src/pi/space/session.js')).snapshotOfThread(threadId);
    expect(after).toBeNull(); // reset 后内存确实空了
    await ensureSpaceRecord(threadId);
    const restored = (await import('../src/pi/space/session.js')).snapshotOfThread(threadId);
    expect(restored!.metadata.messageCount).toBeGreaterThan(0);
  }, 60_000);
```

**注意：** `sendSpaceUserMessage` 会调真实 `session.prompt`，需要 LLM 可达。若 `sk-test` 不可用导致 prompt 抛错，用 try/catch 包住只做落盘断言 —— `prompt` 失败时用户消息仍会经 `_persist` 落盘（pi 在 user message 处即写，见 `_hasConversation` 注释「Starting at the user message」）。

- [ ] **Step 3: 加「损坏文件降级」用例**

```ts
  it('session 文件损坏时降级为新建,不抛错', async () => {
    const { ensureSpaceRecord, resetSpaceSessions } = await import('../src/pi/space/session.js');
    const { versionId } = await seedProject(pool);
    const threadId = crypto.randomUUID();
    const bogus = path.join(process.cwd(), '.data', 'pi-sessions', `broken-${Date.now()}.jsonl`);
    await fs.mkdir(path.dirname(bogus), { recursive: true });
    await fs.writeFile(bogus, 'this is not json\n');
    await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,$3)`, [threadId, versionId, bogus]);

    resetSpaceSessions();
    await expect(ensureSpaceRecord(threadId)).resolves.toBeTruthy();
  }, 60_000);
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/space-persistence.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/space-persistence.test.ts
git commit -m "test(pi): 会话文件持久化与重启恢复用例"
```

---

## Task 7: 修既有 space-router 测试（过滤口径变更）

**Files:**
- Modify: `apps/api/test/space-router.test.ts:145-157`

**背景：** 该用例注入假 factory（`makeFakeSession`），从不写 `pi_thread_id`，也不产文件。新判据下行为变了：建了线程但没发消息 → `pi_thread_id` 为空 → 不进列表（仍符合原断言）。但「已落库且带标题、内存无 record」那条现在也是不进列表。所以**该用例大概率仍通过**——必须实跑确认，而不是想当然。

- [ ] **Step 1: 先跑，确认是否真的红**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/space-router.test.ts`
Expected: 若 PASS → 跳到 Step 3；若 FAIL → 继续 Step 2。

- [ ] **Step 2: 若红，把用例改成覆盖新判据三条路径**

把 `test/space-router.test.ts:145-157` 整条替换为：

```ts
  it('GET /threads?versionId= 无会话文件的线程不进列表', async () => {
    const { versionId } = await seedProject(pool);
    // 路径 1：建了线程但从未发消息 → pi_thread_id 为空串
    await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    // 路径 2：库里有非空 pi_thread_id 但文件不存在（草稿线程：pi 分配了路径却未落盘）
    await pool.query(
      `INSERT INTO ai_threads(id, kind, version_id, pi_thread_id, title) VALUES ($1,'version',$2,$3,'草稿')`,
      [crypto.randomUUID(), versionId, '/tmp/definitely-missing-session.jsonl'],
    );
    const list = await request(app).get(`/api/assistant/threads?versionId=${versionId}`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  it('GET /threads?versionId= 有真实 session 文件的线程进列表', async () => {
    const { versionId } = await seedProject(pool);
    const realFile = path.join(os.tmpdir(), `itest-session-${Date.now()}.jsonl`);
    await fs.writeFile(realFile, '{"type":"session","version":1,"id":"x","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n');
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO ai_threads(id, kind, version_id, pi_thread_id, title) VALUES ($1,'version',$2,$3,'真会话')`,
      [id, versionId, realFile],
    );
    const list = await request(app).get(`/api/assistant/threads?versionId=${versionId}`);
    expect(list.body.map((x: { id: string }) => x.id)).toContain(id);
    await fs.rm(realFile, { force: true });
  });
```

需在该测试文件顶部补 import：`import fs from 'node:fs/promises';`、`import path from 'node:path';`、`import os from 'node:os';`（若已有则不重复加）。

- [ ] **Step 3: 跑全量 api 测试确认无回归**

Run: `cd apps/api && pnpm test 2>&1 | tail -40`
Expected: 无新增失败。

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/space-router.test.ts
git commit -m "test(pi): 列表过滤用例覆盖新判据三条路径"
```

---

## Task 8: web 纯函数分桶（新建）

**Files:**
- Create: `apps/web/src/features/space-assistant/threadBuckets.ts`
- Create: `apps/web/src/features/space-assistant/threadBuckets.test.ts`

- [ ] **Step 1: 写实现**

`threadBuckets.ts`：
```ts
/** 列表分组键。顺序即展示顺序。 */
export const BUCKET_KEYS = ['today', 'yesterday', 'week', 'month', 'older'] as const;
export type BucketKey = (typeof BUCKET_KEYS)[number];

/** 本地自然日零点(非 24h 滚动)——「昨天」须与日历日对齐,才符合 DeepSeek 语义。 */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 按 updatedAt 落到五段之一。缺失/非法时间归「更早」。 */
export function bucketOf(updatedAt: string | undefined, now: Date = new Date()): BucketKey {
  if (!updatedAt) return 'older';
  const t = new Date(updatedAt);
  if (Number.isNaN(t.getTime())) return 'older';
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(t)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days <= 7) return 'week';
  if (days <= 30) return 'month';
  return 'older';
}

/** 把线程按桶分组,桶内按 updatedAt 降序,桶序按 BUCKET_KEYS。空桶不产出。 */
export function groupByBucket<T extends { id: string; updatedAt?: string | null }>(
  items: readonly T[],
  now: Date = new Date(),
): { key: BucketKey; items: T[] }[] {
  const byKey = new Map<BucketKey, T[]>();
  for (const it of items) {
    const k = bucketOf(it.updatedAt ?? undefined, now);
    const arr = byKey.get(k);
    if (arr) arr.push(it);
    else byKey.set(k, [it]);
  }
  for (const arr of byKey.values()) {
    arr.sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime());
  }
  return BUCKET_KEYS.filter((k) => byKey.has(k)).map((k) => ({ key: k, items: byKey.get(k)! }));
}
```

- [ ] **Step 2: 写测试**

`threadBuckets.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { bucketOf, groupByBucket } from './threadBuckets';

const NOW = new Date(2026, 9, 19, 15, 0, 0); // 2026-10-19 15:00 本地
const iso = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h, 0, 0).toISOString();

describe('bucketOf', () => {
  it('今天/昨天按自然日切分(非 24h 滚动)', () => {
    expect(bucketOf(iso(2026, 9, 19, 1), NOW)).toBe('today');   // 今日凌晨 1 点仍是今天
    expect(bucketOf(iso(2026, 9, 18, 23), NOW)).toBe('yesterday'); // 昨日 23 点仍算昨天
  });
  it('7 天内 / 30 天内 边界含端点', () => {
    expect(bucketOf(iso(2026, 9, 17), NOW)).toBe('week');   // 2 天前
    expect(bucketOf(iso(2026, 9, 12), NOW)).toBe('week');   // 恰好 7 天
    expect(bucketOf(iso(2026, 9, 11), NOW)).toBe('month');  // 8 天前
    expect(bucketOf(iso(2026, 8, 19), NOW)).toBe('month');  // 恰好 30 天
    expect(bucketOf(iso(2026, 8, 18), NOW)).toBe('older');  // 31 天前
  });
  it('缺失/非法时间归「更早」', () => {
    expect(bucketOf(undefined, NOW)).toBe('older');
    expect(bucketOf('not-a-date', NOW)).toBe('older');
  });
  it('未来时间(时钟漂移)不炸,归今天', () => {
    expect(bucketOf(iso(2026, 9, 20), NOW)).toBe('today');
  });
});

describe('groupByBucket', () => {
  it('桶序固定 today→older,桶内按 updatedAt 降序,空桶不产出', () => {
    const rows = [
      { id: 'a', updatedAt: iso(2026, 9, 19, 10) }, // today
      { id: 'b', updatedAt: iso(2026, 9, 19, 14) }, // today(较新)
      { id: 'c', updatedAt: iso(2026, 9, 18, 10) }, // yesterday
      { id: 'd', updatedAt: iso(2026, 6, 1, 10) },   // older
    ];
    const g = groupByBucket(rows, NOW);
    expect(g.map((x) => x.key)).toEqual(['today', 'yesterday', 'older']);
    expect(g[0]!.items.map((x) => x.id)).toEqual(['b', 'a']); // 桶内降序
  });
  it('空数组产出空分组', () => {
    expect(groupByBucket([], NOW)).toEqual([]);
  });
});
```

- [ ] **Step 3: 跑测试**

Run: `cd apps/web && npx vitest run src/features/space-assistant/threadBuckets.test.ts`
Expected: 全部 PASS。

若「恰好 7 天」等边界因夏令时偏移失败，改用固定 UTC 构造日期或把断言放宽到相邻桶（测试意图是边界归属，不是 DST）。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/space-assistant/threadBuckets.ts apps/web/src/features/space-assistant/threadBuckets.test.ts
git commit -m "feat(web): 会话列表五段分桶纯函数 + 边界测试"
```

---

## Task 9: api client 加 listThreads

**Files:**
- Modify: `apps/web/src/api/client.ts`（`assistant:` 段内，约 525 行）

- [ ] **Step 1: 加类型与方法**

在 `assistant: {` 内，`confirm` 之前插入：

```ts
    /** 线程列表:react-pi 的 mapThreadMetadata 会丢弃 updatedAt,左栏分组自持这份时间表。
     *  workspacePath ≡ versionId(见 SpaceWorkspace 的 Props 注释)。 */
    listThreads: (versionId: string) =>
      request<{ id: string; title: string | null; status: string; createdAt?: string; updatedAt?: string }[]>(
        `/assistant/threads${qs({ workspacePath: versionId })}`,
      ),
```

`qs` 已在同文件导出，直接用。

- [ ] **Step 2: typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: 成功退出 0

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/api/client.ts
git commit -m "feat(web): api client 加 assistant.listThreads"
```

---

## Task 10: SpaceThreadList 分组渲染

**Files:**
- Modify: `apps/web/src/features/space-assistant/SpaceThreadList.tsx`
- Modify: `apps/web/src/features/space-assistant/SpaceWorkspace.tsx:118`（传 `versionId`）
- Modify: `apps/web/src/i18n/locales/zh-CN/assistant.json`
- Modify: `apps/web/src/i18n/locales/en-US/assistant.json`

**关键约束：** `ThreadListPrimitive.Items` 内部是 `threadIds.map(...)` 死平铺（core `ThreadListItems.js:39`），**无法插入组标题**。必须改用 `ThreadListPrimitive.ItemByIndex`（接受 `{index, components:{ThreadListItem}}`），按 index 自行排版。

- [ ] **Step 1: 加 i18n 键**

`zh-CN/assistant.json` 的 `threadList` 对象内加：
```json
    "groupToday": "今天",
    "groupYesterday": "昨天",
    "groupWeek": "7 天内",
    "groupMonth": "30 天内",
    "groupOlder": "更早"
```

`en-US/assistant.json` 的 `threadList` 对象内加：
```json
    "groupToday": "Today",
    "groupYesterday": "Yesterday",
    "groupWeek": "Last 7 days",
    "groupMonth": "Last 30 days",
    "groupOlder": "Older"
```

- [ ] **Step 2: 跑 i18n 校验**

Run: `cd apps/web && pnpm i18n:check`
Expected: `[i18n] 所有命名空间 en ⊇ zh,key 完整。`

- [ ] **Step 3: SpaceWorkspace 传 versionId**

`SpaceWorkspace.tsx:118`：
```tsx
<SpaceThreadList collapsed={railCollapsed} onToggleCollapsed={() => setRailCollapsed((v) => !v)} />
```
改为：
```tsx
<SpaceThreadList versionId={versionId} collapsed={railCollapsed} onToggleCollapsed={() => setRailCollapsed((v) => !v)} />
```

- [ ] **Step 4: 改 SpaceThreadList 签名 + 加时间表加载**

把组件签名改为：
```tsx
export default function SpaceThreadList({ versionId, collapsed, onToggleCollapsed }: {
  versionId: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
```

在组件内加时间表 state 与加载：
```tsx
  // react-pi 的 mapThreadMetadata 丢弃 updatedAt(只透传 status/title/custom 且 custom 是重建的),
  // store 里拿不到时间 → 自持一份。挂载/对话 settle 时刷新,否则刚聊过的会话留在旧桶。
  const [updatedAtById, setUpdatedAtById] = useState<Record<string, string | undefined>>({});
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const wasRunningRef = useRef(false);
  useEffect(() => {
    let alive = true;
    void api.assistant.listThreads(versionId)
      .then((rows) => {
        if (!alive) return;
        setUpdatedAtById(Object.fromEntries(rows.map((r) => [r.id, r.updatedAt])));
      })
      .catch(() => {}); // 列表拉不到就退回无分组,不打断对话
    return () => { alive = false; };
  }, [versionId]);

  // 一轮对话 settle(与 SuggestionWatcher 同一 true→false 边沿)→ 重拉时间表
  useEffect(() => {
    if (isRunning) { wasRunningRef.current = true; return; }
    const settled = wasRunningRef.current;
    wasRunningRef.current = false;
    if (!settled) return;
    void api.assistant.listThreads(versionId)
      .then((rows) => setUpdatedAtById(Object.fromEntries(rows.map((r) => [r.id, r.updatedAt]))))
      .catch(() => {});
  }, [isRunning, versionId]);
```

补 imports：`useEffect, useRef`（当前只 import 了 `useState`）、`api`。

- [ ] **Step 5: 把平铺 Items 换成按 index 分组渲染**

当前：
```tsx
        <ThreadListPrimitive.Items>
          {({ threadListItem: item }) => (
            <RailItem key={item.id} item={item} active={item.remoteId === activeRemoteId} />
          )}
        </ThreadListPrimitive.Items>
```
改为：
```tsx
        <GroupedItems updatedAtById={updatedAtById} activeRemoteId={activeRemoteId} />
```

新增组件（放在文件末尾）：
```tsx
/** 段标题的 i18n key：groupToday / groupYesterday / groupWeek / groupMonth / groupOlder */
function bucketLabelKey(k: BucketKey): string {
  return `assistant:threadList.group${k[0]!.toUpperCase()}${k.slice(1)}`;
}

/** ItemByIndex 作用域内的条目。必须是独立组件——components.ThreadListItem 里
 *  不能内联调 useAuiState（违反 Hooks 规则，且组件身份不稳定会反复重挂载）。 */
function IndexedRailItem({ active }: { active: boolean }) {
  const item = useAuiState((s) => s.optional.threadListItem);
  if (!item) return null;
  return <RailItem item={item as unknown as RailItemData} active={active} />;
}

/** 按五段分组渲染。Items 原语内部是 threadIds.map 死平铺、插不进段标题,
 *  故用 ItemByIndex 按 index 自行排版,保留 item scope 的 switchTo/rename/delete。 */
function GroupedItems({ updatedAtById, activeRemoteId }: {
  updatedAtById: Record<string, string | undefined>;
  activeRemoteId: string | undefined;
}) {
  const { t } = useTranslation();
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const rows = useMemo(
    () => groupByBucket(threadIds.map((id) => ({ id, updatedAt: updatedAtById[id] }))),
    [threadIds, updatedAtById],
  );
  // ItemByIndex 的 index 必须是 threadIds 里的原始下标,不能用分组后的序号
  const indexById = useMemo(() => new Map(threadIds.map((id, i) => [id, i])), [threadIds]);
  return (
    <>
      {rows.map((group) => (
        <div key={group.key} className="mb-1">
          <div className="px-2 py-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            {t(bucketLabelKey(group.key))}
          </div>
          {group.items.map((row) => (
            <ThreadListPrimitive.ItemByIndex
              key={row.id}
              index={indexById.get(row.id)!}
              components={{
                ThreadListItem: () => <IndexedRailItem active={row.id === activeRemoteId} />,
              }}
            />
          ))}
        </div>
      ))}
    </>
  );
}
```

补 imports：`useMemo`（除 `useState` 外的 React hooks）、`type BucketKey`、`groupByBucket`、`bucketLabelKey`（本文件内定义，无需 import）、`api`。

- [ ] **Step 6: typecheck + lint + test**

Run: `cd apps/web && pnpm verify`
Expected: typecheck、i18n、test 全部通过。

- [ ] **Step 7: 手工验证**

启动 dev：`cd apps/api && pnpm dev` 与 `cd apps/web && pnpm dev`，进入某版本的 AI 助手页，确认：
1. 左栏出现「今天/昨天/…」段标题
2. 重启 api 后历史会话仍在且可继续对话
3. 造几条不同 `updatedAt` 的会话确认分桶顺序

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/space-assistant/SpaceThreadList.tsx apps/web/src/features/space-assistant/SpaceWorkspace.tsx apps/web/src/i18n/locales/zh-CN/assistant.json apps/web/src/i18n/locales/en-US/assistant.json
git commit -m "feat(web): 会话列表按五段时间分组渲染"
```

---

## Self-Review

**1. Spec 覆盖核对**

| Spec 节 | 对应任务 |
|---|---|
| 1. 持久化路径与恢复流程 | Task 1、2 |
| 2. 列表接口调整（过滤 + updatedAt） | Task 3、4 |
| 3. 前端分组渲染 | Task 8、9、10 |
| 4. 错误处理（损坏降级、DELETE 清文件） | Task 2 Step 3、Task 5、Task 6 Step 3 |
| 5. 测试与验收 | Task 6、7、8、10 Step 7 |

无遗漏。

**2. 占位符扫描**

无 TBD / TODO / 「类似 Task N」占位符。所有代码步骤均含完整可粘贴代码。

**3. 类型一致性**

- `SESSIONS_ROOT` — Task 1 定义、Task 2/6 引用，一致
- `piThreadId` 字段名 — Task 2 定义在 `SpaceThreadContext`、Task 4/5/6 用 DB 列 `piThreads.piThreadId`（DB 列名 `pi_thread_id`），一致
- `bucketOf` / `groupByBucket` / `BUCKET_KEYS` / `BucketKey` — Task 8 定义、Task 10 引用，一致
- `api.assistant.listThreads` — Task 9 定义、Task 10 调用，一致
- `RailItemData` — 既有接口（`SpaceThreadList.tsx:89`），Task 10 的 `IndexedRailItem` 复用，一致
- `bucketLabelKey` — Task 10 内定义并使用，一致

**4. 写计划过程中自查修掉的两个自身缺陷**（记录以免回退）

1. **落盘触发方式错了**：初稿用 `session.messages.push(...)` 断言落盘，但 `_persist` 是 pi 内部路径，外部改 messages 数组**不经过**它，文件永远不会出现。改为经 `sendSpaceUserMessage`（走 `session.prompt`）触发。
2. **Hooks 规则违反**：初稿在 `components.ThreadListItem` 回调里内联调 `useAuiState`。已抽为独立组件 `IndexedRailItem` 并就地改正，不留「⚠️ 注意」让实现者二次判断。

**5. 已知风险（实现者须留意）**

- Task 6 用真 factory 会触发 `session.prompt`，`sk-test` 不可达时 prompt 抛错。用例已内置 `.catch(() => {})` —— **这是允许的**，因核心断言是「文件落盘」与「open 能恢复」，不是 LLM 回复质量。
- Task 7 Step 1 要求**先跑后改**：假 factory 场景下新判据可能仍通过，不要预先重写用例。
- Task 8 的「恰好 7 天 / 30 天」边界断言在夏令时切换日可能偏移，Step 3 已给退路（放宽到相邻桶——测试意图是边界归属，不是 DST）。
