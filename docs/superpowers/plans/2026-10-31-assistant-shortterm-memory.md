# AI 助手短期记忆体（R1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为空间助手建立产品线级短期记忆：save_memory/read_memory 工具 + system prompt 记忆索引段 + 设置页只读/软删管理界面。

**Architecture:** 新表 `assistant_memories`（drizzle）为唯一真源；核心服务 `memories.ts` 提供加载/渲染/upsert/模糊查；两个工具注册进 `buildSpaceTools`（chat/rca 线程均可用）；索引段经 `buildSpaceSystemPrompt` 注入（guides 同轨热生效）；管理端 REST 走 `requireManager` + `visibleProductLineIds` 可见性。设计文档：`docs/superpowers/specs/2026-10-31-assistant-shortterm-memory-design.md`。

**Tech Stack:** Express + drizzle-orm (postgres) + TypeBox (pi-ai) + vitest/testcontainers；web 侧 React + @tanstack/react-query + i18next。

**环境注意（执行者必读）：**
- 本地 dev api 启动须带 `ENCRYPTION_KEY` 与 `CHROMIUM_PATH` 环境变量，否则 execute 500
- dev PG 容器名 `itest-pg`；**新表须手动 psql 建表**（`drizzle-kit push --force` 会被 rename 交互卡住），生产由 api 容器启动 `drizzle-kit push --force` 自动应用
- 测试全量并发会轮转假失败：判断回归前先单跑本文件
- 跑完测试收尾必查 `git status`，陌生文件（尤其 `step-dsl-spec.ts` 类源码改动）须还原
- 本计划不触碰 packages/shared，无需重编译 shared

---

### Task 1: DB schema + 测试建表 SQL

**Files:**
- Modify: `apps/api/src/db/schema.ts`（在 `assistantSkills` 表定义之后，约 line 807）
- Modify: `apps/api/test/helpers/db.ts`（`SCHEMA_SQL` 模板末尾，line 208 的反引号前）

- [ ] **Step 1: schema.ts 加表定义**

在 `assistantSkills` 的 `}));` 之后插入（`integer`/`text`/`index` 等已在文件头部 import，无需新增）：

```ts
// ── AI 助手短期记忆（产品线级，仿 Claude Code auto-memory：索引常驻 + 正文按需读）──
// 写入 = 模型 save_memory 工具（upsert 同 title 的 active 行）；读取 = system prompt
// 索引段 + read_memory 工具。status 软删/退役保审计，所有读路径只取 active。
// R3 预留：retired_by_batch（固化批次）；R5 预留：hit_count/last_hit_at（read_memory 埋点）。
export const assistantMemories = pgTable('assistant_memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  scope: varchar('scope', { length: 16 }).notNull(),
  productLineId: uuid('product_line_id').references(() => productLines.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 120 }).notNull(),
  hook: varchar('hook', { length: 200 }).notNull(),
  body: text('body'),
  provenance: varchar('provenance', { length: 16 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  retiredByBatch: uuid('retired_by_batch'),
  sourceThreadId: uuid('source_thread_id'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  hitCount: integer('hit_count').notNull().default(0),
  lastHitAt: timestamp('last_hit_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  activeIdx: index('assistant_memories_active_idx').on(t.scope, t.productLineId, t.status),
}));
```

- [ ] **Step 2: SCHEMA_SQL 加同构建表语句**

`apps/api/test/helpers/db.ts` 的 `SCHEMA_SQL` 模板末尾（`CREATE INDEX solidify_batch_cases_case_idx ...` 行后）追加：

```sql
CREATE TABLE assistant_memories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope varchar(16) NOT NULL, product_line_id uuid REFERENCES product_lines(id) ON DELETE CASCADE, title varchar(120) NOT NULL, hook varchar(200) NOT NULL, body text, provenance varchar(16) NOT NULL, status varchar(20) NOT NULL DEFAULT 'active', retired_by_batch uuid, source_thread_id uuid, created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL, hit_count integer NOT NULL DEFAULT 0, last_hit_at timestamp, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE INDEX assistant_memories_active_idx ON assistant_memories(scope, product_line_id, status);
```

- [ ] **Step 3: 类型检查**

Run: `pnpm -C apps/api run typecheck`
Expected: 无错误退出（exit 0）

- [ ] **Step 4: dev 库手动建表**

Run（替换实际连接串，默认 dev 库见 `.env` DATABASE_URL）:
```bash
psql "$DATABASE_URL" -c "CREATE TABLE assistant_memories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope varchar(16) NOT NULL, product_line_id uuid REFERENCES product_lines(id) ON DELETE CASCADE, title varchar(120) NOT NULL, hook varchar(200) NOT NULL, body text, provenance varchar(16) NOT NULL, status varchar(20) NOT NULL DEFAULT 'active', retired_by_batch uuid, source_thread_id uuid, created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL, hit_count integer NOT NULL DEFAULT 0, last_hit_at timestamp, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()); CREATE INDEX assistant_memories_active_idx ON assistant_memories(scope, product_line_id, status);"
```
Expected: `CREATE TABLE` + `CREATE INDEX`（若表已存在报 duplicate 则跳过）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/test/helpers/db.ts
git commit -m "feat(memories): assistant_memories 表——产品线级短期记忆存储(R1)"
```

---

### Task 2: memories 核心服务（loadActiveMemories / buildMemoriesSection / upsertMemory / findMemoriesByTitle）

**Files:**
- Create: `apps/api/src/pi/space/memories.ts`
- Test: `apps/api/test/space-memories.test.ts`（本 task 先建骨架 + 服务层用例）

- [ ] **Step 1: 写失败测试（服务层）**

新建 `apps/api/test/space-memories.test.ts`（骨架仿 `space-guides.test.ts`）：

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject, seedProductLineInOrg, seedProjectInOrg } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let managerApp: import('express').Express;
let memberApp: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: exp } = await import('express');
  const { spaceRoute } = await import('../src/pi/space/router.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf, memberUserOf } = await import('./helpers/auth.js');
  const mount = (user: ReturnType<typeof managerUserOf>) => {
    const a = exp();
    a.use(exp.json());
    a.use((req, _res, next) => { req.user = user; next(); });
    a.use('/api/assistant', spaceRoute);
    a.use(errorHandler);
    return a;
  };
  managerApp = mount(managerUserOf(userId, username, orgId, orgPath));
  memberApp = mount(memberUserOf(userId, username, orgId, orgPath));
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_memories`);
});

