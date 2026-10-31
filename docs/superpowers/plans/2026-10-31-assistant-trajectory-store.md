# AI 助手轨迹库（R2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「需求 → 建用例 → verify_case 实测通过 → 用户确认落库」的成功会话轨迹后台蒸馏成结构化 exemplar 入库，同产品线后续建用例任务经 `search_trajectories` 检索 top-3 做 few-shot。

**Architecture:** 方案 A（R1 全同构）：DB 表 `assistant_trajectories`（product_line 作用域、status 软删、source_case_id partial unique）+ stageRoute 落库钩子投递 BullMQ 任务（rcaQueue 同构，无 REDIS 时 inline 降级）+ worker 读 pi-sessions JSONL 做**判据核实**（verify_case toolCall↔toolResult isError=false 链）后 LLM 蒸馏（llm-client 直调）+ system prompt 索引段（buildSpaceSystemPrompt 第 5 参）+ 管理路由/设置页（memoriesRoute/MemoriesSection 同构，可见性下推 SQL + error 分支）。

**Tech Stack:** drizzle + postgres、bullmq、@earendil-works/pi-ai TypeBox（工具参数）、zod（蒸馏输出校验）、react-query + i18next（web）。

**设计文档:** `docs/superpowers/specs/2026-10-31-assistant-trajectory-store-design.md`（已评审通过）

---

## 已核实的关键代码事实（实施者必读）

| 事实 | 位置/内容 |
|---|---|
| JSONL 会话记录 | `apps/api/.data/pi-sessions/<ISO>_<piThreadId>.jsonl`；`SESSIONS_ROOT` 在 `src/pi/space/session.ts:36` |
| toolCall 块 | assistant message content 内 `{type:'toolCall', id:'call_…', name:'verify_case', arguments:{caseId:'<stage localId>', …}}` |
| toolResult 消息 | 独立 message：`{role:'toolResult', toolCallId:'call_…', toolName, content:[{type:'text',text}], isError:boolean}` —— **isError 落盘**，成功判据 = `toolName==='verify_case' && isError===false`，id↔toolCallId 链接 |
| verify_case 参数 | `arguments.caseId` = stage localId（reqDesign.ts:109 「verify_case(caseId=<that localId>)」） |
| 落库钩子位点 | `src/pi/space/stageRoute.ts` `/stage/save`：step 2 删 stage 行（~L274）之后、`res.json`（~L276）之前；`createdCaseIds: Map<localId, realCaseId>` 在作用域内 |
| 队列先例 | `src/scheduler/rcaQueue.ts` 全文 65 行：Queue/Worker/enqueue（动态 import worker 防环 + 无 REDIS inline 降级 + try/catch warn）；worker 启动 `src/index.ts:87 void startRcaWorker()` |
| LLM 直调 | `readLlmConfig()`（`src/pi/modelBridge.ts`）→ `getLlmClient(cfg)` + `completeJson(client, req)`（`src/agent/llm-client.ts:97`，自带 JSON 重试 1 次）；`r.model` 为 distill_model 来源 |
| 线程归属 | `aiThreads.piThreadId`（schema.ts:104，text not null）；versionId→projectId 用 `resolveVersionProjectId`（`src/services/projectAccess.ts`，stageRoute.ts:21 已 import 先例）；projectId→lineId 用 R1 `resolveProductLineId`（`src/pi/space/memories.ts:17`） |
| 用例形态 | `testCases`（title/description/url/expectedOutcome）+ `testSteps`（caseId/order/instruction/assertion，schema.ts:250） |
| R1 同构件 | 服务 `src/pi/space/memories.ts`、工具 `src/pi/space/tools/memories.ts`、路由 `src/pi/space/memoriesRoute.ts`、注入 `session.ts` 工厂段（~L733-741）与 override（~L770）、web `MemoriesSection.tsx`、client.ts memories 组（~L718-723） |
| schema.ts 表定义风格 | `assistantMemories`（schema.ts:813-831）；extras 对象式 `(t) => ({…})`；**`uniqueIndex` 需新增 import**（现只有 `unique`） |
| 测试建表 | `test/helpers/db.ts` `SCHEMA_SQL` 模板串，assistant_memories DDL 在尾部（~L209-210），新 DDL 紧随其后 |
| zod 可用 | `src/pi/space/tools/stage-tools.ts:11 import { z } from 'zod'` 先例 |

**通用测试文件骨架**（Task 1 建立，后续任务往里加 describe）：仿 `test/space-memories.test.ts` —— PostgreSqlContainer + SCHEMA_SQL + seedOrg/seedProject + manager/member 双 app 挂载 `/api/assistant`。

---

### Task 1: DB schema——assistant_trajectories 表

**Files:**
- Modify: `apps/api/src/db/schema.ts`（assistantMemories 定义后，~L831 之后插入）
- Modify: `apps/api/test/helpers/db.ts`（SCHEMA_SQL 尾部追加 DDL）
- Create: `apps/api/test/space-trajectories.test.ts`

- [ ] **Step 1: 写失败的建表测试**

创建 `apps/api/test/space-trajectories.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject, seedProductLineInOrg } from './helpers/db.js';

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
  await pool.query(`TRUNCATE assistant_trajectories`);
});

describe('R2 trajectories：表与约束', () => {
  it('插入/查询往返；partial unique——同 source_case_id 双 active 插入第二次落空，软删后可再插', async () => {
    const { projectId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    const caseId = randomUUID();
    const base = `INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model, source_case_id)
      VALUES ($1,$2,'T','k','d','C','m',$3)`;
    await pool.query(base, [randomUUID(), lineId, caseId]);
    await pool.query(base, [randomUUID(), lineId, caseId]); // 必须不抛
    let n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(1);
    await pool.query(`UPDATE assistant_trajectories SET status='deleted' WHERE source_case_id=$1`, [caseId]);
    await pool.query(base, [randomUUID(), lineId, caseId]); // 软删后可再插
    n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(2);
  });

  it('删除产品线级联清除轨迹', async () => {
    const org = await seedOrg(pool);
    const lineId = await seedProductLineInOrg(pool, org.orgId, `线-${randomUUID().slice(0, 8)}`);
    await pool.query(`INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model)
      VALUES ($1,$2,'T','k','d','C','m')`, [randomUUID(), lineId]);
    await pool.query(`DELETE FROM product_lines WHERE id=$1`, [lineId]);
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && npx vitest run test/space-trajectories.test.ts`
Expected: FAIL——`relation "assistant_trajectories" does not exist`

- [ ] **Step 3: 加 schema 定义与测试 DDL**

`apps/api/src/db/schema.ts`：import 行补 `uniqueIndex`（`unique` 同款位置，drizzle-orm/pg-core）；在 `assistantMemories` 定义（~L831）之后插入：

```ts
// ── AI 助手轨迹库（产品线级，R2：成功用例生成轨迹的程序性记忆 exemplar）──
// 写入 = stage/save 落库钩子 → worker 读 pi-sessions JSONL 判据核实（verify_case
// toolResult isError=false）后 LLM 蒸馏入库；读取 = system prompt 索引段 +
// search_trajectories 工具。无 global 档：轨迹含锚点/URL 线特有细节，跨线泄漏
// 即事故。partial unique：一 case 一 active 轨迹，DB 层防重复蒸馏（R1 竞态教训）。
// R3 预留：retired_by_batch；R5 预留：hit_count/last_hit_at（search 埋点）。
export const assistantTrajectories = pgTable('assistant_trajectories', {
  id: uuid('id').primaryKey().defaultRandom(),
  productLineId: uuid('product_line_id').notNull().references(() => productLines.id, { onDelete: 'cascade' }),
  taskTitle: varchar('task_title', { length: 200 }).notNull(),
  taskKeywords: text('task_keywords').notNull(),
  digest: text('digest').notNull(),
  caseTitle: varchar('case_title', { length: 200 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  retiredByBatch: uuid('retired_by_batch'),
  sourceThreadId: uuid('source_thread_id'),
  sourceCaseId: uuid('source_case_id'),
  sourceProjectId: uuid('source_project_id'),
  sourceVersionId: uuid('source_version_id'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  distillModel: varchar('distill_model', { length: 64 }).notNull(),
  hitCount: integer('hit_count').notNull().default(0),
  lastHitAt: timestamp('last_hit_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  lineIdx: index('assistant_trajectories_line_idx').on(t.productLineId, t.status),
  caseUq: uniqueIndex('assistant_trajectories_case_uq').on(t.sourceCaseId).where(sql`status = 'active'`),
}));
```

（若 schema.ts 尚未 import `sql`，从 'drizzle-orm' 补。）

`apps/api/test/helpers/db.ts` SCHEMA_SQL 尾部（assistant_memories 两行后）追加：

