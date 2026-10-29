# 计划级数据集行选择（含用例级配置模式简化）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 计划中对组内用例按 `plan_cases` 行设置数据子集（同用例跨组各行独立、三态覆盖 null=跟随用例），并把用例详情页的三档（全部/一条/多条）配置简化为统一的「选择数据」多选弹窗。

**Architecture:** `plan_cases` 加可空列 `dataset_row_indexes`（照 `targetOverride` 先例）。校验口径抽公共函数 `assertDatasetRowIndexes` 供用例级/计划级共用。新端点 `PATCH /plans/:planId/plan-cases/:planCaseId` 按 `plan_cases.id` 定位（跨组重复用例无歧义）。执行链路零改动 `runCase`：`runPlan` 查询透传 `c.datasetRowIndexes ?? undefined`，借 `??` 回落语义 null→用例级、`[]`→全部行、非空→子集。数据集删除/用例换绑时联动清空计划行覆盖。

**Tech Stack:** Express + drizzle + PostgreSQL（vitest + testcontainers，prod 靠 `drizzle-kit push --force` 自动应用）；React + tanstack-query + i18next。

**Spec:** `docs/superpowers/specs/2026-10-29-plan-dataset-row-selection-design.md`

---

## 重要前置：工作树有在途改动

本计划建立在「用例级数据集行选择」在途改动之上（0046 迁移、`DatasetRowPickerDialog`、`CaseDetail` 三档 UI 等，见 `git status`）。这些在途文件与本计划要改的文件高度重叠。**每个任务的 commit 必须只含该任务列出的文件**，否则历史混入在途改动无法回溯。

因此 Task 1 的 Step 0 先把在途改动单独提交为基座 commit。此后每个任务的 diff 都是干净的。

约定：

- api 单测：`cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/<file>.ts`（需要 Docker 在跑，testcontainers 起 postgres:16-alpine）
- web 单测：`cd apps/web && npx vitest run src/<path>`
- 类型检查：`cd apps/api && npx tsc --noEmit`；`cd apps/web && npx tsc --noEmit`
- 三态语义（全文通用）：`null` = 跟随用例级配置；`[]` = 全部启用行；非空 = 启用行下标子集（0 基、剔除禁用行后重新编号，显示行号 = 下标 + 1）

---

### Task 1: `plan_cases.dataset_row_indexes` 列（0051 迁移 + schema + 测试 SCHEMA_SQL）

**Files:**
- Create: `apps/api/drizzle/0051_plan_case_dataset_row_indexes.sql`
- Modify: `apps/api/src/db/schema.ts`（planCases 定义，约 :519-530）
- Modify: `apps/api/test/helpers/db.ts`（SCHEMA_SQL 内 `plan_cases` 的 ALTER 区，约 :138-141）

- [ ] **Step 0: 提交在途基座 + 本计划文档**

```bash
cd /Users/lyq/workdir/codedev/iTest
git status --short   # 确认在途改动就是用例级行选择那批文件（apps/ 下 + 0046 迁移 + 2 个新组件/测试文件）
git add docs/superpowers/
git commit -m "docs: 计划级数据集行选择设计与实现计划"
git add apps/
git commit -m "feat(cases): 用例级数据集行选择——0046 列/执行回落/行选择弹窗/详情页配置"
```

若 `git status` 里出现不属于自己的文件，停下来问用户，不要盲目 `git add apps/`。

- [ ] **Step 1: 写 0051 迁移文件**

`apps/api/drizzle/0051_plan_case_dataset_row_indexes.sql`（全新文件）：

```sql
-- 计划级数据集行选择（三态覆盖，与 plan_cases.target_override 同为先例）：
-- null = 跟随用例级配置（执行回落 test_cases.dataset_row_indexes）
-- []   = 全部启用行
-- 非空 = 启用行下标子集（0 基，与用例级同一编号空间）。同用例跨组=多行，各行独立。
ALTER TABLE plan_cases ADD COLUMN dataset_row_indexes integer[];
```

- [ ] **Step 2: schema.ts 加列**

`apps/api/src/db/schema.ts` — 在 `planCases` 的 `targetOverride` 行（:527）之后加：

```ts
  // 计划级数据集行选择（三态覆盖）：null = 跟随用例级配置（执行回落 test_cases.dataset_row_indexes）；
  // [] = 全部启用行；非空 = 启用行下标子集（与用例级同一编号空间）。同用例跨组=多行，各行独立。
  datasetRowIndexes: integer('dataset_row_indexes').array(),
```

（`integer` 已在该文件 import。无默认值——存量行即 null = 跟随用例级，零回迁。）

- [ ] **Step 3: 测试容器 SCHEMA_SQL 同步**

`apps/api/test/helpers/db.ts` — 在 `ALTER TABLE plan_cases ADD COLUMN target_override jsonb;` 那个 DO 块（:138-141）之后追加：

```sql
-- 计划级数据集行选择（三态覆盖，可空；null = 跟随用例级）
DO $$ BEGIN
 ALTER TABLE plan_cases ADD COLUMN dataset_row_indexes integer[];
EXCEPTION WHEN duplicate_column THEN null;
END $$;
```

- [ ] **Step 4: 跑既有 plans 测试确认 schema 兼容**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/plans.test.ts`
Expected: 全部 PASS（列还没被读写，纯加列零行为变化）

- [ ] **Step 5: Commit**

```bash
git add apps/api/drizzle/0051_plan_case_dataset_row_indexes.sql apps/api/src/db/schema.ts apps/api/test/helpers/db.ts
git commit -m "feat(plans): plan_cases 加 dataset_row_indexes 列——计划级行选择三态覆盖第一步（只加不删）"
```

---

### Task 2: 共用校验 `assertDatasetRowIndexes` + cases.service 收口

**Files:**
- Modify: `apps/api/src/services/datasets.service.ts`（`enabledRowCount` 之后，约 :238）
- Modify: `apps/api/src/services/cases.service.ts`（:13 import、:259-268 校验块）

- [ ] **Step 1: datasets.service.ts 新增导出函数**

`apps/api/src/services/datasets.service.ts` — 在 `enabledRowCount` 函数（:235-238）之后加：

```ts
/** 行选择共用校验（用例级 cases.service / 计划级 plans.service 同一口径）：
 *  空数组放行（[]=全部行）；非空要求 ≤500 个非负整数下标、已绑数据集、落在启用行范围内。
 *  null（清覆盖）由调用方自行放行，不进本函数。 */
export async function assertDatasetRowIndexes(datasetId: string | null | undefined, rowIndexes: number[]): Promise<void> {
  if (rowIndexes.length === 0) return;
  if (rowIndexes.length > 500) throw new HttpError(400, 'bad_request', '数据行选择最多 500 行');
  if (rowIndexes.some((i) => !Number.isInteger(i) || i < 0)) {
    throw new HttpError(400, 'bad_request', '数据行下标必须是非负整数');
  }
  if (!datasetId) throw new HttpError(400, 'bad_request', '选择数据集行前须先绑定数据集');
  const enabledCount = await enabledRowCount(datasetId);
  const bad = rowIndexes.filter((i) => i >= enabledCount);
  if (bad.length > 0) {
    throw new HttpError(400, 'bad_request',
      `选中的数据行 ${bad.map((i) => i + 1).join('、')} 超出该数据集的启用行范围（共 ${enabledCount} 行）`);
  }
}
```

- [ ] **Step 2: cases.service 改用共用函数**

`apps/api/src/services/cases.service.ts`：

1. :13 的 `import { enabledRowCount } from './datasets.service.js';` 改为：
```ts
import { assertDatasetRowIndexes } from './datasets.service.js';
```
（先 grep 确认 `enabledRowCount` 在该文件只有这一处使用——是则直接换；若还有别处，改为两者都 import。）

2. `updateCase` 里的越界校验块（:259-268）整体替换为：
```ts
  if (datasetRowIndexes && datasetRowIndexes.length > 0) {
    await assertDatasetRowIndexes(patch.datasetId ?? existing.datasetId, datasetRowIndexes);
  }
