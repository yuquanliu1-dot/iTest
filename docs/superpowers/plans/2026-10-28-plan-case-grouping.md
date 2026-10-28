# 执行计划用例分组与组级执行策略 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 计划内用例支持分组，每组独立配置目标环境、登录准备、组内 fail_fast、设备/浏览器上下文；组间串行按组序执行，计划级 strategy 管组间失败传导。

**Architecture:** 新增 `plan_case_groups` 表（方案 A），`plan_cases.group_id` 外键；`runPlan.ts` 单循环重构为按组双层循环（组边界做环境切换 + 登录准备，签名相同复用 storageState）；存量计划由容器启动时的幂等回迁（migrate.ts，advisory lock 内、push 之前）转为单个「默认分组」；计划级环境/登录字段在迁移完成后删除。

**Tech Stack:** Node/Express/Drizzle/pg（api）、React/TanStack Query/i18next（web）、vitest + testcontainers。

**设计文档:** `docs/superpowers/specs/2026-10-28-plan-case-grouping-design.md`

---

## 关键事实（实现者必读）

- **prod 迁移执行方式**：`drizzle-kit push --force` 在 api 启动时跑（`apps/api/src/db/migrate.ts`，advisory lock `0x4954455354` 串行化多容器）。`apps/api/drizzle/*.sql` 是记录/兜底文件，**不会自动执行**——数据回填必须挂在 migrate.ts 的锁窗口里（seedAssistantGuides 就是这么跑的）。
- **测试 schema**：`apps/api/test/helpers/db.ts` 的 `SCHEMA_SQL` 是独立维护的全量建表 SQL，不走迁移；有「测试 schema 放宽 NOT NULL」的先例（L73 version_id）。
- **NOT NULL 时序**：`plan_cases.group_id` 必须先回填、后置 NOT NULL——回填代码（Task 2）必须与 NOT NULL 声明同任务落地，且在 push 之前执行。
- **runCase 强制失败钩子**：环境变量 `FORCE_FAIL_CASE_IDS=uuid1,uuid2` 让 runCase 不启动浏览器直接落失败报告——引擎集成测试全靠它。
- **测试框架**：vitest + `@testcontainers/postgresql`（每文件真 PG 容器），模块用动态 `import()` 加载（db client 读 env 于模块加载时）。
- **既有基线红**：`sendSyslog` 等基线即红（见 CLAUDE 项目记忆），全量跑完先对照基线再判回归。
- **drizzle 编号**：工作区已有未提交的 `0046_case_dataset_row_indexes.sql`，本计划用 **0047**；开工时若 0047 已存在则顺延。
- **命名避撞**：`groups` 表是用例库文件夹，与本计划的 `plan_case_groups`（执行分组）无关。
- dev 本地起 api 需 `ENCRYPTION_KEY` + `CHROMIUM_PATH` 环境变量（turbo strict env 会剥离未声明变量）。

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/api/src/db/schema.ts` | 改 | planCaseGroups 新表；planCases.groupId；planRuns.groups；planRunCases 组列；（Task 10）删计划级旧列 |
| `apps/api/src/db/backfillPlanCaseGroups.ts` | 建新 | 幂等回迁：默认分组 + group_id 回填 |
| `apps/api/src/db/migrate.ts` | 改 | 锁窗口内、push 前调用回迁 |
| `apps/api/drizzle/0047_plan_case_groups.sql` | 建新 | 迁移记录（幂等 SQL，含回填与最终删列） |
| `apps/api/test/helpers/db.ts` | 改 | SCHEMA_SQL 同步 |
| `apps/api/src/services/plans.service.ts` | 改 | 组 CRUD + 组内用例编排 + getPlanDetail 分组形状 |
| `apps/api/src/routes/plans.ts` | 改 | 组端点 + 计划 POST/PATCH 瘦身 + 退役 PUT /cases |
| `apps/api/src/execute/enqueuePlanRun.ts` | 改 | 组级登录来源/隐身冲突/mobile 校验 + groups 快照 |
| `apps/api/src/execute/runCase.ts` | 改 | targetOverride 消费（incognito/deviceTargetId 覆盖点） |
| `apps/api/src/execute/runPlan.ts` | 重写 | 双层循环 + 登录复用签名 + 两级失败语义 |
| `apps/api/src/pi/space/tools/plans.ts` | 改 | manage_plans 适配分组 |
| `apps/web/src/api/client.ts` | 改 | 类型 + plans 组方法 |
| `apps/web/src/components/plans/PlanGroupCard.tsx` | 建新 | 分组卡片（组头配置 + 组内用例列表） |
| `apps/web/src/pages/PlanDetail.tsx` | 改 | 分组区块渲染 + 设置瘦身 + 加用例选组 |
| `apps/web/src/pages/PlanRunDetail.tsx` | 改 | chip 条按组分节 |
| `apps/web/src/i18n/locales/{zh-CN,en-US}/plans.json` | 改 | 新文案 |
| 测试 | 建/改 | `backfill-plan-groups.test.ts`、`plan-run-groups.test.ts`；扩展 `plans.service.test.ts`、`plans.test.ts`、`space-tools-plans.test.ts` |

---

### Task 1: Schema 加列（只加不删）

**Files:**
- Modify: `apps/api/src/db/schema.ts`（L466-553 区域）
- Modify: `apps/api/test/helpers/db.ts`（SCHEMA_SQL）
- Create: `apps/api/drizzle/0047_plan_case_groups.sql`

- [ ] **Step 1: schema.ts 加 planCaseGroups 表与相关列**

在 `export const planCases = pgTable(...)`（L489）**之前**插入：

```ts
/** 执行分组：计划内用例的有序分组，每组独立配置环境/登录准备/组内 fail_fast/设备与浏览器上下文。
 *  组间串行按 order 执行；计划级 strategy 管组间失败传导（fail_fast=前组失败取消后续组）。 */
export const planCaseGroups = pgTable('plan_case_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id').notNull().references(() => executionPlans.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  order: integer('order').notNull(),
  environmentId: uuid('environment_id').references(() => testEnvironments.id, { onDelete: 'set null' }),
  loginPrepareEnabled: boolean('login_prepare_enabled').notNull().default(false),
  loginCaseId: uuid('login_case_id').references(() => testCases.id, { onDelete: 'set null' }),
  detectionUrl: text('detection_url'),
  loginSuccessSelector: text('login_success_selector'),
  loginUnauthorizedKeywords: jsonb('login_unauthorized_keywords'),
  /** 组内策略：首例失败后跳过本组剩余用例（计划级 strategy 管组间） */
  failFast: boolean('fail_fast').notNull().default(false),
  /** 组级统一生效：deviceTargetId / 浏览器上下文（与 plan_cases.target_override 同形状） */
  targetConfig: jsonb('target_config').$type<{ deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  planOrderIdx: index('idx_plan_case_groups_plan_order').on(t.planId, t.order),
}));
```

`planCases` 表体（L489-499）加一列（**暂不 notNull**，Task 2 回填就位后再翻）：

```ts
export const planCases = pgTable('plan_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id').notNull().references(() => executionPlans.id, { onDelete: 'cascade' }),
  caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').references(() => planCaseGroups.id, { onDelete: 'cascade' }),
  order: integer('order').notNull(),
  // 计划级覆盖：用例默认 device_target / 浏览器上下文可在「加进计划」时改写，
  // 不动用例本体，仅本次计划执行时按覆盖解析。null = 沿用例自带值。
  targetOverride: jsonb('target_override').$type<{ deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null>(),
}, (t) => ({
  planOrderIdx: index('idx_plan_cases_plan_order').on(t.planId, t.order),
}));
```

`planRuns` 表（L501）加组快照列（插在 `strategy` 之后）：

```ts
  /** 组结构快照（enqueue 时写入）：[{id,name,order,environmentId,loginPrepareEnabled,loginCaseId,detectionUrl,loginSuccessSelector,loginUnauthorizedKeywords,failFast,targetConfig}]。
   *  老运行为 null（引擎兜底合成为单组）。标量 login_* 列保留给老运行 + 新运行写 OR 兼容旧 UI。 */
  groups: jsonb('groups'),
```

`planRunCases` 表（L533）加三列（插在 `order` 之前）：

```ts
  groupId: uuid('group_id'),
  groupName: varchar('group_name', { length: 200 }),
  groupOrder: integer('group_order'),