```sql
CREATE TABLE assistant_trajectories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_line_id uuid REFERENCES product_lines(id) ON DELETE CASCADE NOT NULL, task_title varchar(200) NOT NULL, task_keywords text NOT NULL, digest text NOT NULL, case_title varchar(200) NOT NULL, status varchar(20) NOT NULL DEFAULT 'active', retired_by_batch uuid, source_thread_id uuid, source_case_id uuid, source_project_id uuid, source_version_id uuid, created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL, distill_model varchar(64) NOT NULL, hit_count integer NOT NULL DEFAULT 0, last_hit_at timestamp, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE INDEX assistant_trajectories_line_idx ON assistant_trajectories(product_line_id, status);
CREATE UNIQUE INDEX assistant_trajectories_case_uq ON assistant_trajectories(source_case_id) WHERE status = 'active';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && npx vitest run test/space-trajectories.test.ts`
Expected: PASS 2 tests

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/test/helpers/db.ts apps/api/test/space-trajectories.test.ts
git commit -m "feat(trajectories): assistant_trajectories 表——R2 成功用例轨迹存储"
```

---

### Task 2: 核心服务——加载/索引渲染/打分检索/幂等插入

**Files:**
- Create: `apps/api/src/pi/space/trajectories.ts`
- Test: `apps/api/test/space-trajectories.test.ts`（追加 describe）

- [ ] **Step 1: 写失败的服务层测试**

追加到 `test/space-trajectories.test.ts`：

```ts
describe('R2 trajectories：服务层', () => {
  async function lineOfSeed(): Promise<string> {
    const { projectId } = await seedProject(pool);
    return (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
  }
  async function insertRow(lineId: string, o: { title?: string; keywords?: string; caseTitle?: string; caseId?: string; ago?: number }) {
    await pool.query(`INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model, source_case_id, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'m',$7, now() - ($8 || ' seconds')::interval)`,
      [randomUUID(), lineId, o.title ?? 'T', o.keywords ?? 'k', 'digest-body', o.caseTitle ?? 'C', o.caseId ?? randomUUID(), String(o.ago ?? 0)]);
  }

  it('loadActiveTrajectories：本线 active 降序；他线/deleted 不泄漏', async () => {
    const lineId = await lineOfSeed();
    const otherLine = await seedProductLineInOrg(pool, (await seedOrg(pool)).orgId, `他线-${randomUUID().slice(0, 8)}`);
    await insertRow(lineId, { title: '旧', ago: 60 });
    await insertRow(lineId, { title: '新', ago: 0 });
    await insertRow(otherLine, { title: '他线行' });
    await insertRow(lineId, { title: '已删' });
    await pool.query(`UPDATE assistant_trajectories SET status='deleted' WHERE task_title='已删'`);
    const { loadActiveTrajectories } = await import('../src/pi/space/trajectories.js');
    const rows = await loadActiveTrajectories(lineId);
    expect(rows.map((r) => r.taskTitle)).toEqual(['新', '旧']);
  });

  it('buildTrajectoriesSection：空→''；正常含标题行+检索指引脚注；超预算截完整行', async () => {
    const { buildTrajectoriesSection, TRAJECTORY_SECTION_MAX_CHARS } = await import('../src/pi/space/trajectories.js');
    expect(buildTrajectoriesSection([])).toBe('');
    const out = buildTrajectoriesSection([
      { taskTitle: '登录失败锁定提示', caseTitle: '用户管理-登录-密码错误' },
      { taskTitle: '列表导出按钮遮蔽绕行', caseTitle: '事件管理-导出' },
    ]);
    expect(out).toContain('# 成功用例轨迹');
    expect(out).toContain('- 登录失败锁定提示（用例：用户管理-登录-密码错误）');
    expect(out).toContain('search_trajectories');
    const many = Array.from({ length: 60 }, (_, i) => ({ taskTitle: `T${i}${'x'.repeat(80)}`, caseTitle: `C${i}` }));
    const big = buildTrajectoriesSection(many);
    expect(big.length).toBeLessThanOrEqual(TRAJECTORY_SECTION_MAX_CHARS);
    big.split('\n').filter((l) => l.startsWith('- ')).forEach((l) => {
      expect(many.some((m) => `- ${m.taskTitle}（用例：${m.caseTitle}）`.startsWith(l) || l === `- ${m.taskTitle}（用例：${m.caseTitle}）`.slice(0, l.length))).toBe(true);
    });
  });

  it('searchTrajectoriesByQuery：命中字段数打分 top-3、同分 updatedAt 降序、命中行 hit_count +1；miss 返回空 hits 带全集', async () => {
    const lineId = await lineOfSeed();
    const c1 = randomUUID(), c2 = randomUUID(), c3 = randomUUID(), c4 = randomUUID();
    await insertRow(lineId, { title: '登录 失败 提示', keywords: '登录 密码错误', caseTitle: '登录用例', caseId: c1, ago: 300 });
    await insertRow(lineId, { title: '登录锁定', keywords: '账号锁', caseTitle: '登录用例B', caseId: c2, ago: 200 });
    await insertRow(lineId, { title: '列表导出', keywords: '导出 excel', caseTitle: '导出用例', caseId: c3, ago: 100 });
    await insertRow(otherLinePlaceholder(), { title: '他线', caseId: c4 });
    const { searchTrajectoriesByQuery } = await import('../src/pi/space/trajectories.js');
    const r = await searchTrajectoriesByQuery(lineId, '登录');
    expect(r.hits.length).toBe(2); // 只有 2 条含「登录」
    expect(r.hits[0]!.taskTitle).toBe('登录 失败 提示'); // title+keywords+caseTitle 三字段命中 > 单字段
    const hits = (await pool.query(`SELECT hit_count::int h FROM assistant_trajectories WHERE source_case_id = ANY($1) ORDER BY h`, [[c1, c2]])).rows;
    expect(hits.every((x) => x.h === 1)).toBe(true);
    const miss = await searchTrajectoriesByQuery(lineId, '不存在词');
    expect(miss.hits).toEqual([]);
    expect(miss.all.length).toBeGreaterThanOrEqual(3);
    function otherLinePlaceholder(): string { return lineIdOther; }
  });

  it('insertTrajectory：onConflictDoNothing——同 case 二次插入返回 false 不新建', async () => {
    const lineId = await lineOfSeed();
    const caseId = randomUUID();
    const { insertTrajectory } = await import('../src/pi/space/trajectories.js');
    const input = {
      productLineId: lineId, taskTitle: 'T', taskKeywords: 'k', digest: 'd', caseTitle: 'C',
      status: 'active' as const, retiredByBatch: null, sourceThreadId: null, sourceCaseId: caseId,
      sourceProjectId: null, sourceVersionId: null, createdByUserId: null, distillModel: 'm',
    };
    expect(await insertTrajectory(input)).toBe(true);
    expect(await insertTrajectory(input)).toBe(false);
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(1);
  });
});
```

注意：第 3 个用例里 `otherLinePlaceholder`/`lineIdOther` 是示意——实际写法直接在 it 内 `const lineOther = await seedProductLineInOrg(...)` 后 `await insertRow(lineOther, {...})`，写测试时理顺即可（勿留未定义引用）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && npx vitest run test/space-trajectories.test.ts`
Expected: FAIL——模块 `../src/pi/space/trajectories.js` 不存在

- [ ] **Step 3: 实现服务**

创建 `apps/api/src/pi/space/trajectories.ts`：

```ts
/**
 * 轨迹库（产品线级）核心服务：加载/索引渲染/打分检索/幂等插入。
 * 设计：docs/superpowers/specs/2026-10-31-assistant-trajectory-store-design.md
 * 注入走 buildSpaceSystemPrompt 轨迹索引段（线程冷构建时快照；会话内新鲜轨迹走
 * search_trajectories 实时查库）。
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantTrajectories } from '../../db/schema.js';

export type TrajectoryRow = typeof assistantTrajectories.$inferSelect;

/** 注入预算（硬编码常量；膨胀治理归 R3 退役机制）。 */
export const TRAJECTORY_MAX_LISTED = 10;
export const TRAJECTORY_SECTION_MAX_CHARS = 1_500;
/** 检索加载上限：线内轨迹量级安全网。 */
const SEARCH_SCAN_LIMIT = 200;
export const SEARCH_TOP_K = 3;

/** 加载某产品线 active 轨迹，updatedAt 降序。 */
export async function loadActiveTrajectories(productLineId: string): Promise<TrajectoryRow[]> {
  return db.select().from(assistantTrajectories)
    .where(and(eq(assistantTrajectories.productLineId, productLineId), eq(assistantTrajectories.status, 'active')))
    .orderBy(desc(assistantTrajectories.updatedAt))
    .limit(TRAJECTORY_MAX_LISTED);
}

/** 渲染轨迹索引段：一行指引 + `- task_title（用例：case_title）` 清单 + 脚注；空 → ''。 */
export function buildTrajectoriesSection(rows: Array<Pick<TrajectoryRow, 'taskTitle' | 'caseTitle'>>): string {
  if (rows.length === 0) return '';
  const header = '# 成功用例轨迹';
  const intro = '本产品线已沉淀同类任务的成功生成轨迹（按时间倒序）。开始设计用例前，先用任务关键词调用 search_trajectories 检索相似轨迹参考。';
  const footer = '参考轨迹取其决策思路与用例形态；锚点、URL、账号等线内事实必须以当前应用实测为准，禁止照抄。';
  const kept: string[] = [];
  for (const r of rows) {
    const line = `- ${r.taskTitle}（用例：${r.caseTitle}）`;
    const size = header.length + intro.length + footer.length + [...kept, line].join('\n').length + 3;
    if (kept.length > 0 && size > TRAJECTORY_SECTION_MAX_CHARS) break;
    kept.push(line);
  }
  return `${header}\n${intro}\n${kept.join('\n')}\n${footer}`;
}

/** 打分：query 按空白切词，term 对 taskTitle/taskKeywords/caseTitle 三字段做大小写不敏感包含，
 *  命中字段数为分。纯函数（测试直测）。 */
export function scoreTrajectory(
  row: Pick<TrajectoryRow, 'taskTitle' | 'taskKeywords' | 'caseTitle'>,
  query: string,
): number {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const fields = [row.taskTitle, row.taskKeywords, row.caseTitle].map((s) => s.toLowerCase());
  let score = 0;
  for (const f of fields) if (terms.some((t) => f.includes(t))) score += 1;
  return score;
}

/** 检索：线内 active 全量（≤SCAN_LIMIT）打分，top-k；命中行 hit_count/last_hit_at SQL 原子自增。
 *  返回 { hits, all }——miss 时 all 供工具层给可用标题清单（read_memory 模式）。 */
export async function searchTrajectoriesByQuery(
  productLineId: string,
  query: string,
): Promise<{ hits: TrajectoryRow[]; all: TrajectoryRow[] }> {
  const all = await db.select().from(assistantTrajectories)
    .where(and(eq(assistantTrajectories.productLineId, productLineId), eq(assistantTrajectories.status, 'active')))
    .orderBy(desc(assistantTrajectories.updatedAt))
    .limit(SEARCH_SCAN_LIMIT);
  const scored = all
    .map((r) => ({ r, s: scoreTrajectory(r, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.r.updatedAt.getTime() - a.r.updatedAt.getTime());
  const hits = scored.slice(0, SEARCH_TOP_K).map((x) => x.r);
  if (hits.length > 0) {
    // SQL 表达式自增：三副本并发不丢更新（R1 read_memory 同款）。
    await db.update(assistantTrajectories)
      .set({ hitCount: sql`${assistantTrajectories.hitCount} + 1`, lastHitAt: new Date() })
      .where(inArray(assistantTrajectories.id, hits.map((h) => h.id)));
  }
  return { hits, all };
}

/** 幂等插入：ON CONFLICT DO NOTHING（partial unique source_case_id where active）。
 *  返回是否真正插入。 */
export async function insertTrajectory(
  input: typeof assistantTrajectories.$inferInsert,
): Promise<boolean> {
  const rows = await db.insert(assistantTrajectories).values(input).onConflictDoNothing().returning({ id: assistantTrajectories.id });
  return rows.length > 0;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && npx vitest run test/space-trajectories.test.ts`
Expected: PASS 全部

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/space/trajectories.ts apps/api/test/space-trajectories.test.ts
git commit -m "feat(trajectories): 记忆核心服务——加载/索引渲染/打分检索/幂等插入(R2)"
```

---

### Task 3: JSONL 解析 + 判据核实（纯函数）

**Files:**
- Create: `apps/api/src/scheduler/trajectoryParse.ts`
- Test: `apps/api/test/trajectory-parse.test.ts`（纯函数测试，无容器）

- [ ] **Step 1: 写失败的解析测试**

创建 `apps/api/test/trajectory-parse.test.ts`：

```ts
import { describe, it, expect } from 'vitest';

/** 造一条 JSONL 行的辅助（形状见计划「已核实的关键代码事实」）。 */
function msgLine(role: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'message', id: Math.random().toString(36).slice(2), parentId: null, timestamp: new Date().toISOString(), message: { role, content, ...extra } });
}
const toolCallBlock = (id: string, name: string, args: Record<string, unknown>) => ({ type: 'toolCall', id, name, arguments: args });