```

- [ ] **Step 3: 跑相关测试确认口径不变（报错文案逐字一致）**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/runCase-dataset.test.ts test/datasets.test.ts test/cases-copy.test.ts`
Expected: 全部 PASS（重构不改行为；若有用例断言了越界报错文案，也能对上——共用函数文案与原实现逐字一致）

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/datasets.service.ts apps/api/src/services/cases.service.ts
git commit -m "refactor(cases): 行选择越界校验抽公共 assertDatasetRowIndexes——用例级/计划级同口径"
```

---

### Task 3: `updatePlanCaseDatasetRows` service + 新端点 + 集成测试（TDD）

**Files:**
- Modify: `apps/api/test/plans.test.ts`（beforeAll 挂 datasetsRoute + 新 describe）
- Modify: `apps/api/src/services/plans.service.ts`（`updatePlanCase` 之后）
- Modify: `apps/api/src/routes/plans.ts`（`PATCH /:id/cases/:caseId` 块之后，约 :214）

- [ ] **Step 1: 先写失败测试**

`apps/api/test/plans.test.ts`：

1. beforeAll 里 `app.use('/api/cases', casesRoute);`（:37）之后、`app.use(errorHandler);` 之前插入：

```ts
  // 数据集路由（行选择校验/联动清空测试用）：挂载形状同 plan-run-datasets.test.ts
  const { datasetsRoute } = await import('../src/routes/datasets.js');
  app.use('/api', datasetsRoute);
```

2. 文件末尾追加 describe（`makeCase` 是文件里已有的 helper）：

```ts
describe('计划级数据集行选择（PATCH /plans/:id/plan-cases/:planCaseId）', () => {
  /** 建项目/计划/分组 + 绑数据集用例（2 启用行），把用例加进组并返回各 id 与 planCaseId。 */
  async function seedSelection(): Promise<{
    projectId: string; planId: string; caseId: string; datasetId: string; planCaseId: string;
  }> {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const ds = await request(app).post(`/api/projects/${projectId}/datasets`).send({
      name: '行选择数据',
      columns: [{ name: 'username', sensitive: false }],
      rows: [
        { disabled: false, cells: { username: 'u1' } },
        { disabled: false, cells: { username: 'u2' } },
      ],
    });
    expect(ds.status).toBe(200);
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const g = await request(app).post(`/api/plans/${plan.body.id}/groups`).send({ name: 'G' });
    const c = await makeCase(groupId, versionId, '绑数据集用例');
    await pool.query(`UPDATE test_cases SET dataset_id = $2 WHERE id = $1`, [c, ds.body.id]);
    await request(app).post(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c], groupId: g.body.id });
    const detail = await request(app).get(`/api/plans/${plan.body.id}`);
    const planCaseId = detail.body.groups[0].cases[0].planCaseId as string;
    return { projectId, planId: plan.body.id, caseId: c, datasetId: ds.body.id, planCaseId };
  }

  it('落库：PATCH 子集 → plan_cases.dataset_row_indexes 持久化', async () => {
    const s = await seedSelection();
    const r = await request(app)
      .patch(`/api/plans/${s.planId}/plan-cases/${s.planCaseId}`)
      .send({ datasetRowIndexes: [1] });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const pc = await pool.query(`SELECT dataset_row_indexes FROM plan_cases WHERE id = $1`, [s.planCaseId]);
    expect(pc.rows[0].dataset_row_indexes).toEqual([1]);
  });

  it('null 清覆盖（置 NULL）；[] 存全部行（空数组）', async () => {
    const s = await seedSelection();
    await request(app).patch(`/api/plans/${s.planId}/plan-cases/${s.planCaseId}`).send({ datasetRowIndexes: [0] });
    await request(app).patch(`/api/plans/${s.planId}/plan-cases/${s.planCaseId}`).send({ datasetRowIndexes: null });
    let pc = await pool.query(`SELECT dataset_row_indexes FROM plan_cases WHERE id = $1`, [s.planCaseId]);
    expect(pc.rows[0].dataset_row_indexes).toBeNull();

    await request(app).patch(`/api/plans/${s.planId}/plan-cases/${s.planCaseId}`).send({ datasetRowIndexes: [] });
    pc = await pool.query(`SELECT dataset_row_indexes FROM plan_cases WHERE id = $1`, [s.planCaseId]);
    expect(pc.rows[0].dataset_row_indexes).toEqual([]);
  });

  it('校验：越界 400（文案含越界行号与启用行总数）；未绑数据集 400', async () => {
    const s = await seedSelection();
    const bad = await request(app)
      .patch(`/api/plans/${s.planId}/plan-cases/${s.planCaseId}`)
      .send({ datasetRowIndexes: [5] });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('共 2 行');

    // 未绑数据集的用例 → 400
    const { groupId, versionId } = await seedProject(pool);
    const plan = await request(app)
      .post(`/api/projects/${(await seedProject(pool)).projectId}/plans`)
      .send({ name: 'P2', versionId });
    const g = await request(app).post(`/api/plans/${plan.body.id}/groups`).send({ name: 'G' });
    const c = await makeCase(groupId, versionId, '裸用例');
    // 上面 plan 属于另一个 seedProject 的项目，直接在本项目内重建，保持归属一致：
    const { projectId, versionId: v2 } = await seedProject(pool);
    const plan2 = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P3', versionId: v2 });
    const g2 = await request(app).post(`/api/plans/${plan2.body.id}/groups`).send({ name: 'G' });
    const c2 = await makeCase(groupId, versionId, '裸用例2');
    await request(app).post(`/api/plans/${plan2.body.id}/cases`).send({ caseIds: [c2], groupId: g2.body.id });
    const detail = await request(app).get(`/api/plans/${plan2.body.id}`);
    const pcId = detail.body.groups[0].cases[0].planCaseId;
    const r = await request(app)
      .patch(`/api/plans/${plan2.body.id}/plan-cases/${pcId}`)
      .send({ datasetRowIndexes: [0] });
    expect(r.status).toBe(400);
  });

  it('跨组重复用例：两行各写各的（写路径独立性）', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const ds = await request(app).post(`/api/projects/${projectId}/datasets`).send({
      name: '跨组数据',
      columns: [{ name: 'username', sensitive: false }],
      rows: [
        { disabled: false, cells: { username: 'u1' } },
        { disabled: false, cells: { username: 'u2' } },
        { disabled: false, cells: { username: 'u3' } },
      ],
    });
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P', versionId });
    const g1 = await request(app).post(`/api/plans/${plan.body.id}/groups`).send({ name: 'G1' });
    const g2 = await request(app).post(`/api/plans/${plan.body.id}/groups`).send({ name: 'G2' });
    const c = await makeCase(groupId, versionId, '重复用例');
    await pool.query(`UPDATE test_cases SET dataset_id = $2 WHERE id = $1`, [c, ds.body.id]);
    await request(app).post(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c], groupId: g1.body.id });
    await request(app).post(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c], groupId: g2.body.id });
    const detail = await request(app).get(`/api/plans/${plan.body.id}`);
    const pc1 = detail.body.groups[0].cases[0].planCaseId as string;
    const pc2 = detail.body.groups[1].cases[0].planCaseId as string;
    await request(app).patch(`/api/plans/${plan.body.id}/plan-cases/${pc1}`).send({ datasetRowIndexes: [0] });
    await request(app).patch(`/api/plans/${plan.body.id}/plan-cases/${pc2}`).send({ datasetRowIndexes: [1, 2] });
    const rows = await pool.query(`SELECT id, dataset_row_indexes FROM plan_cases WHERE plan_id = $1`, [plan.body.id]);
    expect(rows.rows).toHaveLength(2);
    const byRow = new Map<string, number[] | null>(rows.rows.map((r: { id: string; dataset_row_indexes: number[] | null }) => [r.id, r.dataset_row_indexes]));
    expect(byRow.get(pc1)).toEqual([0]);
    expect(byRow.get(pc2)).toEqual([1, 2]);
  });
});
```

（注：'校验' 用例里第一次 `seedProject` 出来的 groupId/versionId 会被后面第二段覆盖——按上面写法只用到第二次 seed 的 projectId/v2 与第一次的 groupId/versionId 造裸用例，两段用例归属各自独立即可，执行时以代码实际编译通过为准；若嫌绕，可把「未绑数据集」拆成独立 it，内里单跑一次 seedProject。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/plans.test.ts`
Expected: 新 describe 全部 FAIL（404 路由不存在 / service 函数不存在导致 import 报错）

