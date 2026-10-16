# 空间助手执行历史查询 query_stats 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给空间助手新增只读工具 `query_stats`，可查询当前项目全部执行历史（项目域+版本标注），支持失败归因下钻、通过率统计、计划运行查询，供 AI 在对话中做归因问答与测试报告。

**Architecture:** 三层——`executionHistory.service.ts`（drizzle 聚合查询，项目域范围）→ `pi/space/tools/history.ts`（单工具 action 判别联合，zod 校验 + JSON 返回）→ `index.ts` 注册。全部只读、无确认卡、无 UI 改动。spec：`docs/superpowers/specs/2026-10-16-assistant-query-stats-design.md`。

**Tech Stack:** TypeScript ESM、drizzle-orm 0.36（pg）、zod 3、TypeBox（@earendil-works/pi-ai）、vitest 2 + @testcontainers/postgresql。

**硬约束（实现前必读）：**

1. **口径差异**：`case_stats`/`failures` **包含**计划运行成员执行（归因口径 = 用例全历史）。**禁止**照抄 `routes/executions.ts:84-96` 的计划成员排除逻辑（那是列表页展示口径）。
2. **drizzle 计数必须转型**：pg 的 `count(*)` 返回 bigint → JS string。所有计数一律写 `(count(*) filter (where ...))::int`（带括号再转型）。
3. 时间过滤基准：case 类用 `reports.createdAt`，plan 类用 `planRuns.startedAt`。
4. 测试跑在 testcontainers（需 Docker 运行）；单文件命令带 `TESTCONTAINERS_RYUK_DISABLED=true`（与 package.json test script 一致）。
5. 工具不接受 `projectId` 参数——只从 `ctx.projectId` 取，无越权面。

---

### Task 1: service 骨架 + caseStats（聚合/隔离/计划成员含入/版本标注）

**Files:**
- Create: `apps/api/src/services/executionHistory.service.ts`
- Test: `apps/api/test/executionHistory.service.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/executionHistory.service.test.ts`：

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
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function makeCase(groupId: string, versionId: string, title: string): Promise<string> {
  return (await pool.query(
    `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1,$2,$3) RETURNING id`, [groupId, versionId, title],
  )).rows[0]!.id as string;
}

async function makeReport(
  caseId: string,
  status: 'passed' | 'failed',
  opts: { healed?: boolean; createdAt?: Date; durationMs?: number; stepResults?: unknown[] } = {},
): Promise<string> {
  return (await pool.query(
    `INSERT INTO reports(case_id, status, duration_ms, step_results, healed, created_at, duration_done)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6, now())) RETURNING id`,
    // duration_done 列不存在则去掉——见下方说明
    [caseId, status, opts.durationMs ?? 100,
      JSON.stringify(opts.stepResults ?? [{ order: 1, status, durationMs: 10 }]),
      opts.healed ?? false, opts.createdAt ?? null],
  )).rows[0]!.id as string;
}