```

- [ ] **Step 2: SCHEMA_SQL 同步（测试库放宽版）**

`apps/api/test/helpers/db.ts`：`plan_cases` 建表行（L31）改为：

```sql
CREATE TABLE plan_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid REFERENCES execution_plans(id) ON DELETE CASCADE NOT NULL, case_id uuid REFERENCES test_cases(id) ON DELETE CASCADE NOT NULL, group_id uuid, "order" integer NOT NULL);
```

在 `plan_cases` 建表行**之前**插入（测试库 group_id 放宽为可空，沿用 version_id 先例）：

```sql
CREATE TABLE plan_case_groups (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid REFERENCES execution_plans(id) ON DELETE CASCADE NOT NULL, name varchar(200) NOT NULL, "order" integer NOT NULL, environment_id uuid REFERENCES test_environments(id) ON DELETE SET NULL, login_prepare_enabled boolean NOT NULL DEFAULT false, login_case_id uuid REFERENCES test_cases(id) ON DELETE SET NULL, detection_url text, login_success_selector text, login_unauthorized_keywords jsonb, fail_fast boolean NOT NULL DEFAULT false, target_config jsonb, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE INDEX idx_plan_case_groups_plan_order ON plan_case_groups(plan_id, "order");
```

`plan_runs` 建表行（L32）的 `strategy varchar(20) NOT NULL,` 后插 `groups jsonb,`；`plan_run_cases` 建表行（L33）的 `"order" integer NOT NULL,` 前插 `group_id uuid, group_name varchar(200), group_order integer,`。

- [ ] **Step 3: 迁移记录文件 0047**

`apps/api/drizzle/0047_plan_case_groups.sql`（Task 1 只写建表部分；删列部分 Task 10 追加）：

```sql
-- 0047: 执行计划用例分组。plan_case_groups 新表 + plan_cases.group_id（回填后 NOT NULL）
--        + plan_runs.groups 快照 + plan_run_cases 组列。
-- 语义：一计划 = 有序分组的串行执行流；组级环境/登录准备/fail_fast/target_config；
--        计划级 strategy 管组间失败传导。存量计划回迁为单个「默认分组」。
-- 执行路径：数据回填在 api 启动 migrate.ts 的 advisory lock 窗口内、drizzle-kit push 之前
--        （apps/api/src/db/backfillPlanCaseGroups.ts）；本文件为记录/兜底，不自动执行。
-- 幂等：可重复执行。
CREATE TABLE IF NOT EXISTS plan_case_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid REFERENCES execution_plans(id) ON DELETE CASCADE NOT NULL,
  name varchar(200) NOT NULL,
  "order" integer NOT NULL,
  environment_id uuid REFERENCES test_environments(id) ON DELETE SET NULL,
  login_prepare_enabled boolean NOT NULL DEFAULT false,
  login_case_id uuid REFERENCES test_cases(id) ON DELETE SET NULL,
  detection_url text,
  login_success_selector text,
  login_unauthorized_keywords jsonb,
  fail_fast boolean NOT NULL DEFAULT false,
  target_config jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plan_case_groups_plan_order ON plan_case_groups(plan_id, "order");
ALTER TABLE plan_cases ADD COLUMN IF NOT EXISTS group_id uuid;
ALTER TABLE plan_runs ADD COLUMN IF NOT EXISTS groups jsonb;
ALTER TABLE plan_run_cases ADD COLUMN IF NOT EXISTS group_id uuid;
ALTER TABLE plan_run_cases ADD COLUMN IF NOT EXISTS group_name varchar(200);
ALTER TABLE plan_run_cases ADD COLUMN IF NOT EXISTS group_order integer;
-- 数据回填见 backfillPlanCaseGroups.ts（DO 块版本，幂等）：
DO $$ BEGIN
  INSERT INTO plan_case_groups (id, plan_id, name, "order", environment_id, login_prepare_enabled,
    login_case_id, detection_url, login_success_selector, login_unauthorized_keywords, fail_fast)
  SELECT gen_random_uuid(), p.id, '默认分组', 0, p.environment_id, p.login_prepare_enabled,
    p.login_case_id, p.detection_url, p.login_success_selector, p.login_unauthorized_keywords,
    (p.strategy = 'fail_fast')
  FROM execution_plans p
  WHERE EXISTS (SELECT 1 FROM plan_cases pc WHERE pc.plan_id = p.id AND pc.group_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM plan_case_groups g WHERE g.plan_id = p.id);
EXCEPTION WHEN undefined_column THEN null;
END $$;
DO $$ BEGIN
  UPDATE plan_cases pc SET group_id = g.id
  FROM plan_case_groups g
  WHERE g.plan_id = pc.plan_id AND pc.group_id IS NULL;
EXCEPTION WHEN undefined_column THEN null;
END $$;
```

- [ ] **Step 4: typecheck 通过**

Run: `pnpm -C apps/api exec tsc --noEmit`
Expected: 无错误（纯加列不破坏现有代码）

- [ ] **Step 5: 既有计划相关测试不回归**

Run: `pnpm -C apps/api exec vitest run test/plans.service.test.ts test/plans.test.ts test/plan-run-cancel.test.ts`
Expected: 全 PASS（需本地 Docker 跑 testcontainers）

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/test/helpers/db.ts apps/api/drizzle/0047_plan_case_groups.sql
git commit -m "feat(plans): plan_case_groups 建表与组列——分组化第一步（只加不删）"
```

---

### Task 2: 回迁模块 + migrate.ts 接线 + group_id 置 NOT NULL

**Files:**
- Create: `apps/api/src/db/backfillPlanCaseGroups.ts`
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/db/schema.ts`（groupId 翻 notNull）
- Test: `apps/api/test/backfill-plan-groups.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/api/test/backfill-plan-groups.test.ts`（照 `plans.service.test.ts` 的容器引导模式：文件顶部启 testcontainer → 设 env → `pool.query(SCHEMA_SQL)` → 动态 import）：

```ts
import { afterAll, beforeAll, expect, test } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { SCHEMA_SQL, seedProject } from './helpers/db.js';

let pool: Pool;

beforeAll(async () => {
  const c = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = c.getConnectionUri();
  process.env.ENCRYPTION_KEY = 'test-encryption-key-32bytes-padding!';
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(SCHEMA_SQL);
});

afterAll(async () => {
  await pool?.end();
});

async function makePlan(name: string, strategy = 'run_all'): Promise<string> {
  const s = await seedProject(pool);
  const p = await pool.query(
    `INSERT INTO execution_plans(project_id, version_id, name, environment_id, strategy, login_prepare_enabled, login_case_id, detection_url, login_success_selector, login_unauthorized_keywords)
     VALUES ($1, $2, $3, NULL, $4, true, NULL, 'https://x/detect', '.ok', '["未登录"]'::jsonb) RETURNING id`,
    [s.projectId, s.versionId, name, strategy],
  );
  const cases = await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, 'c1'), ($1, $2, 'c2') RETURNING id`,
    [s.groupId, s.versionId],
  );
  const ids = cases.rows.map((r) => r.id as string);
  await pool.query(
    `INSERT INTO plan_cases(plan_id, case_id, "order") VALUES ($1, $2, 1), ($1, $3, 2)`,
    [p.rows[0]!.id, ids[0], ids[1]],
  );
  return p.rows[0]!.id as string;
}

test('有用例且无组的计划回迁为默认分组，拷贝环境/登录配置，strategy=fail_fast 映射组 failFast', async () => {
  const planId = await makePlan('回迁A', 'fail_fast');
  const { backfillPlanCaseGroups } = await import('../src/db/backfillPlanCaseGroups.js');
  await backfillPlanCaseGroups(pool);
  const g = await pool.query(`SELECT * FROM plan_case_groups WHERE plan_id = $1`, [planId]);
  expect(g.rows.length).toBe(1);
  expect(g.rows[0]!.name).toBe('默认分组');
  expect(g.rows[0]!.fail_fast).toBe(true);
  expect(g.rows[0]!.login_prepare_enabled).toBe(true);
  expect(g.rows[0]!.detection_url).toBe('https://x/detect');
  const pcs = await pool.query(`SELECT group_id, "order" FROM plan_cases WHERE plan_id = $1 ORDER BY "order"`, [planId]);
  expect(pcs.rows.every((r) => r.group_id === g.rows[0]!.id)).toBe(true);
  expect(pcs.rows.map((r) => r.order)).toEqual([1, 2]);
});

test('幂等：重跑不产生重复组', async () => {
  const planId = await makePlan('回迁B');
  const { backfillPlanCaseGroups } = await import('../src/db/backfillPlanCaseGroups.js');
  await backfillPlanCaseGroups(pool);
  await backfillPlanCaseGroups(pool);
  const n = await pool.query(`SELECT count(*)::int AS n FROM plan_case_groups WHERE plan_id = $1`, [planId]);
  expect(n.rows[0]!.n).toBe(1);
});

test('空计划不建组', async () => {
  const s = await seedProject(pool);
  const p = await pool.query(`INSERT INTO execution_plans(project_id, version_id, name) VALUES ($1, $2, '空计划') RETURNING id`, [s.projectId, s.versionId]);
  const { backfillPlanCaseGroups } = await import('../src/db/backfillPlanCaseGroups.js');
  await backfillPlanCaseGroups(pool);
  const n = await pool.query(`SELECT count(*)::int AS n FROM plan_case_groups WHERE plan_id = $1`, [p.rows[0]!.id]);
  expect(n.rows[0]!.n).toBe(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/backfill-plan-groups.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现回迁模块**

`apps/api/src/db/backfillPlanCaseGroups.ts`：

```ts
import type { Pool } from 'pg';

/**
 * 存量计划回迁（幂等，可在任何状态重跑）：
 * 1. 有用例且尚无分组的计划 → 建一个「默认分组」，拷贝计划级环境 + 登录配置，
 *    fail_fast = (计划 strategy = 'fail_fast')；
 * 2. group_id 为空的 plan_cases 全部挂入所属计划的默认分组（组内序沿用原全局序）。
 * 空计划不建组。执行时机：migrate.ts 拿到 advisory lock 后、drizzle-kit push 之前——
 * 这样 push 才能安全地把 group_id 置 NOT NULL。
 * 计划级旧列被后续迁移删除后，本函数自动 no-op（列不存在则跳过回填段）。
 */
export async function backfillPlanCaseGroups(pool: Pool): Promise<void> {
  // 列存在性探测：旧列已删（迁移完成后）则回填段整体跳过，只保留建表/加列的 no-op。
  const cols = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'execution_plans'`,
  );
  const has = (c: string) => cols.rows.some((r) => r.column_name === c);
  if (!has('login_prepare_enabled')) return; // 已完成删列迁移，无事可做

  await pool.query(`
    INSERT INTO plan_case_groups (id, plan_id, name, "order", environment_id, login_prepare_enabled,
      login_case_id, detection_url, login_success_selector, login_unauthorized_keywords, fail_fast)
    SELECT gen_random_uuid(), p.id, '默认分组', 0, p.environment_id, p.login_prepare_enabled,
      p.login_case_id, p.detection_url, p.login_success_selector, p.login_unauthorized_keywords,
      (p.strategy = 'fail_fast')
    FROM execution_plans p
    WHERE EXISTS (SELECT 1 FROM plan_cases pc WHERE pc.plan_id = p.id AND pc.group_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM plan_case_groups g WHERE g.plan_id = p.id)
  `);
  await pool.query(`
    UPDATE plan_cases pc SET group_id = g.id
    FROM plan_case_groups g
    WHERE g.plan_id = pc.plan_id AND pc.group_id IS NULL
  `);
}
```

注意：`plan_case_groups` 表此时可能尚不存在（全新库首次启动、push 未跑）——模块开头补一段 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE plan_cases ADD COLUMN IF NOT EXISTS group_id uuid`（与 0047.sql 建表段相同），保证在 push 之前能安全执行。

- [ ] **Step 4: migrate.ts 接线（push 之前）**

`apps/api/src/db/migrate.ts`：import 区加 `import { backfillPlanCaseGroups } from './backfillPlanCaseGroups.js';`（用 `new pg.Pool(...)` 建池或在 lock 块内复用 client——实现按现有 client 直连即可）：

```ts
  try {
    logger.info('advisory lock 获取成功，执行分组回迁（push 前）');
    await backfillPlanCaseGroupsPool(client);
    logger.info('advisory lock 获取成功，执行 drizzle-kit push');
    const r = spawnSync('pnpm', ['exec', 'drizzle-kit', 'push', '--force'], { ... });
```

实现细节：`backfillPlanCaseGroups` 签名收 `Pool`，而 migrate.ts 持有的是 `pg.Client`。两者都实现 `query`——把参数类型放宽为 `{ query: (sql: string) => Promise<unknown> }` 最省事：

```ts
export async function backfillPlanCaseGroups(pool: { query: (sql: string) => Promise<unknown> }): Promise<void> {
```

（测试里 `information_schema` 查询返回类型断言按实际调整。）

- [ ] **Step 5: schema.ts 翻 NOT NULL**

`planCases.groupId` 改为：

```ts
  groupId: uuid('group_id').notNull().references(() => planCaseGroups.id, { onDelete: 'cascade' }),
```

- [ ] **Step 6: 跑测试通过 + typecheck**

Run: `pnpm -C apps/api exec vitest run test/backfill-plan-groups.test.ts && pnpm -C apps/api exec tsc --noEmit`
Expected: 3 个测试 PASS；typecheck 无错误

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/backfillPlanCaseGroups.ts apps/api/src/db/migrate.ts apps/api/src/db/schema.ts apps/api/test/backfill-plan-groups.test.ts
git commit -m "feat(plans): 存量计划回迁默认分组——migrate 锁窗口内 push 前执行，group_id 置 NOT NULL"
```

---

### Task 3: plans.service 组 CRUD

**Files:**
- Modify: `apps/api/src/services/plans.service.ts`
- Test: `apps/api/test/plans.service.test.ts`（追加 describe）

- [ ] **Step 1: 写失败测试（追加到 plans.service.test.ts）**

```ts
describe('plan case groups CRUD', () => {
  test('create→默认 order=1，第二组 order=2；env 校验沿用 assertEnvInProject', async () => {
    const s = await seedProject(pool);
    const g1 = await svc.createPlanGroup(s.projectId, { planVersionSeedPlanId, name: '组A' }); // 见下：helper
    // ……实际写法：先建 plan 再建组
  });
});
```

实际测试体（`planId` 用现有 helper 建 plan：`svc.createPlan(s.projectId, { name: 'p', versionId: s.versionId })`）：

```ts
test('组 CRUD：建组递增 order、改组、删空组、删非空组 409、重排', async () => {
  const s = await seedProject(pool);
  const plan = await svc.createPlan(s.projectId, { name: '分组计划', versionId: s.versionId });
  const g1 = await svc.createPlanGroup(plan.id, { name: '组A' });
  const g2 = await svc.createPlanGroup(plan.id, { name: '组B' });
  expect(g1.order).toBe(1);
  expect(g2.order).toBe(2);

  const renamed = await svc.updatePlanGroup(plan.id, g1.id, { name: '组A1', failFast: true });
  expect(renamed.name).toBe('组A1');
  expect(renamed.failFast).toBe(true);

  await expect(svc.deletePlanGroup(plan.id, g2.id)).resolves.toMatchObject({ ok: true });

  // 组A 放入用例后删除 → 409 group_not_empty
  const c = await pool.query(`INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, 'c') RETURNING id`, [s.groupId, s.versionId]);
  await svc.setPlanGroupCases(plan.id, g1.id, [c.rows[0]!.id]); // Task 4 实现；本测试先于实现会失败，Step 3 一起实现
  await expect(svc.deletePlanGroup(plan.id, g1.id)).rejects.toMatchObject({ status: 409, code: 'group_not_empty' });

  // 清空后可删
  await svc.setPlanGroupCases(plan.id, g1.id, []);
  await expect(svc.deletePlanGroup(plan.id, g1.id)).resolves.toMatchObject({ ok: true });
});

test('组重排：整包替换 order，groupId 不属于该计划 → 404', async () => {
  const s = await seedProject(pool);
  const plan = await svc.createPlan(s.projectId, { name: 'p2', versionId: s.versionId });
  const g1 = await svc.createPlanGroup(plan.id, { name: 'A' });
  const g2 = await svc.createPlanGroup(plan.id, { name: 'B' });
  await svc.reorderPlanGroups(plan.id, [g2.id, g1.id]);
  const after = await svc.listPlanGroups(plan.id);
  expect(after.map((g) => g.name)).toEqual(['B', 'A']);
  await expect(svc.reorderPlanGroups(plan.id, ['00000000-0000-4000-8000-000000000000'])).rejects.toMatchObject({ status: 404 });
});

test('组环境必须属于计划项目', async () => {
  const s = await seedProject(pool);
  const other = await seedProject(pool); // 同种子线内另一项目（同线合法），跨线才非法——用 seedOtherProductLine 造真跨线
  const plan = await svc.createPlan(s.projectId, { name: 'p3', versionId: s.versionId });
  const otherLine = await seedOtherProductLine(pool);
  const s2 = await seedProject(pool, { productLineId: otherLine });
  const env = await pool.query(`INSERT INTO test_environments(project_id, name) VALUES ($1, 'e') RETURNING id`, [s2.projectId]);
  await expect(svc.createPlanGroup(plan.id, { name: 'g', environmentId: env.rows[0]!.id })).rejects.toMatchObject({ status: 400, code: 'env_project_mismatch' });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/plans.service.test.ts`
Expected: FAIL（createPlanGroup 等不存在）

- [ ] **Step 3: 实现组 CRUD**

`plans.service.ts` 追加（import 区补 `planCaseGroups`；`asc/desc/eq/and/inArray/sql` 已有）：

```ts
export interface PlanGroupLoginPrepareInput {
  enabled: boolean;
  caseId?: string | null;
  detectionUrl?: string | null;
  successSelector?: string | null;
  unauthorizedKeywords?: string[] | null;
}

export interface CreatePlanGroupInput {
  name: string;
  environmentId?: string | null;
  loginPrepare?: PlanGroupLoginPrepareInput;
  failFast?: boolean;
  targetConfig?: { deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null;
}

export interface UpdatePlanGroupPatch extends Partial<Omit<CreatePlanGroupInput, 'name'>> {
  name?: string;
}

/** 组必须属于该计划；不存在 → 404（事务外用的只读版）。 */
async function getPlanGroup(planId: string, groupId: string) {
  const g = (await db.select().from(planCaseGroups)
    .where(and(eq(planCaseGroups.id, groupId), eq(planCaseGroups.planId, planId))).limit(1))[0];
  if (!g) throw new HttpError(404, 'group_not_found', 'plan case group not found');
  return g;
}

export async function listPlanGroups(planId: string) {
  return db.select().from(planCaseGroups).where(eq(planCaseGroups.planId, planId)).orderBy(asc(planCaseGroups.order));
}

export async function createPlanGroup(planId: string, input: CreatePlanGroupInput) {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  if (input.environmentId) await assertEnvInProject(input.environmentId, plan.projectId);
  const base = Number((await db.select({ m: sql<number>`coalesce(max("order"), 0)` })
    .from(planCaseGroups).where(eq(planCaseGroups.planId, planId)))[0]?.m ?? 0);
  return (await db.insert(planCaseGroups).values({
    planId,
    name: input.name,
    order: base + 1,
    environmentId: input.environmentId ?? null,
    loginPrepareEnabled: input.loginPrepare?.enabled ?? false,
    loginCaseId: input.loginPrepare?.caseId ?? null,
    detectionUrl: input.loginPrepare?.detectionUrl ?? null,
    loginSuccessSelector: input.loginPrepare?.successSelector ?? null,
    loginUnauthorizedKeywords: input.loginPrepare?.unauthorizedKeywords ?? null,
    failFast: input.failFast ?? false,
    targetConfig: input.targetConfig ?? null,
  }).returning())[0]!;
}

export async function updatePlanGroup(planId: string, groupId: string, patch: UpdatePlanGroupPatch) {
  const existing = await getPlanGroup(planId, groupId);
  if (patch.environmentId !== undefined && patch.environmentId !== null) {
    const plan = (await db.select({ projectId: executionPlans.projectId }).from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
    if (plan) await assertEnvInProject(patch.environmentId, plan.projectId);
  }
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.environmentId !== undefined) update.environmentId = patch.environmentId;
  if (patch.failFast !== undefined) update.failFast = patch.failFast;
  if (patch.targetConfig !== undefined) update.targetConfig = patch.targetConfig;
  if (patch.loginPrepare !== undefined) {
    update.loginPrepareEnabled = patch.loginPrepare.enabled;
    update.loginCaseId = patch.loginPrepare.caseId ?? null;
    update.detectionUrl = patch.loginPrepare.detectionUrl ?? null;
    update.loginSuccessSelector = patch.loginPrepare.successSelector ?? null;
    update.loginUnauthorizedKeywords = patch.loginPrepare.unauthorizedKeywords ?? null;
  }
  void existing;
  return (await db.update(planCaseGroups).set(update).where(eq(planCaseGroups.id, groupId)).returning())[0]!;
}

/** 组内有用例 → 409（对齐删产品线 409 惯例）；空组直接删。 */
export async function deletePlanGroup(planId: string, groupId: string) {
  await getPlanGroup(planId, groupId);
  const n = (await db.select({ c: sql<number>`count(*)::int` }).from(planCases)
    .where(eq(planCases.groupId, groupId)))[0]?.c ?? 0;
  if (n > 0) throw new HttpError(409, 'group_not_empty', `group still has ${n} case(s); move or remove them first`);
  await db.delete(planCaseGroups).where(eq(planCaseGroups.id, groupId));
  return { ok: true };
}

/** 组排序整包替换；groupIds 必须恰好是计划的全部分组。事务 + 计划行锁。 */
export async function reorderPlanGroups(planId: string, groupIds: string[]) {
  return db.transaction(async (tx) => {
    await tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1).for('update');
    const current = await tx.select({ id: planCaseGroups.id }).from(planCaseGroups).where(eq(planCaseGroups.planId, planId));
    const have = new Set(current.map((g) => g.id));
    if (groupIds.length !== have.size || groupIds.some((id) => !have.has(id))) {
      throw new HttpError(404, 'group_not_found', 'groupIds must be exactly the plan groups');
    }
    for (let i = 0; i < groupIds.length; i++) {
      await tx.update(planCaseGroups).set({ order: i + 1, updatedAt: new Date() }).where(eq(planCaseGroups.id, groupIds[i]!));
    }
    return { ok: true };
  });
}
```

注意：`setPlanGroupCases` 在本任务尚不存在——测试里对它的调用会编译错。实现顺序：本 Step 先把 Task 4 的 `setPlanGroupCases` 一并落地（见 Task 4 Step 3 的代码），或把 409 测试挪到 Task 4。**推荐：本任务先实现组 CRUD + 用 `db.insert(planCases)` 直插行来造「非空组」，`setPlanGroupCases` 留给 Task 4。**

- [ ] **Step 4: 跑测试通过**

Run: `pnpm -C apps/api exec vitest run test/plans.service.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/plans.service.ts apps/api/test/plans.service.test.ts
git commit -m "feat(plans): 分组 CRUD——建/改/删(409 非空)/重排，环境归属校验"
```

---

### Task 4: plans.service 组内用例编排 + getPlanDetail 分组形状

**Files:**
- Modify: `apps/api/src/services/plans.service.ts`
- Test: `apps/api/test/plans.service.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

```ts
test('setPlanGroupCases 整包替换组内用例并 1..n 重排；同用例可入多组；组内去重', async () => {
  const s = await seedProject(pool);
  const plan = await svc.createPlan(s.projectId, { name: 'p', versionId: s.versionId });
  const gA = await svc.createPlanGroup(plan.id, { name: 'A' });
  const gB = await svc.createPlanGroup(plan.id, { name: 'B' });
  const cs = await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, 'c1'), ($1, $2, 'c2') RETURNING id`,
    [s.groupId, s.versionId]);
  const [c1, c2] = cs.rows.map((r) => r.id as string);

  await svc.setPlanGroupCases(plan.id, gA.id, [c1, c2]);
  await svc.setPlanGroupCases(plan.id, gB.id, [c1, c1]); // 同组重复去重为 1 条；跨组重复合法
  const detailA = await svc.getPlanDetail(plan.id);
  const gAafter = detailA!.groups!.find((g) => g.id === gA.id)!;
  const gBafter = detailA!.groups!.find((g) => g.id === gB.id)!;
  expect(gAafter.cases.map((c) => c.id)).toEqual([c1, c2]);
  expect(gBafter.cases.map((c) => c.id)).toEqual([c1]);
  expect(gAafter.cases.map((c) => c.order)).toEqual([1, 2]);
  // 平铺 cases（兼容旧读取）：按组序拼接
  expect(detailA!.cases.map((c) => c.id)).toEqual([c1, c2, c1]);
});

test('addPlanCases 带 groupId 追加到指定组尾；无组计划自动建「默认分组」；remove 后受影响组内重排', async () => {
  const s = await seedProject(pool);
  const plan = await svc.createPlan(s.projectId, { name: 'p', versionId: s.versionId });
  const cs = await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, 'x1'), ($1, $2, 'x2') RETURNING id`,
    [s.groupId, s.versionId]);
  const [x1, x2] = cs.rows.map((r) => r.id as string);

  const added = await svc.addPlanCases(plan.id, [x1]); // 无组 → 自动建默认分组
  expect(added).toBe(1);
  const d1 = await svc.getPlanDetail(plan.id);
  expect(d1!.groups!.map((g) => g.name)).toEqual(['默认分组']);

  await svc.addPlanCases(plan.id, [x2]);
  const d2 = await svc.getPlanDetail(plan.id);
  expect(d2!.groups![0]!.cases.map((c) => c.id)).toEqual([x1, x2]);

  await svc.removePlanCases(plan.id, [x1]);
  const d3 = await svc.getPlanDetail(plan.id);
  expect(d3!.groups![0]!.cases.map((c) => c.id)).toEqual([x2]);
  expect(d3!.groups![0]!.cases.map((c) => c.order)).toEqual([1]);
});

test('movePlanCases 跨组移动行；reorderPlanGroupCases 组内重排', async () => {
  const s = await seedProject(pool);
  const plan = await svc.createPlan(s.projectId, { name: 'p', versionId: s.versionId });
  const gA = await svc.createPlanGroup(plan.id, { name: 'A' });
  const gB = await svc.createPlanGroup(plan.id, { name: 'B' });
  const cs = await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1, $2, 'm1'), ($1, $2, 'm2') RETURNING id`,
    [s.groupId, s.versionId]);
  const [m1, m2] = cs.rows.map((r) => r.id as string);
  await svc.setPlanGroupCases(plan.id, gA.id, [m1, m2]);

  const rows = await pool.query(`SELECT id, case_id FROM plan_cases WHERE plan_id = $1 ORDER BY "order"`, [plan.id]);
  const rowM2 = rows.rows.find((r) => r.case_id === m2)!;
  await svc.movePlanCases(plan.id, [rowM2.id as string], gB.id);
  let d = await svc.getPlanDetail(plan.id);
  expect(d!.groups!.find((g) => g.id === gA.id)!.cases.map((c) => c.id)).toEqual([m1]);
  expect(d!.groups!.find((g) => g.id === gB.id)!.cases.map((c) => c.id)).toEqual([m2]);

  await svc.setPlanGroupCases(plan.id, gA.id, [m1, m2]);
  await svc.reorderPlanGroupCases(plan.id, gA.id, [m2, m1]);
  d = await svc.getPlanDetail(plan.id);
  expect(d!.groups!.find((g) => g.id === gA.id)!.cases.map((c) => c.id)).toEqual([m2, m1]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/plans.service.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现编排函数**

`plans.service.ts`：

```ts
/** 事务内锁计划行 + 校验组归属（写路径共用）。 */
async function lockPlanGroup(tx: typeof db, planId: string, groupId: string) {
  const plan = (await tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1).for('update'))[0];
  if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
  const g = (await tx.select().from(planCaseGroups)
    .where(and(eq(planCaseGroups.id, groupId), eq(planCaseGroups.planId, planId))).limit(1))[0];
  if (!g) throw new HttpError(404, 'group_not_found', 'plan case group not found');
  return { plan, group: g };
}

/** 整包替换该组用例（组内去重、1..n）；跨组重复合法。事务 + 计划行锁。 */
export async function setPlanGroupCases(planId: string, groupId: string, caseIds: string[]): Promise<number> {
  const ids = [...new Set(caseIds)];
  return db.transaction(async (tx) => {
    const { plan } = await lockPlanGroup(tx as unknown as typeof db, planId, groupId);
    await assertCasesInProject(plan.projectId, ids);
    await tx.delete(planCases).where(eq(planCases.groupId, groupId));
    if (ids.length > 0) {
      await tx.insert(planCases).values(ids.map((caseId, i) => ({ planId, caseId, groupId, order: i + 1 })));
    }
    return ids.length;
  });
}

/** 组内重排：caseIds 必须恰为该组当前用例集合。事务 + 计划行锁。 */
export async function reorderPlanGroupCases(planId: string, groupId: string, caseIds: string[]) {
  return db.transaction(async (tx) => {
    await lockPlanGroup(tx as unknown as typeof db, planId, groupId);
    const rows = await tx.select({ id: planCases.id, caseId: planCases.caseId })
      .from(planCases).where(eq(planCases.groupId, groupId));
    const have = new Set(rows.map((r) => r.caseId));
    if (caseIds.length !== have.size || caseIds.some((c) => !have.has(c))) {
      throw new HttpError(400, 'cases_mismatch', 'caseIds must be exactly the group cases');
    }
    for (let i = 0; i < caseIds.length; i++) {
      await tx.update(planCases).set({ order: i + 1 })
        .where(and(eq(planCases.groupId, groupId), eq(planCases.caseId, caseIds[i]!)));
    }
    return { ok: true };
  });
}

/** 跨组移动行（按 plan_cases.id，不是 caseId——同用例可多行）。追加到目标组尾。 */
export async function movePlanCases(planId: string, planCaseIds: string[], toGroupId: string) {
  return db.transaction(async (tx) => {
    await lockPlanGroup(tx as unknown as typeof db, planId, toGroupId);
    const rows = await tx.select().from(planCases)
      .where(and(eq(planCases.planId, planId), inArray(planCases.id, planCaseIds)));
    if (rows.length !== planCaseIds.length) throw new HttpError(404, 'not_found', 'plan case row not found');
    const base = Number((await tx.select({ m: sql<number>`coalesce(max("order"), 0)` })
      .from(planCases).where(eq(planCases.groupId, toGroupId)))[0]?.m ?? 0);
    for (let i = 0; i < rows.length; i++) {
      await tx.update(planCases).set({ groupId: toGroupId, order: base + i + 1 }).where(eq(planCases.id, rows[i]!.id));
    }
    // 源组重排
    const touched = [...new Set(rows.map((r) => r.groupId))];
    for (const gid of touched) {
      if (gid === toGroupId) continue;
      await renumberGroup(tx as unknown as typeof db, gid);
    }
    return { ok: true };
  });
}

async function renumberGroup(tx: typeof db, groupId: string) {
  const rest = await tx.select({ id: planCases.id }).from(planCases)
    .where(eq(planCases.groupId, groupId)).orderBy(asc(planCases.order));
  for (let i = 0; i < rest.length; i++) {
    await tx.update(planCases).set({ order: i + 1 }).where(eq(planCases.id, rest[i]!.id));
  }
}
```

**改造既有三函数**（签名/语义变化）：

```ts
/** 追加用例到指定组（默认第一个组；无组计划自动建「默认分组」）。仅对目标组内已有 id 去重，跨组重复合法。 */
export async function addPlanCases(planId: string, caseIds: string[], groupId?: string): Promise<number> {
  return db.transaction(async (tx) => {
    const plan = (await tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1).for('update'))[0];
    if (!plan) throw new HttpError(404, 'not_found', 'plan not found');
    await assertCasesInProject(plan.projectId, caseIds);
    let gid = groupId;
    if (!gid) {
      const first = (await tx.select().from(planCaseGroups).where(eq(planCaseGroups.planId, planId)).orderBy(asc(planCaseGroups.order)).limit(1))[0];
      if (first) gid = first.id;
      else {
        const g = (await tx.insert(planCaseGroups).values({ planId, name: '默认分组', order: 1 }).returning())[0]!;
        gid = g.id;
      }
    } else {
      const g = (await tx.select().from(planCaseGroups)
        .where(and(eq(planCaseGroups.id, gid), eq(planCaseGroups.planId, planId))).limit(1))[0];
      if (!g) throw new HttpError(404, 'group_not_found', 'plan case group not found');
    }
    const existing = await tx.select({ caseId: planCases.caseId }).from(planCases).where(eq(planCases.groupId, gid));
    const have = new Set(existing.map((e) => e.caseId));
    const fresh = [...new Set(caseIds)].filter((c) => !have.has(c));
    if (fresh.length === 0) return 0;
    const base = Number((await tx.select({ m: sql<number>`coalesce(max("order"), 0)` }).from(planCases).where(eq(planCases.groupId, gid)))[0]?.m ?? 0);
    await tx.insert(planCases).values(fresh.map((caseId, i) => ({ planId, caseId, groupId: gid, order: base + i + 1 })));
    return fresh.length;
  });
}