- [ ] **Step 3: service 实现**

`apps/api/src/services/plans.service.ts`：

1. import 区加：
```ts
import { assertDatasetRowIndexes } from './datasets.service.js';
```

2. `updatePlanCase`（:47-55）之后加：

```ts
/** 计划级数据集行选择写入：按 plan_cases.id 定位（同用例跨组=多行，各改各的）。
 *  null = 清覆盖（执行回落用例级）；[] = 全部启用行；非空 = 启用行下标子集。
 *  非空时校验口径与用例级共用 assertDatasetRowIndexes（已绑数据集 + 下标在启用行范围内）。 */
export async function updatePlanCaseDatasetRows(
  planId: string,
  planCaseId: string,
  datasetRowIndexes: number[] | null,
): Promise<{ ok: boolean; datasetRowIndexes: number[] | null }> {
  const existing = (await db.select().from(planCases)
    .where(and(eq(planCases.planId, planId), eq(planCases.id, planCaseId))).limit(1))[0];
  if (!existing) throw new HttpError(404, 'not_found', 'plan case not found');
  if (datasetRowIndexes !== null) {
    const c = (await db.select({ datasetId: testCases.datasetId }).from(testCases)
      .where(eq(testCases.id, existing.caseId)).limit(1))[0];
    if (!c) throw new HttpError(404, 'not_found', 'case not found');
    await assertDatasetRowIndexes(c.datasetId, datasetRowIndexes);
  }
  const rows = await db.update(planCases)
    .set({ datasetRowIndexes })
    .where(eq(planCases.id, existing.id))
    .returning({ datasetRowIndexes: planCases.datasetRowIndexes });
  return { ok: true, datasetRowIndexes: rows[0]?.datasetRowIndexes ?? null };
}
```

（`plan_cases` 无 updated_at 列——照 `updatePlanCase` 不动时间戳的先例。）

- [ ] **Step 4: 路由实现**

`apps/api/src/routes/plans.ts`：

1. :17 import 列表里 `updatePlanCase,` 后加 `updatePlanCaseDatasetRows,`。

2. `plansRoute.patch('/:id/cases/:caseId', ...)` 块（:204-214）之后加：

```ts
// 计划级数据集行选择：按 plan_cases.id 定位（同用例跨组=多行，各改各的）。
// null = 清覆盖（执行回落用例级）；[] = 全部启用行；非空 = 启用行下标子集。
// 不复用 PATCH /:id/cases/:caseId——那个按 caseId+limit(1) 定位，跨组重复用例有歧义。
plansRoute.patch('/:id/plan-cases/:planCaseId', async (req, res) => {
  const { datasetRowIndexes } = z.object({
    datasetRowIndexes: z.array(z.number().int().min(0)).max(500).nullable(),
  }).parse(req.body);
  const pid = await planProjectId(req.params.id!);
  if (!pid) throw new HttpError(404, 'not_found', 'plan not found');
  await assertProjectVisible(pid, req.user!);
  res.json(await updatePlanCaseDatasetRows(req.params.id!, req.params.planCaseId!, datasetRowIndexes));
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/plans.test.ts`
Expected: 全部 PASS（含既有用例）

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/plans.service.ts apps/api/src/routes/plans.ts apps/api/test/plans.test.ts
git commit -m "feat(plans): 计划级行选择端点 PATCH /plans/:id/plan-cases/:planCaseId——按 plan_cases.id 定位，跨组各行独立"
```

---

### Task 4: `getPlanDetail` 回带三态字段 + client.ts 类型/API

**Files:**
- Modify: `apps/api/src/services/plans.service.ts`（`getPlanDetail` :121-188）
- Modify: `apps/api/test/plans.test.ts`（追加 detail 断言用例）
- Modify: `apps/web/src/api/client.ts`（PlanCaseGroup.cases 类型 :947 + plans API :133-171）

- [ ] **Step 1: 先写失败测试**

`apps/api/test/plans.test.ts` — 上面 describe 里追加：

```ts
  it('detail 回带数据集字段与三态 planRowIndexes', async () => {
    const s = await seedSelection();
    await request(app).patch(`/api/plans/${s.planId}/plan-cases/${s.planCaseId}`).send({ datasetRowIndexes: [0] });
    const detail = await request(app).get(`/api/plans/${s.planId}`);
    const row = detail.body.groups[0].cases[0];
    expect(row.datasetId).toBe(s.datasetId);
    expect(row.datasetName).toBe('行选择数据');
    expect(row.datasetEnabledRowCount).toBe(2);
    expect(row.caseRowIndexes).toEqual([]); // 用例级选择：[] = 全部
    expect(row.planRowIndexes).toEqual([0]); // 计划级覆盖
  });
```

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/plans.test.ts`
Expected: 新用例 FAIL（detail 还没有这些字段 → undefined）

- [ ] **Step 2: getPlanDetail 实现**

`apps/api/src/services/plans.service.ts`：

1. schema import（:8）加 `datasets`：
```ts
import { datasets, executionPlans, groups, planCaseGroups, planCases, projects, projectVersions, testCases, testEnvironments } from '../db/schema.js';
```

2. `getPlanDetail` 的 join 查询（:127-143）替换为：

```ts
  const rows = pcs.length
    ? await db
        .select({
          id: testCases.id,
          title: testCases.title,
          url: testCases.url,
          versionId: testCases.versionId,
          versionName: projectVersions.name,
          projectId: groups.projectId,
          projectName: projects.name,
          // 计划级数据行选择三态展示所需：绑定的数据集 + 用例级选择；启用行数 SQL 内联统计
          datasetId: testCases.datasetId,
          caseRowIndexes: testCases.datasetRowIndexes,
          datasetName: datasets.name,
          datasetEnabledRowCount: sql<number>`(SELECT count(*)::int FROM jsonb_array_elements(coalesce(${datasets.rows}, '[]'::jsonb)) AS r WHERE (r->>'disabled') IS NOT TRUE)`,
        })
        .from(testCases)
        .innerJoin(groups, eq(groups.id, testCases.groupId))
        .innerJoin(projects, eq(projects.id, groups.projectId))
        .leftJoin(projectVersions, eq(projectVersions.id, testCases.versionId))
        .leftJoin(datasets, eq(datasets.id, testCases.datasetId))
        .where(inArray(testCases.id, pcs.map((p) => p.caseId)))
    : [];
```

（`sql` 已在该文件 import。innerJoin→leftJoin 的变化只多不少：datasets 可空所以用 leftJoin，groups/projects/versions 仍是 inner——原有语义不变。）