describe('executionHistory.service caseStats', () => {
  it('项目域聚合:含计划成员执行;失败数排序;版本标注;跨项目隔离;days 过滤', async () => {
    const a = await seedProject(pool); // {projectId, groupId, versionId(v0)}
    const b = await seedProject(pool);
    const v1 = (await pool.query(
      `INSERT INTO project_versions(project_id, name) VALUES ($1,'v1') RETURNING id`, [a.projectId],
    )).rows[0]!.id as string;

    const c1 = await makeCase(a.groupId, a.versionId, '登录-正常');
    const c2 = await makeCase(a.groupId, v1, '下单-失败');
    const cB = await makeCase(b.groupId, b.versionId, '别家的用例');

    // c1: 一次通过 + 一次自愈通过 + 两次失败(其一挂在计划运行成员上) + 一次 40 天前的失败(应被 days 过滤)
    await makeReport(c1, 'passed');
    await makeReport(c1, 'passed', { healed: true });
    const f1 = await makeReport(c1, 'failed', { stepResults: [{ order: 1, status: 'failed', durationMs: 5, error: '元素未找到' }] });
    const f2 = await makeReport(c1, 'failed');
    await makeReport(c1, 'failed', { createdAt: new Date(Date.now() - 40 * 86_400_000) });
    // 把 f2 挂成计划运行成员 → case_stats 仍须计入(与 executions 列表页口径不同)
    const plan = (await pool.query(
      `INSERT INTO execution_plans(project_id, version_id, name) VALUES ($1,$2,'回归') RETURNING id`, [a.projectId, a.versionId],
    )).rows[0]!.id as string;
    const run = (await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1,$2,'failed','run_all') RETURNING id`, [plan, a.projectId],
    )).rows[0]!.id as string;
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, report_id, "order", status, step_kind) VALUES ($1,$2,$3,1,'failed','mechanical')`,
      [run, c1, f2],
    );
    // c2: 一次通过
    await makeReport(c2, 'passed');
    // 项目 B 的报告:不可见
    await makeReport(cB, 'failed');

    const svc = await import('../src/services/executionHistory.service.js');
    const rows = await svc.caseStats(a.projectId);
    expect(rows).toHaveLength(2); // cB 不可见;老报告不产生行
    expect(rows[0]!.caseId).toBe(c1); // failed=2 排最前
    expect(rows[0]).toMatchObject({ caseTitle: '登录-正常', versionName: 'v0', total: 4, passed: 1, healed: 1, failed: 2 });
    expect(rows[0]!.lastStatus).toBe('failed');
    expect(rows[1]).toMatchObject({ caseId: c2, versionName: 'v1', total: 1, failed: 0 });

    // versionId 过滤
    expect((await svc.caseStats(a.projectId, { versionId: v1 })).map((r: { caseId: string }) => r.caseId)).toEqual([c2]);
    // caseIds 过滤
    expect((await svc.caseStats(a.projectId, { caseIds: [c1] })).map((r: { caseId: string }) => r.caseId)).toEqual([c1]);
  }, 30_000);
});
```

**注意 `makeReport` 的 INSERT**：reports 表没有 `duration_done` 列，上面 SQL 里的列表写成（去掉该列）：

```ts
    `INSERT INTO reports(case_id, status, duration_ms, step_results, healed, created_at)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6, now())) RETURNING id`,
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/executionHistory.service.test.ts`
Expected: FAIL，`Cannot find module '../src/services/executionHistory.service.js'`

- [ ] **Step 3: 最小实现**

创建 `apps/api/src/services/executionHistory.service.ts`：

```ts
/** 执行历史查询 service(query_stats 工具的数据层)。
 *  范围语义:项目域——当前项目全部执行历史(含计划成员执行、无版本计划运行),结果标注所属版本。
 *  与 executions 列表页的"展示口径"(排除计划成员)不同:归因口径关注用例本身全历史。
 *  只读,无写路径。 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { executionPlans, groups, planRuns, projectVersions, reports, testCases } from '../db/schema.js';
import { resolveUsersByIds } from '../lib/creator.js';

/** days 天前的时间点(含当天当天,闭区间起点)。 */
function since(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/** 失败计数片段(orderBy 复用;必须括号包住 filter 再 ::int,否则 pg 返回 bigint→string) */
const failedCount = sql`(count(*) filter (where ${reports.status} = 'failed'))`;

export interface HistoryCaseStat {
  caseId: string;
  caseTitle: string;
  versionId: string;
  versionName: string | null;
  total: number;
  passed: number;
  healed: number;
  failed: number;
  avgDurationMs: number | null;
  lastStatus: string | null;
  lastRunAt: string | null;
}

/** 用例级聚合:执行数/通过(含自愈拆分)/失败/均耗时/最新状态,按失败数降序。含计划成员执行。 */
export async function caseStats(
  projectId: string,
  opts: { caseIds?: string[]; versionId?: string; days?: number } = {},
): Promise<HistoryCaseStat[]> {
  const conds = [eq(groups.projectId, projectId), gte(reports.createdAt, since(opts.days ?? 30))];
  if (opts.caseIds?.length) conds.push(inArray(reports.caseId, opts.caseIds));
  if (opts.versionId) conds.push(eq(testCases.versionId, opts.versionId));
  const rows = await db
    .select({
      caseId: testCases.id,
      caseTitle: testCases.title,
      versionId: testCases.versionId,
      total: sql<number>`(count(*))::int`,
      passed: sql<number>`(count(*) filter (where ${reports.status} = 'passed' and ${reports.healed} = false))::int`,
      healed: sql<number>`(count(*) filter (where ${reports.status} = 'passed' and ${reports.healed} = true))::int`,
      failed: sql<number>`${failedCount}::int`,
      avgDurationMs: sql<number | null>`(avg(${reports.durationMs}))::int`,
      lastStatus: sql<string | null>`(array_agg(${reports.status} order by ${reports.createdAt} desc))[1]`,
      lastRunAt: sql<string | null>`(max(${reports.createdAt}))::text`,
    })
    .from(reports)
    .innerJoin(testCases, eq(testCases.id, reports.caseId))
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .where(and(...conds))
    .groupBy(testCases.id, testCases.title, testCases.versionId)
    .orderBy(desc(failedCount));
  return attachVersionNames(rows);
}

/** 批量给行补 versionName(null versionId → null,由上层标注"无版本")。 */
async function attachVersionNames<T extends { versionId: string | null }>(
  rows: T[],
): Promise<Array<T & { versionName: string | null }>> {
  const ids = [...new Set(rows.map((r) => r.versionId).filter((v): v is string => !!v))];
  const map = new Map<string, string>();
  if (ids.length) {
    const vs = await db
      .select({ id: projectVersions.id, name: projectVersions.name })
      .from(projectVersions)
      .where(inArray(projectVersions.id, ids));
    for (const v of vs) map.set(v.id, v.name);
  }
  return rows.map((r) => ({ ...r, versionName: r.versionId ? (map.get(r.versionId) ?? null) : null }));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/executionHistory.service.test.ts`
Expected: PASS（1 test）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/executionHistory.service.ts apps/api/test/executionHistory.service.test.ts
git commit -m "feat(stats): executionHistory service——caseStats 项目域聚合(含计划成员执行,版本标注)"
```

---

### Task 2: historyOverview + failureList

**Files:**
- Modify: `apps/api/src/services/executionHistory.service.ts`（追加）
- Test: `apps/api/test/executionHistory.service.test.ts`（追加 describe）

- [ ] **Step 1: 追加失败测试**

在 `apps/api/test/executionHistory.service.test.ts` 末尾追加（`beforeAll`/helpers 复用已有）：

```ts
describe('executionHistory.service overview + failures', () => {
  it('overview:总数/通过率/top5;failures:失败明细含 lastAssertion 与 planRunId', async () => {
    const a = await seedProject(pool);
    const c1 = await makeCase(a.groupId, a.versionId, '充值-超时');
    const c2 = await makeCase(a.groupId, a.versionId, '查询-正常');
    await makeReport(c2, 'passed');
    await makeReport(c1, 'failed', {
      stepResults: [
        { order: 1, status: 'passed', durationMs: 10 },
        { order: 2, status: 'passed', durationMs: 10 },
        { order: -1, status: 'failed', durationMs: 0, error: 'vision 追加失败步', visionAssert: { passed: false, reason: '页面缺少充值入口' } },
      ],
    });
    const member = await makeReport(c1, 'failed', {
      stepResults: [{ order: 1, status: 'failed', durationMs: 3, error: '按钮不可点击' }],
    });
    const plan = (await pool.query(
      `INSERT INTO execution_plans(project_id, name) VALUES ($1,'无版本计划') RETURNING id`, [a.projectId], // version_id 为 null
    )).rows[0]!.id as string;
    const run = (await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy, total_cases, passed_cases, failed_cases) VALUES ($1,$2,'failed','run_all',2,0,2) RETURNING id`, [plan, a.projectId],
    )).rows[0]!.id as string;
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, report_id, "order", status, step_kind) VALUES ($1,$2,$3,1,'failed','mechanical')`,
      [run, c1, member],
    );

    const svc = await import('../src/services/executionHistory.service.js');
    const ov = await svc.historyOverview(a.projectId);
    expect(ov.caseReports).toMatchObject({ total: 3, passed: 1, healed: 0, failed: 2 });
    expect(ov.caseReports.passRatePct).toBeCloseTo(33.3, 1);
    expect(ov.planRuns).toMatchObject({ total: 1, failed: 1, passed: 0 });
    expect(ov.topFailedCases[0]!.caseId).toBe(c1);
    expect(ov.topFailedCases.length).toBeLessThanOrEqual(5);

    const fs = await svc.failureList(a.projectId);
    expect(fs).toHaveLength(2);
    expect(fs[0]!.caseId).toBe(c1); // 最新失败在前(member 后插)
    const byId = new Map(fs.map((f: { reportId: string }) => [f.reportId, f]));
    const visionRow = fs.find((f: { lastAssertion: string | null }) => f.lastAssertion === '页面缺少充值入口');
    expect(visionRow).toBeTruthy(); // lastAssertion 优先取 visionAssert.reason
    expect(byId.get(member)!.lastAssertion).toBe('按钮不可点击'); // 失败步 error 兜底
    expect(byId.get(member)!.planRunId).toBe(run); // 计划成员可追溯到 plan_run
    // caseId 过滤 + limit
    expect((await svc.failureList(a.projectId, { caseId: c2 }))).toHaveLength(0);
    expect((await svc.failureList(a.projectId, { limit: 1 }))).toHaveLength(1);
  }, 30_000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/executionHistory.service.test.ts`