/** 移除用例（按 caseId 删该计划所有行——同用例多行一并删），受影响组内重排 1..m。 */
export async function removePlanCases(planId: string, caseIds: string[]): Promise<number> {
  if (caseIds.length === 0) return 0;
  return db.transaction(async (tx) => {
    await tx.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1).for('update');
    const removed = await tx.delete(planCases)
      .where(and(eq(planCases.planId, planId), inArray(planCases.caseId, caseIds)))
      .returning({ id: planCases.id, groupId: planCases.groupId });
    if (removed.length === 0) return 0;
    for (const gid of [...new Set(removed.map((r) => r.groupId))]) {
      await renumberGroup(tx as unknown as typeof db, gid);
    }
    return removed.length;
  });
}
```

**`replacePlanCases` 删除**（退役——调用方 Task 5/9 迁移到 `setPlanGroupCases`）。

**getPlanDetail 改造**（保持 `cases` 平铺字段做兼容，另加 `groups`）：

```ts
export async function getPlanDetail(planId: string) {
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, planId)).limit(1))[0];
  if (!plan) return null;
  const gs = await db.select().from(planCaseGroups).where(eq(planCaseGroups.planId, plan.id)).orderBy(asc(planCaseGroups.order));
  const pcs = await db.select().from(planCases).where(eq(planCases.planId, plan.id)).orderBy(asc(planCases.order));
  // ……join 用例元信息的 rows 查询保持原样（L157-173）……
  const byId = new Map(rows.map((c) => [c.id, c]));
  const caseMeta = (caseId: string) => {
    const c = byId.get(caseId);
    return {
      id: caseId,
      title: c?.title ?? 'unknown',
      url: c?.url ?? null,
      versionId: c?.versionId ?? null,
      versionName: c?.versionName ?? null,
      projectId: c?.projectId ?? null,
      projectName: c?.projectName ?? null,
    };
  };
  let versionName: string | null = null;
  if (plan.versionId) {
    const v = (await db.select({ name: projectVersions.name }).from(projectVersions).where(eq(projectVersions.id, plan.versionId)).limit(1))[0];
    versionName = v?.name ?? null;
  }
  const groups = gs.map((g, gi) => ({
    id: g.id,
    name: g.name,
    order: g.order,
    environmentId: g.environmentId,
    loginPrepareEnabled: g.loginPrepareEnabled,
    loginCaseId: g.loginCaseId,
    detectionUrl: g.detectionUrl,
    loginSuccessSelector: g.loginSuccessSelector,
    loginUnauthorizedKeywords: g.loginUnauthorizedKeywords,
    failFast: g.failFast,
    targetConfig: g.targetConfig,
    cases: pcs.filter((pc) => pc.groupId === g.id).map((pc, i) => ({
      planCaseId: pc.id,
      order: i + 1,
      ...caseMeta(pc.caseId),
    })),
  }));
  // 平铺 cases：按组序拼接，order 为全局 1..N（兼容旧读取/UI 过渡）
  const flat = groups.flatMap((g) => g.cases.map((c) => ({ ...c, planCaseId: c.planCaseId })));
  return attachCreator({
    ...plan,
    versionName,
    groups,
    cases: flat.map((c, i) => ({ ...c, globalOrder: i + 1 })),
  });
}
```

- [ ] **Step 4: 跑测试（本文件全部）**

Run: `pnpm -C apps/api exec vitest run test/plans.service.test.ts`
Expected: 全 PASS（`replacePlanCases` 的既有用例改写为 `setPlanGroupCases` 或删除）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/plans.service.ts apps/api/test/plans.service.test.ts
git commit -m "feat(plans): 组内用例编排——整包替换/追加(自动建默认组)/跨组移动/移除重排；getPlanDetail 分组形状"
```