describe('trajectoryParse：JSONL → 会话轮次', () => {
  it('parseSessionJsonl：user/assistant/toolResult 三类各就位；非 message 行跳过；坏行跳过', async () => {
    const { parseSessionJsonl } = await import('../src/scheduler/trajectoryParse.js');
    const jsonl = [
      JSON.stringify({ type: 'session', version: 3, id: 't1', timestamp: 'x', cwd: '/x' }),
      msgLine('system', ''),
      msgLine('user', [{ type: 'text', text: '帮我建登录失败用例' }]),
      msgLine('assistant', [{ type: 'thinking', thinking: '…' }, { type: 'text', text: '我先暂存草稿' }, toolCallBlock('c1', 'stage_case', { caseId: 'loc-1' })]),
      msgLine('toolResult', [{ type: 'text', text: '已暂存' }], { toolCallId: 'c1', toolName: 'stage_case', isError: false }),
      '{broken json',
      msgLine('assistant', [{ type: 'text', text: '跑一下验证' }, toolCallBlock('c2', 'verify_case', { caseId: 'loc-1' })]),
      msgLine('toolResult', [{ type: 'text', text: '通过：终态达成' }], { toolCallId: 'c2', toolName: 'verify_case', isError: false }),
    ].join('\n');
    const turns = parseSessionJsonl(jsonl);
    expect(turns.filter((t) => t.role === 'user')).toHaveLength(1);
    const a1 = turns.find((t) => t.role === 'assistant' && t.toolCalls.some((c) => c.name === 'stage_case'))!;
    expect(a1.text).toContain('我先暂存草稿');
    expect(turns.filter((t) => t.role === 'toolResult')).toHaveLength(2);
  });

  it('findVerifiedLocalIds：verify_case 成功→收录；isError=true 不收；只有别的 case 的成功不收；多次调用末次成功即成功', async () => {
    const { parseSessionJsonl, findVerifiedLocalIds } = await import('../src/scheduler/trajectoryParse.js');
    const jsonl = [
      msgLine('assistant', [toolCallBlock('a', 'verify_case', { caseId: 'ok-1' })]),
      msgLine('toolResult', [{ type: 'text', text: '通过' }], { toolCallId: 'a', toolName: 'verify_case', isError: false }),
      msgLine('assistant', [toolCallBlock('b', 'verify_case', { caseId: 'fail-1' })]),
      msgLine('toolResult', [{ type: 'text', text: '失败：找不到按钮' }], { toolCallId: 'b', toolName: 'verify_case', isError: true }),
      msgLine('assistant', [toolCallBlock('c', 'verify_case', { caseId: 'other' })]),
      msgLine('toolResult', [{ type: 'text', text: '通过' }], { toolCallId: 'c', toolName: 'verify_case', isError: false }),
      msgLine('assistant', [toolCallBlock('d', 'verify_case', { caseId: 'retry-1' })]),
      msgLine('toolResult', [{ type: 'text', text: '失败' }], { toolCallId: 'd', toolName: 'verify_case', isError: true }),
      msgLine('assistant', [toolCallBlock('e', 'verify_case', { caseId: 'retry-1' })]),
      msgLine('toolResult', [{ type: 'text', text: '通过' }], { toolCallId: 'e', toolName: 'verify_case', isError: false }),
    ].join('\n');
    const turns = parseSessionJsonl(jsonl);
    const verified = findVerifiedLocalIds(turns, ['ok-1', 'fail-1', 'retry-1']);
    expect(Array.from(verified).sort()).toEqual(['ok-1', 'retry-1']);
  });

  it('compressConversation：user 全文 / assistant 文本（无 thinking）/ toolCall 行 / toolResult 截断；总量限预算', async () => {
    const { parseSessionJsonl, compressConversation } = await import('../src/scheduler/trajectoryParse.js');
    const jsonl = [
      msgLine('user', [{ type: 'text', text: '建登录用例' }]),
      msgLine('assistant', [{ type: 'thinking', thinking: '内部思考不该出现' }, { type: 'text', text: '好的' }, toolCallBlock('c1', 'stage_case', { caseId: 'x', title: '登录' })]),
      msgLine('toolResult', [{ type: 'text', text: '长'.repeat(2000) }], { toolCallId: 'c1', toolName: 'stage_case', isError: false }),
    ].join('\n');
    const out = compressConversation(parseSessionJsonl(jsonl), 3_000);
    expect(out).toContain('[用户] 建登录用例');
    expect(out).toContain('[助手] 好的');
    expect(out).toContain('stage_case');
    expect(out).not.toContain('内部思考不该出现');
    expect(out.length).toBeLessThanOrEqual(3_200); // 截断容差
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && npx vitest run test/trajectory-parse.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现解析器**

创建 `apps/api/src/scheduler/trajectoryParse.ts`：

```ts
/**
 * pi-sessions JSONL 解析 + 轨迹判据核实 + 对话流压缩（纯函数，无 IO）。
 * 记录形状（实测，见 R2 计划「关键代码事实」）：
 *   {type:'message', message:{role:'user'|'assistant'|'toolResult'|'system', content}}
 *   assistant content 块：{type:'text'|'thinking'|'toolCall', id?, name?, arguments?}
 *   toolResult message 额外字段：toolCallId / toolName / isError（成功判据的硬信号）。
 */
export interface ParsedToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface ParsedTurn {
  role: 'user' | 'assistant' | 'toolResult';
  text: string;
  toolCalls: ParsedToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export function parseSessionJsonl(content: string): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o: { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean } };
    try {
      o = JSON.parse(t);
    } catch {
      continue; // 坏行跳过（半行写入等）
    }
    if (o.type !== 'message' || !o.message?.role) continue;
    const m = o.message;
    const blocks = Array.isArray(m.content) ? m.content.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null) : [];
    const textOf = (b: Record<string, unknown>): string => (typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '');
    if (m.role === 'user') {
      const text = blocks.map(textOf).filter(Boolean).join('\n');
      if (text) turns.push({ role: 'user', text, toolCalls: [] });
    } else if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map(textOf).filter(Boolean).join('\n');
      const toolCalls = blocks
        .filter((b) => b.type === 'toolCall')
        .map((b) => ({ id: String(b.id ?? ''), name: String(b.name ?? ''), arguments: (b.arguments ?? {}) as Record<string, unknown> }))
        .filter((c) => c.id && c.name);
      if (text || toolCalls.length > 0) turns.push({ role: 'assistant', text, toolCalls });
    } else if (m.role === 'toolResult') {
      turns.push({
        role: 'toolResult',
        text: blocks.map(textOf).filter(Boolean).join('\n'),
        toolCalls: [],
        toolCallId: typeof m.toolCallId === 'string' ? m.toolCallId : undefined,
        toolName: typeof m.toolName === 'string' ? m.toolName : undefined,
        isError: m.isError === true,
      });
    }
  }
  return turns;
}

/** 判据核实：localId 集合中，哪些存在「verify_case(caseId=localId) 的 toolResult isError=false」。
 *  多次 verify 末次成功即成功（失败→修正→通过是正常路径）。 */
export function findVerifiedLocalIds(turns: ParsedTurn[], localIds: string[]): Set<string> {
  const want = new Set(localIds);
  const verified = new Set<string>();
  const callById = new Map<string, string>(); // toolCallId → localId（仅 verify_case 且 caseId 命中）
  for (const t of turns) {
    if (t.role === 'assistant') {
      for (const c of t.toolCalls) {
        const caseId = c.name === 'verify_case' ? String(c.arguments.caseId ?? '') : '';
        if (caseId && want.has(caseId)) callById.set(c.id, caseId);
      }
    } else if (t.role === 'toolResult' && t.toolName === 'verify_case' && t.isError === false && t.toolCallId) {
      const localId = callById.get(t.toolCallId);
      if (localId) verified.add(localId);
    }
  }
  return verified;
}

/** 对话流压缩：user 全文 / assistant 决策文本（弃 thinking）/ toolCall 摘要行 / toolResult 截头。
 *  尾部超预算整体截断（蒸馏重最新上下文，头部被截不影响判据——判据已由 findVerifiedLocalIds 完成）。 */
export function compressConversation(turns: ParsedTurn[], maxChars = 24_000): string {
  const lines: string[] = [];
  for (const t of turns) {
    if (t.role === 'user') {
      lines.push(`[用户] ${t.text}`);
    } else if (t.role === 'assistant') {
      if (t.text) lines.push(`[助手] ${t.text}`);
      for (const c of t.toolCalls) {
        const args = JSON.stringify(c.arguments);
        lines.push(`[助手→工具] ${c.name}(${args.length > 300 ? `${args.slice(0, 300)}…` : args})`);
      }
    } else {
      const head = t.text.length > 400 ? `${t.text.slice(0, 400)}…` : t.text;
      lines.push(`[工具结果${t.isError ? '·失败' : ''}] ${head}`);
    }
  }
  const joined = lines.join('\n');
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && npx vitest run test/trajectory-parse.test.ts`
Expected: PASS 3 tests

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scheduler/trajectoryParse.ts apps/api/test/trajectory-parse.test.ts
git commit -m "feat(trajectories): JSONL 解析+verify 判据核实+对话流压缩——纯函数(R2)"
```

---

### Task 4: 蒸馏 worker（queue + LLM 蒸馏 + 入库）

**Files:**
- Create: `apps/api/src/scheduler/trajectoryQueue.ts`
- Create: `apps/api/src/scheduler/trajectoryWorker.ts`
- Test: `apps/api/test/trajectory-worker.test.ts`

- [ ] **Step 1: 写失败的 worker 测试**

创建 `apps/api/test/trajectory-worker.test.ts`（容器骨架同 space-trajectories.test.ts 的 beforeAll/afterAll，另加 ai_threads 种子；此处展示差异部分，骨架照抄）：

```ts
// —— 骨架同 space-trajectories.test.ts（container/pool/SCHEMA_SQL），beforeEach 改为：
beforeEach(async () => {
  await pool.query(`TRUNCATE assistant_trajectories`);
});
// 另需在文件头 import：import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';

/** 假 LLM client：返回固定蒸馏 JSON（completeJson 的 json 形态）。 */
function stubClient() {
  return {
    provider: 'openai' as const,
    complete: async () => ({
      kind: 'json' as const,
      value: { task_title: '登录失败提示任务', task_keywords: '登录 密码错误 提示', digest: '## 任务描述\n…\n## 环境事实\n…\n## 关键决策\n…\n## 最终用例形态\n…\n## verify 证据\n一次通过' },
      provider: 'openai' as const,
      vision: false,
      model: 'stub-model',
    }),
  };
}

describe('R2 trajectories：蒸馏 worker', () => {
  async function seedThreadWithFixture(opts: { verified: boolean }): Promise<{ threadId: string; caseId: string; lineId: string; sessionsRoot: string }> {
    const { projectId, versionId } = await seedProjectWithVersion(pool); // 见下：seed helper
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    const threadId = randomUUID();
    const piThreadId = `01atest-${randomUUID().slice(0, 8)}`;
    await pool.query(`INSERT INTO ai_threads (id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,$3)`, [threadId, versionId, piThreadId]);
    // 用例 + 步骤（蒸馏输入的最终形态）
    const gid = (await pool.query(`INSERT INTO groups (project_id, name) VALUES ($1,'G') RETURNING id`, [projectId])).rows[0]!.id;
    const caseId = (await pool.query(`INSERT INTO test_cases (group_id, version_id, title, expected_outcome) VALUES ($1,$2,'登录-密码错误',$3) RETURNING id`, [gid, versionId, '提示密码错误'])).rows[0]!.id;
    await pool.query(`INSERT INTO test_steps (case_id, "order", source, instruction) VALUES ($1,0,'ai','输入错误密码'),($1,1,'ai','点击登录')`, [caseId]);
    // JSONL fixture
    const callId = 'c1';
    const jsonl = [
      JSON.stringify({ type: 'session', version: 3, id: piThreadId, timestamp: 'x', cwd: '/x' }),
      JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: 'x', message: { role: 'user', content: [{ type: 'text', text: '建一条登录失败提示用例' }] } }),
      JSON.stringify({ type: 'message', id: 'm2', parentId: 'm1', timestamp: 'x', message: { role: 'assistant', content: [
        { type: 'text', text: '先暂存再实测验证' },
        { type: 'toolCall', id: callId, name: 'verify_case', arguments: { caseId: 'loc-1' } },
      ] } }),
      JSON.stringify({ type: 'message', id: 'm3', parentId: 'm2', timestamp: 'x', message: { role: 'toolResult', toolCallId: callId, toolName: 'verify_case', isError: !opts.verified, content: [{ type: 'text', text: opts.verified ? '通过：终态达成' : '失败：找不到元素' }] } }),
    ].join('\n');
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'traj-sessions-'));
    writeFileSync(join(sessionsRoot, `2026-10-31T00-00-00-000Z_${piThreadId}.jsonl`), jsonl);
    return { threadId, caseId, lineId, sessionsRoot };
  }

  it('判据满足：蒸馏入库（task_title/keywords/digest/distill_model/溯源列全）', async () => {
    const fx = await seedThreadWithFixture({ verified: true });
    const { processTrajectoryJob } = await import('../src/scheduler/trajectoryWorker.js');
    await processTrajectoryJob(
      { kind: 'trajectory', threadId: fx.threadId, versionId: (await poolVersionId(fx)).versionId, userId: null, items: [{ localId: 'loc-1', caseId: fx.caseId }] },
      { client: stubClient(), sessionsRoot: fx.sessionsRoot },
    );
    const row = (await pool.query(`SELECT * FROM assistant_trajectories`)).rows[0]!;
    expect(row.task_title).toBe('登录失败提示任务');
    expect(row.task_keywords).toBe('登录 密码错误 提示');
    expect(row.digest).toContain('verify 证据');
    expect(row.distill_model).toBe('stub-model');
    expect(row.source_case_id).toBe(fx.caseId);
    expect(row.product_line_id).toBe(fx.lineId);
    expect(row.case_title).toBe('登录-密码错误');
  });

  it('判据不满足（verify 失败/未跑）：不入库', async () => {
    const fx = await seedThreadWithFixture({ verified: false });
    const { processTrajectoryJob } = await import('../src/scheduler/trajectoryWorker.js');
    await processTrajectoryJob(
      { kind: 'trajectory', threadId: fx.threadId, versionId: (await poolVersionId(fx)).versionId, userId: null, items: [{ localId: 'loc-1', caseId: fx.caseId }] },
      { client: stubClient(), sessionsRoot: fx.sessionsRoot },
    );
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(0);
  });

  it('会话文件缺失：静默跳过不抛', async () => {
    const fx = await seedThreadWithFixture({ verified: true });
    const { processTrajectoryJob } = await import('../src/scheduler/trajectoryWorker.js');
    await expect(processTrajectoryJob(
      { kind: 'trajectory', threadId: fx.threadId, versionId: (await poolVersionId(fx)).versionId, userId: null, items: [{ localId: 'loc-1', caseId: fx.caseId }] },
      { client: stubClient(), sessionsRoot: mkdtempSync(join(tmpdir(), 'empty-')) },
    )).resolves.toBeUndefined();
  });

  it('LLM 输出形状不合法：丢弃该 item 不入库、不抛', async () => {
    const fx = await seedThreadWithFixture({ verified: true });
    const bad = { ...stubClient(), complete: async () => ({ kind: 'text' as const, value: 'not json', provider: 'openai' as const, vision: false, model: 'stub' }) };
    const { processTrajectoryJob } = await import('../src/scheduler/trajectoryWorker.js');
    await processTrajectoryJob(
      { kind: 'trajectory', threadId: fx.threadId, versionId: (await poolVersionId(fx)).versionId, userId: null, items: [{ localId: 'loc-1', caseId: fx.caseId }] },
      { client: bad, sessionsRoot: fx.sessionsRoot },
    );
    const n = (await pool.query(`SELECT count(*)::int n FROM assistant_trajectories`)).rows[0]!;
    expect(n.n).toBe(0);
  });
});
```

实现注意：`seedProjectWithVersion`/`poolVersionId` 是测试内辅助——直接用 `seedProject(pool)`（返回含 versionId；若返回结构不同，以 `test/helpers/db.ts` 实际导出为准调整，核心是拿到 versionId+projectId）；`ai_threads` 必填列以 SCHEMA_SQL 里该表 DDL 为准（kind 默认 'requirement'，显式传 'version'）。fixture 写入临时目录传 `sessionsRoot`，afterAll 里 `rmSync` 清理。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && npx vitest run test/trajectory-worker.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现 queue + worker**

创建 `apps/api/src/scheduler/trajectoryQueue.ts`（rcaQueue 逐行同构）：

```ts
/**
 * 轨迹蒸馏队列：/stage/save 落库钩子投递，worker 读 pi-sessions JSONL 判据核实后
 * LLM 蒸馏入库。REDIS_URL 缺失 → inline fire-and-forget（rcaQueue 同款降级）。
 * 幂等由 partial unique(source_case_id where active) + onConflictDoNothing 兜底。
 * 开关：ASSISTANT_TRAJECTORY_DISTILL=0 关闭（默认开）。
 */