Expected: FAIL，`svc.historyOverview is not a function`

- [ ] **Step 3: 实现（service 追加）**

在 `executionHistory.service.ts` 末尾追加：

```ts
export interface HistoryOverview {
  days: number;
  caseReports: { total: number; passed: number; healed: number; failed: number; passRatePct: number | null };
  planRuns: { total: number; passed: number; failed: number; cancelled: number; running: number };
  topFailedCases: HistoryCaseStat[];
}

/** 项目执行概览:case 报告口径(通过=一次通过+自愈通过)/计划运行状态分布/失败 top5。 */
export async function historyOverview(
  projectId: string,
  opts: { days?: number; versionId?: string } = {},
): Promise<HistoryOverview> {
  const days = opts.days ?? 30;
  const caseConds = [eq(groups.projectId, projectId), gte(reports.createdAt, since(days))];
  if (opts.versionId) caseConds.push(eq(testCases.versionId, opts.versionId));
  const [agg] = await db
    .select({
      total: sql<number>`(count(*))::int`,
      passed: sql<number>`(count(*) filter (where ${reports.status} = 'passed' and ${reports.healed} = false))::int`,
      healed: sql<number>`(count(*) filter (where ${reports.status} = 'passed' and ${reports.healed} = true))::int`,
      failed: sql<number>`(count(*) filter (where ${reports.status} = 'failed'))::int`,
    })
    .from(reports)
    .innerJoin(testCases, eq(testCases.id, reports.caseId))
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .where(and(...caseConds));
  const planConds = [eq(planRuns.projectId, projectId), gte(planRuns.startedAt, since(days))];
  if (opts.versionId) planConds.push(eq(executionPlans.versionId, opts.versionId));
  const [pagg] = await db
    .select({
      total: sql<number>`(count(*))::int`,
      passed: sql<number>`(count(*) filter (where ${planRuns.status} = 'passed'))::int`,
      failed: sql<number>`(count(*) filter (where ${planRuns.status} = 'failed'))::int`,
      cancelled: sql<number>`(count(*) filter (where ${planRuns.status} = 'cancelled'))::int`,
      running: sql<number>`(count(*) filter (where ${planRuns.status} = 'running'))::int`,
    })
    .from(planRuns)
    .innerJoin(executionPlans, eq(executionPlans.id, planRuns.planId))
    .where(and(...planConds));
  const topFailedCases = (await caseStats(projectId, { days, versionId: opts.versionId })).slice(0, 5);
  return {
    days,
    caseReports: {
      ...agg,
      passRatePct: agg.total > 0 ? Math.round(((agg.passed + agg.healed) / agg.total) * 1000) / 10 : null,
    },
    planRuns: pagg,
    topFailedCases,
  };
}

export interface HistoryFailure {
  reportId: string;
  caseId: string;
  caseTitle: string;
  versionId: string;
  versionName: string | null;
  durationMs: number | null;
  summary: string | null;
  /** 最后断言信息:vision reason 优先,失败步 error 兜底(与 executions 列表页同款 SQL) */
  lastAssertion: string | null;
  /** 计划成员执行回溯到的 plan_run id;单用例执行为 null */
  planRunId: string | null;
  createdAt: string | null;
}

/** 失败报告明细(归因下钻原材料),最新在前。含计划成员执行。 */
export async function failureList(
  projectId: string,
  opts: { caseId?: string; days?: number; limit?: number } = {},
): Promise<HistoryFailure[]> {
  const conds = [
    eq(groups.projectId, projectId),
    eq(reports.status, 'failed'),
    gte(reports.createdAt, since(opts.days ?? 30)),
  ];
  if (opts.caseId) conds.push(eq(reports.caseId, opts.caseId));
  const rows = await db
    .select({
      reportId: reports.id,
      caseId: reports.caseId,
      caseTitle: testCases.title,
      versionId: testCases.versionId,
      durationMs: reports.durationMs,
      summary: reports.summary,
      lastAssertion: sql<string | null>`
        case
          when jsonb_typeof(${reports.stepResults}) = 'array' and jsonb_array_length(${reports.stepResults}) > 0 then
            (select coalesce(
               e -> 'visionAssert' ->> 'reason',
               case when e ->> 'status' = 'failed' then e ->> 'error' end
             )
             from jsonb_array_elements(${reports.stepResults}) with ordinality as t(e, ord)
             order by ord desc
             limit 1)
          else null
        end`,
      planRunId: sql<string | null>`(select pr.plan_run_id::text from plan_run_cases pr where pr.report_id = ${reports.id} limit 1)`,
      createdAt: sql<string | null>`${reports.createdAt}::text`,
    })
    .from(reports)
    .innerJoin(testCases, eq(testCases.id, reports.caseId))
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .where(and(...conds))
    .orderBy(desc(reports.createdAt))
    .limit(opts.limit ?? 20);
  return attachVersionNames(rows);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/executionHistory.service.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/executionHistory.service.ts apps/api/test/executionHistory.service.test.ts
git commit -m "feat(stats): overview 汇总与失败明细查询——双通过率口径/lastAssertion/planRun 回溯"
```