3. `caseMeta`（:145-156）追加四个字段：

```ts
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
      // 计划级数据行选择三态展示所需（未绑数据集时 datasetId 为 null）
      datasetId: c?.datasetId ?? null,
      datasetName: c?.datasetName ?? null,
      datasetEnabledRowCount: c?.datasetEnabledRowCount ?? 0,
      caseRowIndexes: c?.caseRowIndexes ?? [],
    };
  };
```

4. 组内 cases 映射（:174-178）加 `planRowIndexes`：

```ts
    cases: pcs.filter((pc) => pc.groupId === g.id).map((pc, i) => ({
      planCaseId: pc.id,
      order: i + 1,
      ...caseMeta(pc.caseId),
      // 计划行覆盖三态：null = 跟随用例级；[] = 全部行；非空 = 子集
      planRowIndexes: pc.datasetRowIndexes ?? null,
    })),
```

（`pcs` 是 `db.select().from(planCases)` 全列查询，Task 1 加列后自动带上 `datasetRowIndexes`。平铺 `cases` 从 `planGroups.flatMap` 派生，自动获得同字段。）

- [ ] **Step 3: 跑测试确认通过**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/plans.test.ts`
Expected: 全部 PASS

- [ ] **Step 4: client.ts 类型与 API**

`apps/web/src/api/client.ts`：

1. `PlanCaseGroup.cases` 类型（:947）整体替换为：

```ts
  cases: Array<{
    planCaseId: string; id: string; order: number; title: string; url: string | null;
    versionId: string | null; versionName: string | null; projectId: string | null; projectName: string | null;
    /** 绑定的数据集（未绑为 null）与名称/启用行数/用例级行选择（[] = 全部）。 */
    datasetId: string | null;
    datasetName: string | null;
    datasetEnabledRowCount: number;
    caseRowIndexes: number[];
    /** 计划行覆盖三态：null = 跟随用例级；[] = 全部行；非空 = 子集。 */
    planRowIndexes: number[] | null;
  }>;
```

2. `plans` API 对象里（`moveCases` 之后）加：

```ts
    /** 计划级数据行选择（按 plan_cases.id 定位，跨组重复用例各行独立）：
     *  null = 跟随用例级；[] = 全部启用行；非空 = 子集。 */
    patchPlanCase: (id: string, planCaseId: string, body: { datasetRowIndexes: number[] | null }) =>
      request<{ ok: boolean; datasetRowIndexes: number[] | null }>(`/plans/${id}/plan-cases/${planCaseId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
```

- [ ] **Step 5: web 类型检查**

Run: `cd apps/web && npx tsc --noEmit`
Expected: 0 错误（纯类型扩展，无调用方破坏）

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/plans.service.ts apps/api/test/plans.test.ts apps/web/src/api/client.ts
git commit -m "feat(plans): getPlanDetail 回带数据集三态字段（datasetId/caseRowIndexes/planRowIndexes 等）+ client 类型"
```

---

### Task 5: `runPlan` 透传 + 执行链路测试（TDD）

**Files:**
- Modify: `apps/api/test/plan-run-datasets.test.ts`（追加 describe）
- Modify: `apps/api/src/execute/runPlan.ts`（pcs 查询 :162-174 + 业务 runCase 调用 :430-441）

- [ ] **Step 1: 先写失败测试**

`apps/api/test/plan-run-datasets.test.ts` 文件末尾追加：

```ts
describe('runPlan 计划级行选择覆盖', () => {
  it('计划级子集覆盖用例级：用例级全部、计划 [1] → 只跑启用行 2', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '计划覆盖A' });
    const boundCaseId = await insertCase('计划覆盖A用例', created.body.id);
    await pool.query(`UPDATE test_cases SET dataset_row_indexes = ARRAY[0,1] WHERE id = $1`, [boundCaseId]);
    const plainCaseId = await insertCase('普通5', null);
    const planRunId = await makePlan(boundCaseId, plainCaseId);
    const { rows: pr } = await pool.query(`SELECT plan_id FROM plan_runs WHERE id = $1`, [planRunId]);
    await pool.query(
      `UPDATE plan_cases SET dataset_row_indexes = ARRAY[1]::integer[] WHERE plan_id = $1 AND case_id = $2`,
      [pr[0].plan_id, boundCaseId],
    );

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await runPlanAsync({ planRunId });

    const reps = await pool.query(`SELECT dataset_row_index FROM reports WHERE case_id = $1`, [boundCaseId]);
    expect(reps.rows).toHaveLength(1);
    expect(reps.rows[0].dataset_row_index).toBe(1);
  });

  it('计划级 null → 回落用例级选择（[1] 只跑行 2）', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '计划回落' });
    const boundCaseId = await insertCase('计划回落用例', created.body.id);
    await pool.query(`UPDATE test_cases SET dataset_row_indexes = ARRAY[1] WHERE id = $1`, [boundCaseId]);
    const plainCaseId = await insertCase('普通6', null);
    const planRunId = await makePlan(boundCaseId, plainCaseId);
    // plan_cases.dataset_row_indexes 保持 NULL（默认）

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await runPlanAsync({ planRunId });

    const reps = await pool.query(`SELECT dataset_row_index FROM reports WHERE case_id = $1`, [boundCaseId]);
    expect(reps.rows).toHaveLength(1);
    expect(reps.rows[0].dataset_row_index).toBe(1);
  });

  it('计划级 [] 覆盖为全部行：用例级 [0] 子集 → 跑 2 行', async () => {
    const created = await request(app).post(`/api/projects/${projectId}/datasets`).send({ ...dsBody, name: '计划全行' });
    const boundCaseId = await insertCase('计划全行用例', created.body.id);
    await pool.query(`UPDATE test_cases SET dataset_row_indexes = ARRAY[0] WHERE id = $1`, [boundCaseId]);
    const plainCaseId = await insertCase('普通7', null);
    const planRunId = await makePlan(boundCaseId, plainCaseId);
    const { rows: pr } = await pool.query(`SELECT plan_id FROM plan_runs WHERE id = $1`, [planRunId]);
    await pool.query(
      `UPDATE plan_cases SET dataset_row_indexes = ARRAY[]::integer[] WHERE plan_id = $1 AND case_id = $2`,
      [pr[0].plan_id, boundCaseId],
    );

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    const { runPlanAsync } = await import('../src/execute/runPlan.js');
    await runPlanAsync({ planRunId });

    const reps = await pool.query(
      `SELECT dataset_row_index FROM reports WHERE case_id = $1 ORDER BY dataset_row_index`,
      [boundCaseId],
    );
    expect(reps.rows.map((r: { dataset_row_index: number }) => r.dataset_row_index)).toEqual([0, 1]);
  });
});
```

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/plan-run-datasets.test.ts`
Expected: 第一条 FAIL（计划级 [1] 被无视 → 2 行报告）；第二条 PASS（回落本就是现状）；第三条 FAIL（`[]` 被无视 → 1 行报告）

- [ ] **Step 2: runPlan 实现（两处）**

`apps/api/src/execute/runPlan.ts`：

1. pcs 查询（:162-174）select 里 `incognito: testCases.incognito,` 之后加：

```ts
      // 计划级行覆盖三态：null = 跟随用例级；[] = 全部行；非空 = 子集（实时读 plan_cases，不进快照）
      datasetRowIndexes: planCases.datasetRowIndexes,
```

2. 业务用例 `runCase` 调用（:430-441）`targetOverride: group.targetConfig ?? null,` 之后加：

```ts
                // 计划级行覆盖：null→undefined→回落用例级；[] 照传→全部行（覆盖用例级子集）；非空→子集
                datasetRowIndexes: c.datasetRowIndexes ?? undefined,
```