import { Queue, Worker } from 'bullmq';
import { getRedis } from './queue.js';
import { logger } from '../logger.js';

export const TRAJECTORY_QUEUE_NAME = 'trajectories';

export type TrajectoryJob = {
  kind: 'trajectory';
  threadId: string;
  versionId: string;
  userId: string | null;
  items: Array<{ localId: string; caseId: string }>;
};

let _queue: Queue<TrajectoryJob> | null = null;

export function isTrajectoryQueueReady(): boolean {
  return !!process.env.REDIS_URL;
}

export function getTrajectoryQueue(): Queue<TrajectoryJob> {
  if (!_queue) {
    _queue = new Queue<TrajectoryJob>(TRAJECTORY_QUEUE_NAME, { connection: getRedis() });
  }
  return _queue;
}

/** 构造 worker（index.ts 启动时调用）。concurrency=1：蒸馏是 LLM 任务，串行防网关压力。 */
export function buildTrajectoryWorker(processor: (job: TrajectoryJob) => Promise<void>): Worker<TrajectoryJob> {
  return new Worker<TrajectoryJob>(TRAJECTORY_QUEUE_NAME, async (job) => processor(job.data), {
    connection: getRedis(),
    concurrency: 1,
  });
}

/** 落库钩子调用。动态 import trajectoryWorker 防静态环（stageRoute→queue→worker→session→…）。 */
export async function enqueueTrajectoryDistill(data: TrajectoryJob): Promise<void> {
  if (process.env.ASSISTANT_TRAJECTORY_DISTILL === '0') return;
  if (data.items.length === 0) return;
  if (isTrajectoryQueueReady()) {
    try {
      await getTrajectoryQueue().add(TRAJECTORY_QUEUE_NAME, data);
      return;
    } catch (e) {
      logger.warn({ err: e, threadId: data.threadId }, 'trajectory queue add failed; running inline');
    }
  }
  const { processTrajectoryJobInline } = await import('./trajectoryWorker.js');
  void processTrajectoryJobInline(data).catch((err) => logger.error({ err, threadId: data.threadId }, 'inline trajectory job crashed'));
}