---

### Task 3: reportDetail + planRunList

**Files:**
- Modify: `apps/api/src/services/executionHistory.service.ts`（追加）
- Test: `apps/api/test/executionHistory.service.test.ts`（追加 describe）

- [ ] **Step 1: 追加失败测试**

追加到 `apps/api/test/executionHistory.service.test.ts` 末尾：

```ts
describe('executionHistory.service reportDetail + planRunList', () => {
  it('reportDetail:步骤时间线映射 visionAssertReason/healed/degraded;跨项目/不存在 → null', async () => {
    const a = await seedProject(pool);
    const b = await seedProject(pool);
    const c1 = await makeCase(a.groupId, a.versionId, '导出-报表');
    const rid = await makeReport(c1, 'failed', {
      stepResults: [
        { order: 1, status: 'passed', durationMs: 12, instruction: '打开报表页' },
        { order: 2, status: 'failed', durationMs: 30, instruction: '点击导出按钮', error: 'timeout 30000ms exceeded', humanMessage: '导出按钮未响应', failureReason: 'LocatorMismatch', degraded: true },
        { order: -1, status: 'failed', durationMs: 0, visionAssert: { passed: false, reason: '页面未出现下载提示' } },
      ],
    });
    const ridB = await makeReport((await makeCase(b.groupId, b.versionId, '隔离用')), 'passed');

    const svc = await import('../src/services/executionHistory.service.js');
    const d = await svc.reportDetail(a.projectId, rid);
    expect(d!.caseTitle).toBe('导出-报表');
    expect(d!.versionName).toBe('v0');
    expect(d!.steps).toHaveLength(3);
    expect(d!.steps[0]).toMatchObject({ order: 1, status: 'passed', instruction: '打开报表页' });
    expect(d!.steps[1]).toMatchObject({ status: 'failed', error: 'timeout 30000ms exceeded', humanMessage: '导出按钮未响应', failureReason: 'LocatorMismatch', degraded: true });
    expect(d!.steps[2]!.visionAssertReason).toBe('页面未出现下载提示');
    expect(await svc.reportDetail(a.projectId, ridB)).toBeNull(); // 跨项目不可见
    expect(await svc.reportDetail(a.projectId, '00000000-0000-0000-0000-000000000000')).toBeNull();
  }, 30_000);

  it('planRunList:版本标注(无版本→null);触发人解析;status/planId 过滤', async () => {
    const a = await seedProject(pool);
    const c1 = await makeCase(a.groupId, a.versionId, 'p-用例');
    const planV = (await pool.query(
      `INSERT INTO execution_plans(project_id, version_id, name) VALUES ($1,$2,'带版本计划') RETURNING id`, [a.projectId, a.versionId],
    )).rows[0]!.id as string;
    const planN = (await pool.query(
      `INSERT INTO execution_plans(project_id, name) VALUES ($1,'无版本计划') RETURNING id`, [a.projectId],
    )).rows[0]!.id as string;
    // 触发人 = seed 管理员
    const org = (await pool.query(`SELECT id FROM users ORDER BY created_at DESC LIMIT 1`)).rows[0]!;
    await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy, total_cases, passed_cases, triggered_by_user_id, started_at)
       VALUES ($1,$2,'passed','run_all',1,1,$3, now() - interval '1 hour'), ($4,$2,'failed','run_all',1,0,$3, now())`,
      [planV, a.projectId, org.id, planN],
    );
    // 别的项目的 run:不可见
    const b = await seedProject(pool);
    await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1,$2,'failed','run_all')`,
      [(await pool.query(`INSERT INTO execution_plans(project_id, name) VALUES ($1,'B计划') RETURNING id`, [b.projectId])).rows[0]!.id, b.projectId],
    );

    const svc = await import('../src/services/executionHistory.service.js');
    const rows = await svc.planRunList(a.projectId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.planName).toBe('无版本计划'); // 最新在前
    expect(rows[0]!.versionName).toBeNull();
    expect(rows[1]!.versionName).toBe('v0');
    expect(rows.every((r: { triggeredBy: string | null }) => r.triggeredBy === '测试管理员')).toBe(true);
    expect((await svc.planRunList(a.projectId, { status: 'passed' })).map((r: { planName: string }) => r.planName)).toEqual(['带版本计划']);
    expect((await svc.planRunList(a.projectId, { planId: planN }))).toHaveLength(1);
  }, 30_000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/executionHistory.service.test.ts`