describe('R1 memories：服务层', () => {
  it('loadActiveMemories：global+本线可见、他线不泄漏、非 active 不可见、updatedAt 降序', async () => {
    const { projectId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    const otherLine = await seedProductLineInOrg(pool, (await seedOrg(pool)).orgId, `他线-${randomUUID().slice(0, 8)}`);
    await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance, status) VALUES
      ($1,'product_line',$2,'A-本线','hook-a','user_stated','active'),
      ($3,'global',NULL,'B-全局','hook-b','user_stated','active'),
      ($4,'product_line',$5,'C-他线','hook-c','user_stated','active'),
      ($6,'product_line',$2,'D-退役','hook-d','user_stated','retired_solidified'),
      ($7,'product_line',$2,'E-删除','hook-e','user_stated','deleted')`,
      [randomUUID(), lineId, randomUUID(), randomUUID(), otherLine, randomUUID(), randomUUID()]);
    const { loadActiveMemories } = await import('../src/pi/space/memories.js');
    const rows = await loadActiveMemories(lineId);
    expect(rows.map((r) => r.title).sort()).toEqual(['A-本线', 'B-全局']);
  });

  it('loadActiveMemories：updatedAt 降序（新写的排前面）', async () => {
    const { projectId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance) VALUES
      ($1,'product_line',$2,'旧','旧 hook','user_stated')`, [randomUUID(), lineId]);
    await new Promise((r) => setTimeout(r, 20));
    await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance) VALUES
      ($1,'product_line',$2,'新','新 hook','user_stated')`, [randomUUID(), lineId]);
    const { loadActiveMemories } = await import('../src/pi/space/memories.js');
    const rows = await loadActiveMemories(lineId);
    expect(rows[0]!.title).toBe('新');
  });

  it('buildMemoriesSection：空返回空串；正常渲染含标题/hook/说明脚注', async () => {
    const { buildMemoriesSection } = await import('../src/pi/space/memories.js');
    expect(buildMemoriesSection([])).toBe('');
    const out = buildMemoriesSection([
      { title: '登录页特殊行为', hook: '必须先关掉公告弹窗才能点登录按钮' },
      { title: '测试账号怪癖', hook: '未验证：admin 账号连续失败 3 次锁 10 分钟' },
    ]);
    expect(out).toContain('# 产品线记忆（历史会话沉淀的经验）');
    expect(out).toContain('- [登录页特殊行为] 必须先关掉公告弹窗才能点登录按钮');
    expect(out).toContain('- [测试账号怪癖] 未验证：admin 账号连续失败 3 次锁 10 分钟');
    expect(out).toContain('read_memory');
    expect(out).toContain('save_memory');
  });

  it('buildMemoriesSection：超字符预算截断到最近完整行（不产生半行）', async () => {
    const { buildMemoriesSection } = await import('../src/pi/space/memories.js');
    const rows = Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, hook: 'x'.repeat(200) }));
    const out = buildMemoriesSection(rows);
    expect(out.length).toBeLessThanOrEqual(4_200); // 预算 4000 + 头脚余量
    for (const line of out.split('\n')) {
      expect(line === '' || line.startsWith('#') || line.startsWith('- [') || !line.startsWith('-')).toBe(true);
    }
    expect(out).not.toContain('- [T29]'); // 30×~210 字符必然超 4000，尾部被截
  });

  it('upsertMemory：同 title active 行更新不新建；retired 同名行不算命中', async () => {
    const { upsertMemory } = await import('../src/pi/space/memories.js');
    const lineId = (await seedProductLineInOrg(pool, (await seedOrg(pool)).orgId, `线-${randomUUID().slice(0, 8)}`));
    const base = { scope: 'product_line' as const, productLineId: lineId, title: '标题', provenance: 'user_stated' as const, sourceThreadId: null, createdByUserId: null };
    expect(await upsertMemory({ ...base, hook: 'v1', body: null })).toBe('created');
    expect(await upsertMemory({ ...base, hook: 'v2', body: '正文' })).toBe('updated');
    let n = (await pool.query(`SELECT count(*)::int n, max(hook) hook FROM assistant_memories WHERE title='标题'`)).rows[0]!;
    expect(n.n).toBe(1);
    expect(n.hook).toBe('v2');
    await pool.query(`UPDATE assistant_memories SET status='retired_stale' WHERE title='标题'`);
    expect(await upsertMemory({ ...base, hook: 'v3', body: null })).toBe('created');
    n = (await pool.query(`SELECT count(*)::int n FROM assistant_memories WHERE title='标题'`)).rows[0]!;
    expect(n.n).toBe(2);
  });

  it('findMemoriesByTitle：ILIKE 模糊命中 active+可见作用域', async () => {
    const { projectId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance) VALUES
      ($1,'product_line',$2,'登录页特殊行为','h','user_stated'),
      ($3,'global',NULL,'登录接口怪癖','h','user_stated')`,
      [randomUUID(), lineId, randomUUID()]);
    const { findMemoriesByTitle } = await import('../src/pi/space/memories.js');
    const hits = await findMemoriesByTitle(lineId, '登录');
    expect(hits.map((h) => h.title).sort()).toEqual(['登录接口怪癖', '登录页特殊行为']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/space-memories.test.ts`
Expected: FAIL——`Cannot find module '../src/pi/space/memories.js'`

- [ ] **Step 3: 实现 memories.ts**

新建 `apps/api/src/pi/space/memories.ts`：

```ts
/**
 * 短期记忆体（产品线级）核心服务：加载/渲染/upsert/模糊查。
 * 设计：docs/superpowers/specs/2026-10-31-assistant-shortterm-memory-design.md
 * 注入走 buildSpaceSystemPrompt 记忆索引段（guides 同轨，每轮重算热生效）。
 */
import { and, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantMemories, projects } from '../../db/schema.js';

export type AssistantMemoryRow = typeof assistantMemories.$inferSelect;

/** 注入预算（硬编码常量；膨胀治理归 R3 退役机制，不做配置项）。 */
export const MEMORY_MAX_ENTRIES = 50;
export const MEMORY_SECTION_MAX_CHARS = 4_000;

/** 项目 → 产品线解析（save_memory 与会话工厂注入共用）。项目必归线（结构不变式）。 */
export async function resolveProductLineId(projectId: string): Promise<string | null> {
  const rows = await db.select({ id: projects.productLineId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  return rows[0]?.id ?? null;
}

/** 加载某产品线可见的 active 记忆（global + 本线），updatedAt 降序，条数上限截断。 */
export async function loadActiveMemories(productLineId: string): Promise<AssistantMemoryRow[]> {
  return db.select().from(assistantMemories)
    .where(and(
      eq(assistantMemories.status, 'active'),
      or(
        eq(assistantMemories.scope, 'global'),
        and(eq(assistantMemories.scope, 'product_line'), eq(assistantMemories.productLineId, productLineId)),
      ),
    ))
    .orderBy(desc(assistantMemories.updatedAt))
    .limit(MEMORY_MAX_ENTRIES);
}

/** 渲染记忆索引段：`- [title] hook` 每条一行 + 脚注；超字符预算截到最近完整行；空 → ''。 */
export function buildMemoriesSection(rows: Array<Pick<AssistantMemoryRow, 'title' | 'hook'>>): string {
  if (rows.length === 0) return '';
  const header = '# 产品线记忆（历史会话沉淀的经验）';
  const footer = '需要完整内容时调用 read_memory；用户要求记住的事实用 save_memory。';
  const kept: string[] = [];
  for (const r of rows) {
    const line = `- [${r.title}] ${r.hook}`;
    const size = header.length + footer.length + [...kept, line].join('\n').length + 2;
    if (kept.length > 0 && size > MEMORY_SECTION_MAX_CHARS) break;
    kept.push(line);
  }
  return `${header}\n${kept.join('\n')}\n${footer}`;
}

/** upsert：同 (scope, productLineId, title) 的 active 行存在则更新，否则插入。
 *  返回 'created' | 'updated'——工具据此告知模型，形成防重复写的反馈回路。 */
export async function upsertMemory(input: {
  scope: 'product_line' | 'global';
  productLineId: string | null;
  title: string;
  hook: string;
  body: string | null;
  provenance: 'user_stated' | 'ai_inferred';
  sourceThreadId: string | null;
  createdByUserId: string | null;
}): Promise<'created' | 'updated'> {
  const existing = (await db.select().from(assistantMemories)
    .where(and(
      eq(assistantMemories.status, 'active'),
      eq(assistantMemories.scope, input.scope),
      input.productLineId
        ? eq(assistantMemories.productLineId, input.productLineId)
        : isNull(assistantMemories.productLineId),
      eq(assistantMemories.title, input.title),
    )).limit(1))[0];
  if (existing) {
    await db.update(assistantMemories)
      .set({ hook: input.hook, body: input.body, provenance: input.provenance, updatedAt: new Date() })
      .where(eq(assistantMemories.id, existing.id));
    return 'updated';
  }
  await db.insert(assistantMemories).values({
    scope: input.scope,
    productLineId: input.productLineId,
    title: input.title,
    hook: input.hook,
    body: input.body,
    provenance: input.provenance,
    sourceThreadId: input.sourceThreadId,
    createdByUserId: input.createdByUserId,
  });
  return 'created';
}

/** read_memory 的模糊查：active + 可见作用域（global/本线）ILIKE %title%，updatedAt 降序。 */
export async function findMemoriesByTitle(productLineId: string, title: string): Promise<AssistantMemoryRow[]> {
  return db.select().from(assistantMemories)
    .where(and(
      eq(assistantMemories.status, 'active'),
      or(
        eq(assistantMemories.scope, 'global'),
        and(eq(assistantMemories.scope, 'product_line'), eq(assistantMemories.productLineId, productLineId)),
      ),
      ilike(assistantMemories.title, `%${title}%`),
    ))
    .orderBy(desc(assistantMemories.updatedAt));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/api exec vitest run test/space-memories.test.ts`
Expected: PASS（6 个服务层用例全绿）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/space/memories.ts apps/api/test/space-memories.test.ts
git commit -m "feat(memories): 记忆核心服务——加载/索引渲染/upsert/模糊查(R1)"
```

---

### Task 3: save_memory / read_memory 工具 + 注册

**Files:**
- Create: `apps/api/src/pi/space/tools/memories.ts`
- Modify: `apps/api/src/pi/space/tools/index.ts`（import 区 + buildSpaceTools 内注册，line 71 附近）
- Test: `apps/api/test/space-memories.test.ts`（追加 describe）

- [ ] **Step 1: 追加失败测试（工具层）**

在 `space-memories.test.ts` 追加（文件顶部 helper 区已有 seedProject；工具 ctx 用真实 projectId）：

```ts
describe('R1 memories：工具层', () => {
  async function toolCtx(projectId: string) {
    const { emptyRepoState } = await import('../src/pi/space/tools/context.js');
    return {
      threadId: randomUUID(), versionId: randomUUID(), projectId,
      repo: emptyRepoState(), emit: () => {}, createdByUserId: null, manager: true,
    };
  }

  it('save_memory：新建/更新语义 + product_line 解析 + global 不查线', async () => {
    const { buildSaveMemoryTool } = await import('../src/pi/space/tools/memories.js');
    const { projectId } = await seedProject(pool);
    const tool = buildSaveMemoryTool(await toolCtx(projectId));
    const r1 = await tool.execute({ title: '环境怪癖', hook: '测试环境每晚 2 点重启', provenance: 'user_stated' });
    expect(r1.ok).toBe(true);
    expect((r1 as { ok: true; data: string }).data).toContain('新建');
    const r2 = await tool.execute({ title: '环境怪癖', hook: '测试环境每晚 2 点重启（已证实）', provenance: 'user_stated' });
    expect((r2 as { ok: true; data: string }).data).toContain('更新');
    const g = await tool.execute({ title: '平台事实', hook: '附件下载有 24h 过期', provenance: 'user_stated', scope: 'global' });
    expect(g.ok).toBe(true);
  });

  it('save_memory：项目不存在时 product_line 报错不写入', async () => {
    const { buildSaveMemoryTool } = await import('../src/pi/space/tools/memories.js');
    const tool = buildSaveMemoryTool(await toolCtx(randomUUID()));
    const r = await tool.execute({ title: 'X', hook: 'Y', provenance: 'user_stated' });
    expect(r.ok).toBe(false);
  });

  it('read_memory：模糊命中返回正文 + hit_count 递增；找不到给可用标题清单', async () => {
    const { buildSaveMemoryTool, buildReadMemoryTool } = await import('../src/pi/space/tools/memories.js');
    const { projectId } = await seedProject(pool);
    const ctx = await toolCtx(projectId);
    await buildSaveMemoryTool(ctx).execute({ title: '登录页特殊行为', hook: '先关弹窗', body: '公告弹窗出现在登录页首次加载，selector .announce-modal，必须先点右上角关闭才能点登录按钮。', provenance: 'ai_inferred' });
    const read = buildReadMemoryTool(ctx);
    const r = await read.execute({ title: '登录页' });
    expect(r.ok).toBe(true);
    const data = JSON.parse((r as { ok: true; data: string }).data);
    expect(data.body).toContain('announce-modal');
    const hit = (await pool.query(`SELECT hit_count::int h FROM assistant_memories WHERE title='登录页特殊行为'`)).rows[0]!;
    expect(hit.h).toBe(1);
    const miss = await read.execute({ title: '不存在的主题' });
    expect(miss.ok).toBe(false);
    expect((miss as { ok: false; error: string }).error).toContain('登录页特殊行为');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/space-memories.test.ts`
Expected: 工具层用例 FAIL——`Cannot find module '../src/pi/space/tools/memories.js'`

- [ ] **Step 3: 实现工具文件**

新建 `apps/api/src/pi/space/tools/memories.ts`：

```ts
/**
 * 短期记忆工具对：save_memory（模型自写，门禁内置 description）+ read_memory（取正文+埋点）。
 * chat / rca 线程均注册（rca 发现的坑同样值得记，溯源靠 source_thread_id）。
 * 门禁与 Claude Code auto-memory 同语义：只记产品线级长期经验；
 * 未验证归因须 provenance=ai_inferred 且 hook 以「未验证：」开头；先读后写，更新优先于新建。
 */
import { Type } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import type { ToolExecutor } from '../../tools.js';
import { db } from '../../../db/client.js';
import { assistantMemories } from '../../../db/schema.js';
import type { SpaceToolsContext } from './context.js';
import { findMemoriesByTitle, loadActiveMemories, resolveProductLineId, upsertMemory } from '../memories.js';

export function buildSaveMemoryTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'save_memory',
    description: '把对当前产品线长期有价值的经验写入共享短期记忆（同线所有后续会话的提示词可见索引行）。该记：用户显式说「记住 X」；verify_case/执行结果证实的踩坑结论；产品线环境事实（账号怪癖、环境特殊行为）。不该记：能从代码/DB/guides 推导的信息；会话临时状态（当前进度）；未经验证的归因——确要记必须 provenance=ai_inferred 且 hook 以「未验证：」开头。同 title 已存在时自动更新（先读后写，更新优先于新建）。',
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 120 }),
      hook: Type.String({ minLength: 1, maxLength: 200 }),
      body: Type.Optional(Type.String()),
      provenance: Type.Union([Type.Literal('user_stated'), Type.Literal('ai_inferred')]),
      scope: Type.Optional(Type.Union([Type.Literal('product_line'), Type.Literal('global')])),
    }),
    execute: async (input) => {
      const p = input as {
        title: string; hook: string; body?: string;
        provenance: 'user_stated' | 'ai_inferred';
        scope?: 'product_line' | 'global';
      };
      const scope = p.scope ?? 'product_line';
      let lineId: string | null = null;
      if (scope === 'product_line') {
        lineId = await resolveProductLineId(ctx.projectId);
        if (!lineId) return { ok: false, error: `无法解析当前项目的产品线（projectId=${ctx.projectId}），本次未写入` };
      }
      const result = await upsertMemory({
        scope,
        productLineId: lineId,
        title: p.title.trim(),
        hook: p.hook.trim(),
        body: p.body?.trim() || null,
        provenance: p.provenance,
        sourceThreadId: ctx.threadId,
        createdByUserId: ctx.createdByUserId,
      });
      return { ok: true, data: result === 'created' ? `已新建记忆「${p.title.trim()}」` : `已更新已有记忆「${p.title.trim()}」` };
    },
  };
}

export function buildReadMemoryTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'read_memory',
    description: '按标题模糊读取当前产品线可见的记忆完整内容（含 global）。提示词的「产品线记忆」索引段只有一行 hook；需要 body、provenance、更新时间等完整信息时用本工具。',
    parameters: Type.Object({ title: Type.String({ minLength: 1 }) }),
    execute: async (input) => {
      const { title } = input as { title: string };
      const lineId = await resolveProductLineId(ctx.projectId);
      if (!lineId) return { ok: false, error: `无法解析当前项目的产品线（projectId=${ctx.projectId}）` };
      const hits = await findMemoriesByTitle(lineId, title.trim());
      if (hits.length === 0) {
        const all = await loadActiveMemories(lineId);
        const names = all.map((m) => m.title).join('、') || '（无）';
        return { ok: false, error: `没有匹配「${title}」的记忆。可用标题：${names}` };
      }
      // 多命中取 updatedAt 最新一条；R5 埋点：命中计数
      const hit = hits[0]!;
      await db.update(assistantMemories)
        .set({ hitCount: hit.hitCount + 1, lastHitAt: new Date() })
        .where(eq(assistantMemories.id, hit.id));
      return {
        ok: true,
        data: JSON.stringify({
          title: hit.title, hook: hit.hook, body: hit.body,
          provenance: hit.provenance, updatedAt: hit.updatedAt,
        }),
      };
    },
  };
}

export function buildMemoryTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [buildSaveMemoryTool(ctx), buildReadMemoryTool(ctx)];
}
```

- [ ] **Step 4: 注册进 buildSpaceTools**

`apps/api/src/pi/space/tools/index.ts`：
import 区（`buildSaveRcaResultTool` import 之后）加：

```ts
import { buildMemoryTools } from './memories.js';
```

`buildSpaceTools` 内 `tools.push(buildReadSkillTool());` 行后加：

```ts
  // R1 短期记忆：chat/rca 线程均可用（产品线内共享，写入门禁在工具 description）
  tools.push(...buildMemoryTools(ctx));
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -C apps/api exec vitest run test/space-memories.test.ts`
Expected: PASS（服务层 + 工具层全绿）

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pi/space/tools/memories.ts apps/api/src/pi/space/tools/index.ts apps/api/test/space-memories.test.ts
git commit -m "feat(memories): save_memory/read_memory 工具——模型自写+按需读+命中埋点(R1)"
```

---

### Task 4: system prompt 记忆索引段注入

**Files:**
- Modify: `apps/api/src/pi/space/session.ts`（`buildSpaceSystemPrompt` line 639-653；工厂 guides 加载块 line 723-730 后；`appendSystemPromptOverride` line 759）
- Test: `apps/api/test/space-memories.test.ts`（追加 describe）

- [ ] **Step 1: 追加失败测试（注入层）**

```ts
describe('R1 memories：system prompt 注入', () => {
  it('零记忆时输出与旧构造完全一致（回归红线）', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const withMem = buildSpaceSystemPrompt('SUMMARY', 'zh-CN', [{ kind: 'flow', body: 'F' }], '');
    const noArg = buildSpaceSystemPrompt('SUMMARY', 'zh-CN', [{ kind: 'flow', body: 'F' }]);
    expect(withMem).toBe(noArg);
    expect(withMem).not.toContain('产品线记忆');
  });

  it('记忆段位于 guides 段之后、workspace 段之前', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const { buildMemoriesSection } = await import('../src/pi/space/memories.js');
    const mem = buildMemoriesSection([{ title: 'T', hook: 'H' }]);
    const out = buildSpaceSystemPrompt(null, 'zh-CN', [], mem);
    const iGuides = out.indexOf('# 流程指令');
    const iMem = out.indexOf('# 产品线记忆');
    const iWorkspace = out.indexOf('## 工作空间');
    expect(iMem).toBeGreaterThan(-1);
    expect(iMem).toBeGreaterThan(iGuides === -1 ? -Infinity : iGuides);
    expect(iWorkspace).toBeGreaterThan(iMem);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/space-memories.test.ts`
Expected: 注入层 FAIL——`buildSpaceSystemPrompt` 第 4 参不存在（`toBe` 断言失败或 TS 报错由 vitest esbuild 忽略，运行时行为：额外实参被忽略则第一条用例可能意外通过，第二条必失败因签名无 memories）

- [ ] **Step 3: 改 buildSpaceSystemPrompt 与工厂**

`session.ts` import 区加：

```ts
import { buildMemoriesSection, loadActiveMemories, resolveProductLineId } from './memories.js';
```

`buildSpaceSystemPrompt`（line 639）签名与 body 构造改为：

```ts
export function buildSpaceSystemPrompt(
  summaryText: string | null,
  lang?: AiLang,
  guides: Array<Pick<AssistantGuideRow, 'kind' | 'body'>> = [],
  memoriesSection = '',
): string {
```

（函数体内部）原 `const body = [style, guidesSection, workspace].filter(Boolean).join('\n\n');` 改为：

```ts
  const body = [style, guidesSection, memoriesSection, workspace].filter(Boolean).join('\n\n');
```

工厂内 guides 加载块（`loadActiveGuides` try/catch，line 723-730）之后加：

```ts
  // R1 短期记忆：产品线级记忆索引段（global + 本线 active，updated_at 降序，预算内）。
  // 与 guides 同款容错：装载失败不拖垮会话工厂。
  let memoriesSection = '';
  try {
    const lineId = await resolveProductLineId(ctx.projectId);
    memoriesSection = lineId ? buildMemoriesSection(await loadActiveMemories(lineId)) : '';
  } catch (e) {
    logger.warn({ err: e, versionId: ctx.versionId }, 'memories 加载失败;继续无记忆段');
  }
```

line 759 的 override 改为：

```ts
    appendSystemPromptOverride: (base) => [...base, buildSpaceSystemPrompt(summaryText, ctx.lang, guides, memoriesSection)],
```

- [ ] **Step 4: 跑测试确认通过 + 全文件回归**

Run: `pnpm -C apps/api exec vitest run test/space-memories.test.ts`
Expected: PASS 全绿

Run: `pnpm -C apps/api exec vitest run test/space-guides.test.ts`
Expected: PASS（guides 零回归）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/space/session.ts apps/api/test/space-memories.test.ts
git commit -m "feat(memories): system prompt 记忆索引段——guides 后 workspace 前,零记忆零diff(R1)"
```

---

### Task 5: 管理端 REST 路由（列表 + 软删）

**Files:**
- Create: `apps/api/src/pi/space/memoriesRoute.ts`
- Modify: `apps/api/src/pi/space/router.ts`（import 区 + line 464 `spaceRoute.use('/skills', ...)` 后）
- Test: `apps/api/test/space-memories.test.ts`（追加 describe）

- [ ] **Step 1: 追加失败测试（路由层）**

```ts
describe('R1 memories：管理路由', () => {
  it('GET：global + 本组织线可见，他组织线不可见；带 productLineName', async () => {
    const org1 = await seedOrg(pool);
    const line1 = await seedProductLineInOrg(pool, org1.orgId, `本线-${randomUUID().slice(0, 8)}`);
    // 第二组织 + 该组织下的线（manager 不在其子树）
    const org2Id = randomUUID();
    await pool.query(`INSERT INTO organizations(id, name, path) VALUES ($1,$2,$3)`, [org2Id, `他组织-${org2Id.slice(0, 8)}`, `/${org2Id}/`]);
    const line2 = await seedProductLineInOrg(pool, org2Id, `他线-${randomUUID().slice(0, 8)}`);
    await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance) VALUES
      ($1,'product_line',$2,'本线记忆','h','user_stated'),
      ($3,'global',NULL,'全局记忆','h','user_stated'),
      ($4,'product_line',$5,'他组织线记忆','h','user_stated')`,
      [randomUUID(), line1, randomUUID(), randomUUID(), line2]);
    const res = await request(managerApp).get('/api/assistant/memories');
    expect(res.status).toBe(200);
    const titles = (res.body as Array<{ title: string; productLineName: string | null }>).map((r) => r.title);
    expect(titles).toContain('本线记忆');
    expect(titles).toContain('全局记忆');
    expect(titles).not.toContain('他组织线记忆');
    const mine = (res.body as Array<{ title: string; productLineName: string | null }>).find((r) => r.title === '本线记忆');
    expect(mine!.productLineName).toBeTruthy();
  });

  it('DELETE：软删（行保留 status=deleted），loadActiveMemories 不再返回；member 403', async () => {
    const { projectId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    const id = randomUUID();
    await pool.query(`INSERT INTO assistant_memories (id, scope, product_line_id, title, hook, provenance) VALUES ($1,'product_line',$2,'待删','h','user_stated')`, [id, lineId]);
    const forbidden = await request(memberApp).delete(`/api/assistant/memories/${id}`);
    expect(forbidden.status).toBe(403);
    const res = await request(managerApp).delete(`/api/assistant/memories/${id}`);
    expect(res.status).toBe(204);
    const row = (await pool.query(`SELECT status FROM assistant_memories WHERE id=$1`, [id])).rows[0]!;
    expect(row.status).toBe('deleted');
    const { loadActiveMemories } = await import('../src/pi/space/memories.js');
    expect((await loadActiveMemories(lineId)).map((r) => r.title)).not.toContain('待删');
  });

  it('GET ?status=deleted：软删行可查（审计）', async () => {
    await pool.query(`INSERT INTO assistant_memories (id, scope, title, hook, provenance, status) VALUES ($1,'global','已删','h','user_stated','deleted')`, [randomUUID()]);
    const res = await request(managerApp).get('/api/assistant/memories?status=deleted');
    expect(res.status).toBe(200);
    expect((res.body as Array<{ title: string }>).some((r) => r.title === '已删')).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/space-memories.test.ts`
Expected: 路由层 FAIL——GET 404（路由不存在）

- [ ] **Step 3: 实现 memoriesRoute.ts**

新建 `apps/api/src/pi/space/memoriesRoute.ts`：

```ts
/**
 * assistant_memories 管理端（设置页「助手记忆」）：GET 列表 + DELETE 软删。
 * 挂载于 /api/assistant/memories，router.ts 处 requireManager 保护。
 * 可见性（guidesRoute 同口径）：global 实例级共享；product_line 归属组织，
 * 仅该组织子树用户可见（visibleProductLineIds），跨组织一律不返回。
 */
import { Router } from 'express';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantMemories, productLines } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AuthUser } from '../../services/auth.service.js';
import { assertProductLineVisible, visibleProductLineIds } from '../../services/projectAccess.js';

export const memoriesRoute = Router();

memoriesRoute.get('/', async (req, res) => {
  const user = req.user as AuthUser;
  const q = req.query;
  const conds: SQL[] = [];
  if (typeof q.status === 'string' && q.status) conds.push(eq(assistantMemories.status, q.status));
  if (typeof q.productLineId === 'string' && q.productLineId) conds.push(eq(assistantMemories.productLineId, q.productLineId));
  const rows = await db
    .select({
      id: assistantMemories.id,
      scope: assistantMemories.scope,
      productLineId: assistantMemories.productLineId,
      productLineName: productLines.name,
      title: assistantMemories.title,
      hook: assistantMemories.hook,
      body: assistantMemories.body,
      provenance: assistantMemories.provenance,
      status: assistantMemories.status,
      hitCount: assistantMemories.hitCount,
      lastHitAt: assistantMemories.lastHitAt,
      createdByUserId: assistantMemories.createdByUserId,
      createdAt: assistantMemories.createdAt,
      updatedAt: assistantMemories.updatedAt,
    })
    .from(assistantMemories)
    .leftJoin(productLines, eq(assistantMemories.productLineId, productLines.id))
    .where(and(...conds))
    .orderBy(desc(assistantMemories.updatedAt))
    .limit(500);
  const visible = new Set(await visibleProductLineIds(user));
  res.json(rows.filter((r) => r.scope === 'global' || (r.productLineId != null && visible.has(r.productLineId))));
});

memoriesRoute.delete('/:id', async (req, res) => {
  const user = req.user as AuthUser;
  const existing = (await db.select().from(assistantMemories).where(eq(assistantMemories.id, req.params.id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', '记忆不存在');
  if (existing.scope === 'product_line' && existing.productLineId) {
    await assertProductLineVisible(existing.productLineId, user);
  }
  // 软删保审计（R3/R5 消费轨迹）；注入与工具只取 active → 删除即从助手侧消失
  await db.update(assistantMemories)
    .set({ status: 'deleted', updatedAt: new Date() })
    .where(eq(assistantMemories.id, req.params.id));
  res.status(204).end();
});
```

- [ ] **Step 4: 挂载路由**

`router.ts` import 区（guidesRoute import 旁）加：

```ts
import { memoriesRoute } from './memoriesRoute.js';
```

line 464 `spaceRoute.use('/skills', requireManager, skillsRoute);` 后加：

```ts
spaceRoute.use('/memories', requireManager, memoriesRoute);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -C apps/api exec vitest run test/space-memories.test.ts`
Expected: PASS 全绿（服务/工具/注入/路由四层）

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pi/space/memoriesRoute.ts apps/api/src/pi/space/router.ts apps/api/test/space-memories.test.ts
git commit -m "feat(memories): 管理端列表+软删路由——产品线可见性隔离(R1)"
```

---

### Task 6: web 管理界面（api client + MemoriesSection + i18n）

**Files:**
- Modify: `apps/web/src/api/client.ts`（`AssistantMcpServer` 接口旁加类型；`api.assistant` 块 `mcpServers` 前加 `memories`，line ~717）
- Create: `apps/web/src/components/settings/MemoriesSection.tsx`
- Modify: `apps/web/src/components/settings/AssistantPanel.tsx`（import + `<MemoriesSection />`）
- Modify: `apps/web/src/i18n/locales/zh-CN/settings.json`、`apps/web/src/i18n/locales/en-US/settings.json`

- [ ] **Step 1: client.ts 加类型与方法**

在 `AssistantMcpServer` interface 定义旁（grep `interface AssistantMcpServer` 定位）新增：

```ts
/** 助手短期记忆行（GET /assistant/memories；productLineName 由路由 join 带出）。 */
export interface AssistantMemory {
  id: string;
  scope: 'product_line' | 'global';
  productLineId: string | null;
  productLineName: string | null;
  title: string;
  hook: string;
  body: string | null;
  provenance: 'user_stated' | 'ai_inferred';
  status: string;
  hitCount: number;
  lastHitAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

`api.assistant` 块内（`mcpServers:` 之前）加：

```ts
    /** 系统设置：助手短期记忆（只读+软删；写入唯一入口是助手 save_memory 工具）。 */
    memories: {
      list: (params?: { productLineId?: string; status?: string }) =>
        request<AssistantMemory[]>(`/assistant/memories${qs(params ?? {})}`),
      remove: (id: string) =>
        request<void>(`/assistant/memories/${id}`, { method: 'DELETE' }),
    },
```

- [ ] **Step 2: i18n 键**

`zh-CN/settings.json`（`mcpTitle` 键旁）追加：

```json
"memoryTitle": "助手记忆",
"memoryIntro": "产品线级短期记忆：助手在会话中自行沉淀的经验（save_memory 工具写入门禁内置），索引自动注入同线后续会话。此处仅查看与删除。",
"memoryNone": "暂无记忆",
"memoryScopeGlobal": "全局",
"memoryFilterAll": "全部作用域",
"memoryHits": "{{count}} 次查阅",
"memoryDeleteConfirm": "删除记忆「{{name}}」？删除后不再注入助手上下文。",
"memoryProvenanceUser": "用户明示",
"memoryProvenanceAi": "AI 归因"
```

`en-US/settings.json` 对应追加：

```json
"memoryTitle": "Assistant Memories",
"memoryIntro": "Product-line scoped short-term memory: experiences the assistant distills on its own (write gating built into the save_memory tool); index auto-injected into later sessions on the same line. View and delete only.",
"memoryNone": "No memories yet",
"memoryScopeGlobal": "Global",
"memoryFilterAll": "All scopes",
"memoryHits": "{{count}} lookups",
"memoryDeleteConfirm": "Delete memory \"{{name}}\"? It will no longer be injected into the assistant context.",
"memoryProvenanceUser": "User stated",
"memoryProvenanceAi": "AI inferred"
```

- [ ] **Step 3: MemoriesSection 组件**

新建 `apps/web/src/components/settings/MemoriesSection.tsx`（布局仿 AssistantPanel 内 McpServersSection；无编辑器、无 Toggle——只读+删除）：

```tsx
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { localizeApiError } from '../../i18n';
import { api, type AssistantMemory } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import IconButton from '../ui/IconButton';
import EmptyState from '../ui/EmptyState';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';

/** 设置页「助手记忆」：只读列表 + 软删（写入唯一入口是助手的 save_memory 工具）。 */
export default function MemoriesSection() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const listQ = useQuery({ queryKey: ['assistant-memories'], queryFn: () => api.assistant.memories.list() });
  const [lineFilter, setLineFilter] = useState('all');
  const [deleting, setDeleting] = useState<AssistantMemory | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.assistant.memories.remove(id),
    onSuccess: () => {
      toast(t('settings:saved'), 'success');
      setDeleting(null);
      qc.invalidateQueries({ queryKey: ['assistant-memories'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const rows = listQ.data ?? [];
  const lineOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.scope === 'product_line' && r.productLineId) m.set(r.productLineId, r.productLineName ?? r.productLineId);
    return Array.from(m.entries());
  }, [rows]);
  const filtered = lineFilter === 'all'
    ? rows
    : lineFilter === 'global'
      ? rows.filter((r) => r.scope === 'global')
      : rows.filter((r) => r.productLineId === lineFilter);

  return (
    <div className="bg-card border rounded-[var(--radius-sm)]">
      <div className="flex items-center gap-2 px-4 py-3 hairline-bottom" style={{ borderColor: 'var(--border)' }}>
        <Icon name="brain" size={14} style={{ color: 'var(--primary)' }} />
        <h3 className="text-[14px] font-semibold m-0 flex-1" style={{ color: 'var(--foreground)' }}>
          {t('settings:memoryTitle')}
        </h3>
        <select
          className="input-base"
          style={{ width: 'auto', fontSize: 12 }}
          value={lineFilter}
          onChange={(e) => setLineFilter(e.target.value)}
        >
          <option value="all">{t('settings:memoryFilterAll')}</option>
          <option value="global">{t('settings:memoryScopeGlobal')}</option>
          {lineOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </div>
      <div className="px-4 pt-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
        {t('settings:memoryIntro')}
      </div>
      <div className="p-2">
        {listQ.isLoading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={14} className="animate-spin" />
            {t('common:loading')}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState icon="brain" title={t('settings:memoryNone')} compact />
        ) : (
          filtered.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-2 py-2">
              <div className="flex flex-col min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium truncate" style={{ color: 'var(--foreground)' }}>{m.title}</span>
                  <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                    {m.scope === 'global' ? t('settings:memoryScopeGlobal') : (m.productLineName ?? '—')}
                  </span>
                  <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                    {m.provenance === 'user_stated' ? t('settings:memoryProvenanceUser') : t('settings:memoryProvenanceAi')}
                  </span>
                </div>
                <span className="text-[11px] truncate" style={{ color: 'var(--muted-foreground)' }}>{m.hook}</span>
              </div>
              <span className="text-[11px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                {t('settings:memoryHits', { count: m.hitCount })}
              </span>
              <IconButton icon="trash" tone="destructive" title={t('common:delete')} onClick={() => setDeleting(m)} />
            </div>
          ))
        )}
      </div>

      <Dialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings:memoryDeleteConfirm', { name: deleting?.title })}</DialogTitle>
          </DialogHeader>
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="ghost" onClick={() => setDeleting(null)}>{t('common:cancel')}</Button>
            <Button variant="danger" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting.id)}>
              {t('common:delete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

组件 import 区为：`import Button from '../ui/Button';`（删除确认按钮用）。若 Icon 名 `brain` 在图标库不存在，换成已有名（grep `apps/web/src/components/Icon` 的 name 清单，选 `note`/`bookmark` 类）。

- [ ] **Step 4: 挂进 AssistantPanel**

`AssistantPanel.tsx` import 区加：

```tsx
import MemoriesSection from './MemoriesSection';
```

`<McpServersSection />` 与 `<SkillsSection />` 之间插入：

```tsx
      <MemoriesSection />
```

- [ ] **Step 5: 类型检查 + web 测试回归**

Run: `pnpm -C apps/web run typecheck`（若无此 script 则 `pnpm -C apps/web exec tsc --noEmit`）
Expected: exit 0

Run: `pnpm -C apps/web exec vitest run`（若 web 测试较慢可只跑 `src/features/space-assistant` 相关）
Expected: 无新增失败（基线红名单见 memory：sendSyslog 等既有失败不算回归）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/components/settings/MemoriesSection.tsx apps/web/src/components/settings/AssistantPanel.tsx apps/web/src/i18n/locales/zh-CN/settings.json apps/web/src/i18n/locales/en-US/settings.json
git commit -m "feat(memories): 设置页助手记忆管理——只读+软删+作用域筛选(R1)"
```

---

### Task 7: 全量回归 + 手工 E2E + 收尾

**Files:** 无新增（验证任务）

- [ ] **Step 1: api 单测全量**

Run: `pnpm -C apps/api run test`
Expected: 除既有基线红（sendSyslog 等 memory 记录项）外全绿；`space-memories.test.ts` 必须全绿

- [ ] **Step 2: 手工 E2E（dev 双进程）**

```bash
# 终端 1（api；ENCRYPTION_KEY/CHROMIUM_PATH 值见 .env / 部署文档）
ENCRYPTION_KEY=<dev值> CHROMIUM_PATH=<chromium路径> pnpm -C apps/api run dev
# 终端 2
pnpm -C apps/web run dev
```

验证链路（浏览器）：
1. 打开任意项目版本空间，对助手说「记住：测试环境的公告弹窗要先关掉才能登录」→ 助手应调 save_memory 并回复已记住
2. 新建一个**同产品线**另一版本的空间线程 → 助手 system prompt 含「# 产品线记忆」索引行（或直接问「你记得哪些经验？」它不查工具就能复述 hook）
3. 问「详细说说公告弹窗」→ 助手调 read_memory 取 body
4. 设置 → 助手面板 → 助手记忆：能看到该条（产品线 badge + provenance badge），删除后再开新线程问 → 不再知晓
5. 回归确认：设置页 MCP/Skills/Feedback 三节不受影响

- [ ] **Step 3: 收尾核查**

Run: `git status --short`
Expected: 干净（或仅本需求文件）；发现 `step-dsl-spec.ts` 等陌生源码改动 = 测试污染，立即还原

Run: `git log --oneline -6`
Expected: 6 个本需求提交（Task 1-6 各一）

---

## Self-Review 记录

- **Spec 覆盖**：schema（§3→Task 1）、写入路径+门禁（§4→Task 3）、注入+读取（§5→Task 2/4）、管理界面（§6→Task 5/6）、R3 预留（§7→status/retired_by_batch 列，Task 1）、测试矩阵（§8→各 Task 内嵌 + Task 7 E2E）、YAGNI 边界（§9→无编辑 UI/无配置项，确认未引入）
- **占位符**：无。全部步骤含完整代码（MemoriesSection 含删除确认真实按钮；Icon `brain` 名附 fallback 指引）
- **类型一致性**：`upsertMemory` 返回 `'created' | 'updated'`（服务/工具两处一致）；`buildSpaceSystemPrompt` 第 4 参 `memoriesSection: string`（工厂与测试一致）；`AssistantMemory` web 类型与路由 select 列一一对应（productLineName 由 join 带出）