/** 仅供测试/teardown。 */
export async function __closeTrajectoryQueue(): Promise<void> {
  if (_queue) await _queue.close();
  _queue = null;
}
```

创建 `apps/api/src/scheduler/trajectoryWorker.ts`：

```ts
/**
 * 轨迹蒸馏 worker：定位会话 JSONL → 判据核实（verify_case 成功链）→ LLM 蒸馏 → 入库。
 * 失败语义（设计 §4.2）：LLM 超时/输出不合法/文件缺失/项目未归线 → 丢弃 + warn，不重试
 * 不阻塞（transcript 仍在卷上，R3 可重蒸）。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import { z } from 'zod';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import { aiThreads, testCases, testSteps } from '../db/schema.js';
import { SESSIONS_ROOT } from '../pi/space/session.js';
import { resolveProductLineId } from '../pi/space/memories.js';
import { insertTrajectory } from '../pi/space/trajectories.js';
import { resolveVersionProjectId } from '../services/projectAccess.js';
import { readLlmConfig } from '../pi/modelBridge.js';
import { completeJson, getLlmClient, type LLMClient } from '../agent/llm-client.js';
import { buildTrajectoryWorker, type TrajectoryJob } from './trajectoryQueue.js';
import { compressConversation, findVerifiedLocalIds, parseSessionJsonl } from './trajectoryParse.js';

const DISTILL_SYSTEM_PROMPT = `你是测试轨迹蒸馏器。输入是一次「为用户创建测试用例」的助手会话压缩流与最终落库的用例形态。产出一条可复用的成功轨迹 exemplar，供同产品线后续相似任务 few-shot。

输出只含 JSON（不要 markdown 围栏）：
{"task_title":"…","task_keywords":"…","digest":"…"}

字段要求：
- task_title：≤60 字的人话任务指纹——什么类型的被测任务（页面/动作/断言要点），例如「SOC 事件管理列表页——筛选后导出 Excel」。不要含用例标题原文照抄。
- task_keywords：空格分隔的检索关键词（8~15 个词，覆盖页面名、功能、动作、断言对象）。
- digest：markdown，固定五段骨架，每段 1~4 行：
  ## 任务描述
  ## 环境事实（URL/账号/入口等会话中实际用到的）
  ## 关键决策（步骤怎么拆、断言怎么定、踩过什么坑怎么修的——从工具结果与修正过程提炼）
  ## 最终用例形态（步骤序列与断言要点概括）
  ## verify 证据（实测结果一句话）
只依据输入材料，禁止臆造输入中没有的行为或结论。`;

const DistillOutput = z.object({
  task_title: z.string().min(1).max(200),
  task_keywords: z.string().min(1),
  digest: z.string().min(1),
});

/** 定位线程会话文件：SESSIONS_ROOT 下 `*_<piThreadId>.jsonl`。 */
export async function findSessionFile(sessionsRoot: string, piThreadId: string): Promise<string | null> {
  try {
    const names = await readdir(sessionsRoot);
    const hit = names.find((n) => n.endsWith(`_${piThreadId}.jsonl`));
    return hit ? join(sessionsRoot, hit) : null;
  } catch {
    return null;
  }
}

/** 用例最终形态（DB 读）：标题/预期/步骤指令序列。 */
async function buildCaseShape(caseId: string): Promise<string> {
  const c = (await db.select().from(testCases).where(eq(testCases.id, caseId)).limit(1))[0];
  if (!c) return '（用例已不存在）';
  const steps = await db.select({ order: testSteps.order, instruction: testSteps.instruction })
    .from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order));
  const stepLines = steps.map((s) => `${s.order + 1}. ${s.instruction ?? '（机械步骤）'}`).join('\n');
  return `【最终用例】\n标题：${c.title}\n预期结果：${c.expectedOutcome ?? '（无）'}\n步骤：\n${stepLines}`;
}

export interface TrajectoryJobDeps {
  client: LLMClient;
  sessionsRoot?: string;
}

/** 核心：判据核实 → 蒸馏 → 入库。client/sessionsRoot 可注入（测试）。 */
export async function processTrajectoryJob(data: TrajectoryJob, deps: TrajectoryJobDeps): Promise<void> {
  const thread = (await db.select({ piThreadId: aiThreads.piThreadId }).from(aiThreads).where(eq(aiThreads.id, data.threadId)).limit(1))[0];
  if (!thread) { logger.warn({ threadId: data.threadId }, 'trajectory: thread not found; skip'); return; }
  const file = await findSessionFile(deps.sessionsRoot ?? SESSIONS_ROOT, thread.piThreadId);
  if (!file) { logger.warn({ threadId: data.threadId }, 'trajectory: session file missing; skip'); return; }
  const turns = parseSessionJsonl(await readFile(file, 'utf8'));
  const verified = findVerifiedLocalIds(turns, data.items.map((i) => i.localId));
  const items = data.items.filter((i) => verified.has(i.localId));
  if (items.length === 0) { logger.info({ threadId: data.threadId }, 'trajectory: no verified items; skip'); return; }
  const projectId = await resolveVersionProjectId(data.versionId);
  const lineId = projectId ? await resolveProductLineId(projectId) : null;
  if (!projectId || !lineId) { logger.warn({ versionId: data.versionId }, 'trajectory: product line unresolved (项目未归线?); skip'); return; }
  const conv = compressConversation(turns);
  for (const item of items) {
    try {
      const r = await completeJson(deps.client, {
        systemPrompt: DISTILL_SYSTEM_PROMPT,
        userMessage: `${conv}\n\n${await buildCaseShape(item.caseId)}`,
      });
      const parsed = DistillOutput.safeParse(r.value);
      if (!parsed.success) {
        logger.warn({ threadId: data.threadId, caseId: item.caseId, issues: parsed.error.issues.length }, 'trajectory: distill output invalid; drop item');
        continue;
      }
      const inserted = await insertTrajectory({
        productLineId: lineId,
        taskTitle: parsed.data.task_title.slice(0, 200),
        taskKeywords: parsed.data.task_keywords,
        digest: parsed.data.digest,
        caseTitle: (await db.select({ title: testCases.title }).from(testCases).where(eq(testCases.id, item.caseId)).limit(1))[0]?.title?.slice(0, 200) ?? '（未知用例）',
        status: 'active',
        sourceThreadId: data.threadId,
        sourceCaseId: item.caseId,
        sourceProjectId: projectId,
        sourceVersionId: data.versionId,
        createdByUserId: data.userId,
        distillModel: r.model ?? 'unknown',
      });
      if (inserted) logger.info({ threadId: data.threadId, caseId: item.caseId }, 'trajectory: distilled and stored');
      else logger.info({ caseId: item.caseId }, 'trajectory: duplicate (active row exists); skipped');
    } catch (e) {
      logger.warn({ err: e, caseId: item.caseId }, 'trajectory: distill failed; drop item');
    }
  }
}

/** inline 路径：settings 建 client（未配置 → warn 跳过）。 */
export async function processTrajectoryJobInline(data: TrajectoryJob): Promise<void> {
  const cfg = await readLlmConfig();
  if (!cfg) { logger.warn('trajectory: LLM not configured; skip inline distill'); return; }
  await processTrajectoryJob(data, { client: getLlmClient({ provider: cfg.provider, apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.baseUrl ?? undefined }) });
}

let _worker: Worker<TrajectoryJob> | null = null;

/** API 进程启动时调用（index.ts）。无 REDIS → inline 模式（enqueue 直接跑），不建 worker。 */
export async function startTrajectoryWorker(): Promise<void> {
  if (!process.env.REDIS_URL) {
    logger.info('REDIS_URL not set; trajectory queue inline mode');
    return;
  }
  try {
    const cfg = await readLlmConfig();
    if (!cfg) { logger.info('trajectory: LLM not configured; worker not started'); return; }
    const client = getLlmClient({ provider: cfg.provider, apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.baseUrl ?? undefined });
    _worker = buildTrajectoryWorker((job) => processTrajectoryJob(job, { client }));
    _worker.on('ready', () => logger.info('trajectory worker ready'));
    _worker.on('error', (err) => logger.warn({ err: err.message }, 'trajectory worker error'));
    _worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err: err.message }, 'trajectory job failed'));
    logger.info('trajectory worker started');
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'trajectory worker init failed; continuing inline');
    _worker = null;
  }
}
```

（若 `testCases` 无 `expectedOutcome` 列名以 schema.ts 为准——有，R1 期间多次见过；`queue.js` 的 `getRedis` 与 rcaQueue 同源。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && npx vitest run test/trajectory-worker.test.ts test/trajectory-parse.test.ts`
Expected: PASS 全部

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scheduler/trajectoryQueue.ts apps/api/src/scheduler/trajectoryWorker.ts apps/api/test/trajectory-worker.test.ts
git commit -m "feat(trajectories): 蒸馏队列+worker——判据核实→LLM 蒸馏→幂等入库(R2)"
```

---

### Task 5: 落库钩子接线（stageRoute + index 启动）

**Files:**
- Modify: `apps/api/src/pi/space/stageRoute.ts`（imports 加 logger；step 2 删 stage 行后、res.json 前插钩子）
- Modify: `apps/api/src/index.ts`（startRcaWorker 旁加 startTrajectoryWorker）
- Test: `apps/api/test/stage-trajectory-hook.test.ts`

- [ ] **Step 1: 写失败的钩子测试**

创建 `apps/api/test/stage-trajectory-hook.test.ts`（容器骨架照抄 space-trajectories.test.ts；核心差异）：

```ts
import { vi } from 'vitest';
// 其余 import 与骨架同。beforeAll 里额外挂 stage 路由所在的完整 space 路由已在
// /api/assistant 下（stageRoute 是 spaceRoute 的一部分，managerApp 即可）。