Expected: FAIL，`svc.reportDetail is not a function`

- [ ] **Step 3: 实现（service 追加）**

追加到 `executionHistory.service.ts` 末尾：

```ts
/** stepResults jsonb 里归因需要的字段子集(结构化挑选,不透传 screenshot/db/http 等大对象)。 */
export interface HistoryStep {
  order: number;
  status: string;
  durationMs: number;
  instruction?: string;
  error?: string;
  humanMessage?: string;
  failureReason?: string;
  visionAssertReason?: string;
  healed?: boolean;
  degraded?: boolean;
  cached?: boolean;
}

export interface HistoryReportDetail {
  reportId: string;
  caseId: string;
  caseTitle: string;
  versionId: string;
  versionName: string | null;
  status: string;
  healed: boolean;
  durationMs: number | null;
  summary: string | null;
  datasetRowIndex: number | null;
  platform: string;
  createdAt: string | null;
  steps: HistoryStep[];
}

/** 单报告详情(深度归因)。范围:reportId 必须属于当前项目,否则 null。 */
export async function reportDetail(projectId: string, reportId: string): Promise<HistoryReportDetail | null> {
  const rows = await db
    .select({
      reportId: reports.id,
      caseId: reports.caseId,
      caseTitle: testCases.title,
      versionId: testCases.versionId,
      status: reports.status,
      healed: reports.healed,
      durationMs: reports.durationMs,
      summary: reports.summary,
      datasetRowIndex: reports.datasetRowIndex,
      platform: reports.platform,
      createdAt: sql<string | null>`${reports.createdAt}::text`,
      stepResults: reports.stepResults,
    })
    .from(reports)
    .innerJoin(testCases, eq(testCases.id, reports.caseId))
    .innerJoin(groups, eq(groups.id, testCases.groupId))
    .where(and(eq(reports.id, reportId), eq(groups.projectId, projectId)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const raw = Array.isArray(r.stepResults) ? (r.stepResults as Array<Record<string, unknown>>) : [];
  const steps: HistoryStep[] = raw.map((s) => ({
    order: typeof s.order === 'number' ? s.order : 0,
    status: String(s.status ?? 'unknown'),
    durationMs: typeof s.durationMs === 'number' ? s.durationMs : 0,
    ...(typeof s.instruction === 'string' && s.instruction ? { instruction: s.instruction } : {}),
    ...(typeof s.error === 'string' && s.error ? { error: s.error } : {}),
    ...(typeof s.humanMessage === 'string' && s.humanMessage ? { humanMessage: s.humanMessage } : {}),
    ...(typeof s.failureReason === 'string' && s.failureReason ? { failureReason: s.failureReason } : {}),
    ...(s.visionAssert && typeof s.visionAssert === 'object' && typeof (s.visionAssert as Record<string, unknown>).reason === 'string'
      ? { visionAssertReason: (s.visionAssert as { reason: string }).reason }
      : {}),
    ...(s.healed === true ? { healed: true } : {}),
    ...(s.degraded === true ? { degraded: true } : {}),
    ...(s.cached === true ? { cached: true } : {}),
  }));
  const [named] = await attachVersionNames([{ versionId: r.versionId }]);
  return {
    reportId: r.reportId,
    caseId: r.caseId,
    caseTitle: r.caseTitle,
    versionId: r.versionId,
    versionName: named.versionName,
    status: r.status,
    healed: r.healed,
    durationMs: r.durationMs,
    summary: r.summary,
    datasetRowIndex: r.datasetRowIndex,
    platform: r.platform,
    createdAt: r.createdAt,
    steps,
  };
}

export interface HistoryPlanRun {
  runId: string;
  planId: string;
  planName: string;
  versionId: string | null;
  versionName: string | null;
  status: string;
  totalCases: number;
  passedCases: number | null;
  failedCases: number | null;
  skippedCases: number | null;
  durationMs: number | null;
  startedAt: string | null;
  triggeredBy: string | null;
}

/** 计划运行列表(最新在前)。versionId 来自 execution_plans(可空→versionName null=无版本)。 */
export async function planRunList(
  projectId: string,
  opts: { planId?: string; status?: string; days?: number; limit?: number } = {},
): Promise<HistoryPlanRun[]> {
  const conds = [eq(planRuns.projectId, projectId), gte(planRuns.startedAt, since(opts.days ?? 30))];
  if (opts.planId) conds.push(eq(planRuns.planId, opts.planId));
  if (opts.status) conds.push(eq(planRuns.status, opts.status));
  const rows = await db
    .select({
      runId: planRuns.id,
      planId: planRuns.planId,
      planName: executionPlans.name,
      versionId: executionPlans.versionId,
      status: planRuns.status,
      totalCases: planRuns.totalCases,
      passedCases: planRuns.passedCases,
      failedCases: planRuns.failedCases,
      skippedCases: planRuns.skippedCases,
      durationMs: planRuns.durationMs,
      startedAt: sql<string | null>`${planRuns.startedAt}::text`,
      triggeredById: planRuns.triggeredByUserId,
    })
    .from(planRuns)
    .innerJoin(executionPlans, eq(executionPlans.id, planRuns.planId))
    .where(and(...conds))
    .orderBy(desc(planRuns.startedAt))
    .limit(opts.limit ?? 20);
  const users = await resolveUsersByIds(rows.map((r) => r.triggeredById));
  const withNames = await attachVersionNames(rows);
  return withNames.map((r, i) => ({
    ...r,
    triggeredBy: rows[i]!.triggeredById ? users.get(rows[i]!.triggeredById)?.displayName ?? null : null,
  }));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/executionHistory.service.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/executionHistory.service.ts apps/api/test/executionHistory.service.test.ts
git commit -m "feat(stats): 单报告步骤时间线与计划运行列表——visionAssert/healed/degraded 挑选,触发人解析"
```