登录准备用例的 `runCase`（:316 附近）**不传**——登录链路保持用例级配置（spec 非目标）。

`runCase` 本体零改动：`opts?.datasetRowIndexes ?? caseRow.datasetRowIndexes ?? []`（runCase.ts:107）的 `??` 只对 null/undefined 回落，`[]` 是合法覆盖值。

- [ ] **Step 3: 跑测试确认通过**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/plan-run-datasets.test.ts`
Expected: 全部 PASS（含既有 3 条）

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/execute/runPlan.ts apps/api/test/plan-run-datasets.test.ts
git commit -m "feat(plans): runPlan 透传 plan_cases.dataset_row_indexes——null 回落用例级/[] 全部行/非空子集"
```

---

### Task 6: 联动清空（数据集删除 + 用例换绑/解绑）

**Files:**
- Modify: `apps/api/src/services/datasets.service.ts`（`deleteDataset` :225-232）
- Modify: `apps/api/src/services/cases.service.ts`（`updateCase` :251-258 之后）
- Modify: `apps/api/test/plans.test.ts`（追加联动 describe）

- [ ] **Step 1: 先写失败测试**

`apps/api/test/plans.test.ts` 追加（依赖 Task 3 已挂载的 datasetsRoute 和 seedSelection）：

```ts
describe('计划行覆盖联动清空', () => {
  it('数据集删除 → 关联用例的 plan_cases.dataset_row_indexes 置 null', async () => {
    const s = await seedSelection();
    await request(app).patch(`/api/plans/${s.planId}/plan-cases/${s.planCaseId}`).send({ datasetRowIndexes: [0] });
    const del = await request(app).delete(`/api/projects/${s.projectId}/datasets/${s.datasetId}?confirm=true`);
    expect(del.status).toBe(200);
    const pc = await pool.query(`SELECT dataset_row_indexes FROM plan_cases WHERE id = $1`, [s.planCaseId]);
    expect(pc.rows[0].dataset_row_indexes).toBeNull();
    // 用例级选择同时被清空（既有行为，一并守住）
    const c = await pool.query(`SELECT dataset_row_indexes, dataset_id FROM test_cases WHERE id = $1`, [s.caseId]);
    expect(c.rows[0].dataset_row_indexes).toEqual([]);
    expect(c.rows[0].dataset_id).toBeNull();
  });

  it('用例解绑数据集 → 该用例所有计划行覆盖置 null', async () => {
    const s = await seedSelection();
    await request(app).patch(`/api/plans/${s.planId}/plan-cases/${s.planCaseId}`).send({ datasetRowIndexes: [1] });
    const r = await request(app).patch(`/api/cases/${s.caseId}`).send({ datasetId: null });
    expect(r.status).toBe(200);
    const pc = await pool.query(`SELECT dataset_row_indexes FROM plan_cases WHERE id = $1`, [s.planCaseId]);
    expect(pc.rows[0].dataset_row_indexes).toBeNull();
  });
});
```

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/plans.test.ts`
Expected: 两条 FAIL（plan 覆盖仍是旧值；第一条的用例级断言应已 PASS——那是既有行为）

- [ ] **Step 2: deleteDataset 追加清计划覆盖**

`apps/api/src/services/datasets.service.ts`：

1. import：`import { asc, eq } from 'drizzle-orm';` → `import { asc, eq, inArray } from 'drizzle-orm';`；schema import 加 `planCases`：
```ts
import { datasets, planCases, testCases } from '../db/schema.js';
```

2. `deleteDataset`（:225-232）在 `await db.update(testCases)...` 之后、`db.delete(datasets)` 之前插入：

```ts
  // 计划级行覆盖一并清空（置 null = 跟随用例级）：下标空间属于被删数据集，留下即垃圾值。
  await db.update(planCases).set({ datasetRowIndexes: null }).where(
    inArray(planCases.caseId, db.select({ id: testCases.id }).from(testCases).where(eq(testCases.datasetId, datasetId))),
  );