beforeEach(async () => {
  vi.resetModules();
  await pool.query(`TRUNCATE assistant_trajectories`);
});

describe('R2 trajectories：落库钩子', () => {
  it('/stage/save 带 case → enqueueTrajectoryDistill 收到 localId/caseId 成对负载；钩子异常不影响落库', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../src/scheduler/trajectoryQueue.js', () => ({ enqueueTrajectoryDistill: enqueue }));
    // 重新 import stageRoute 使 mock 生效（动态 import 在钩子内部，vi.doMock 拦截得到）
    const { seedStageCase } = await import('./helpers/stage.js'); // 见下：往 ai_stage_cases 种一行
    const { threadId, versionId, localId } = await seedStageCase(pool);
    const res = await request(managerApp).post(`/api/assistant/threads/${threadId}/stage/save`).send({ cases: [{ localId, groupId: await seedGroup(pool, versionId) }] });
    expect(res.status).toBe(200);
    expect(res.body.savedCases).toBe(1);
    await new Promise((r) => setTimeout(r, 50)); // 钩子是 await 的，但 doMock 后动态 import 异步——留缓冲
    expect(enqueue).toHaveBeenCalledTimes(1);
    const arg = enqueue.mock.calls[0]![0];
    expect(arg.threadId).toBe(threadId);
    expect(arg.items).toHaveLength(1);
    expect(arg.items[0]!.caseId).toBe(res.body.caseIdMap[localId]);
    expect(arg.items[0]!.localId).toBe(localId);
  });

  it('enqueue 抛错：save 仍然 200 落库成功', async () => {
    vi.doMock('../../src/scheduler/trajectoryQueue.js', () => ({
      enqueueTrajectoryDistill: vi.fn().mockRejectedValue(new Error('queue down')),
    }));
    const { seedStageCase } = await import('./helpers/stage.js');
    const { threadId, localId } = await seedStageCase(pool);
    const res = await request(managerApp).post(`/api/assistant/threads/${threadId}/stage/save`).send({ cases: [{ localId, groupId: await seedGroup(pool, versionId) }] });
    expect(res.status).toBe(200);
    expect(res.body.savedCases).toBe(1);
  });
});
```

实现注意：
- 若 `test/helpers/stage.js` 不存在，就在本测试文件内写 `seedStageCase`（往 `ai_stage_cases` 插一行：thread_id/version_id/localId/title/steps jsonb `[{"action":"打开登录页"}]`，以 SCHEMA_SQL 中该表 DDL 列为准）；`seedGroup` 同理（`groups` 表 project_id+name）。**注意**：managerApp 是 beforeAll 里静态 import 的路由——`vi.doMock` 对其内动态 import 的模块生效需 `vi.resetModules()` 后**重建 app**。若 mock 不生效，改为直接测导出的 `stageSaveHandler`（把 `/stage/save` 处理器抽成可导出函数是允许的小重构），或在钩子内通过环境变量 `ASSISTANT_TRAJECTORY_DISTILL=0` 的旁路断言。以「mock 生效的最小改法」为准，不许为测试改产品代码结构超过抽函数一级。
- 钩子内已 try/catch：第二个用例其实走的是钩子自身 try/catch。断言点在 save 不受影响。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && npx vitest run test/stage-trajectory-hook.test.ts`
Expected: FAIL——enqueue 未被调用（钩子不存在）

- [ ] **Step 3: 接线**

`stageRoute.ts`：import 区加 `import { logger } from '../../logger.js';`；在 step 2（删 stage 行循环，~L274）之后、`res.json({...})` 之前插入：

```ts
  // R2 轨迹库：确认落库的用例投递轨迹蒸馏（fire-and-forget；verify 判据由 worker 在
  // transcript 核实，未实测的确认用例不会产轨迹）。绝不影响落库主流程。
  if (createdCaseIds.size > 0) {
    try {
      const { enqueueTrajectoryDistill } = await import('../../scheduler/trajectoryQueue.js');
      await enqueueTrajectoryDistill({
        kind: 'trajectory',
        threadId,
        versionId,
        userId: creatorId,
        items: Array.from(createdCaseIds, ([localId, caseId]) => ({ localId, caseId })),
      });
    } catch (e) {
      logger.warn({ err: e, threadId }, 'trajectory distill enqueue failed; save unaffected');
    }
  }
```

`src/index.ts`：`import { startRcaWorker } ...`（L27）旁加 `import { startTrajectoryWorker } from './scheduler/trajectoryWorker.js';`；`void startRcaWorker();`（L87）后加 `void startTrajectoryWorker();`。

- [ ] **Step 4: 跑测试确认通过 + 邻接回归**