---

### Task 5: 路由——组端点 + 计划 POST/PATCH 瘦身 + 退役 PUT /cases

**Files:**
- Modify: `apps/api/src/routes/plans.ts`
- Modify: `apps/api/src/services/plans.service.ts`（createPlan/updatePlan 去掉环境/登录字段）
- Test: `apps/api/test/plans.test.ts`

- [ ] **Step 1: 写失败测试（HTTP 层，追加到 plans.test.ts）**

```ts
test('组端点全链路：建组→PATCH→409 删除非空组→组排序→组内用例替换→跨组移动', async () => {
  // 沿用文件既有 helper：token、createPlan via POST /api/projects/:pid/plans、cases seed
  // ……造 2 组 2 用例，逐一断言：
  // POST /api/plans/:id/groups {name} → 200 组行
  // PATCH /api/plans/:id/groups/:gid {failFast:true} → 200
  // DELETE /api/plans/:id/groups/:gid（非空）→ 409 {code:'group_not_empty'}
  // PUT /api/plans/:id/groups/order {groupIds:[g2,g1]} → 200，GET :id 验组序
  // PUT /api/plans/:id/groups/:gid/cases {caseIds} → 200
  // PUT /api/plans/:id/cases/move {planCaseIds, toGroupId} → 200
  // POST /api/plans/:id/cases {caseIds, groupId} → 200
  // PUT /api/plans/:id/cases/order {groupId, caseIds} → 200
  // 越组：PATCH /api/plans/A/groups/:B组id → 404 group_not_found
});

test('计划 PATCH 不再接受 environmentId/loginPrepare（422 未知字段由 zod strip；显式传 strategy/rca 仍可）', async () => {
  // PATCH /api/plans/:id {name} → 200；响应体无 environmentId/loginPrepare 字段
});
```