```

- [ ] **Step 3: updateCase 换绑/解绑时清计划覆盖**

`apps/api/src/services/cases.service.ts`：

1. schema import（:8）加 `planCases`：
```ts
import { caseTags, datasets, groups, planCases, productLines, projects, projectVersions, scenarios, tags, testCases, testSteps } from '../db/schema.js';
```

2. `updateCase` 里 datasetRowIndexes 归一化块（:251-258 的 `} else if (datasetRowIndexes === null) { datasetRowIndexes = []; }`）之后插入：

```ts
  // 换数据集/解绑：该用例在所有计划里的行级覆盖一并清空（下标空间属于旧数据集）。
  // 计划级置 null（跟随用例级），与用例级清空同触发；用例删除无需处理（plan_cases.caseId 外键 CASCADE）。
  if (patch.datasetId !== undefined && patch.datasetId !== existing.datasetId) {
    await db.update(planCases).set({ datasetRowIndexes: null }).where(eq(planCases.caseId, caseId));
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run test/plans.test.ts test/datasets.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/datasets.service.ts apps/api/src/services/cases.service.ts apps/api/test/plans.test.ts
git commit -m "feat(plans): 数据集删除/用例换绑时联动清空计划行覆盖（置 null 跟随用例级）"
```

---

### Task 7: DatasetRowPickerDialog 统一多选 + 跟随用例按钮

**Files:**
- Modify: `apps/web/src/components/DatasetRowPickerDialog.tsx`（整体重写）
- Modify: `apps/web/src/components/DatasetRowPickerDialog.test.tsx`（整体重写）

- [ ] **Step 1: 先写失败测试（整体替换测试文件）**

`apps/web/src/components/DatasetRowPickerDialog.test.tsx` 全文替换为：

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// api.datasets.get 替换：其余走真实实现（i18n / stores 都从这里 import）。
const datasetGet = vi.fn();
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      datasets: {
        ...actual.api.datasets,
        get: (projectId: string, id: string) => datasetGet(projectId, id),
      },
    },
  };
});

import DatasetRowPickerDialog from './DatasetRowPickerDialog';
import '../i18n';

/** 3 行数据：第 2 行被禁用 → 启用行下标空间是 0、1（分别对应原始第 1、3 行）。 */
const detail = {
  id: 'ds-1',
  projectId: 'p1',
  name: '账号',
  description: null,
  columns: [
    { name: 'username', sensitive: false },
    { name: 'password', sensitive: true },
  ],
  rows: [
    { disabled: false, cells: { username: 'alice', password: { __masked: true } } },
    { disabled: true, cells: { username: 'skip', password: { __masked: true } } },
    { disabled: false, cells: { username: 'bob', password: { __masked: true } } },
  ],
  createdAt: '',
  updatedAt: '',
};

function renderPicker(props: Partial<React.ComponentProps<typeof DatasetRowPickerDialog>> = {}) {
  const onConfirm = vi.fn();
  const onFollowCase = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <DatasetRowPickerDialog
        open
        onOpenChange={() => {}}
        projectId="p1"
        datasetId="ds-1"
        value={[]}
        onConfirm={onConfirm}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onConfirm, onFollowCase };
}

/** 行表格 tbody 里的勾选框（表头全选框在 thead，不参与）。 */
function rowCheckboxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('tbody input[type=checkbox]')) as HTMLInputElement[];
}

const confirmBtn = () => screen.getByRole('button', { name: '确认' }) as HTMLButtonElement;

describe('DatasetRowPickerDialog', () => {
  beforeEach(() => {
    datasetGet.mockReset();
    datasetGet.mockResolvedValue(detail);
  });

  it('只渲染启用行，编号 = 启用行下标 + 1（禁用行不占号）', async () => {
    renderPicker();
    await waitFor(() => expect(datasetGet).toHaveBeenCalled());
    await waitFor(() => expect(rowCheckboxes()).toHaveLength(2));
    expect(screen.queryByText('skip')).toBeNull();
    const numbers = screen.getAllByRole('row').slice(1).map((tr) => tr.children[1]?.textContent);
    expect(numbers).toEqual(['1', '2']);
  });

  it('敏感格显示掩码，不回显明文', async () => {
    renderPicker();
    await waitFor(() => expect(rowCheckboxes()).toHaveLength(2));
    expect(screen.getAllByText('••••••')).toHaveLength(2);
  });

  it('value=[]（全部行）→ 打开即全选；确认回传 []', async () => {
    const { onConfirm } = renderPicker({ value: [] });
    await waitFor(() => expect(rowCheckboxes().every((c) => c.checked)).toBe(true));
    await act(async () => {
      confirmBtn().click();
    });
    expect(onConfirm).toHaveBeenCalledWith([]);
  });

  it('value=子集 → 只勾子集；确认回传子集', async () => {
    const { onConfirm } = renderPicker({ value: [1] });
    await waitFor(() => expect(rowCheckboxes()).toHaveLength(2));
    expect(rowCheckboxes()[0]!.checked).toBe(false);
    expect(rowCheckboxes()[1]!.checked).toBe(true);
    await act(async () => {
      confirmBtn().click();
    });
    expect(onConfirm).toHaveBeenCalledWith([1]);
  });

  it('全选状态取消一行 → 确认回传剩余下标', async () => {
    const { onConfirm } = renderPicker({ value: [] });
    await waitFor(() => expect(rowCheckboxes().every((c) => c.checked)).toBe(true));
    await act(async () => {
      rowCheckboxes()[0]!.click();
    });
    await act(async () => {
      confirmBtn().click();
    });
    expect(onConfirm).toHaveBeenCalledWith([1]);
  });

  it('手动取消全部勾选 → 确认禁用；表头全选可恢复（回到全部的唯一入口）', async () => {
    renderPicker({ value: [] });
    await waitFor(() => expect(rowCheckboxes().every((c) => c.checked)).toBe(true));
    await act(async () => {
      rowCheckboxes()[0]!.click();
    });
    await act(async () => {
      rowCheckboxes()[1]!.click();
    });
    expect(confirmBtn().disabled).toBe(true);
    await act(async () => {
      (screen.getByTitle('全选') as HTMLInputElement).click();
    });
    expect(confirmBtn().disabled).toBe(false);
  });

  it('传 onFollowCase → 显示「跟随用例」按钮，点击回调并关弹窗', async () => {
    const onOpenChange = vi.fn();
    const { onFollowCase } = renderPicker({ onFollowCase, onOpenChange });
    await waitFor(() => expect(rowCheckboxes()).toHaveLength(2));
    await act(async () => {
      (screen.getByRole('button', { name: '跟随用例' }) as HTMLButtonElement).click();
    });
    expect(onFollowCase).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('未传 onFollowCase → 不渲染「跟随用例」按钮', async () => {
    renderPicker();
    await waitFor(() => expect(rowCheckboxes()).toHaveLength(2));
    expect(screen.queryByRole('button', { name: '跟随用例' })).toBeNull();
  });

  it('关闭时不拉数据集（零额外请求）', async () => {
    renderPicker({ open: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(datasetGet).not.toHaveBeenCalled();
  });
});
```

（原 `mode='one'` 用例删除——mode 概念退役。）

Run: `cd apps/web && npx vitest run src/components/DatasetRowPickerDialog.test.tsx`
Expected: FAIL（组件还有 mode 必填 prop、没有 onFollowCase；value=[] 不会全选）

- [ ] **Step 2: 组件整体重写**

`apps/web/src/components/DatasetRowPickerDialog.tsx` 全文替换为：

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/Modal';
import { Button } from './ui/shadcn/button';

const isMasked = (v: unknown): v is { __masked: true } =>
  typeof v === 'object' && v !== null && (v as { __masked?: boolean }).__masked === true;

interface DatasetRowPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | undefined;
  datasetId: string | null;
  /** 当前已选（启用行下标，0 基）。[] = 全部启用行（打开即全选）。 */
  value: number[];
  /** 确认回传：勾满全部启用行 → []；部分勾选 → 升序下标；未勾任何行时确认禁用。 */
  onConfirm: (indexes: number[]) => void;
  /** 计划级专用：传了才显示「跟随用例」按钮——清计划级覆盖（置 null），执行回落用例级配置。 */
  onFollowCase?: () => void;
}

/**
 * 数据集行选择弹窗（统一多选，不分单行/多行模式）：只渲染「启用行」，
 * 编号用启用行下标 + 1（与执行器同一编号空间）。只在打开时拉数据集（页面加载零额外请求）；
 * 敏感格显示 ••••••。
 */