---

### Task 4: query_stats 工具 + 注册

**Files:**
- Create: `apps/api/src/pi/space/tools/history.ts`
- Modify: `apps/api/src/pi/space/tools/index.ts`（import + push）
- Test: `apps/api/test/query-stats-tool.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/query-stats-tool.test.ts`：

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
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('query_stats 工具', () => {
  it('buildSpaceTools 注册了 query_stats;各 action 分发返回 JSON 且数字与 service 一致', async () => {
    const seed = await seedProject(pool);
    const caseId = (await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1,$2,'t-登录') RETURNING id`, [seed.groupId, seed.versionId],
    )).rows[0]!.id as string;
    await pool.query(
      `INSERT INTO reports(case_id, status, duration_ms, step_results) VALUES ($1,'failed',88,$3), ($1,'passed',10,$3)`,
      [caseId, JSON.stringify([{ order: 1, status: 'failed', durationMs: 88, error: 'x'.repeat(600) }])],
    );
    const planId = (await pool.query(
      `INSERT INTO execution_plans(project_id, version_id, name) VALUES ($1,$2,'t-计划') RETURNING id`, [seed.projectId, seed.versionId],
    )).rows[0]!.id as string;
    await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES ($1,$2,'failed','run_all')`, [planId, seed.projectId],
    );

    const { buildSpaceTools } = await import('../src/pi/space/tools/index.js');
    const ctx = {
      threadId: 't1', versionId: seed.versionId, projectId: seed.projectId,
      repo: { cwd: null, issue: null, noRepo: false }, emit: () => {}, createdByUserId: null,
    };
    const tools = buildSpaceTools(ctx as never);
    const tool = tools.find((t) => t.name === 'query_stats');
    expect(tool).toBeTruthy();

    const ov = JSON.parse(((await tool!.execute({ action: 'overview' })) as { ok: true; data: string }).data!);
    expect(ov.caseReports.total).toBe(2);
    expect(ov.caseReports.failed).toBe(1);

    const cs = JSON.parse(((await tool!.execute({ action: 'case_stats' })) as { ok: true; data: string }).data!);
    expect(cs[0].caseTitle).toBe('t-登录');
    expect(cs[0].versionName).toBe('v0');

    const pr = JSON.parse(((await tool!.execute({ action: 'plan_runs' })) as { ok: true; data: string }).data!);
    expect(pr).toHaveLength(1);
    expect(pr[0].planName).toBe('t-计划');
  }, 30_000);

  it('failures 空结果给明确文案;report_detail 截断 500 字;参数错误文案可操作', async () => {
    const seed = await seedProject(pool);
    const { buildHistoryTools } = await import('../src/pi/space/tools/history.js');
    const ctx = {
      threadId: 't2', versionId: seed.versionId, projectId: seed.projectId,
      repo: { cwd: null, issue: null, noRepo: false }, emit: () => {}, createdByUserId: null,
    };
    const [tool] = buildHistoryTools(ctx as never);

    // 空历史:failures → 明确文案(不是空数组 JSON)
    const empty = (await tool.execute({ action: 'failures', days: 7 })) as { ok: true; data: string };
    expect(empty.data).toContain('近 7 天无失败记录');

    // 长错误截断:600 → 500 + 省略号
    const caseId = (await pool.query(
      `INSERT INTO test_cases(group_id, version_id, title) VALUES ($1,$2,'t-截断') RETURNING id`, [seed.groupId, seed.versionId],
    )).rows[0]!.id as string;
    const rid = (await pool.query(
      `INSERT INTO reports(case_id, status, duration_ms, step_results) VALUES ($1,'failed',1,$2) RETURNING id`,
      [caseId, JSON.stringify([{ order: 1, status: 'failed', durationMs: 1, error: 'x'.repeat(600) }])],
    )).rows[0]!.id as string;
    const detail = JSON.parse(((await tool.execute({ action: 'report_detail', reportId: rid })) as { ok: true; data: string }).data!);
    expect(detail.steps[0].error.length).toBe(501); // 500 + '…'
    expect(detail.steps[0].error.endsWith('…')).toBe(true);

    // 参数校验:未知 action / 缺 reportId / limit 超界
    const bad1 = await tool.execute({ action: 'nope' });
    expect(bad1.ok).toBe(false);
    const bad2 = await tool.execute({ action: 'report_detail' });
    expect(bad2).toMatchObject({ ok: false, error: expect.stringContaining('reportId') });
    const bad3 = await tool.execute({ action: 'failures', limit: 1000 });
    expect(bad3).toMatchObject({ ok: false, error: expect.stringContaining('参数不合法') });

    // 不存在/跨项目报告
    const nf = await tool.execute({ action: 'report_detail', reportId: '00000000-0000-0000-0000-000000000000' });
    expect(nf).toMatchObject({ ok: false, error: '报告不存在或不属于当前项目' });
  }, 30_000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/query-stats-tool.test.ts`
Expected: FAIL，`Cannot find module '../src/pi/space/tools/history.js'`

- [ ] **Step 3: 实现工具**

创建 `apps/api/src/pi/space/tools/history.ts`：

```ts
/** query_stats:执行历史只读查询(overview/case_stats/failures/report_detail/plan_runs)。
 *  项目域范围(含计划成员执行、无版本计划),结果标注版本;汇总优先、按需下钻控制上下文预算。 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import * as svc from '../../../services/executionHistory.service.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

const Actions = z.object({
  action: z.enum(['overview', 'case_stats', 'failures', 'report_detail', 'plan_runs']),
  days: z.number().int().min(1).max(365).optional(),
  versionId: z.string().uuid().optional(),
  caseIds: z.array(z.string().uuid()).max(50).optional(),
  caseId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  status: z.string().min(1).max(20).optional(),
  reportId: z.string().uuid().optional(),
  planId: z.string().uuid().optional(),
});

/** 长文本截断(上下文预算):error 类字段超 500 字截断加省略号。 */
function clipSteps<T extends { error?: string; humanMessage?: string; visionAssertReason?: string }>(steps: T[]): T[] {
  const clip = (s: string) => (s.length > 500 ? `${s.slice(0, 500)}…` : s);
  return steps.map((st) => ({
    ...st,
    ...(st.error ? { error: clip(st.error) } : {}),
    ...(st.humanMessage ? { humanMessage: clip(st.humanMessage) } : {}),
    ...(st.visionAssertReason ? { visionAssertReason: clip(st.visionAssertReason) } : {}),
  }));
}

export function buildHistoryTools(ctx: SpaceToolsContext): ToolExecutor[] {
  void ctx; // 只读工具,当前仅用 ctx.projectId;留参数保持家族签名一致
  return [
    {
      name: 'query_stats',
      description:
        '执行历史查询(只读,当前项目全部历史,含计划成员执行与无版本计划)。action=overview(执行总览:总数/双通过率/失败top5/计划运行分布)| case_stats(每用例聚合:执行数/通过/自愈/失败/均耗时,按失败数排序——归因入口)| failures(失败报告明细:reportId/用例/最后断言/所属计划运行)| report_detail(reportId,单报告步骤时间线——深度归因)| plan_runs(计划运行列表:状态/通过失败数/版本标注/触发人)。days 默认30。',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('overview'), Type.Literal('case_stats'), Type.Literal('failures'),
          Type.Literal('report_detail'), Type.Literal('plan_runs'),
        ]),
        days: Type.Optional(Type.Number()),
        versionId: Type.Optional(Type.String()),
        caseIds: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
        caseId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
        status: Type.Optional(Type.String()),
        reportId: Type.Optional(Type.String()),
        planId: Type.Optional(Type.String()),
      }),
      promptGuidelines: [
        '归因/统计类问题先 overview 或 case_stats,再按需用 failures / report_detail 下钻;禁止把明细全量贴进回答,汇总优先,用户追问再下钻。',
        '结果可能含其他版本的数据:回答时标注每条的所属版本(versionName 为 null 的计划运行标注"无版本")。',
        '"最近"未指明天数时按 7 天查询并在回答中说明;days 上限 365。',
        '生成测试报告用固定骨架:# <项目> 测试报告(<时间范围>)/ 1 概览(执行数、通过率、环比)/ 2 失败清单(按失败数排序,含版本标注)/ 3 计划运行状况 / 4 发现与建议——第4节结论必须源自查询到的数据,禁止臆测。',
        '通过率口径:passed=一次通过,healed=自愈通过,通过率=(passed+healed)/total;回答时分开说明,别把自愈混成一次通过。',
        'failures 返回的 lastAssertion 优先是用例级视觉判定理由(visionAssert.reason),否则是失败步错误;planRunId 非空说明该次执行发生在计划运行里。',
      ],
      execute: async (input) => {
        let v: z.infer<typeof Actions>;
        try {
          v = Actions.parse(input);
        } catch (e) {
          if (e instanceof z.ZodError) {
            return { ok: false, error: `参数不合法:${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
          }
          throw e;
        }
        const days = v.days ?? 30;
        try {
          switch (v.action) {
            case 'overview': {
              const ov = await svc.historyOverview(ctx.projectId, { days, versionId: v.versionId });
              if (ov.caseReports.total === 0 && ov.planRuns.total === 0) {
                return { ok: true, data: `近 ${days} 天无执行历史(当前项目)` };
              }
              return { ok: true, data: JSON.stringify(ov, null, 2) };
            }
            case 'case_stats': {
              const rows = await svc.caseStats(ctx.projectId, { caseIds: v.caseIds, versionId: v.versionId, days });
              if (rows.length === 0) return { ok: true, data: `近 ${days} 天无用例执行记录` };
              return { ok: true, data: JSON.stringify(rows, null, 2) };
            }
            case 'failures': {
              const rows = await svc.failureList(ctx.projectId, { caseId: v.caseId, days, limit: v.limit });
              if (rows.length === 0) return { ok: true, data: `近 ${days} 天无失败记录` };
              return { ok: true, data: JSON.stringify(rows, null, 2) };
            }
            case 'report_detail': {
              if (!v.reportId) return { ok: false, error: 'report_detail 需要 reportId(可从 failures 结果获取)' };
              const d = await svc.reportDetail(ctx.projectId, v.reportId);
              if (!d) return { ok: false, error: '报告不存在或不属于当前项目' };
              return { ok: true, data: JSON.stringify({ ...d, steps: clipSteps(d.steps) }, null, 2) };
            }
            case 'plan_runs': {
              const rows = await svc.planRunList(ctx.projectId, { planId: v.planId, status: v.status, days, limit: v.limit });
              if (rows.length === 0) return { ok: true, data: `近 ${days} 天无计划运行记录` };
              return { ok: true, data: JSON.stringify(rows, null, 2) };
            }
          }
        } catch (e) {
          return { ok: false, error: `查询失败:${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },
  ];
}
```

- [ ] **Step 4: 注册到 buildSpaceTools**

修改 `apps/api/src/pi/space/tools/index.ts`：

import 区（`buildPlansTools` 之后）加：

```ts
import { buildHistoryTools } from './history.js';
```

`buildSpaceTools` 内 `tools.push(...buildPlansTools(ctx));` 之后加：

```ts
  tools.push(...buildHistoryTools(ctx));
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/query-stats-tool.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pi/space/tools/history.ts apps/api/src/pi/space/tools/index.ts apps/api/test/query-stats-tool.test.ts
git commit -m "feat(pi): query_stats 只读工具接入空间助手——五 action,汇总优先下钻,空态/截断/校验文案"
```

---

### Task 5: 全量回归 + typecheck + lint

**Files:**
- 无新增（验证性任务）

- [ ] **Step 1: 跑 service + 工具两份测试**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/executionHistory.service.test.ts test/query-stats-tool.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 2: 跑 api 全量测试**

Run: `cd apps/api && npm test`
Expected: 全绿。若出现与 query_stats 无关的既有失败，对比 main 记录基线，不修无关问题（记录即可）。

- [ ] **Step 3: typecheck + lint**

Run: `cd apps/api && npm run typecheck && npm run lint`
Expected: 零错误。若 lint 报 import 顺序/未用变量，修自己引入的行。

- [ ] **Step 4: Commit（如有修复）**

```bash
git add -u
git commit -m "test(stats): query_stats 全量回归与静态检查"
```

（无修改则跳过本步，不留空提交。）

---

### Task 6: 场景清单验收（人工，spec §8）

**Files:**
- 无代码改动。产出：验收记录追加到 spec 文件末尾"## 12. 验收记录"小节。

- [ ] **Step 1: 起 dev 环境**

```bash
cd apps/api && ENCRYPTION_KEY=<dev key> CHROMIUM_PATH=<chromium path> npm run dev
```

（dev 必需环境变量见项目备忘：`ENCRYPTION_KEY` + `CHROMIUM_PATH`；api 日志在 `/private/tmp/itest-api.log`。）

- [ ] **Step 2: 三个代表问题过一遍助手对话**

打开版本空间助手页，依次问：

1. "最近哪个用例失败最多？为什么失败？" → 核对用例名/失败步骤/错误与 Reports 页一致（验收标准 1）
2. "近 7 天通过率多少？" → 数字与 Reports 页统计对账（验收标准 2）
3. "出一份本周测试报告" → 输出含 4 节骨架的 Markdown，数字与页面对账（验收标准 3）
4. 若项目有多版本/无版本计划：确认回答带版本标注、"无版本"字样（验收标准 4）

- [ ] **Step 3: 记录验收结果**

在 `docs/superpowers/specs/2026-10-16-assistant-query-stats-design.md` 末尾追加：

```markdown
## 12. 验收记录

- 日期 / 环境：
- 场景 1 失败归因：通过/问题：
- 场景 2 通过率对账：通过/问题：
- 场景 3 报告骨架与数字：通过/问题：
- 场景 4 版本标注：通过/问题/不适用：
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-16-assistant-query-stats-design.md
git commit -m "docs(spec): query_stats 场景清单验收记录"
```

---

## 自审记录（writing-plans Self-Review）

1. **Spec 覆盖**：§3 五个 action → Task 1-4 全部实现并测试；§4 数据访问/项目域 → Task 1 测试"跨项目隔离"；§5 上下文预算（limit/截断/汇总优先）→ Task 4 clipSteps + promptGuidelines + 空态文案测试；§6 报告骨架 → promptGuidelines 第 4 条；§7 错误处理 → Task 4 Step 1 第二个测试；§8 验收 → Task 6；§9 测试策略 → Task 1-5。无缺口。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤给全量代码；测试 SQL 列名已按 SCHEMA_SQL 核对（reports 无 duration_done 列——计划内已标注修正）。
3. **类型一致性**：`HistoryCaseStat/HistoryOverview/HistoryFailure/HistoryStep/HistoryReportDetail/HistoryPlanRun` 在 Task 1-3 定义、Task 4 消费；工具 zod 字段与 TypeBox 字段一一对应；`clipSteps` 签名匹配 `HistoryStep` 子集。