（具体实现照 plans.test.ts 既有 supertest 模式写全，此处为断言清单；写测试时每个断言独立 `request(app)` 调用。）

- [ ] **Step 2: 实现路由**

`routes/plans.ts`：

```ts
const GroupLoginPrepareBody = z.object({
  enabled: z.boolean(),
  caseId: z.string().uuid().optional().nullable(),
  detectionUrl: z.string().url().optional().nullable(),
  successSelector: z.string().max(500).optional().nullable(),
  unauthorizedKeywords: z.array(z.string().max(80)).max(20).optional().nullable(),
}).optional();

const TargetConfigBody = z.object({
  deviceTargetId: z.string().uuid().optional(),
  browserContext: z.enum(['incognito', 'persistent']).optional(),
}).nullable().optional();

const CreateGroupBody = z.object({
  name: z.string().min(1).max(200),
  environmentId: z.string().uuid().optional().nullable(),
  loginPrepare: GroupLoginPrepareBody,
  failFast: z.boolean().optional(),
  targetConfig: TargetConfigBody,
});

const PatchGroupBody = z.object({
  name: z.string().min(1).max(200).optional(),
  environmentId: z.string().uuid().nullable().optional(),
  loginPrepare: GroupLoginPrepareBody,
  failFast: z.boolean().optional(),
  targetConfig: TargetConfigBody,
});

// 计划级 CreateBody/PatchBody 删掉 environment/environmentId/loginPrepare 字段：
const CreateBody = z.object({
  name: z.string().min(1).max(200),
  versionId: z.string().uuid().optional(),
  strategy: StrategyEnum.default('run_all'),
  rcaEnabled: z.boolean().optional(),
});
const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  versionId: z.string().uuid().nullable().optional(),
  strategy: StrategyEnum.optional(),
  rcaEnabled: z.boolean().optional(),
});
```

路由（登录准备字段映射：`loginPrepare.successSelector` → service 的 `successSelector`）：

```ts
plansRoute.post('/:id/groups', async (req, res) => {
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  const b = CreateGroupBody.parse(req.body);
  res.json(await createPlanGroup(req.params.id!, {
    name: b.name,
    environmentId: b.environmentId ?? undefined,
    loginPrepare: b.loginPrepare && {
      enabled: b.loginPrepare.enabled,
      caseId: b.loginPrepare.caseId ?? null,
      detectionUrl: b.loginPrepare.detectionUrl ?? null,
      successSelector: b.loginPrepare.successSelector ?? null,
      unauthorizedKeywords: b.loginPrepare.unauthorizedKeywords ?? null,
    },
    failFast: b.failFast,
    targetConfig: b.targetConfig ?? null,
  }));
});

plansRoute.patch('/:id/groups/:groupId', async (req, res) => {
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  const b = PatchGroupBody.parse(req.body);
  res.json(await updatePlanGroup(req.params.id!, req.params.groupId!, {
    name: b.name,
    environmentId: b.environmentId,
    loginPrepare: b.loginPrepare && {
      enabled: b.loginPrepare.enabled,
      caseId: b.loginPrepare.caseId ?? null,
      detectionUrl: b.loginPrepare.detectionUrl ?? null,
      successSelector: b.loginPrepare.successSelector ?? null,
      unauthorizedKeywords: b.loginPrepare.unauthorizedKeywords ?? null,
    },
    failFast: b.failFast,
    targetConfig: b.targetConfig,
  }));
});

plansRoute.delete('/:id/groups/:groupId', async (req, res) => {
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  res.json(await deletePlanGroup(req.params.id!, req.params.groupId!));
});

plansRoute.put('/:id/groups/order', async (req, res) => {
  const { groupIds } = z.object({ groupIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  res.json(await reorderPlanGroups(req.params.id!, groupIds));
});

plansRoute.put('/:id/groups/:groupId/cases', async (req, res) => {
  const { caseIds } = z.object({ caseIds: z.array(z.string().uuid()) }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  await setPlanGroupCases(req.params.id!, req.params.groupId!, caseIds);
  res.json({ ok: true });
});
```

既有用例端点改造：

```ts
// POST /:id/cases 加必选语义：groupId 缺省 = 追加到第一个组/自动建组（service 默认行为）
plansRoute.post('/:id/cases', async (req, res) => {
  const { caseIds, groupId } = z.object({
    caseIds: z.array(z.string().uuid()).min(1),
    groupId: z.string().uuid().optional(),
  }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  res.json({ added: await addPlanCases(req.params.id!, caseIds, groupId) });
});

// PUT /:id/cases/order 改为组内重排
plansRoute.put('/:id/cases/order', async (req, res) => {
  const { groupId, caseIds } = z.object({
    groupId: z.string().uuid(),
    caseIds: z.array(z.string().uuid()).min(1),
  }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  res.json(await reorderPlanGroupCases(req.params.id!, groupId, caseIds));
});

// 新增跨组移动
plansRoute.put('/:id/cases/move', async (req, res) => {
  const { planCaseIds, toGroupId } = z.object({
    planCaseIds: z.array(z.string().uuid()).min(1),
    toGroupId: z.string().uuid(),
  }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  res.json(await movePlanCases(req.params.id!, planCaseIds, toGroupId));
});
```

**删除**：`PUT /:id/cases`（L137-144 全量替换端点）整个路由块。

`plans.service.ts` 的 `CreatePlanInput` 删 `environment/environmentId/loginPrepare`；`UpdatePlanPatch` 删 `environment/environmentId/loginPrepare`；`createPlan/updatePlan` 内对应赋值行删除。

- [ ] **Step 3: 全仓 grep 退役端点消费者**

Run: `rg -n "setCases|/cases'.*PUT|plans.setCases" apps/web/src apps/api/src | grep -v test`
Expected: `apps/web/src/api/client.ts` L153-157（Task 11 改）与 `pi/space/tools/plans.ts`（Task 9 改）之外为 0。**在 Task 9/11 完成前 web 会编译失败——所以本任务先只加新端点+瘦身 service，退役 PUT /:id/cases 路由块的删除与本步 grep 验证挪到 Task 11 之后统一做一次（见 Task 13）。**（实现顺序调整：本 Step 保留旧路由转发实现 `setPlanGroupCases(planId, 第一组, caseIds)` 以维持旧 UI 不死，Task 13 删。）

- [ ] **Step 4: 跑测试 + typecheck**

Run: `pnpm -C apps/api exec vitest run test/plans.test.ts && pnpm -C apps/api exec tsc --noEmit`
Expected: 全 PASS（既有 PUT /cases 用例改为「替换第一组」语义断言）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/plans.ts apps/api/src/services/plans.service.ts apps/api/test/plans.test.ts
git commit -m "feat(plans): 组端点(建/改/删/排序/组内用例/跨组移动)；计划级环境/登录字段退役"
```

---

### Task 6: enqueuePlanRun 组级校验 + groups 快照

**Files:**
- Modify: `apps/api/src/execute/enqueuePlanRun.ts`
- Test: `apps/api/test/plans.test.ts`（追加 enqueue 校验用例）

- [ ] **Step 1: 写失败测试**

```ts
test('组登录准备无来源 → 422 login_case_required 且报组名；组内 incognito 用例 + 组登录 → 422；组登录 + 组内 mobile → 422', async () => {
  // 造组：loginPrepareEnabled=true、无 loginCaseId、environmentId=null → POST /run 422
  // 组环境有凭据（environment_objects web payload user+secret）→ 通过
  // 组内 incognito 用例 → 422 incognito_conflicts_with_login_prepare
  // 组内 mobile 用例（platform='mobile'）→ 422 login_prepare_skips_mobile
});

test('运行快照带 groups；标量 login_prepare_enabled = 任一组开启（旧 UI 兼容）', async () => {
  // POST /run 成功后查 plan_runs：groups jsonb 数组含组配置；login_prepare_enabled = OR(groups)
});
```

- [ ] **Step 2: 实现**

`enqueuePlanRun.ts` 重写校验段：

```ts
async function loadGroups(planId: string) {
  const { asc, eq } = await import('drizzle-orm');
  const { planCaseGroups } = await import('../db/schema.js');
  return db.select().from(planCaseGroups).where(eq(planCaseGroups.planId, planId)).orderBy(asc(planCaseGroups.order));
}

/** 组登录来源校验（原 assertLoginPrepareHasSource 的组级版）：组开登录必须有登录用例或组环境凭据。 */
async function assertGroupsLoginSource(groups: Array<{ id: string; name: string; loginPrepareEnabled: boolean; loginCaseId: string | null; environmentId: string | null }>): Promise<void> {
  for (const g of groups) {
    if (!g.loginPrepareEnabled) continue;
    if (g.loginCaseId) continue;
    if (!g.environmentId) {
      throw new HttpError(422, 'login_case_required', `分组「${g.name}」登录准备已开启:需选择登录用例,或在分组环境中配置登录凭据`);
    }
    const objs = await db.select({ payload: environmentObjects.payload }).from(environmentObjects)
      .where(and(eq(environmentObjects.environmentId, g.environmentId), eq(environmentObjects.objectType, 'web')))
      .orderBy(desc(environmentObjects.isDefault), asc(environmentObjects.createdAt), asc(environmentObjects.id))
      .limit(1);
    const p = (objs[0]?.payload ?? {}) as { user?: unknown; secret?: { c?: unknown; i?: unknown; t?: unknown } };
    const hasCred = typeof p.user === 'string' && p.user.length > 0
      && typeof p.secret?.c === 'string' && typeof p.secret?.i === 'string' && typeof p.secret?.t === 'string';
    if (!hasCred) {
      throw new HttpError(422, 'login_case_required', `分组「${g.name}」登录准备已开启:需选择登录用例,或在分组环境的默认 web 服务对象中配置登录凭据(用户名+密码)`);
    }
  }
}