Run: `cd apps/api && npx vitest run test/stage-trajectory-hook.test.ts test/space-stage.test.ts 2>/dev/null || npx vitest run test/stage-trajectory-hook.test.ts`
Expected: PASS（若存在既有 stage 测试文件——用 `ls test | grep -i stage` 找——一并跑）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/space/stageRoute.ts apps/api/src/index.ts apps/api/test/stage-trajectory-hook.test.ts
git commit -m "feat(trajectories): /stage/save 落库钩子+worker 启动接线——fire-and-forget 不碰主流程(R2)"
```

---

### Task 6: search_trajectories 工具 + 注册

**Files:**
- Create: `apps/api/src/pi/space/tools/trajectories.ts`
- Modify: `apps/api/src/pi/space/tools/index.ts`（L32 import 区 + L74 注册区）
- Test: `apps/api/test/space-trajectories.test.ts`（追加 describe）

- [ ] **Step 1: 写失败的工具层测试**

追加到 `test/space-trajectories.test.ts`：

```ts
describe('R2 trajectories：工具层', () => {
  async function toolCtx(projectId: string) {
    const { emptyRepoState } = await import('../src/pi/space/tools/context.js');
    return { threadId: randomUUID(), versionId: randomUUID(), projectId, repo: emptyRepoState(), emit: () => {}, createdByUserId: null, manager: true };
  }

  it('search_trajectories：命中返回 digest+task_title；命中行 hit_count +1；miss 返回可用清单', async () => {
    const { buildSearchTrajectoryTool } = await import('../src/pi/space/tools/trajectories.js');
    const { projectId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    const caseId = randomUUID();
    await pool.query(`INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model, source_case_id)
      VALUES ($1,$2,'登录失败提示','登录 密码','## 任务描述…','登录-密码错误','m',$3)`, [randomUUID(), lineId, caseId]);
    const tool = buildSearchTrajectoryTool(await toolCtx(projectId));
    const hit = await tool.execute({ query: '登录 失败' });
    expect(hit.ok).toBe(true);
    const data = JSON.parse((hit as { ok: true; data: string }).data);
    expect(Array.isArray(data.trajectories)).toBe(true);
    expect(data.trajectories[0].task_title).toBe('登录失败提示');
    expect(data.trajectories[0].digest).toContain('任务描述');
    expect((await pool.query(`SELECT hit_count::int h FROM assistant_trajectories WHERE source_case_id=$1`, [caseId])).rows[0]!.h).toBe(1);
    const miss = await tool.execute({ query: '不存在词' });
    expect(miss.ok).toBe(false);
    expect((miss as { ok: false; error: string }).error).toContain('登录失败提示');
  });

  it('项目未归线：报错不抛', async () => {
    const { buildSearchTrajectoryTool } = await import('../src/pi/space/tools/trajectories.js');
    const tool = buildSearchTrajectoryTool(await toolCtx(randomUUID()));
    const r = await tool.execute({ query: 'x' });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && npx vitest run test/space-trajectories.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现工具**

创建 `apps/api/src/pi/space/tools/trajectories.ts`：

```ts
/**
 * 轨迹检索工具：建用例前取同线成功轨迹 exemplar 做 few-shot（R2 读路径）。
 * 返回脚注硬约束锚点/URL 禁照抄——线内事实以当前应用实测为准。
 */
import { Type } from '@earendil-works/pi-ai';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { resolveProductLineId } from '../memories.js';
import { searchTrajectoriesByQuery, SEARCH_TOP_K } from '../trajectories.js';

export function buildSearchTrajectoryTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'search_trajectories',
    description: '检索当前产品线的成功用例生成轨迹（exemplar）。开始设计/编写任何用例前，用任务关键词（如「登录 失败 提示」「列表 导出」）先检索：返回 top-' + `${SEARCH_TOP_K}` + ' 条相似轨迹的蒸馏件（任务指纹/环境事实/关键决策/最终用例形态/verify 证据），作为 few-shot 参考其决策思路与用例形态。注意：轨迹中的锚点、URL、账号等线内事实必须以当前应用实测为准，禁止照抄。',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200, description: '任务关键词，空格分隔多个词' }),
    }),
    execute: async (input) => {
      const { query } = input as { query: string };
      const lineId = await resolveProductLineId(ctx.projectId);
      if (!lineId) return { ok: false, error: `无法解析当前项目的产品线（projectId=${ctx.projectId}）` };
      const { hits, all } = await searchTrajectoriesByQuery(lineId, query.trim());
      if (hits.length === 0) {
        const titles = all.map((t) => t.taskTitle).join('、') || '（无）';
        return { ok: false, error: `没有匹配「${query}」的成功轨迹。可用轨迹：${titles}` };
      }
      return {
        ok: true,
        data: JSON.stringify({
          trajectories: hits.map((h) => ({
            task_title: h.taskTitle,
            task_keywords: h.taskKeywords,
            digest: h.digest,
            case_title: h.caseTitle,
          })),
          note: '参考决策思路与用例形态；锚点/URL/账号等事实以当前应用实测为准，禁止照抄。',
        }),
      };
    },
  };
}

export function buildTrajectoryTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [buildSearchTrajectoryTool(ctx)];
}
```

`tools/index.ts`：`import { buildMemoryTools } from './memories.js';`（L32）后加 `import { buildTrajectoryTools } from './trajectories.js';`；`tools.push(...buildMemoryTools(ctx));`（L74）后加 `tools.push(...buildTrajectoryTools(ctx));`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && npx vitest run test/space-trajectories.test.ts`
Expected: PASS 全部

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/space/tools/trajectories.ts apps/api/src/pi/space/tools/index.ts apps/api/test/space-trajectories.test.ts
git commit -m "feat(trajectories): search_trajectories 工具——top-3 exemplar few-shot+命中埋点(R2)"
```

---

### Task 7: system prompt 注入（第 5 参 + 工厂段 + 零 diff 红线）

**Files:**
- Modify: `apps/api/src/pi/space/session.ts`（buildSpaceSystemPrompt ~L640-655；工厂 memories 段后 ~L741；override ~L770）
- Test: `apps/api/test/space-trajectories.test.ts`（追加 describe）

- [ ] **Step 1: 写失败的注入测试**

追加到 `test/space-trajectories.test.ts`：

```ts
describe('R2 trajectories：system prompt 注入', () => {
  it('零轨迹时输出与旧构造完全一致（回归红线）', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const legacy = buildSpaceSystemPrompt('SUMMARY', 'zh-CN', [{ kind: 'flow', body: 'F' }], 'MEM');
    const withEmpty = buildSpaceSystemPrompt('SUMMARY', 'zh-CN', [{ kind: 'flow', body: 'F' }], 'MEM', '');
    expect(legacy).toBe(withEmpty);
    expect(withEmpty).not.toContain('成功用例轨迹');
  });

  it('轨迹段位于 memories 之后、workspace 之前；工厂零轨迹时第 5 参缺省可用', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const out = buildSpaceSystemPrompt(null, 'zh-CN', [{ kind: 'flow', body: 'F' }], '# 产品线记忆\n- x', '# 成功用例轨迹\n- t');
    const iGuides = out.indexOf('# 流程指令');
    const iMem = out.indexOf('# 产品线记忆');
    const iTraj = out.indexOf('# 成功用例轨迹');
    const iWorkspace = out.indexOf('## 工作空间');
    expect(iGuides).toBeGreaterThan(-1);
    expect(iMem).toBeGreaterThan(iGuides);
    expect(iTraj).toBeGreaterThan(iMem);
    expect(iWorkspace).toBeGreaterThan(iTraj);
    // 缺省第 5 参（旧调用）编译期兼容
    expect(() => buildSpaceSystemPrompt(null, 'zh-CN', [], '')).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && npx vitest run test/space-trajectories.test.ts -t 'system prompt'`
Expected: FAIL——第 5 参不存在（TS 报错或 not.toContain 失败于四参调用）

- [ ] **Step 3: 实现注入**

`session.ts` 三处：

(a) 签名与 body（~L640-652）：

```ts
export function buildSpaceSystemPrompt(
  summaryText: string | null,
  lang?: AiLang,
  guides: Array<Pick<AssistantGuideRow, 'kind' | 'body'>> = [],
  memoriesSection = '',
  trajectoriesSection = '',
): string {
```

body 行改：`const body = [style, guidesSection, memoriesSection, trajectoriesSection, workspace].filter(Boolean).join('\n\n');`

(b) import 区加：`import { buildTrajectoriesSection, loadActiveTrajectories } from './trajectories.js';`（`resolveProductLineId` 已在 R1 import 过）

(c) 工厂段（memories try/catch 块 ~L741 之后）：

```ts
  // R2 轨迹库：产品线级成功轨迹索引段（active，updatedAt 降序，预算内）。
  // 与 guides/memories 同款容错：装载失败不拖垮会话工厂。
  let trajectoriesSection = '';
  try {
    const lineId = await resolveProductLineId(ctx.projectId);
    trajectoriesSection = lineId ? buildTrajectoriesSection(await loadActiveTrajectories(lineId)) : '';
  } catch (e) {
    logger.warn({ err: e, versionId: ctx.versionId }, 'trajectories 加载失败;继续无轨迹段');
  }
```

(d) override（~L770）改：

```ts
    appendSystemPromptOverride: (base) => [...base, buildSpaceSystemPrompt(summaryText, ctx.lang, guides, memoriesSection, trajectoriesSection)],
```

- [ ] **Step 4: 跑测试确认通过 + R1 注入回归**

Run: `cd apps/api && npx vitest run test/space-trajectories.test.ts test/space-memories.test.ts`
Expected: PASS 全部（R1 零 diff 红线不回归）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pi/space/session.ts apps/api/test/space-trajectories.test.ts
git commit -m "feat(trajectories): system prompt 轨迹索引段——memories 后 workspace 前,零轨迹零diff(R2)"
```

---

### Task 8: 管理路由 + web 设置页

**Files:**
- Create: `apps/api/src/pi/space/trajectoriesRoute.ts`
- Modify: `apps/api/src/pi/space/router.ts`（L32 import 区 + L466 挂载区）
- Modify: `apps/web/src/api/client.ts`（memories 组后 ~L723）
- Create: `apps/web/src/components/settings/TrajectoriesSection.tsx`
- Modify: `apps/web/src/components/settings/AssistantPanel.tsx`（MemoriesSection 后）
- Modify: `apps/web/src/i18n/locales/zh-CN/settings.json` + `en-US/settings.json`
- Test: `apps/api/test/space-trajectories.test.ts`（追加 describe）

- [ ] **Step 1: 写失败的路由测试**

追加到 `test/space-trajectories.test.ts`：

```ts
describe('R2 trajectories：管理路由', () => {
  it('GET：本组织线可见+带 productLineName+默认 active；他组织线不可见；?status=deleted 可审计', async () => {
    const org1 = await seedOrg(pool);
    const line1 = await seedProductLineInOrg(pool, org1.orgId, `本线-${randomUUID().slice(0, 8)}`);
    const org2Id = randomUUID();
    await pool.query(`INSERT INTO organizations(id, name, path) VALUES ($1,$2,$3)`, [org2Id, `他组织-${org2Id.slice(0, 8)}`, `/${org2Id}/`]);
    const line2 = await seedProductLineInOrg(pool, org2Id, `他线-${randomUUID().slice(0, 8)}`);
    await pool.query(`INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model) VALUES
      ($1,$2,'本线轨迹','k','d','C','m'), ($3,$4,'他组织线轨迹','k','d','C','m')`, [randomUUID(), line1, randomUUID(), line2]);
    const res = await request(managerApp).get('/api/assistant/trajectories');
    expect(res.status).toBe(200);
    const titles = (res.body as Array<{ taskTitle: string; productLineName: string | null }>).map((r) => r.taskTitle);
    expect(titles).toContain('本线轨迹');
    expect(titles).not.toContain('他组织线轨迹');
    expect((res.body as Array<{ productLineName: string | null }>).find((r) => r.productLineName)).toBeTruthy();
    await pool.query(`UPDATE assistant_trajectories SET status='deleted' WHERE task_title='本线轨迹'`);
    const activeRes = await request(managerApp).get('/api/assistant/trajectories');
    expect((activeRes.body as Array<{ taskTitle: string }>).some((r) => r.taskTitle === '本线轨迹')).toBe(false);
    const auditRes = await request(managerApp).get('/api/assistant/trajectories?status=deleted');
    expect((auditRes.body as Array<{ taskTitle: string }>).some((r) => r.taskTitle === '本线轨迹')).toBe(true);
  });

  it('DELETE：软删 status=deleted；member 403；不存在 404', async () => {
    const { projectId } = await seedProject(pool);
    const lineId = (await pool.query(`SELECT product_line_id FROM projects WHERE id=$1`, [projectId])).rows[0]!.product_line_id as string;
    const id = randomUUID();
    await pool.query(`INSERT INTO assistant_trajectories (id, product_line_id, task_title, task_keywords, digest, case_title, distill_model) VALUES ($1,$2,'待删','k','d','C','m')`, [id, lineId]);
    expect((await request(memberApp).delete(`/api/assistant/trajectories/${id}`)).status).toBe(403);
    expect((await request(managerApp).delete(`/api/assistant/trajectories/${randomUUID()}`)).status).toBe(404);
    const res = await request(managerApp).delete(`/api/assistant/trajectories/${id}`);
    expect(res.status).toBe(204);
    expect((await pool.query(`SELECT status FROM assistant_trajectories WHERE id=$1`, [id])).rows[0]!.status).toBe('deleted');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && npx vitest run test/space-trajectories.test.ts -t '管理路由'`
Expected: FAIL——404（路由不存在）

- [ ] **Step 3: 实现路由 + 挂载**

创建 `apps/api/src/pi/space/trajectoriesRoute.ts`（memoriesRoute 同构，可见性下推 SQL——R1 终审教训）：

```ts
/**
 * assistant_trajectories 管理端（设置页「助手轨迹」）：GET 列表 + DELETE 软删。
 * 挂载于 /api/assistant/trajectories，router.ts 处 requireManager 保护。
 * 与 memoriesRoute 的差异：无 global 档；可见性条件下推 SQL 后再 limit（R1 终审教训：
 * 先 limit 后过滤会在全库超限时把本组织旧行静默挤出窗口）。
 */
import { Router } from 'express';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantTrajectories, productLines } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AuthUser } from '../../services/auth.service.js';
import { assertProductLineVisible, visibleProductLineIds } from '../../services/projectAccess.js';

export const trajectoriesRoute = Router();

trajectoriesRoute.get('/', async (req, res) => {
  const user = req.user as AuthUser;
  const q = req.query;
  const visible = await visibleProductLineIds(user);
  if (visible.length === 0) { res.json([]); return; }
  const conds: SQL[] = [
    eq(assistantTrajectories.status, typeof q.status === 'string' && q.status ? q.status : 'active'),
    inArray(assistantTrajectories.productLineId, visible),
  ];
  if (typeof q.productLineId === 'string' && q.productLineId) conds.push(eq(assistantTrajectories.productLineId, q.productLineId));
  const rows = await db
    .select({
      id: assistantTrajectories.id,
      productLineId: assistantTrajectories.productLineId,
      productLineName: productLines.name,
      taskTitle: assistantTrajectories.taskTitle,
      taskKeywords: assistantTrajectories.taskKeywords,
      digest: assistantTrajectories.digest,
      caseTitle: assistantTrajectories.caseTitle,
      status: assistantTrajectories.status,
      hitCount: assistantTrajectories.hitCount,
      lastHitAt: assistantTrajectories.lastHitAt,
      createdAt: assistantTrajectories.createdAt,
      updatedAt: assistantTrajectories.updatedAt,
    })
    .from(assistantTrajectories)
    .leftJoin(productLines, eq(assistantTrajectories.productLineId, productLines.id))
    .where(and(...conds))
    .orderBy(desc(assistantTrajectories.updatedAt))
    .limit(500);
  res.json(rows);
});

trajectoriesRoute.delete('/:id', async (req, res) => {
  const user = req.user as AuthUser;
  const existing = (await db.select().from(assistantTrajectories).where(eq(assistantTrajectories.id, req.params.id)).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', '轨迹不存在');
  await assertProductLineVisible(existing.productLineId, user);
  // 软删保审计（R3/R5 消费轨迹）；注入与工具只取 active → 删除即从助手侧消失
  await db.update(assistantTrajectories)
    .set({ status: 'deleted', updatedAt: new Date() })
    .where(eq(assistantTrajectories.id, req.params.id));
  res.status(204).end();
});
```

`router.ts`：L32 import 区加 `import { trajectoriesRoute } from './trajectoriesRoute.js';`；L466 `spaceRoute.use('/memories', requireManager, memoriesRoute);` 后加 `spaceRoute.use('/trajectories', requireManager, trajectoriesRoute);`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && npx vitest run test/space-trajectories.test.ts`
Expected: PASS 全部（本文件累计约 12 用例）

- [ ] **Step 5: web 端——client + 组件 + i18n**

`apps/web/src/api/client.ts`：类型区（AssistantMemory 附近）加：

```ts
/** 助手轨迹行（GET /assistant/trajectories；productLineName 由路由 join 带出）。 */
export interface AssistantTrajectory {
  id: string;
  productLineId: string;
  productLineName: string | null;
  taskTitle: string;
  taskKeywords: string;
  digest: string;
  caseTitle: string;
  status: string;
  hitCount: number;
  lastHitAt: string | null;
  createdAt: string;
  updatedAtAt: string;
}
```

（列名以路由实际返回为准——updatedAt 拼写要与 select 一致，勿手滑。）memories 组（~L723）后加：

```ts
    /** 系统设置：助手轨迹（只读+软删；写入唯一入口是落库钩子→蒸馏 worker）。 */
    trajectories: {
      list: (params?: { productLineId?: string; status?: string }) =>
        request<AssistantTrajectory[]>(`/assistant/trajectories${qs(params ?? {})}`),
      remove: (id: string) =>
        request<void>(`/assistant/trajectories/${id}`, { method: 'DELETE' }),
    },
```

创建 `apps/web/src/components/settings/TrajectoriesSection.tsx`——**MemoriesSection.tsx 全同构**，差异点：
- queryKey `['assistant-trajectories']`、`api.assistant.trajectories.list({ status: 'active' })`
- 行渲染：主标题 `m.taskTitle`，副行 `m.caseTitle`，徽章：产品线名 + `m.hitCount` 次检索命中
- **error 分支（R1 终审教训，R2 必须有）**：在 isLoading 分支前加

```tsx
{listQ.isError ? (
  <div className="flex items-center gap-2 px-2 py-4 text-[12px]" style={{ color: 'var(--destructive)' }}>
    <Icon name="alertCircle" size={14} />
    {localizeApiError(listQ.error as Error)}
  </div>
) : listQ.isLoading ? ( /* 原.loading 分支 */ ) : …}
```

（`alertCircle` 若 Icon 无此名，用现有 `info`/`x` 系列替换。）

`AssistantPanel.tsx`：`<MemoriesSection />` 后加 `<TrajectoriesSection />`。

i18n——`zh-CN/settings.json` 加（en-US 同键英文）：

```json
"trajectoryTitle": "助手轨迹",
"trajectoryIntro": "产品线级成功用例生成轨迹（落库钩子自动蒸馏，判据=verify 实测通过+确认落库）。同线建用例任务检索引用；此处仅查看与删除。",
"trajectoryNone": "暂无轨迹",
"trajectoryFilterAll": "全部产品线",
"trajectoryHits": "{{count}} 次检索命中",
"trajectoryDeleteConfirm": "删除轨迹「{{name}}」？删除后不再注入助手上下文。"
```

- [ ] **Step 6: web 验证**

Run: `cd apps/web && npx tsc -b --dry`（或项目既有 typecheck 命令 `npm run build` 的类型段）；`npm run test -- --run`（若有组件测试）。
Expected: 类型零错误、测试绿

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/pi/space/trajectoriesRoute.ts apps/api/src/pi/space/router.ts apps/web/src/api/client.ts apps/web/src/components/settings/TrajectoriesSection.tsx apps/web/src/components/settings/AssistantPanel.tsx apps/web/src/i18n/locales/zh-CN/settings.json apps/web/src/i18n/locales/en-US/settings.json apps/api/test/space-trajectories.test.ts
git commit -m "feat(trajectories): 管理路由+设置页轨迹区——可见性下推SQL+error分支(R2)"
```

---

### Task 9: 全量回归 + E2E + 终审

**Files:** 无新文件（验证任务）

- [ ] **Step 1: 全量 api 回归**

Run: `cd apps/api && npx vitest run`
Expected: 除既有基线噪声（sendSyslog/testcontainers 并发假失败）外全绿；**space-memories.test.ts 14 例必须全过**（R1 红线）。文件级失败按既有惯例单文件重跑判定。

- [ ] **Step 2: 污染检查**

Run: `git status --short`
Expected: 干净（或仅本需求文件）；发现 `step-dsl-spec.ts` 等陌生源码改动 = 测试污染，立即还原。

- [ ] **Step 3: E2E 浏览器链路（dev 起服务）**

前置：api 用 `env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_API_KEY -u ANTHROPIC_MODEL nohup npx tsx watch src/index.ts >> /private/tmp/itest-api.log 2>&1 &` 起（环境陷阱，见 auto-memory）；web 5173；chrome-devtools MCP。

1. 助手会话让 AI 建一条用例并 verify_case 实测通过，用户确认落库（暂存面板勾选→保存）
2. 等 worker（dev 无 REDIS → inline 路径，数秒~分钟）：查库 `docker exec itest-pg psql -U itest -d itest -c "SELECT task_title, distill_model, status FROM assistant_trajectories;"` 应有一行 active，distill_model 为设置页配置的模型
3. **负向**：再建一条用例不跑 verify 直接确认落库 → 查库**不新增**轨迹行（判据红线）
4. 新开会话问「建一条类似 XX 的用例」→ 观察回复/工具轨迹中调用了 `search_trajectories`（或对「你知道哪些成功轨迹」的提问能列出轨迹）
5. 设置页 → AI 助手 → 助手轨迹区：行渲染（任务标题/用例标题/产品线徽章/命中数）；删除→确认→行消失；查库 status='deleted'
6. R1 回归抽查：助手记忆区仍正常（memories 不回归）

- [ ] **Step 4: 终审 subagent**

对 `git diff <Task1 起点>^..HEAD` 整体审查（adversarial-reviewer），重点：判据核实的绕过面、钩子对落库事务的影响、蒸馏 prompt 注入面（transcript 内容进 LLM）、跨线泄漏。发现 blocking 项回修；non-blocking 记 R3 backlog。

- [ ] **Step 5: 收尾**

- 记忆沉淀：R2 完成状态写入 auto-memory（含 E2E 结果与遗留项）
- 向用户报告：提交清单、E2E 证据、R3 backlog 增量

---

## Self-Review 记录

- **Spec 覆盖**：设计 §2 决策表逐项→Task 1（表）/2（服务）/3-4（判据+蒸馏）/6（检索）/7（注入）/8（管理+UI，含 R1 终审两教训落地）；§5.2 零 diff 红线→Task 7；§6「明确不做」未做。✓
- **类型一致**：`TrajectoryJob.items`（localId/caseId 对）在 Task 4（定义）/5（钩子构造）一致；`searchTrajectoriesByQuery` 返回 `{hits, all}` 在 Task 2（定义）/6（消费）一致；`insertTrajectory(input: $inferInsert)` Task 2/4 一致。✓
- **无占位符**：Task 5 Step 1 的 seed helper 与 Task 1 Step 1 的 `otherLinePlaceholder` 均已内联注明「以实际 helper 为准理顺」，属可执行指引而非 TBD。✓
- **风险注记**：Task 5 的 vi.doMock 对动态 import 的拦截是本计划唯一不确定测试手法，已给出降级路径（抽导出函数/开关旁路），实施者按最小改法走。