export default function DatasetRowPickerDialog({
  open,
  onOpenChange,
  projectId,
  datasetId,
  value,
  onConfirm,
  onFollowCase,
}: DatasetRowPickerDialogProps) {
  const { t } = useTranslation();
  /** 用户交互后的选择；null = 尚未交互，按 value 派生（[] = 全选）。每次打开重置。 */
  const [pickedOverride, setPickedOverride] = useState<number[] | null>(null);

  useEffect(() => {
    if (open) setPickedOverride(null);
  }, [open]);

  const { data, isLoading } = useQuery({
    queryKey: ['dataset', datasetId],
    queryFn: () => api.datasets.get(projectId!, datasetId!),
    enabled: open && !!datasetId && !!projectId,
  });

  // 启用行（剔除 disabled），编号 = 启用行下标 + 1
  const enabledRows = (data?.rows ?? [])
    .map((r, i) => ({ r, enabledIndex: i }))
    .filter(({ r }) => !r.disabled);
  const enabledIndexes = enabledRows.map((_, i) => i);

  // 未交互时按 value 派生：[] = 全部启用行；非空 = 子集
  const picked = pickedOverride ?? (value.length === 0 ? enabledIndexes : value);

  const toggle = (idx: number) => {
    setPickedOverride(picked.includes(idx) ? picked.filter((x) => x !== idx) : [...picked, idx]);
  };

  const toggleAll = () => {
    setPickedOverride(picked.length === enabledIndexes.length ? [] : [...enabledIndexes]);
  };

  const confirm = () => {
    // 勾满全部启用行 → 存 []（语义=全部行）；部分勾选 → 升序下标
    const all = picked.length === enabledIndexes.length;
    onConfirm(all ? [] : [...picked].sort((a, b) => a - b));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('cases:datasetRowScope')}</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:datasetRowLoading')}</p>
        ) : enabledRows.length === 0 ? (
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:datasetRowEmpty')}</p>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto">
            {/* table-fixed：勾选/序号列固定，数据列均分剩余宽度——auto 布局下长描述列会被挤成 1 字宽竖条 */}
            <table className="w-full table-fixed">
              <thead>
                <tr>
                  <th className="px-2 py-1.5 w-[36px]">
                    <input
                      type="checkbox"
                      checked={picked.length === enabledIndexes.length && enabledIndexes.length > 0}
                      onChange={toggleAll}
                      title={t('cases:datasetRowSelectAll')}
                      style={{ accentColor: 'var(--primary)' }}
                    />
                  </th>
                  <th className="px-2 py-1.5 w-[36px] text-left text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                    #
                  </th>
                  {data?.columns.map((c) => (
                    <th key={c.name} className="px-2 py-1.5 text-left text-[11px] break-words" style={{ color: 'var(--muted-foreground)' }}>
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {enabledRows.map(({ r }, displayIdx) => {
                  // 执行器用的下标空间：剔除禁用行后重新编号
                  const enabledIndex = displayIdx;
                  return (
                    <tr key={displayIdx} className="hairline-bottom">
                      <td className="px-2 py-1.5 text-center align-top">
                        <input
                          type="checkbox"
                          checked={picked.includes(enabledIndex)}
                          onChange={() => toggle(enabledIndex)}
                          title={t('cases:datasetRowSelect', { index: enabledIndex + 1 })}
                          style={{ accentColor: 'var(--primary)' }}
                        />
                      </td>
                      <td className="px-2 py-1.5 font-mono text-[11px] align-top" style={{ color: 'var(--muted-foreground)' }}>
                        {enabledIndex + 1}
                      </td>
                      {data?.columns.map((c) => {
                        const cell = r.cells[c.name];
                        const masked = isMasked(cell);
                        return (
                          <td key={c.name} className="px-2 py-1.5 font-mono text-[11px] break-words align-top">
                            {masked ? (
                              <span style={{ color: 'var(--muted-foreground)' }} title={t('cases:datasetRowMasked')}>
                                ••••••
                              </span>
                            ) : (
                              (cell ?? '')
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <DialogFooter>
          {onFollowCase && (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                onFollowCase();
                onOpenChange(false);
              }}
            >
              {t('plans:followCase')}
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common:cancel')}</Button>
          <Button onClick={confirm} disabled={picked.length === 0}>{t('common:confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

关键设计：`pickedOverride` 单向门——未交互时按 `value` 派生（`[]` 打开即全选），一旦用户点击任何勾选框就固定为用户的选择，「手动取消全勾」不会再被 value 派生拉回全选。按钮 variant 只有 `primary|ghost|danger|destructive`（`ghost` 即描边次操作）。

- [ ] **Step 3: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/components/DatasetRowPickerDialog.test.tsx`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/DatasetRowPickerDialog.tsx apps/web/src/components/DatasetRowPickerDialog.test.tsx
git commit -m "refactor(web): 行选择弹窗统一多选（退役 one/many 模式）+ 可选跟随用例按钮 + 勾满存 []"
```

---

### Task 8: CaseDetail 去三档 Segmented + cases.json i18n + 测试适配

**Files:**
- Modify: `apps/web/src/pages/CaseDetail.tsx`（:362-366 删派生、:893-928 换控件、:1788 删 mode 行）
- Modify: `apps/web/src/i18n/locales/zh-CN/cases.json`（:94-105 区）
- Modify: `apps/web/src/i18n/locales/en-US/cases.json`（:98-102 区）
- Modify: `apps/web/src/pages/CaseDetail.test.tsx`（适配）

- [ ] **Step 1: 先改测试（失败先行）**

`apps/web/src/pages/CaseDetail.test.tsx`：

1. 删 `scopeButtons()` helper（:104-107）。

2. 第 1 个用例（:125-139）里 `expect(scopeButtons()).toHaveLength(3);` 替换为：

```tsx
    expect(screen.getByRole('button', { name: '选择数据' })).toBeTruthy();
```

Run: `cd apps/web && npx vitest run src/pages/CaseDetail.test.tsx`
Expected: 第 1 条 FAIL（「选择数据」按钮还不存在）；其余 PASS

- [ ] **Step 2: i18n**

`apps/web/src/i18n/locales/zh-CN/cases.json`：删除 `"datasetRowScopeOne"`、`"datasetRowScopeMany"` 两行（:96-97），在 `"datasetRowScopeAllHint"` 之后加：

```json
  "datasetRowChoose": "选择数据",
```

`apps/web/src/i18n/locales/en-US/cases.json`：同样删除 `"datasetRowScopeOne"`（"One row"）、`"datasetRowScopeMany"`（"Multiple rows"），在 `"datasetRowScopeAllHint"` 之后加：

```json
  "datasetRowChoose": "Choose data",
```

（`datasetRowScope`、`datasetRowScopeAllHint`、`datasetRowSelected` 等其余 key 保留复用。）

- [ ] **Step 3: CaseDetail.tsx 改造**

1. 删 `datasetRowScope` 派生与 `datasetPickerMode` state（:362-366）：

```ts
  /** 行范围档位：由已选行数派生（[] = 所有行；1 行 = 一条；≥2 行 = 多条）。 */
  const datasetRowScope: 'all' | 'one' | 'many' =
    datasetRowIndexes.length === 0 ? 'all' : datasetRowIndexes.length === 1 ? 'one' : 'many';
  /** 行选择弹窗模式（one=单选，many=多选）：由用户点的档位决定，与派生值无关。 */
  const [datasetPickerMode, setDatasetPickerMode] = useState<'one' | 'many'>('many');
```

这 5 行整体删除（`datasetRowPickerOpen` state 在别处定义，保留）。

2. Segmented 区块（:893-928，从 `{/* 数据集行范围：执行时只跑选中的行。... */}` 到对应 `)}`）整体替换为：

```tsx
                  {/* 数据集行范围：统一「选择数据」入口 → 多选弹窗 → 显示条数（不分三档）。 */}
                  {datasetId && (
                    <div className="flex flex-col gap-1">
                      <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                        {t('cases:datasetRowScope')}
                      </span>
                      <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setDatasetRowPickerOpen(true)}>
                          {t('cases:datasetRowChoose')}
                        </Button>
                        <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                          {datasetRowIndexes.length === 0
                            ? t('cases:datasetRowScopeAllHint', { count: datasetEnabledRowCount })
                            : t('cases:datasetRowSelected', { indexes: datasetRowIndexes.map((i) => i + 1).join('、') })}
                        </span>
                      </div>
                    </div>
                  )}
```

3. 弹窗用法（:1783-1790）：删 `mode={datasetPickerMode}` 一行，其余不动：

```tsx
      <DatasetRowPickerDialog
        open={datasetRowPickerOpen}
        onOpenChange={setDatasetRowPickerOpen}
        projectId={projectId}
        datasetId={datasetId}
        value={datasetRowIndexes}
        ...
```

（`Segmented` import 保留——窗口策略区 :796/:816 还在用。保存仍随整单 PATCH 带 `datasetRowIndexes`，保存链路零改动。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/CaseDetail.test.tsx src/components/DatasetRowPickerDialog.test.tsx`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/CaseDetail.tsx apps/web/src/pages/CaseDetail.test.tsx apps/web/src/i18n/locales/zh-CN/cases.json apps/web/src/i18n/locales/en-US/cases.json
git commit -m "refactor(web): 用例详情行选择去三档 Segmented——统一「选择数据」入口+条数显示"
```

---

### Task 9: PlanGroupCard 计划级行选择入口 + plans.json i18n

**Files:**
- Modify: `apps/web/src/components/plans/PlanGroupCard.tsx`
- Modify: `apps/web/src/i18n/locales/zh-CN/plans.json`
- Modify: `apps/web/src/i18n/locales/en-US/plans.json`

（弹窗交互按 spec 以浏览器实测验收，无新增单测。）

- [ ] **Step 1: i18n**

`apps/web/src/i18n/locales/zh-CN/plans.json` — `"followCase": "跟随用例"`（:168）之后加（跟随按钮复用 `followCase`，不新增）：

```json
  "datasetEntry": "选择数据",
  "datasetFollowCaseRows": "跟随用例 · {{count}} 行",
  "datasetFollowCaseRows_other": "跟随用例 · {{count}} 行",
  "datasetAllRows": "全部 {{count}} 行",
  "datasetAllRows_other": "全部 {{count}} 行",
  "datasetSelectedRows": "已选 {{count}} 行",
  "datasetSelectedRows_other": "已选 {{count}} 行",
```

`apps/web/src/i18n/locales/en-US/plans.json` — `"followCase"` 之后加（英文按 `caseCountLabel/_one/_other` 三连惯例）：

```json
  "datasetEntry": "Choose data",
  "datasetFollowCaseRows": "Follow case · {{count}} rows",
  "datasetFollowCaseRows_one": "Follow case · {{count}} row",
  "datasetFollowCaseRows_other": "Follow case · {{count}} rows",
  "datasetAllRows": "All {{count}} rows",
  "datasetAllRows_one": "All {{count}} row",
  "datasetAllRows_other": "All {{count}} rows",
  "datasetSelectedRows": "{{count}} rows selected",
  "datasetSelectedRows_one": "{{count}} row selected",
  "datasetSelectedRows_other": "{{count}} rows selected",
```

- [ ] **Step 2: PlanGroupCard 改造**

`apps/web/src/components/plans/PlanGroupCard.tsx`：

1. import 区加：

```tsx
import DatasetRowPickerDialog from '../DatasetRowPickerDialog';
```

2. `confirmRemoveCase` state（:47）之后加：

```tsx
  /** 行内「选择数据」弹窗目标行（null = 关闭）。存整行：projectId/datasetId/生效下标都从它取。 */
  const [datasetPickerCase, setDatasetPickerCase] = useState<PlanCaseGroup['cases'][number] | null>(null);
```

3. `moveCases` mutation 之后加 mutation 与三态文案 helper：

```tsx
  const patchPlanCase = useMutation({
    mutationFn: ({ planCaseId, datasetRowIndexes }: { planCaseId: string; datasetRowIndexes: number[] | null }) =>
      api.plans.patchPlanCase(plan.id, planCaseId, { datasetRowIndexes }),
    onSuccess: invalidate,
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  /** 行内数据选择状态文字三态：跟随用例 · N 行（N=用例级生效条数）/ 全部 N 行 / 已选 M 行。 */
  const datasetStatusLabel = (c: PlanCaseGroup['cases'][number]): string => {
    if (c.planRowIndexes !== null) {
      return c.planRowIndexes.length === 0
        ? t('plans:datasetAllRows', { count: c.datasetEnabledRowCount })
        : t('plans:datasetSelectedRows', { count: c.planRowIndexes.length });
    }
    const n = c.caseRowIndexes.length === 0 ? c.datasetEnabledRowCount : c.caseRowIndexes.length;
    return t('plans:datasetFollowCaseRows', { count: n });
  };
```

4. 组内用例行（:318-385）里，`fromOtherVersion` 徽标块（:350-358）之后、`otherGroups` DropdownMenu（:359）之前插入：

```tsx
                  {/* 计划级数据行选择入口：仅绑了数据集才显示；点开多选弹窗，行内文字三态。 */}
                  {c.datasetId && (
                    <button
                      type="button"
                      className="press shrink-0 text-[10px] font-medium px-1.5 py-[1px] rounded"
                      style={{ background: 'var(--muted)', color: 'var(--muted-foreground)', border: '1px solid var(--border)', cursor: 'pointer' }}
                      onClick={() => setDatasetPickerCase(c)}
                      title={t('plans:datasetEntry')}
                    >
                      {datasetStatusLabel(c)}
                    </button>
                  )}
```

5. 组件 JSX 末尾（移除确认 Dialog 之后、最外层 `</div>` 之前）加：

```tsx
      {/* 计划级数据行选择弹窗：value=生效下标（计划覆盖值；未覆盖用用例级生效值）。
          跨产品线共享用例拉数据集用用例自己的项目（projectId ?? plan.projectId）。 */}
      {datasetPickerCase && (
        <DatasetRowPickerDialog
          open
          onOpenChange={(o) => !o && setDatasetPickerCase(null)}
          projectId={datasetPickerCase.projectId ?? plan.projectId}
          datasetId={datasetPickerCase.datasetId}
          value={datasetPickerCase.planRowIndexes ?? datasetPickerCase.caseRowIndexes}
          onConfirm={(indexes) =>
            patchPlanCase.mutate({ planCaseId: datasetPickerCase.planCaseId, datasetRowIndexes: indexes })
          }
          onFollowCase={
            datasetPickerCase.planRowIndexes !== null
              ? () => patchPlanCase.mutate({ planCaseId: datasetPickerCase.planCaseId, datasetRowIndexes: null })
              : undefined
          }
        />
      )}
```

- [ ] **Step 3: 类型检查**

Run: `cd apps/web && npx tsc --noEmit`
Expected: 0 错误

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/plans/PlanGroupCard.tsx apps/web/src/i18n/locales/zh-CN/plans.json apps/web/src/i18n/locales/en-US/plans.json
git commit -m "feat(plans): 组内用例行数据选择入口——三态状态文字+多选弹窗+跟随用例清覆盖"
```

---

### Task 10: 全量验证 + 浏览器验收

**Files:** 无新改动（纯验证；发现问题回对应任务修）

- [ ] **Step 1: api 全量测试**

Run: `cd apps/api && TESTCONTAINERS_RYUK_DISABLED=true npx vitest run`
Expected: 全部 PASS（基线注：`sendSyslog` 相关若有历史性红项按 memory 记录单独甄别，非本计划引入）

- [ ] **Step 2: web 全量测试 + 双端类型检查**

Run:
```bash
cd apps/web && npx vitest run && npx tsc --noEmit
cd ../api && npx tsc --noEmit
```
Expected: 全部 PASS / 0 错误

- [ ] **Step 3: 浏览器实测（dev server）**

起 dev（需 `ENCRYPTION_KEY` + `CHROMIUM_PATH` 环境变量，turbo strict env 会剥未声明变量）后逐项验：

1. 用例详情页：绑数据集 → 显示「选择数据」按钮 + `执行该数据集全部 N 条启用行`；点开弹窗默认全选；取消一行 → 确认后显示 `已选行号：…`；保存后重新进入页面选择仍在
2. 计划详情页组内用例行：绑数据集的用例显示 `跟随用例 · N 行`；点开弹窗 → 选子集确认 → 行内变 `已选 M 行`
3. 再开弹窗 → 出现「跟随用例」按钮 → 点击 → 行内回到 `跟随用例 · N 行`
4. 同一用例加进两个分组 → 两组行各自设置不同子集 → 互不影响（各自行内文字不同）
5. 计划级选 `全部 N 行`（弹窗全选确认）→ 行内显示 `全部 N 行`（区别于跟随态）
6. 跨产品线共享用例：弹窗能正常拉到数据集行（用例所属项目）
7. 一键执行计划 → 计划运行详情里行数符合各行选择（跑一条 2 行数据集的计划级子集用例看报告条数）

- [ ] **Step 4: 收尾提交（如有回归修复）**

```bash
git status --short   # 确认干净；有修复则按所属任务文件粒度补充 commit
```

---

## 自查记录（Self-Review）

- **Spec 覆盖**：数据模型（Task 1）、API+校验（Task 2/3）、getPlanDetail 回带（Task 4）、执行链路（Task 5）、联动清空（Task 6）、弹窗简化（Task 7）、用例详情简化（Task 8）、计划组内入口+i18n（Task 9）、测试（各任务内嵌 + Task 10）——spec 各节均有对应任务；spec 非目标（登录准备/AI 工具/plan_runs 快照）明确不做。
- **占位符**：无 TBD/TODO；所有代码步骤给出完整代码。
- **类型一致性**：`updatePlanCaseDatasetRows(planId, planCaseId, datasetRowIndexes)` 与路由调用一致；`api.plans.patchPlanCase(id, planCaseId, { datasetRowIndexes })` 与 PlanGroupCard 调用一致；`planRowIndexes`/`caseRowIndexes`/`datasetEnabledRowCount` 字段名在 service 出参、client 类型、PlanGroupCard 消费三处一致。