/** 组级隐身/mobile 冲突：开登录的组内不得有 incognito 用例或非 deprecated mobile 用例。 */
async function assertGroupsCaseConflicts(planId: string, groups: Array<{ id: string; name: string; loginPrepareEnabled: boolean }>): Promise<void> {
  const loginGroupIds = groups.filter((g) => g.loginPrepareEnabled).map((g) => g.id);
  if (loginGroupIds.length === 0) return;
  const rows = await db
    .select({ caseId: planCases.caseId, groupId: planCases.groupId, incognito: testCases.incognito, platform: testCases.platform, status: testCases.status })
    .from(planCases)
    .innerJoin(testCases, eq(testCases.id, planCases.caseId))
    .where(and(eq(planCases.planId, planId), inArray(planCases.groupId, loginGroupIds)));
  const nameOf = new Map(groups.map((g) => [g.id, g.name]));
  const incognito = rows.filter((r) => r.incognito);
  if (incognito.length > 0) {
    throw new HttpError(422, 'incognito_conflicts_with_login_prepare', `分组「${nameOf.get(incognito[0]!.groupId!)}」: cases ${incognito.map((r) => r.caseId).join(',')}`);
  }
  const mobile = rows.filter((r) => r.platform === 'mobile' && r.status !== 'deprecated');
  if (mobile.length > 0) {
    throw new HttpError(422, 'login_prepare_skips_mobile', `分组「${nameOf.get(mobile[0]!.groupId!)}」登录准备仅对 web 用例生效;请关闭该组登录或移出 mobile 用例`);
  }
}
```

`enqueuePlanRun` 主体：

```ts
  const groups = await loadGroups(plan.id);
  await assertGroupsLoginSource(groups);
  await assertGroupsCaseConflicts(plan.id, groups);

  const ins = await db.insert(planRuns).values({
    planId: plan.id,
    projectId: plan.projectId,
    status: 'running',
    strategy: plan.strategy,
    groups: groups.map((g) => ({
      id: g.id, name: g.name, order: g.order, environmentId: g.environmentId,
      loginPrepareEnabled: g.loginPrepareEnabled, loginCaseId: g.loginCaseId,
      detectionUrl: g.detectionUrl, loginSuccessSelector: g.loginSuccessSelector,
      loginUnauthorizedKeywords: g.loginUnauthorizedKeywords, failFast: g.failFast,
      targetConfig: g.targetConfig,
    })),
    // 旧 UI 兼容标量：任一组开启登录即 true；细粒度看 groups
    loginPrepareEnabled: groups.some((g) => g.loginPrepareEnabled),
    loginCaseId: null,
    detectionUrl: null,
    loginSuccessSelector: null,
    loginUnauthorizedKeywords: null,
    rcaEnabled: plan.rcaEnabled,
    /* 其余字段不变 */
```

（`findIncognitoCaseIds`/`findIncognitoConflicts`/`assertLoginPrepareHasSource` 旧函数删除——`findIncognitoCaseIds` 从 runPlan.ts 导出的那份保留给引擎内不再用则一并清理，见 Task 8。）

- [ ] **Step 3: 跑测试**

Run: `pnpm -C apps/api exec vitest run test/plans.test.ts test/plan-run-cancel.test.ts test/rca-trigger.test.ts`
Expected: PASS（rca/既有 run 流程不回归）

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/execute/enqueuePlanRun.ts apps/api/test/plans.test.ts
git commit -m "feat(plans): enqueue 组级登录来源/隐身/mobile 校验 + groups 快照入 plan_runs"
```

---

### Task 7: runCase 消费 targetOverride

**Files:**
- Modify: `apps/api/src/execute/runCase.ts`（L214-222 opts 类型、L238-243、L413-415、L480-483；公开包装 L57-68 附近）

- [ ] **Step 1: opts 类型加 targetOverride（公开入口与 Inner 两处）**

```ts
  opts: {
    storageState?: unknown;
    forceFail?: boolean;
    envOverride?: { envId: string } | null;
    /** 组级统一覆盖：deviceTargetId / 浏览器上下文（plan_case_groups.target_config）。 */
    targetOverride?: { deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null;
    ownedBrowser?: Browser;
    /* ……其余不变 */
  } | undefined,
```

- [ ] **Step 2: 消费点覆盖**

L243 一带：

```ts
  const incognito = opts?.targetOverride?.browserContext
    ? opts.targetOverride.browserContext === 'incognito'
    : !!caseRow.incognito;
  const deviceTargetId = opts?.targetOverride?.deviceTargetId ?? caseRow.mobileDeviceTargetId ?? null;
```

L415 与 L483 两处 `deviceTargetId: caseRow.mobileDeviceTargetId ?? null,` 均改为 `deviceTargetId,`（变量在 L243 区已算好，作用域覆盖两个分支）。`incognito` 两处引用名不变（值已按覆盖解析）。

- [ ] **Step 3: typecheck（无浏览器单测路径——组合行为由 Task 8 集成测/dev E2E 覆盖）**

Run: `pnpm -C apps/api exec tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/execute/runCase.ts
git commit -m "feat(plans): runCase 消费 targetOverride——incognito/deviceTargetId 组级覆盖点"
```

---

### Task 8: runPlan 双层循环（引擎重构）

**Files:**
- Rewrite: `apps/api/src/execute/runPlan.ts`（runPlanAsync 主体 L104-381）
- Test: `apps/api/test/plan-run-groups.test.ts`（新建）

- [ ] **Step 1: 写失败测试（FORCE_FAIL_CASE_IDS 模式，照 plans.test.ts L323-347 的 run 轮询写法）**

`apps/api/test/plan-run-groups.test.ts` 核心用例：

```ts
// helper：造 plan + 2 组 + 每组 2 用例；POST /run；轮询 GET /api/plan-runs/:id 到终态
// FORCE_FAIL_CASE_IDS 由测试进程 env 注入（vitest 文件内在 request 前 process.env.X = … 即可，api 同进程）

test('组内 fail_fast：首例失败只跳过本组剩余，另一组照跑（plan=run_all）', async () => {
  // 组A failFast=true，用例 [F, a2]（F 强制失败）；组B [b1, b2]
  // 终态：a2 skipped（error 含 'group fail_fast'）、b1/b2 passed、run failed
  // plan_run_cases：组A 行 groupName='A' groupOrder=1；组B 行 groupName='B' groupOrder=2
});

test('计划级 fail_fast：前组失败 → 后续组整组 skipped（error 含 plan fail_fast）', async () => {
  // plan fail_fast，组A [F]（不设组 failFast），组B [b1]
  // 终态：b1 skipped + error 含 'plan fail_fast'
});

test('两组登录签名相同 → 只跑一次登录（无第二组登录行）；本用例不启浏览器，只验证签名纯函数', async () => {
  const { loginSignature } = await import('../src/execute/runPlan.js');
  const g = (over: Partial<Parameters<typeof loginSignature>[0]>) => ({ id: 'x', name: 'n', order: 1, environmentId: null, loginPrepareEnabled: true, loginCaseId: null, detectionUrl: null, loginSuccessSelector: null, loginUnauthorizedKeywords: null, failFast: false, targetConfig: null, ...over });
  expect(loginSignature(g({}))).toBe(loginSignature(g({})));
  expect(loginSignature(g({}))).not.toBe(loginSignature(g({ environmentId: 'e1' })));
  expect(loginSignature(g({}))).not.toBe(loginSignature(g({ failFast: true })));
});

test('老运行兼容：plan_runs.groups 为 null 时按标量登录快照合成单组', async () => {
  // 直接 db 插一条 groups=null 的 plan_run（模拟迁移期在途运行），runPlanAsync 跑完不抛错、行照常落库
});
```

- [ ] **Step 2: 重写 runPlanAsync**

新主体（完整结构；`makeReportLinker`/`finalizeRun`/`requestCancel`/`isCancelRequested`/`subscribeRun` 保持不动，`findIncognitoCaseIds` 导出保留供 pi/他处引用则 grep 后决定去留）：

```ts
export interface PlanGroupExec {
  id: string;
  name: string;
  order: number;
  environmentId: string | null;
  loginPrepareEnabled: boolean;
  loginCaseId: string | null;
  detectionUrl: string | null;
  loginSuccessSelector: string | null;
  loginUnauthorizedKeywords: unknown;
  failFast: boolean;
  targetConfig: { deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null;
}

/** 登录复用签名：环境 + 登录配置 + target_config 完全一致才复用 storageState。 */
export function loginSignature(g: PlanGroupExec): string {
  return JSON.stringify([
    g.environmentId, g.loginPrepareEnabled, g.loginCaseId, g.detectionUrl,
    g.loginSuccessSelector, g.loginUnauthorizedKeywords ?? null, g.targetConfig ?? null,
  ]);
}

export async function runPlanAsync(input: RunPlanInput): Promise<void> {
  const { planRunId } = input;
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, planRunId)))[0];
  if (!run) return;
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, run.planId)))[0];
  if (!plan) return;

  const lang = await resolveRunLang(run.triggeredByUserId);
  runState.set(planRunId, { cancelRequested: false });
  const live = registerLiveView(`planrun:${planRunId}`);

  // 组结构：优先 run.groups 快照（enqueue 定格）；老运行 groups=null → 标量快照合成单组。
  let groups: PlanGroupExec[] = (run.groups as PlanGroupExec[] | null) ?? [];
  if (groups.length === 0) {
    groups = [{
      id: 'legacy', name: '默认分组', order: 1,
      environmentId: null, // 老运行计划级环境已在下述 env 解析废弃；如需保留，可读 run 前 executionPlans 快照——此处从简
      loginPrepareEnabled: run.loginPrepareEnabled, loginCaseId: run.loginCaseId,
      detectionUrl: run.detectionUrl, loginSuccessSelector: run.loginSuccessSelector,
      loginUnauthorizedKeywords: run.loginUnauthorizedKeywords, failFast: false, targetConfig: null,
    }];
  }

  // 用例按组聚合（执行时实时读——与现状一致的「启动时定格」语义）
  const pcs = await db
    .select({ groupId: planCases.groupId, caseId: planCases.caseId, order: planCases.order, status: testCases.status, platform: testCases.platform, incognito: testCases.incognito })
    .from(planCases)
    .innerJoin(testCases, eq(testCases.id, planCases.caseId))
    .where(eq(planCases.planId, plan.id))
    .orderBy(asc(planCases.order));
  const groupOfId = new Map(groups.map((g) => [g.id, g]));
  const legacyGroup = groups.find((g) => g.id === 'legacy');
  const casesByGroup = new Map<string, typeof pcs>();
  for (const g of groups) casesByGroup.set(g.id, []);
  for (const pc of pcs) {
    const gid = pc.groupId && groupOfId.has(pc.groupId) ? pc.groupId : legacyGroup?.id ?? groups[0]!.id;
    casesByGroup.get(gid)!.push(pc);
  }

  const allBusiness = groups.flatMap((g) => casesByGroup.get(g.id)!);
  await db.update(planRuns).set({ totalCases: allBusiness.length, startedAt: new Date() }).where(eq(planRuns.id, planRunId));

  let passed = 0, failed = 0, skipped = 0;
  const forceFailIds = new Set((process.env.FORCE_FAIL_CASE_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

  let prevLogin: { signature: string; storageState?: unknown } | undefined;

  for (const group of groups) {
    const gCases = casesByGroup.get(group.id)!;
    const groupMeta = { groupId: group.id === 'legacy' ? null : group.id, groupName: group.name, groupOrder: group.order };
    const remainingAfter = (mark: string) => { /* 组内剩余行批量插入用 */ };

    if (await isCancelRequested(planRunId)) {
      for (const g2 of groups.slice(groups.indexOf(group))) {
        for (const [i, c] of casesByGroup.get(g2.id)!.entries()) {
          await db.insert(planRunCases).values({ planRunId, caseId: c.caseId, order: i + 1, status: 'skipped', stepKind: 'business', error: 'cancelled', ...meta(g2) });
        }
      }
      skipped += groups.slice(groups.indexOf(group)).reduce((n, g2) => n + casesByGroup.get(g2.id)!.length, 0);
      break;
    }
    // 计划级 fail_fast：上一组失败 → 本组起整组跳过（continue 逐组标记）
    // （实现：组循环外维护 abortedByPlanStrategy 布尔，进入组时若为 true → 全组插 skipped('plan fail_fast') + continue）

    // —— 组环境解析（失败回落用例默认链，与原 plan env 语义一致）——
    let groupEnv: { envId: string } | undefined;
    let groupWebOrigin: string | null | undefined;
    let loginCred: import('./envContext.js').LoginCtx | undefined;
    if (group.environmentId) {
      try {
        const { resolveEnv } = await import('./envContext.js');
        const ctx = await resolveEnv({ planEnvId: group.environmentId }, { expectedProjectId: plan.projectId });
        groupWebOrigin = ctx.resolveWebOrigin();
        groupEnv = { envId: ctx.envId };
        loginCred = ctx.login;
        await ctx.close();
      } catch (e) {
        logger.warn({ err: e, planId: plan.id, group: group.name }, 'group env resolve failed; cases will use their own defaultEnv');
        groupEnv = undefined;
      }
    }

    // —— 组登录准备（签名相同且上次成功 → 复用）——
    let loginState: unknown = undefined;
    const sig = loginSignature(group);
    if (group.loginPrepareEnabled && prevLogin?.signature === sig && prevLogin.storageState) {
      loginState = prevLogin.storageState; // 复用：不生成登录行
    } else if (group.loginPrepareEnabled) {
      // ……与原 L161-256 同构的 loginPrepare 调用，差异：
      //   config 字段取 group.*；firstCaseId = 组内第一个非 deprecated 用例；
      //   incognito/mobile 组内冲突在此按「登录准备失败」处理（组失败路径），不再整 run 抛 422；
      //   登录行 insert 带 ...groupMeta（order: 0, stepKind: 'login_prepare'）；
      //   成功 → prevLogin = { signature: sig, storageState: result.storageState }；loginState = storageState；
      //   失败 → 组内业务用例全部插 skipped('login prepare failed') + failed += 0, skipped += n；groupFailed = true；跳到组边界评估
    }

    // —— 组内业务循环（原 L264-362 逻辑，差异标注）——
    let groupFailed = false;
    for (let i = 0; i < gCases.length; i++) {
      const c = gCases[i]!;
      if (c.status === 'deprecated') { /* 插 skipped('case deprecated') 行带 groupMeta；skipped++; continue; */ }
      if (c.platform === 'mobile') continue; // 不注入 web storageState；runCase 路由 MobileEngine
      /* 插 running 行带 groupMeta；runCase 传参差异：
         storageState: loginState,
         ...(groupEnv ? { envOverride: { envId: groupEnv.envId } } : {}),
         targetOverride: group.targetConfig,
         ——失败时：
         if (group.failFast) { 组内剩余插 skipped('skipped: group fail_fast') + break; }
         （不再看 run.strategy——计划级在组边界处理） */
      /* 成功/失败计数同原逻辑；r.status !== 'passed' → groupFailed = true（含 catch 分支） */
    }
    if (loginPrepareFailedThisGroup) groupFailed = true;

    if (groupFailed && run.strategy === 'fail_fast') {
      abortedByPlanStrategy = true; // 后续组整组 skipped('skipped: plan fail_fast')
    }
    // 换组即弃浏览器态：本组 caller-owned 登录 browser/ctx 在组末关闭（沿用原 finally 语义，收窄到组作用域）
  }

  /* 终态/finalize/RCA/runState.delete/live.close 全部沿用原 L364-380 */
}
```

`meta(g)` 小工具：

```ts
const meta = (g: PlanGroupExec) => ({ groupId: g.id === 'legacy' ? null : g.id, groupName: g.name, groupOrder: g.order });
```

（`groups.indexOf(group)` 换成普通下标 for 循环更直白——实现时用 `for (let gi = 0; gi < groups.length; gi++)`。）

登录准备段的完整代码在实现时**从原 L161-256 平移**，逐字段把 `run.*` 换成 `group.*`、`planEnv/planWebOrigin` 换成 `groupEnv/groupWebOrigin`、`cases` 换成 `gCases`、`planRunCases` 插入补 `...meta(group)`、成功回调里 `loginBrowser/loginCtx` 改为组级变量并在组末 `finally` 关闭。

- [ ] **Step 3: 跑引擎集成测试**

Run: `pnpm -C apps/api exec vitest run test/plan-run-groups.test.ts`
Expected: 全 PASS

- [ ] **Step 4: 回归既有引擎路径**

Run: `pnpm -C apps/api exec vitest run test/plan-run-cancel.test.ts test/plan-run-datasets.test.ts test/plan-run-incremental-steps.test.ts test/plan-run-detail-cache.test.ts test/rca-trigger.test.ts test/plans.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/execute/runPlan.ts apps/api/test/plan-run-groups.test.ts
git commit -m "feat(plans): runPlan 双层循环——组级环境/登录/签名复用/两级失败语义/组列落库"
```

---

### Task 9: pi manage_plans 适配

**Files:**
- Modify: `apps/api/src/pi/space/tools/plans.ts`
- Test: `apps/api/test/space-tools-plans.test.ts`

- [ ] **Step 1: 适配点**

1. `create`：`environmentId` 不再进 `createPlan`；`caseIds` 编排从 `replacePlanCases` 改为「`createPlanGroup(plan.id, { name: '默认分组', environmentId })` + `setPlanGroupCases(plan.id, g.id, caseIds)`」。
2. `update`：`environmentId` 分支删除（工具描述与错误提示同步：环境请到 UI 分组配置）。
3. `add_cases`：`svc.addPlanCases(v.planId, v.caseIds)` 语义已变为「追加到第一组/自动建默认组」，调用不变；「已在计划中跳过」的 pendingCount 计算改为**按第一目标组**去重（简化：保留「已在计划任何组即跳过」的旧口径，提示语说明；跨组重复属 UI 高级用法，工具不做）。
4. 工具 description 与 promptGuides 文案同步更新（create 不再带 environmentId；提「分组」概念）。

- [ ] **Step 2: 更新 space-tools-plans.test.ts**

既有 create/update 用例去掉 environmentId 断言；新增：create with caseIds → 计划含 1 组 2 用例。

Run: `pnpm -C apps/api exec vitest run test/space-tools-plans.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/pi/space/tools/plans.ts apps/api/test/space-tools-plans.test.ts
git commit -m "feat(assistant): manage_plans 适配分组——create 建默认组、update 去环境字段"
```

---

### Task 10: 删除计划级旧列（三步闸门收口）

**Files:**
- Modify: `apps/api/src/db/schema.ts`（executionPlans 删 6 列）
- Modify: `apps/api/test/helpers/db.ts`（SCHEMA_SQL 删对应列）
- Modify: `apps/api/drizzle/0047_plan_case_groups.sql`（追加 DROP 段）
- Modify: `apps/api/test/backfill-plan-groups.test.ts`（改为手动 ADD 旧列模拟存量）

- [ ] **Step 1: grep 零读者确认**

Run: `rg -n "plan\.environmentId|plan\.loginPrepareEnabled|plan\.loginCaseId|plan\.detectionUrl|plan\.loginSuccessSelector|plan\.loginUnauthorizedKeywords|executionPlans\.environmentId|executionPlans\.loginPrepare" apps/api/src`
Expected: 仅 schema.ts / enqueuePlanRun 的 groups 快照无关引用为 0（runPlan 已在 Task 8 切到 run.groups；plans.service Task 5 已清）。有残留先清再继续。

- [ ] **Step 2: schema.ts 删列**

`executionPlans` 表体删除：`environment`、`environmentId`、`loginPrepareEnabled`、`loginCaseId`、`detectionUrl`、`loginSuccessSelector`、`loginUnauthorizedKeywords` 七行。

- [ ] **Step 3: SCHEMA_SQL 删列 + 回填测试改写**

SCHEMA_SQL 的 execution_plans 建表行去掉对应列；`backfill-plan-groups.test.ts` 的 `makePlan` 前置：

```ts
await pool.query(`ALTER TABLE execution_plans ADD COLUMN IF NOT EXISTS environment_id uuid`);
await pool.query(`ALTER TABLE execution_plans ADD COLUMN IF NOT EXISTS login_prepare_enabled boolean DEFAULT false`);
await pool.query(`ALTER TABLE execution_plans ADD COLUMN IF NOT EXISTS login_case_id uuid`);
await pool.query(`ALTER TABLE execution_plans ADD COLUMN IF NOT EXISTS detection_url text`);
await pool.query(`ALTER TABLE execution_plans ADD COLUMN IF NOT EXISTS login_success_selector text`);
await pool.query(`ALTER TABLE execution_plans ADD COLUMN IF NOT EXISTS login_unauthorized_keywords jsonb`);
```

并补一个用例：`ALTER TABLE execution_plans DROP COLUMN login_prepare_enabled` 后跑 backfill 不抛错（列缺失 guard 生效）。

- [ ] **Step 4: 0047.sql 追加删列记录**

```sql
-- 计划级旧列删除（回填完成后执行；闸门：SELECT count(*) FROM plan_cases WHERE group_id IS NULL 必须为 0）
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM plan_cases WHERE group_id IS NULL) THEN
    RAISE EXCEPTION 'plan_cases with null group_id remain; run backfillPlanCaseGroups first';
  END IF;
END $$;
ALTER TABLE execution_plans DROP COLUMN IF EXISTS environment;
ALTER TABLE execution_plans DROP COLUMN IF EXISTS environment_id;
ALTER TABLE execution_plans DROP COLUMN IF EXISTS login_prepare_enabled;
ALTER TABLE execution_plans DROP COLUMN IF EXISTS login_case_id;
ALTER TABLE execution_plans DROP COLUMN IF EXISTS detection_url;
ALTER TABLE execution_plans DROP COLUMN IF EXISTS login_success_selector;
ALTER TABLE execution_plans DROP COLUMN IF EXISTS login_unauthorized_keywords;
```

（prod 实际删列由 push 完成——schema.ts 删字段后 push 自动 DROP；闸门语义靠 backfill 先行保证。）

- [ ] **Step 5: 全量 api 测试 + typecheck**

Run: `pnpm -C apps/api exec tsc --noEmit && pnpm -C apps/api exec vitest run`
Expected: 对照基线全绿（基线红名单：sendSyslog 等既有）

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/test/helpers/db.ts apps/api/drizzle/0047_plan_case_groups.sql apps/api/test/backfill-plan-groups.test.ts
git commit -m "feat(plans): 删计划级环境/登录旧列——回填闸门后 push 收口"
```

---

### Task 11: Web——client 类型 + PlanDetail 分组化 + 文案

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Create: `apps/web/src/components/plans/PlanGroupCard.tsx`
- Modify: `apps/web/src/pages/PlanDetail.tsx`
- Modify: `apps/web/src/i18n/locales/zh-CN/plans.json`、`apps/web/src/i18n/locales/en-US/plans.json`

- [ ] **Step 1: client.ts 类型与方法**

```ts
export interface PlanCaseGroup {
  id: string;
  name: string;
  order: number;
  environmentId: string | null;
  loginPrepareEnabled: boolean;
  loginCaseId: string | null;
  detectionUrl: string | null;
  loginSuccessSelector: string | null;
  loginUnauthorizedKeywords: string[] | null;
  failFast: boolean;
  targetConfig: { deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null;
  cases: Array<{ planCaseId: string; id: string; order: number; title: string; url: string | null; versionId: string | null; versionName: string | null; projectId: string | null; projectName: string | null }>;
}
```

`PlanDetail` 接口改为：删 `loginPrepareEnabled/loginCaseId/detectionUrl/loginSuccessSelector/loginUnauthorizedKeywords/environmentId`，加 `groups: PlanCaseGroup[]`；`cases` 行加 `planCaseId`（engine/后端平铺口径）。`PlanRunDetail.cases` 行加 `groupId: string | null; groupName: string | null; groupOrder: number | null`。

`api.plans` 方法（`patch` body 删环境/登录字段）：

```ts
    createGroup: (id: string, body: { name: string; environmentId?: string | null; failFast?: boolean }) =>
      request<PlanCaseGroup>(`/plans/${id}/groups`, { method: 'POST', body: JSON.stringify(body) }),
    patchGroup: (id: string, groupId: string, body: Partial<{ name: string; environmentId: string | null; failFast: boolean; loginPrepare: { enabled: boolean; caseId: string | null; detectionUrl: string | null; successSelector: string | null; unauthorizedKeywords: string[] | null }; targetConfig: { deviceTargetId?: string; browserContext?: 'incognito' | 'persistent' } | null }>) =>
      request<PlanCaseGroup>(`/plans/${id}/groups/${groupId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteGroup: (id: string, groupId: string) =>
      request<{ ok: boolean }>(`/plans/${id}/groups/${groupId}`, { method: 'DELETE' }),
    reorderGroups: (id: string, groupIds: string[]) =>
      request<{ ok: boolean }>(`/plans/${id}/groups/order`, { method: 'PUT', body: JSON.stringify({ groupIds }) }),
    setGroupCases: (id: string, groupId: string, caseIds: string[]) =>
      request<{ ok: boolean }>(`/plans/${id}/groups/${groupId}/cases`, { method: 'PUT', body: JSON.stringify({ caseIds }) }),
    addCases: (id: string, caseIds: string[], groupId?: string) =>
      request<{ added: number }>(`/plans/${id}/cases`, { method: 'POST', body: JSON.stringify({ caseIds, groupId }) }),
    reorderGroupCases: (id: string, groupId: string, caseIds: string[]) =>
      request<{ ok: boolean }>(`/plans/${id}/cases/order`, { method: 'PUT', body: JSON.stringify({ groupId, caseIds }) }),
    moveCases: (id: string, planCaseIds: string[], toGroupId: string) =>
      request<{ ok: boolean }>(`/plans/${id}/cases/move`, { method: 'PUT', body: JSON.stringify({ planCaseIds, toGroupId }) }),
```

删除 `setCases`/`reorderCases`；`removeCases` 不变。

- [ ] **Step 2: PlanGroupCard 组件（新建）**

`apps/web/src/components/plans/PlanGroupCard.tsx`——props：`{ plan, group, groups, environments, loginCases, onInvalidate }`；内部 useMutation：patchGroup/deleteGroup/reorderGroupCases/moveCases，成功后 invalidate `['plan', plan.id]`。结构：

- 组头：`InlineEdit` 组名；组上移/下移（`reorderGroups` 整包）；环境 `select`（onChange 即存，`patchGroup({environmentId})`）；`fail_fast` checkbox；登录准备 checkbox + 登录用例 select + 高级配置 `<details>`（**从 PlanDetail.tsx L368-428 平移**，字段读写改指 group）；浏览器上下文 select（无痕/持久/跟随用例 → `patchGroup({targetConfig:{browserContext}})`）；删除按钮（409 → toast「组内有用例，先移出」）。
- 组内用例 `<ol>`：**从 PlanDetail.tsx L458-515 平移**，`moveBy/onDragStart/onDrop` 改为组内序列 + `reorderGroupCases(group.id, ids)`；行删除走 `removeCases`（按 caseId）；行尾加「移动到组」`DropdownMenu`（其他组列表 → `moveCases([planCaseId], toGroupId)`）。
- 空组：EmptyState + 「删除该组」入口。

（实现时整文件新写，以上锚点即代码来源；登录准备表单与用例行的 JSX 保持原样式类不变。）

- [ ] **Step 3: PlanDetail.tsx 改造**

1. 设置卡（L322-447）：删环境 select 行（L335-357）与登录准备面板（L359-430）；strategy 选择保留并更新说明文案；RCA 区块保留。
2. 用例卡（L451-517）替换为分组渲染：

```tsx
{plan.groups.length === 0 ? (
  <EmptyState icon="flag" title={t('plans:noGroups')} description={t('plans:noGroupsHint')} />
) : (
  plan.groups.map((g) => <PlanGroupCard key={g.id} plan={plan} group={g} groups={plan.groups} environments={environments ?? []} loginCases={loginCases ?? []} />)
)}
```

3. 顶栏加「添加分组」按钮（`createGroup({ name: t('plans:newGroupName') })`）。
4. `run` 按钮 disabled 条件 `plan.cases.length === 0` 不变（平铺 cases 仍供计数）。
5. 加用例弹窗：底部加「目标分组」select（`targetGroupId` state，默认末组）；提交改 `addCases(id, [...selectedAdd], targetGroupId)`；`candidates` 不再排除 in-plan（去掉 `!inPlanIds.has(c.id)` 过滤），已在计划的候选行加「已在计划」小标（仍可勾选——支持跨组重复）。
6. `loginCases` 查询的 enabled 条件从 `plan?.loginPrepareEnabled` 改为 `plan.groups.some(g => g.loginPrepareEnabled)`；查询移入 PlanGroupCard 或保持在页面传参（实现取传参，改动最小）。
7. 删除 `updateLoginPrepare`/`environmentId` state/`envSyncRef` 相关代码（L56、L146-153、L257-267）。

- [ ] **Step 4: 文案（两个 locale 的 plans.json）**

新增 key（zh / en 对照）：

```json
{
  "noGroups": "还没有分组",
  "noGroupsHint": "创建第一个分组，为每组独立配置环境与登录准备",
  "addGroup": "添加分组",
  "newGroupName": "新分组",
  "groupFailFast": "组内失败即停",
  "groupBrowserContext": "浏览器上下文",
  "followCase": "跟随用例",
  "incognito": "无痕",
  "persistent": "持久",
  "moveToGroup": "移动到分组",
  "groupNotEmpty": "分组内还有用例，先移出或删除",
  "targetGroup": "加入分组",
  "alreadyInPlan": "已在计划",
  "groupOrder": "分组 {{index}}",
  "loginCaseDeleted": "登录用例已删除",
  "groupSkippedByPlan": "已跳过（计划策略）",
  "groupSkippedByGroup": "已跳过（组策略）"
}
```

（en-US 同 key 英文翻译；`loginCaseDeleted/groupSkippedByPlan/groupSkippedByGroup` 若 PlanRunDetail 不取 plans 命名空间则一并放。）

- [ ] **Step 5: typecheck + 手动冒烟**

Run: `pnpm -C apps/web exec tsc --noEmit`
Expected: 无错误

启动 dev（带 `ENCRYPTION_KEY`、`CHROMIUM_PATH`），浏览器走一遍：建组 → 配环境/登录 → 加用例（含跨组重复）→ 组内重排 → 跨组移动 → 删空组/非空组 409 toast。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/components/plans/PlanGroupCard.tsx apps/web/src/pages/PlanDetail.tsx apps/web/src/i18n/locales
git commit -m "feat(web): 计划详情分组化——组卡配置/组内编排/跨组移动/加用例选组"
```

---

### Task 12: PlanRunDetail 分组展示

**Files:**
- Modify: `apps/web/src/pages/PlanRunDetail.tsx`（chip 条 L171-227）

- [ ] **Step 1: chip 条按组分节**

`cases`（`PlanRunDetail.cases`）按 `(groupOrder ?? 0, order)` 排序后分节渲染：

```tsx
const sorted = [...cases].sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0) || a.order - b.order);
const sections: Array<{ key: string; name: string; items: typeof sorted }> = [];
for (const c of sorted) {
  const key = c.groupId ?? 'legacy';
  const last = sections[sections.length - 1];
  if (last && last.key === key) last.items.push(c);
  else sections.push({ key, name: c.groupName ?? '', items: [c] });
}
```

chip 容器内每节前置组名分隔标签：`<span className="text-[11px] font-semibold">{name}</span>` + 竖线（复用现有 `<span style={{width:1,...}} />` 分隔样式）；`#/` 前缀照旧（order 为组内序）。老运行（groupId 全 null）单节且不显示组名——与现状视觉一致。

- [ ] **Step 2: typecheck + dev 冒烟**

Run: `pnpm -C apps/web exec tsc --noEmit`
Expected: 无错误；dev 里跑一次双组计划，运行详情看到分节 chip。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/PlanRunDetail.tsx
git commit -m "feat(web): 运行详情用例切换器按分组分节"
```

---

### Task 13: 收口——退役端点删除、旧路由清理、全量回归

**Files:**
- Modify: `apps/api/src/routes/plans.ts`（删 Task 5 临时保留的 `PUT /:id/cases` 转发块）
- Modify: `apps/web/src/api/client.ts`（确认 setCases/reorderCases 已删）

- [ ] **Step 1: 删除退役路由**

删 `plansRoute.put('/:id/cases', ...)`（Task 5 临时转发的实现）。

- [ ] **Step 2: grep 验证零消费者**

Run: `rg -n "plans.setCases|plans.reorderCases|put\('/plans/\\\${id}/cases'" apps/web/src apps/api/src`
Expected: 0 命中

Run: `rg -n "replacePlanCases" apps/api/src`
Expected: 0 命中（Task 4 已删函数、Task 9 已迁移调用）

- [ ] **Step 3: 全量回归**

Run: `pnpm -C apps/api exec tsc --noEmit && pnpm -C apps/api exec vitest run && pnpm -C apps/web exec tsc --noEmit`
Expected: api 全绿（对照基线红名单）；web typecheck 无错误

- [ ] **Step 4: dev E2E 双组实跑（金路径）**

1. dev 起服务（`ENCRYPTION_KEY`+`CHROMIUM_PATH`）；建计划「双组验证」。
2. 组A：环境 JW、登录准备=环境凭据自动登录、用例=登录后的业务用例；组B：环境 BSIM（或另一环境）、登录准备=登录用例模式。
3. 一键执行 → 断言：live view 出两组登录画面；运行详情两组分节；两组各自登录成功、storageState 不串（B 组用例不带着 A 组身份跑）。
4. 失败矩阵抽查：FORCE_FAIL 或临时破坏一例，验证组内/计划级 fail_fast 的跳过标注。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/plans.ts apps/web/src/api/client.ts
git commit -m "feat(plans): 退役 PUT /plans/:id/cases 全量替换端点——分组编排收口"
```

---

## Self-Review 记录

- **Spec 覆盖**：数据模型（T1/T2/T10）、组 CRUD+409（T3）、组内编排+跨组移动+多组重复（T4）、API 七端点+退役（T5/T13）、enqueue 组级校验+快照（T6）、targetOverride 消费（T7）、双层循环+登录复用+两级失败+legacy 兜底（T8）、pi 工具（T9）、前端三页+文案（T11/T12）、迁移三步闸门（T2 回填 → T10 grep+删列）、测试策略各任务内嵌。无缺口。
- **类型一致性**：service `createPlanGroup/updatePlanGroup/deletePlanGroup/reorderPlanGroups/listPlanGroups/setPlanGroupCases/reorderPlanGroupCases/movePlanCases` 与路由/client/pi 引用同名；`PlanGroupExec`/`loginSignature` 引擎导出与测试一致；`PlanCaseGroup`（web）字段与 getPlanDetail 输出对齐。
- **已知取舍**：plan_runs 标量 login 列保留（老运行数据 + 新运行写 OR 兼容）；pi add_cases 维持「计划内去重」口径；runCase targetOverride 无独立单测（浏览器路径，靠 E2E）。
