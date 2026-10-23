# 失败用例根因分析（RCA）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 计划运行（开关打开）结束后自动建一个 AI 助手线程，按 `defect-rca` skill 对失败用例先分类、仅对系统缺陷结合代码仓取证，结构化结果写入 `planRunCases.rca` 并在运行详情/报告详情展示。

**Architecture:** 复用现有 pi 空间会话（`ensureSpaceRecord` + `sendSpaceUserMessage`）与 skill 体系（`.data/skills` 磁盘真源 + DB 元数据）。新增 BullMQ `rca` 队列（全局并发 1，无 redis 回落 inline），`runPlan` 收尾处触发；AI 经 `save_rca_result` 工具（仅 `purpose='rca'` 线程注册）落库；worker 带整体超时护栏（steer 收尾 → abort → 兜底 timeout 行）。

**Tech Stack:** drizzle-orm/postgres、BullMQ、pi-coding-agent（@earendil-works）、TypeBox（工具 schema）+ zod（入参防御解析）、vitest + testcontainers、React + react-i18next。

**Spec:** `docs/superpowers/specs/2026-10-23-failure-rca-design.md`

**注意：**
- api 测试需要 Docker（testcontainers）。本机已知基线红：`sendSyslog` 相关测试与 recorder xpath typecheck 噪声——判定以本计划涉及的测试文件为准，不要被全量跑的红吓到。
- shared 包无改动，不需要重编译 shared。
- 每个任务完成即 commit；分支：`feat/verify-trace-mechanical`（当前分支，或按需新开 `feat/failure-rca`）。

---

## 文件结构总览

| 动作 | 文件 | 职责 |
|---|---|---|
| 改 | `apps/api/src/db/schema.ts` | 4 张表加列 |
| 改 | `apps/api/test/helpers/db.ts` | 测试 SCHEMA_SQL 同步加列 |
| 改 | `apps/api/src/routes/plans.ts` | CreateBody/PatchBody 放开 `rcaEnabled` |
| 改 | `apps/api/src/services/plans.service.ts` | create/update 透传 `rcaEnabled` |
| 改 | `apps/api/src/execute/enqueuePlanRun.ts` | planRuns 快照 `rcaEnabled` |
| 建 | `apps/api/src/scheduler/rcaQueue.ts` | RCA 队列 + 触发入口（inline 回落） |
| 改 | `apps/api/src/execute/runPlan.ts` | 运行收尾触发 RCA |
| 建 | `apps/api/src/scheduler/rcaWorker.ts` | 编排：建线程/发任务/超时护栏 |
| 改 | `apps/api/src/index.ts` | 启动 rca worker |
| 建 | `apps/api/src/pi/space/tools/saveRcaResult.ts` | `save_rca_result` 工具 |
| 改 | `apps/api/src/pi/space/tools/context.ts` | SpaceToolsContext 加 `purpose` |
| 改 | `apps/api/src/pi/space/tools/index.ts` | 按 purpose 注册工具 |
| 改 | `apps/api/src/pi/space/session.ts` | purpose 从 aiThreads 行贯通到 ctx |
| 建 | `apps/api/scripts/defect-rca-content/SKILL.md` | skill 正文 |
| 建 | `apps/api/scripts/seed-defect-rca.mjs` | seed（缺失才铺） |
| 改 | `infra/docker/deploy.sh` | 发版接 seed |
| 改 | `apps/api/src/routes/reports.ts` | 报告详情回带 `rca` |
| 改 | `apps/web/src/api/client.ts` | 类型 + patch 入参 |
| 建 | `apps/web/src/components/RcaBlock.tsx` | RCA 展示组件（两页共用） |
| 改 | `apps/web/src/pages/PlanDetail.tsx` | 「失败根因分析」开关 |
| 改 | `apps/web/src/pages/PlanRunDetail.tsx` | 失败行 RCA 区块 + 线程跳转 |
| 改 | `apps/web/src/pages/ReportDetail.tsx` | 报告页 RCA 区块 |
| 改 | `apps/web/src/i18n/locales/zh-CN/{plans,reports}.json`、`en-US` 同名 | 文案 |
| 建 | `apps/api/test/rca-enabled.test.ts` | 开关透传/快照/报告回带 |
| 建 | `apps/api/test/rca-save-tool.test.ts` | 工具落库/准入/purpose 贯通 |
| 建 | `apps/api/test/rca-trigger.test.ts` | 运行结束触发条件 |
| 建 | `apps/api/test/rca-worker.test.ts` | 编排 happy path/幂等/跳过守卫 |
| 建 | `apps/api/test/rca-worker-timeout.test.ts` | 超时兜底 |
| 建 | `apps/api/test/rca-skill-seed.test.ts` | skill 内容/seed 一致性 |

---

### Task 1: 数据模型加列

**Files:**
- Modify: `apps/api/src/db/schema.ts`（executionPlans ≈L457、planRuns ≈L488、planRunCases ≈L526、aiThreads ≈L96）
- Modify: `apps/api/test/helpers/db.ts`（SCHEMA_SQL 末尾追加）

- [ ] **Step 1: schema.ts 四处加列**

`executionPlans`（`loginUnauthorizedKeywords` 行后加）:

```ts
  /** 运行结束后对失败用例自动做 AI 根因分析（快照进 planRuns） */
  rcaEnabled: boolean('rca_enabled').notNull().default(false),
```

`planRuns`（`loginUnauthorizedKeywords` 行后加，同款快照）:

```ts
  rcaEnabled: boolean('rca_enabled').notNull().default(false),
```

`planRunCases`（`error` 行后加）:

```ts
  /** AI 根因分析结果（save_rca_result 工具写入；worker 超时兜底写 timeout） */
  rca: jsonb('rca'),
```

`aiThreads`（`piThreadId` 行后加；`planRunId` 不加 FK——同 `plan_runs.schedule_id` 先例，避免表声明顺序的前向引用问题）:

```ts
  /** 线程用途：'chat' 用户对话（默认）；'rca' 计划运行失败根因分析后台线程 */
  purpose: varchar('purpose', { length: 20 }).notNull().default('chat'),
  /** purpose='rca' 时关联的 plan_run；chat 线程为 NULL（无 FK，同 schedule_id 先例） */
  planRunId: uuid('plan_run_id'),
```

- [ ] **Step 2: SCHEMA_SQL 同步**（`apps/api/test/helpers/db.ts` 的模板字符串末尾、`assistant_skills` 建表后追加）

```sql
-- RCA：计划开关快照 + 每失败用例分析结果 + 线程用途标记
DO $$ BEGIN ALTER TABLE execution_plans ADD COLUMN rca_enabled boolean NOT NULL DEFAULT false; EXCEPTION WHEN duplicate_column THEN null; END $$;
DO $$ BEGIN ALTER TABLE plan_runs      ADD COLUMN rca_enabled boolean NOT NULL DEFAULT false; EXCEPTION WHEN duplicate_column THEN null; END $$;
DO $$ BEGIN ALTER TABLE plan_run_cases ADD COLUMN rca jsonb; EXCEPTION WHEN duplicate_column THEN null; END $$;
DO $$ BEGIN ALTER TABLE ai_threads     ADD COLUMN purpose varchar(20) NOT NULL DEFAULT 'chat'; EXCEPTION WHEN duplicate_column THEN null; END $$;
DO $$ BEGIN ALTER TABLE ai_threads     ADD COLUMN plan_run_id uuid; EXCEPTION WHEN duplicate_column THEN null; END $$;
```

- [ ] **Step 3: 验证**

```bash
cd apps/api && npx tsc --noEmit
```
Expected: 无新增错误（recorder xpath 报错是既有基线噪声，忽略）。

```bash
cd apps/api && npx vitest run test/plans.test.ts
```
Expected: PASS（SCHEMA_SQL 改动后既有测试不炸）。

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/test/helpers/db.ts
git commit -m "feat(rca): schema 加列——计划 rcaEnabled 快照/planRunCases.rca/ai_threads.purpose"
```

---

### Task 2: rcaEnabled 路由/service/快照透传

**Files:**
- Create: `apps/api/test/rca-enabled.test.ts`
- Modify: `apps/api/src/routes/plans.ts:42-59`
- Modify: `apps/api/src/services/plans.service.ts`（CreatePlanInput/createPlan/UpdatePlanPatch/updatePlan）
- Modify: `apps/api/src/execute/enqueuePlanRun.ts:73-87`

- [ ] **Step 1: 写失败测试** `apps/api/test/rca-enabled.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  delete process.env.REDIS_URL; // enqueue 走 inline，无队列依赖
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { plansRoute } = await import('../src/routes/plans.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/projects/:projectId/plans', plansRoute);
  app.use('/api/plans', plansRoute);
  app.use(errorHandler);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('rcaEnabled 透传', () => {
  it('create 带 rcaEnabled=true → 详情可见;patch 置 false 生效', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const created = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({ name: 'RCA 计划', versionId, rcaEnabled: true });
    expect(created.status).toBe(200);
    expect(created.body.rcaEnabled).toBe(true);

    const patched = await request(app).patch(`/api/plans/${created.body.id}`).send({ rcaEnabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body.rcaEnabled).toBe(false);
  });

  it('enqueuePlanRun 把 rcaEnabled 快照进 plan_runs', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const created = await request(app)
      .post(`/api/projects/${projectId}/plans`)
      .send({ name: '快照计划', versionId, rcaEnabled: true });
    const run = await request(app).post(`/api/plans/${created.body.id}/run`);
    expect(run.status).toBe(200);
    const row = await pool.query('SELECT rca_enabled, status FROM plan_runs WHERE id = $1', [run.body.runId]);
    expect(row.rows[0]!.rca_enabled).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && npx vitest run test/rca-enabled.test.ts
```
Expected: FAIL（路由剥掉 rcaEnabled / plan_runs 无该列值）。

- [ ] **Step 3: 实现**

`plans.ts` CreateBody/PatchBody 各加一行:

```ts
  rcaEnabled: z.boolean().optional(),
```

`plans.service.ts`:
- `CreatePlanInput` 加 `rcaEnabled?: boolean;`
- `createPlan` 的 `db.insert(executionPlans).values({...})` 里加 `rcaEnabled: input.rcaEnabled ?? false,`
- `UpdatePlanPatch` 加 `rcaEnabled?: boolean;`
- `updatePlan` 的字段拷贝段加:

```ts
  if (patch.rcaEnabled !== undefined) update.rcaEnabled = patch.rcaEnabled;
```

`enqueuePlanRun.ts` 的 `db.insert(planRuns).values({...})` 里（`loginUnauthorizedKeywords` 后）加:

```ts
    rcaEnabled: plan.rcaEnabled,
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && npx vitest run test/rca-enabled.test.ts test/plans.test.ts
```
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/plans.ts apps/api/src/services/plans.service.ts apps/api/src/execute/enqueuePlanRun.ts apps/api/test/rca-enabled.test.ts
git commit -m "feat(rca): 计划 rcaEnabled 透传路由/service 并快照进 plan_runs"
```

---

### Task 3: save_rca_result 工具 + purpose 装配贯通

**Files:**
- Create: `apps/api/src/pi/space/tools/saveRcaResult.ts`
- Create: `apps/api/test/rca-save-tool.test.ts`
- Modify: `apps/api/src/pi/space/tools/context.ts`（SpaceToolsContext 加 purpose）
- Modify: `apps/api/src/pi/space/tools/index.ts`（按 purpose 注册）
- Modify: `apps/api/src/pi/space/session.ts`（SpaceThreadContext + buildSpaceRecord 贯通）

- [ ] **Step 1: 写失败测试** `apps/api/test/rca-save-tool.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';
import { emptyRepoState } from '../src/pi/space/tools/context.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
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

async function seedFailedRunCase(): Promise<{ planRunId: string; planRunCaseId: string }> {
  const { projectId } = await seedProject(pool);
  const run = await pool.query(`INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES (gen_random_uuid(), $1, 'failed', 'run_all') RETURNING id`, [projectId]);
  const prc = await pool.query(
    `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind, error) VALUES ($1, gen_random_uuid(), 1, 'failed', 'business', 'case failed') RETURNING id`,
    [run.rows[0]!.id as string],
  );
  return { planRunId: run.rows[0]!.id as string, planRunCaseId: prc.rows[0]!.id as string };
}

function toolCtx(overrides: Record<string, unknown> = {}) {
  return {
    threadId: randomUUID(),
    versionId: randomUUID(),
    projectId: randomUUID(),
    repo: emptyRepoState(),
    emit: () => {},
    createdByUserId: null,
    manager: false,
    lang: 'zh-CN' as const,
    ...overrides,
  };
}

describe('save_rca_result', () => {
  it('合法入参写入 planRunCases.rca（合并 analyzedAt/threadId）', async () => {
    const { planRunCaseId } = await seedFailedRunCase();
    const { buildSaveRcaResultTool } = await import('../src/pi/space/tools/saveRcaResult.js');
    const tool = buildSaveRcaResultTool(toolCtx());
    const r = await tool.execute({
      planRunCaseId,
      status: 'analyzed',
      category: 'system_defect',
      confidence: 'high',
      summary: '提交接口未校验必填字段',
      evidence: [{ file: 'src/api/submit.ts', lines: '12-34', note: '缺 non-null 校验' }],
      suggestion: '补字段校验',
    });
    expect(r.ok).toBe(true);
    const row = await pool.query('SELECT rca FROM plan_run_cases WHERE id = $1', [planRunCaseId]);
    const rca = row.rows[0]!.rca as Record<string, unknown>;
    expect(rca.status).toBe('analyzed');
    expect(rca.summary).toBe('提交接口未校验必填字段');
    expect(rca.threadId).toBe(tool.threadId ?? undefined);
    expect(typeof rca.analyzedAt).toBe('string');
  });

  it('拒绝 status=timeout / 未知 planRunCaseId / 非法枚举', async () => {
    const { planRunCaseId } = await seedFailedRunCase();
    const { buildSaveRcaResultTool } = await import('../src/pi/space/tools/saveRcaResult.js');
    const tool = buildSaveRcaResultTool(toolCtx());
    expect((await tool.execute({ planRunCaseId, status: 'timeout', category: 'other', confidence: 'low', summary: 'x' })).ok).toBe(false);
    expect((await tool.execute({ planRunCaseId: randomUUID(), status: 'skipped', category: 'other', confidence: 'low', summary: 'x' })).ok).toBe(false);
    expect((await tool.execute({ planRunCaseId, status: 'skipped', category: 'nope', confidence: 'low', summary: 'x' })).ok).toBe(false);
  });

  it('buildSpaceTools 仅在 purpose=rca 线程注册 save_rca_result', async () => {
    const { buildSpaceTools } = await import('../src/pi/space/tools/index.js');
    const chat = buildSpaceTools(toolCtx() as never).map((t) => t.name);
    expect(chat).not.toContain('save_rca_result');
    const rca = buildSpaceTools(toolCtx({ purpose: 'rca' }) as never).map((t) => t.name);
    expect(rca).toContain('save_rca_result');
  });

  it('session 把 ai_threads.purpose 贯通到工厂 ctx', async () => {
    const { projectId, versionId } = await seedProject(pool);
    const threadId = randomUUID();
    await pool.query(
      `INSERT INTO ai_threads(id, kind, version_id, pi_thread_id, purpose) VALUES ($1, 'version', $2, '', 'rca')`,
      [threadId, versionId],
    );
    const { setSpaceSessionFactory, ensureSpaceRecord, resetSpaceSessions } = await import('../src/pi/space/session.js');
    let captured: Record<string, unknown> | null = null;
    setSpaceSessionFactory(async (ctx) => {
      captured = ctx as unknown as Record<string, unknown>;
      return {
        subscribe: () => () => {},
        prompt: async () => {},
        abort: () => {},
        dispose: () => {},
        clearQueue: () => ({ steering: [], followUp: [] }),
        isStreaming: false,
        messages: [],
      };
    });
    await ensureSpaceRecord(threadId);
    expect(captured && (captured as { purpose?: string }).purpose).toBe('rca');
    resetSpaceSessions();
    await pool.query('DELETE FROM ai_threads WHERE id = $1', [threadId]);
    void projectId;
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && npx vitest run test/rca-save-tool.test.ts
```
Expected: FAIL（saveRcaResult 模块不存在）。

- [ ] **Step 3: 实现 context.ts**（SpaceToolsContext 末尾加）

```ts
  /** 线程用途：'rca' 才注册 save_rca_result；缺省等同 'chat'（历史线程/测试桩不带此字段）。 */
  purpose?: string;
```

- [ ] **Step 4: 实现 saveRcaResult.ts**（新文件，zod 防御解析照 history.ts 模式）

```ts
/** save_rca_result:RCA 线程专用——把单个失败用例的分析结论写入 plan_run_cases.rca。
 *  仅 purpose='rca' 的线程注册(buildSpaceTools 闸门);status='timeout' 保留给 worker 兜底,AI 不可用。 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { planRunCases } from '../../../db/schema.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

const Args = z.object({
  planRunCaseId: z.string().uuid(),
  status: z.enum(['analyzed', 'skipped', 'error']),
  category: z.enum(['system_defect', 'case_issue', 'environment', 'other']),
  confidence: z.enum(['high', 'medium', 'low']),
  summary: z.string().min(1).max(4000),
  evidence: z.array(z.object({
    file: z.string().min(1),
    lines: z.string().max(40).optional(),
    note: z.string().max(500).optional(),
  })).max(20).optional(),
  suggestion: z.string().max(4000).optional(),
});

export function buildSaveRcaResultTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'save_rca_result',
    description:
      '保存一个失败用例的根因分析结论(每个失败用例恰好调用一次)。系统缺陷:status=analyzed+evidence+suggestion;非系统缺陷:status=skipped,summary 一句话结论;报告数据不可得:status=error 并说明原因。',
    parameters: Type.Object({
      planRunCaseId: Type.String({ description: '失败用例清单里的 planRunCaseId' }),
      status: Type.Union([Type.Literal('analyzed'), Type.Literal('skipped'), Type.Literal('error')]),
      category: Type.Union([
        Type.Literal('system_defect'), Type.Literal('case_issue'),
        Type.Literal('environment'), Type.Literal('other'),
      ]),
      confidence: Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')]),
      summary: Type.String({ description: '根因/结论描述' }),
      evidence: Type.Optional(Type.Array(Type.Object({
        file: Type.String(), lines: Type.Optional(Type.String()), note: Type.Optional(Type.String()),
      }), { maxItems: 20 })),
      suggestion: Type.Optional(Type.String()),
    }),
    promptGuidelines: [
      '每个失败用例恰好调用一次;status=timeout 是系统保留值,禁止使用。',
      '系统缺陷必须给出至少一条 evidence(代码仓 file:line);非系统缺陷不写 evidence。',
    ],
    execute: async (input) => {
      let v: z.infer<typeof Args>;
      try {
        v = Args.parse(input);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { ok: false, error: `参数不合法:${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
        }
        throw e;
      }
      const row = (await db.select({ id: planRunCases.id }).from(planRunCases).where(eq(planRunCases.id, v.planRunCaseId)).limit(1))[0];
      if (!row) return { ok: false, error: `planRunCaseId 不存在: ${v.planRunCaseId}` };
      const { planRunCaseId: _omit, ...rca } = v;
      await db.update(planRunCases).set({
        rca: { ...rca, analyzedAt: new Date().toISOString(), threadId: ctx.threadId },
      }).where(eq(planRunCases.id, v.planRunCaseId));
      return { ok: true, data: `已保存 ${v.planRunCaseId.slice(0, 8)} 的分析结论(${v.status}/${v.category})` };
    },
  };
}
```

注意：`const { planRunCaseId: _omit, ...rca } = v;` 若 lint 报未使用变量，改为 `const { planRunCaseId, ...rca } = v; void planRunCaseId;`。

- [ ] **Step 5: tools/index.ts 注册**（`buildHistoryTools` 行后加）

```ts
  // RCA 专用落库工具：仅根因分析后台线程可见，普通对话线程不出现该工具面。
  if (ctx.purpose === 'rca') {
    tools.push(buildSaveRcaResultTool(ctx));
  }
```
并在 import 区加 `import { buildSaveRcaResultTool } from './saveRcaResult.js';`

- [ ] **Step 6: session.ts 贯通 purpose**

`SpaceThreadContext`（repo 字段后）加:

```ts
  /** 线程用途：'rca' 根因分析线程（save_rca_result 注册闸门）；缺省 'chat'。 */
  purpose?: string;
```

`buildSpaceRecord` 的 `factory({...})` 调用参数里加:

```ts
    purpose: row.purpose ?? 'chat',
```

- [ ] **Step 7: 跑测试确认通过**

```bash
cd apps/api && npx vitest run test/rca-save-tool.test.ts test/space-tools-basic.test.ts test/space-router.test.ts
```
Expected: PASS（后两个确认既有装配/路由不回归）。

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/pi/space/tools/saveRcaResult.ts apps/api/src/pi/space/tools/context.ts apps/api/src/pi/space/tools/index.ts apps/api/src/pi/space/session.ts apps/api/test/rca-save-tool.test.ts
git commit -m "feat(rca): save_rca_result 工具——purpose=rca 线程专属,结构化落 planRunCases.rca"
```

---

### Task 4: rcaQueue + runPlan 触发

**Files:**
- Create: `apps/api/src/scheduler/rcaQueue.ts`
- Create: `apps/api/test/rca-trigger.test.ts`
- Modify: `apps/api/src/execute/runPlan.ts`（plan_run_complete 发布后触发）

- [ ] **Step 1: 写失败测试** `apps/api/test/rca-trigger.test.ts`

```ts
/**
 * RCA 触发条件：run 收尾后 rcaEnabled && failedCases>0 才入队（inline → processRcaJob）。
 * 用 FORCE_FAIL_CASE_IDS 造失败（runCase 在进 CDP 前直接写失败报告，无需浏览器）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

vi.mock('../src/scheduler/rcaWorker.js', () => ({ processRcaJob: vi.fn().mockResolvedValue(undefined) }));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  delete process.env.REDIS_URL; // inline 路径
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

async function seedPlanWithCase(rcaEnabled: boolean): Promise<{ planId: string; caseId: string }> {
  const { projectId, groupId, versionId } = await seedProject(pool);
  const c = await pool.query(
    `INSERT INTO test_cases(group_id, title, version_id) VALUES ($1, '必败用例', $2) RETURNING id`,
    [groupId, versionId],
  );
  const caseId = c.rows[0]!.id as string;
  const p = await pool.query(
    `INSERT INTO execution_plans(project_id, name, version_id, rca_enabled) VALUES ($1, '触发计划', $2, $3) RETURNING id`,
    [projectId, versionId, rcaEnabled],
  );
  await pool.query(`INSERT INTO plan_cases(plan_id, case_id, "order") VALUES ($1, $2, 1)`, [p.rows[0]!.id as string, caseId]);
  return { planId: p.rows[0]!.id as string, caseId };
}

async function runPlanAndWait(planId: string, caseId: string): Promise<string> {
  process.env.FORCE_FAIL_CASE_IDS = caseId;
  const { enqueuePlanRun } = await import('../src/execute/enqueuePlanRun.js');
  const { runId } = await enqueuePlanRun({ planId, trigger: { source: 'manual' }, callerUser: null });
  for (let i = 0; i < 100; i++) {
    const r = await pool.query('SELECT status FROM plan_runs WHERE id = $1', [runId]);
    if (r.rows[0] && r.rows[0].status !== 'running') return runId;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('plan run did not finish');
}

describe('RCA 触发条件', () => {
  it('rcaEnabled 且有失败 → processRcaJob 被调用', async () => {
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    const { planId, caseId } = await seedPlanWithCase(true);
    const runId = await runPlanAndWait(planId, caseId);
    expect(vi.mocked(processRcaJob)).toHaveBeenCalledWith({ kind: 'rca', planRunId: runId });
  });

  it('rcaEnabled=false 不触发', async () => {
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    const calls = vi.mocked(processRcaJob).mock.calls.length;
    const { planId, caseId } = await seedPlanWithCase(false);
    await runPlanAndWait(planId, caseId);
    expect(vi.mocked(processRcaJob).mock.calls.length).toBe(calls);
  });

  it('全过（无失败）不触发', async () => {
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    const calls = vi.mocked(processRcaJob).mock.calls.length;
    const { projectId, groupId, versionId } = await seedProject(pool);
    const c = await pool.query(`INSERT INTO test_cases(group_id, title, version_id) VALUES ($1, '正常用例', $2) RETURNING id`, [groupId, versionId]);
    const p = await pool.query(
      `INSERT INTO execution_plans(project_id, name, version_id, rca_enabled) VALUES ($1, '全过计划', $2, true) RETURNING id`,
      [projectId, versionId],
    );
    await pool.query(`INSERT INTO plan_cases(plan_id, case_id, "order") VALUES ($1, $2, 1)`, [p.rows[0]!.id as string, c.rows[0]!.id as string]);
    await runPlanAndWait(p.rows[0]!.id as string, c.rows[0]!.id as string);
    expect(vi.mocked(processRcaJob).mock.calls.length).toBe(calls);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && npx vitest run test/rca-trigger.test.ts
```
Expected: FAIL（rcaQueue 模块不存在 / processRcaJob 零调用）。

- [ ] **Step 3: 实现 rcaQueue.ts**

```ts
/**
 * RCA 队列:计划运行结束后的失败用例根因分析任务。全局并发 1——同一时间只有一个
 * 分析线程在跑,不与执行引擎抢 chromium 资源。REDIS_URL 缺失 → inline fire-and-forget
 * (dev/单容器),与 exec 队列的降级模式一致。幂等判重由 worker 侧线程查重兜底。
 */
import { Queue, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { getRedis } from './queue.js';
import { db } from '../db/client.js';
import { planRuns } from '../db/schema.js';
import { logger } from '../logger.js';

export const RCA_QUEUE_NAME = 'rca';

export type RcaJob = { kind: 'rca'; planRunId: string };

let _queue: Queue<RcaJob> | null = null;

export function isRcaQueueReady(): boolean {
  return !!process.env.REDIS_URL;
}

export function getRcaQueue(): Queue<RcaJob> {
  if (!_queue) {
    _queue = new Queue<RcaJob>(RCA_QUEUE_NAME, { connection: getRedis() });
  }
  return _queue;
}

export function buildRcaWorker(processor: (job: RcaJob) => Promise<void>): Worker<RcaJob> {
  return new Worker<RcaJob>(RCA_QUEUE_NAME, async (job) => processor(job.data), {
    connection: getRedis(),
    concurrency: 1,
  });
}

/** 运行收尾调用:开关打开且有业务失败才投递。动态 import rcaWorker 防静态环
 *  (runPlan→rcaQueue→rcaWorker→session→…),测试也靠它 mock rcaWorker。 */
export async function enqueueRcaForPlanRun(planRunId: string): Promise<void> {
  const run = (await db
    .select({ rcaEnabled: planRuns.rcaEnabled, failedCases: planRuns.failedCases })
    .from(planRuns)
    .where(eq(planRuns.id, planRunId))
    .limit(1))[0];
  if (!run?.rcaEnabled || (run.failedCases ?? 0) <= 0) return;
  const job: RcaJob = { kind: 'rca', planRunId };
  if (isRcaQueueReady()) {
    try {
      await getRcaQueue().add(RCA_QUEUE_NAME, job);
      return;
    } catch (e) {
      logger.warn({ err: e, planRunId }, 'rca queue add failed; running inline');
    }
  }
  const { processRcaJob } = await import('./rcaWorker.js');
  void processRcaJob(job).catch((err) => logger.error({ err, planRunId }, 'inline rca job crashed'));
}

/** 仅供测试/teardown。 */
export async function __closeRcaQueue(): Promise<void> {
  if (_queue) await _queue.close();
  _queue = null;
}
```

- [ ] **Step 4: runPlan.ts 触发**（`publish(planRunId, { type: 'plan_run_complete', ... })` 之后、`runState.delete(planRunId)` 之前加）

```ts
  // RCA:开关打开且有业务失败 → 入队根因分析(异步,不阻塞运行收尾;动态 import 防环)
  try {
    const { enqueueRcaForPlanRun } = await import('../scheduler/rcaQueue.js');
    void enqueueRcaForPlanRun(planRunId).catch((e) => logger.warn({ err: e, planRunId }, 'rca enqueue failed'));
  } catch { /* 队列模块加载失败不影响运行收尾 */ }
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd apps/api && npx vitest run test/rca-trigger.test.ts test/exec-queue.test.ts test/plan-run-cancel.test.ts
```
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/scheduler/rcaQueue.ts apps/api/src/execute/runPlan.ts apps/api/test/rca-trigger.test.ts
git commit -m "feat(rca): rca 队列(并发1+inline回落)与 runPlan 收尾触发"
```

---

### Task 5: rcaWorker 编排（建线程/任务 prompt/幂等/守卫）

**Files:**
- Create: `apps/api/src/scheduler/rcaWorker.ts`
- Create: `apps/api/test/rca-worker.test.ts`
- Modify: `apps/api/src/index.ts`（启动 worker，L84 `startExecutionWorker` 旁）

- [ ] **Step 1: 写失败测试** `apps/api/test/rca-worker.test.ts`

```ts
/** rcaWorker 编排:建 purpose=rca 线程、注入失败清单、幂等、守卫。stub factory 免 LLM。 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  delete process.env.REDIS_URL;
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

afterEach(async () => {
  const { resetSpaceSessions } = await import('../src/pi/space/session.js');
  resetSpaceSessions();
  await pool.query("DELETE FROM ai_threads WHERE purpose = 'rca'");
});

interface FakeSession {
  prompts: string[];
  aborted: boolean;
  factoryCtx: Record<string, unknown> | null;
}

async function stubFactory(): Promise<FakeSession> {
  const fake: FakeSession = { prompts: [], aborted: false, factoryCtx: null };
  const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
  setSpaceSessionFactory(async (ctx) => {
    fake.factoryCtx = ctx as unknown as Record<string, unknown>;
    return {
      subscribe: () => () => {},
      prompt: async (text: string) => {
        fake.prompts.push(text);
        // 模拟 AI 按清单逐个落库(经 save_rca_result 的效果)
        const { db } = await import('../src/db/client.js');
        const { planRunCases } = await import('../src/db/schema.js');
        const { eq } = await import('drizzle-orm');
        const rows = await db.select({ id: planRunCases.id }).from(planRunCases);
        for (const r of rows) {
          if (text.includes(r.id)) {
            await db.update(planRunCases).set({ rca: { status: 'skipped', category: 'case_issue', confidence: 'high', summary: 'stub' } }).where(eq(planRunCases.id, r.id));
          }
        }
      },
      abort: () => { fake.aborted = true; },
      dispose: () => {},
      clearQueue: () => ({ steering: [], followUp: [] }),
      isStreaming: false,
      messages: [],
    };
  });
  return fake;
}

async function seedFailedRun(opts: { rcaEnabled?: boolean; failedCases?: number; withVersion?: boolean } = {}): Promise<string> {
  const withVersion = opts.withVersion ?? true;
  const { projectId, versionId } = await seedProject(pool);
  const r = await pool.query(
    `INSERT INTO plan_runs(plan_id, project_id, status, strategy, rca_enabled, failed_cases)
     VALUES (gen_random_uuid(), $1, 'failed', 'run_all', $2, $3) RETURNING id`,
    [projectId, opts.rcaEnabled ?? true, opts.failedCases ?? 1],
  );
  if (opts.rcaEnabled === false || (opts.failedCases ?? 1) <= 0) return r.rows[0]!.id as string;
  await pool.query(
    `UPDATE execution_plans SET version_id = $1 WHERE id = (SELECT plan_id FROM plan_runs WHERE id = $2)`,
    [withVersion ? versionId : null, r.rows[0]!.id],
  );
  const c = await pool.query(`INSERT INTO test_cases(group_id, title, version_id) VALUES (gen_random_uuid(), '登录后看不到订单', $1) RETURNING id`, [withVersion ? versionId : null]);
  // test_cases.group_id NOT NULL → 先造组
  return r.rows[0]!.id as string;
}
```

注意：`test_cases.group_id NOT NULL`，seedFailedRunCase 里要先用真分组。修正版（替换上面的 seedFailedRun）:

```ts
async function seedFailedRun(opts: { rcaEnabled?: boolean; failedCases?: number; withVersion?: boolean } = {}): Promise<string> {
  const withVersion = opts.withVersion ?? true;
  const { projectId, groupId, versionId } = await seedProject(pool);
  const r = await pool.query(
    `INSERT INTO plan_runs(plan_id, project_id, status, strategy, rca_enabled, failed_cases)
     VALUES (gen_random_uuid(), $1, 'failed', 'run_all', $2, $3) RETURNING id`,
    [projectId, opts.rcaEnabled ?? true, opts.failedCases ?? 1],
  );
  const runId = r.rows[0]!.id as string;
  await pool.query(
    `UPDATE execution_plans SET version_id = $1 WHERE id = (SELECT plan_id FROM plan_runs WHERE id = $2)`,
    [withVersion ? versionId : null, runId],
  );
  if (opts.rcaEnabled === false || (opts.failedCases ?? 1) <= 0) return runId;
  const c = await pool.query(
    `INSERT INTO test_cases(group_id, title, version_id) VALUES ($1, '登录后看不到订单', $2) RETURNING id`,
    [groupId, withVersion ? versionId : null],
  );
  await pool.query(
    `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind, error, report_id) VALUES ($1, $2, 1, 'failed', 'business', 'case failed', $3)`,
    [runId, c.rows[0]!.id as string, (await seedFailedReport(c.rows[0]!.id as string))],
  );
  return runId;
}

async function seedFailedReport(caseId: string): Promise<string> {
  const rep = await pool.query(
    `INSERT INTO reports(case_id, status, step_results, summary) VALUES ($1, 'failed', $2::jsonb, 'e2e') RETURNING id`,
    [caseId, JSON.stringify([
      { order: 1, status: 'passed', durationMs: 10 },
      { order: 2, status: 'failed', durationMs: 30, error: 'Locator click timeout', failureReason: 'LocatorAllFailed', humanMessage: '页面元素未找到' },
    ])],
  );
  return rep.rows[0]!.id as string;
}
```

主体测试:

```ts
describe('rcaWorker.processRcaJob', () => {
  it('建 purpose=rca 线程(标题/planRunId)并注入失败清单;prompt 含 caseTitle/planRunCaseId/失败步骤', async () => {
    const fake = await stubFactory();
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    const runId = await seedFailedRun();
    await processRcaJob({ planRunId: runId });
    const th = await pool.query("SELECT * FROM ai_threads WHERE purpose='rca' AND plan_run_id=$1", [runId]);
    expect(th.rows).toHaveLength(1);
    expect(String(th.rows[0]!.title)).toContain('根因分析');
    expect(fake.factoryCtx && (fake.factoryCtx as { purpose?: string }).purpose).toBe('rca');
    expect(fake.prompts).toHaveLength(1);
    const row = await pool.query('SELECT id, case_id FROM plan_run_cases WHERE plan_run_id=$1', [runId]);
    expect(fake.prompts[0]).toContain(row.rows[0]!.id);
    expect(fake.prompts[0]).toContain('登录后看不到订单');
    expect(fake.prompts[0]).toContain('LocatorAllFailed');
    // 模拟 AI 已落库 → 不应被兜底覆盖
    const rca = await pool.query('SELECT rca FROM plan_run_cases WHERE id=$1', [row.rows[0]!.id]);
    expect((rca.rows[0]!.rca as Record<string, unknown>).status).toBe('skipped');
  });

  it('幂等:同 run 第二次调用不再建线程不再发消息', async () => {
    const fake = await stubFactory();
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    const runId = await seedFailedRun();
    await processRcaJob({ planRunId: runId });
    await processRcaJob({ planRunId: runId });
    expect(fake.prompts).toHaveLength(1);
  });

  it('守卫:rcaEnabled=false / failedCases=0 / plan 无 version → 不建线程', async () => {
    await stubFactory();
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    const r1 = await seedFailedRun({ rcaEnabled: false });
    const r2 = await seedFailedRun({ failedCases: 0 });
    const r3 = await seedFailedRun({ withVersion: false, rcaEnabled: true });
    // withVersion:false 且 failed=1 时上面 seed 不插失败行——直接补一行不依赖 version
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind)
       SELECT $1, gen_random_uuid(), 1, 'failed', 'business'`,
      [r3],
    );
    await processRcaJob({ planRunId: r1 });
    await processRcaJob({ planRunId: r2 });
    await processRcaJob({ planRunId: r3 });
    const th = await pool.query("SELECT count(*)::int AS n FROM ai_threads WHERE purpose='rca'");
    expect(th.rows[0]!.n).toBe(0);
  });

  it('会话异常(工厂抛错)不外抛,线程行保留', async () => {
    const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
    setSpaceSessionFactory(async () => { throw new Error('boom'); });
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    const runId = await seedFailedRun();
    await expect(processRcaJob({ planRunId: runId })).resolves.toBeUndefined();
    const th = await pool.query("SELECT count(*)::int AS n FROM ai_threads WHERE purpose='rca' AND plan_run_id=$1", [runId]);
    expect(th.rows[0]!.n).toBe(1);
  });
});
```

注意「守卫」用例里 r3：`withVersion:false` 时 plan.versionId=null 守卫应短路——但 seed 里失败行插入在守卫检查之前没关系，守卫先判 versionId。还有 `gen_random_uuid()` 直接当 case_id 会违反 FK（test_cases 不存在该 id）。plan_run_cases.case_id 有 FK 到 test_cases——修正：r3 的失败行也走真用例。把守卫用例改为:先 seedProject 拿 groupId 造用例。最终版见 Step 3 后的「测试代码最终形态」——**以实现时能跑通为准，FK 完整性必须满足**。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && npx vitest run test/rca-worker.test.ts
```
Expected: FAIL（rcaWorker 模块不存在）。

- [ ] **Step 3: 实现 rcaWorker.ts**

```ts
/**
 * RCA worker:消费 rca 队列。每个 planRun 建一个 purpose='rca' 的助手线程,注入失败
 * 用例清单,AI 按 defect-rca skill 逐用例分类/取证,经 save_rca_result 落库。
 * 超时护栏见 runWithTimeout:steer 收尾 → 宽限 → abort + 兜底 timeout 行(Task 6)。
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { logger } from '../logger.js';
import { db } from '../db/client.js';
import { aiThreads, executionPlans, planRunCases, planRuns, reports, testCases } from '../db/schema.js';
import { cancelThread, ensureSpaceRecord, sendSpaceUserMessage } from '../pi/space/session.js';
import type { RcaJob } from './rcaQueue.js';

export function buildTaskPrompt(planName: string, runId: string, items: FailedCaseItem[]): string {
  const list = items.map((it, i) => {
    const steps = it.failedSteps.length
      ? it.failedSteps.map((s) => `第${s.order}步[${s.failureReason ?? '?'}] ${s.humanMessage ?? s.error ?? ''}`).join('；')
      : '（步骤数据缺失，用 query_stats 的 report_detail 补取）';
    return [
      `${i + 1}. ${it.caseTitle}`,
      `   - planRunCaseId: ${it.planRunCaseId}`,
      `   - caseId: ${it.caseId}`,
      `   - reportId: ${it.reportId ?? '无'}`,
      `   - 运行级 error: ${it.error ?? '无'}`,
      `   - 失败步骤摘要: ${steps}`,
    ].join('\n');
  }).join('\n');
  return [
    `本次计划运行「${planName}」（run ${runId.slice(0, 8)}）已结束，共 ${items.length} 个失败用例需要做根因分析。请加载 defect-rca skill 并严格按其工作流逐个处理。`,
    '',
    '## 失败用例清单',
    list,
    '',
    '## 硬性要求',
    '1. 每个用例先分类（system_defect / case_issue / environment / other），再决定是否深挖；',
    '2. 系统缺陷必须结合代码仓（./repo）取证到 file:line，代码仓未就绪就先做其它用例、稍后重试；',
    '3. 每个用例恰好调用一次 save_rca_result（planRunCaseId 用清单里的原值）；',
    '4. 全部处理完后发一条结案总结：各类数量 + 关键发现，不超过 10 行。',
  ].join('\n');
}

interface FailedCaseItem {
  planRunCaseId: string;
  caseId: string;
  caseTitle: string;
  reportId: string | null;
  error: string | null;
  failedSteps: Array<{ order: number; failureReason: string | null; humanMessage: string | null; error: string | null }>;
}

async function collectFailedCases(planRunId: string): Promise<FailedCaseItem[]> {
  const rows = await db
    .select({
      id: planRunCases.id,
      caseId: planRunCases.caseId,
      reportId: planRunCases.reportId,
      reportIds: planRunCases.reportIds,
      error: planRunCases.error,
      title: testCases.title,
    })
    .from(planRunCases)
    .leftJoin(testCases, eq(testCases.id, planRunCases.caseId))
    .where(and(eq(planRunCases.planRunId, planRunId), eq(planRunCases.status, 'failed'), eq(planRunCases.stepKind, 'business')));
  const out: FailedCaseItem[] = [];
  for (const r of rows) {
    const firstReport = r.reportId ?? (Array.isArray(r.reportIds) ? r.reportIds.find((id) => !!id) ?? null : null);
    let failedSteps: FailedCaseItem['failedSteps'] = [];
    if (firstReport) {
      const rep = (await db.select({ stepResults: reports.stepResults }).from(reports).where(eq(reports.id, firstReport)).limit(1))[0];
      const steps = Array.isArray(rep?.stepResults) ? (rep!.stepResults as Array<Record<string, unknown>>) : [];
      failedSteps = steps
        .filter((s) => s.status === 'failed')
        .map((s) => ({
          order: Number(s.order ?? 0),
          failureReason: (s.failureReason as string) ?? null,
          humanMessage: (s.humanMessage as string) ?? null,
          error: typeof s.error === 'string' && s.error.length > 500 ? `${s.error.slice(0, 500)}…` : (s.error as string) ?? null,
        }));
    }
    out.push({ planRunCaseId: r.id, caseId: r.caseId, caseTitle: r.title ?? '未知用例', reportId: firstReport, error: r.error, failedSteps });
  }
  return out;
}

export async function processRcaJob(data: RcaJob): Promise<void> {
  const run = (await db.select().from(planRuns).where(eq(planRuns.id, data.planRunId)).limit(1))[0];
  if (!run || !run.rcaEnabled || (run.failedCases ?? 0) <= 0) return;
  const plan = (await db.select().from(executionPlans).where(eq(executionPlans.id, run.planId)).limit(1))[0];
  if (!plan?.versionId) return; // 无版本 → 无助手空间
  const dup = await db.select({ id: aiThreads.id }).from(aiThreads)
    .where(and(eq(aiThreads.purpose, 'rca'), eq(aiThreads.planRunId, run.id))).limit(1);
  if (dup.length > 0) return; // 幂等：本 run 已有分析线程
  const failed = await collectFailedCases(run.id);
  if (failed.length === 0) return;

  const threadId = randomUUID();
  await db.insert(aiThreads).values({
    id: threadId,
    kind: 'version',
    versionId: plan.versionId,
    purpose: 'rca',
    planRunId: run.id,
    title: `根因分析 · ${plan.name} · run#${run.id.slice(0, 8)}`,
    piThreadId: '',
    createdByUserId: run.triggeredByUserId,
  });
  try {
    await ensureSpaceRecord(threadId);
    await runWithTimeout(threadId, () => sendSpaceUserMessage(threadId, buildTaskPrompt(plan.name, run.id, failed)));
  } catch (e) {
    logger.error({ err: e, planRunId: run.id, threadId }, 'rca session failed');
  } finally {
    await fillTimeoutRows(run.id, threadId);
  }
}

/** 超时兜底:本 run 仍未落 rca 的失败行批量写 status=timeout。 */
async function fillTimeoutRows(planRunId: string, threadId: string): Promise<void> {
  await db.update(planRunCases).set({
    rca: { status: 'timeout', summary: '分析超时未完成', analyzedAt: new Date().toISOString(), threadId },
  }).where(and(
    eq(planRunCases.planRunId, planRunId),
    eq(planRunCases.status, 'failed'),
    isNull(planRunCases.rca),
  ));
}

// 超时常量与 runWithTimeout 在 Task 6 落地;先放占位直通版保证 Task 5 可编译可测:
const RCA_TIMEOUT_MS = Number(process.env.RCA_TIMEOUT_MS) || 30 * 60_000;
const RCA_GRACE_MS = Number(process.env.RCA_GRACE_MS) || 3 * 60_000;

async function runWithTimeout(threadId: string, fn: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), RCA_TIMEOUT_MS); });
  const r = await Promise.race([fn().then(() => 'done' as const), timeoutP]);
  clearTimeout(timer);
  if (r === 'done') return;
  logger.warn({ threadId }, 'rca timeout; steering wrap-up');
  try {
    await Promise.race([
      sendSpaceUserMessage(threadId, '整体分析已超时：立即停止取证，把已完成结论逐一 save_rca_result 落库并发一句结案总结；未分析的不用补。', 'steer'),
      new Promise((resolve) => setTimeout(resolve, RCA_GRACE_MS)),
    ]);
  } catch { /* steer 失败按超时处理 */ }
  cancelThread(threadId);
}
```

- [ ] **Step 4: index.ts 启动**（L84 `void startExecutionWorker();` 后加）

```ts
  void startRcaWorker();
```
并 import：

```ts
import { startRcaWorker } from './scheduler/rcaWorker.js';
```

在 rcaWorker.ts 末尾补（照 execWorker 的 startExecutionWorker 模式）:

```ts
import { buildRcaWorker } from './rcaQueue.js';

let _worker: import('bullmq').Worker<RcaJob> | null = null;

/** API 进程启动时调用；无 redis 时降级 inline（enqueue 已兜），不建 worker。 */
export async function startRcaWorker(): Promise<void> {
  if (!process.env.REDIS_URL) {
    logger.warn('REDIS_URL not set; rca queue disabled (inline)');
    return;
  }
  try {
    _worker = buildRcaWorker(processRcaJob);
    _worker.on('ready', () => logger.info('rca worker ready'));
    _worker.on('error', (err) => logger.warn({ err: err.message }, 'rca worker error'));
    _worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err: err.message }, 'rca job failed'));
    logger.info('rca worker started');
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'rca worker init failed; continuing inline');
    _worker = null;
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd apps/api && npx vitest run test/rca-worker.test.ts test/space-session.test.ts
```
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/scheduler/rcaWorker.ts apps/api/src/index.ts apps/api/test/rca-worker.test.ts
git commit -m "feat(rca): worker 编排——每次运行一个 rca 线程,注入失败清单,幂等+守卫"
```

---

### Task 6: 超时护栏测试（驱动 runWithTimeout 兜底）

**Files:**
- Create: `apps/api/test/rca-worker-timeout.test.ts`

Task 5 已实现 runWithTimeout；本任务补行为锁定测试（env 须在动态 import 前设置）。

- [ ] **Step 1: 写测试**

```ts
/** 超时护栏:RCA_TIMEOUT_MS 到点 steer 收尾,宽限期到 abort + 未落库行兜底 timeout。 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  delete process.env.REDIS_URL;
  process.env.RCA_TIMEOUT_MS = '200';   // 必须在动态 import rcaWorker 之前
  process.env.RCA_GRACE_MS = '200';
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

afterEach(async () => {
  const { resetSpaceSessions } = await import('../src/pi/space/session.js');
  resetSpaceSessions();
  await pool.query("DELETE FROM ai_threads WHERE purpose = 'rca'");
});

describe('rca 超时兜底', () => {
  it('prompt 挂死 → 超时 steer → abort,未分析行写 status=timeout', async () => {
    const { projectId, groupId, versionId } = await seedProject(pool);
    const r = await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy, rca_enabled, failed_cases)
       VALUES (gen_random_uuid(), $1, 'failed', 'run_all', true, 1) RETURNING id`,
      [projectId],
    );
    const runId = r.rows[0]!.id as string;
    await pool.query(`UPDATE execution_plans SET version_id=$1 WHERE id=(SELECT plan_id FROM plan_runs WHERE id=$2)`, [versionId, runId]);
    const c = await pool.query(
      `INSERT INTO test_cases(group_id, title, version_id) VALUES ($1, '超时用例', $2) RETURNING id`,
      [groupId, versionId],
    );
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind) VALUES ($1, $2, 1, 'failed', 'business')`,
      [runId, c.rows[0]!.id as string],
    );

    const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
    let aborted = false;
    setSpaceSessionFactory(async () => ({
      subscribe: () => () => {},
      prompt: () => new Promise<void>(() => { /* 挂死模拟 AI 长转 */ }),
      abort: () => { aborted = true; },
      dispose: () => {},
      clearQueue: () => ({ steering: [], followUp: [] }),
      isStreaming: true,
      messages: [],
    }));
    const { processRcaJob } = await import('../src/scheduler/rcaWorker.js');
    await processRcaJob({ planRunId: runId });
    expect(aborted).toBe(true);
    const rows = await pool.query('SELECT rca FROM plan_run_cases WHERE plan_run_id=$1', [runId]);
    expect((rows.rows[0]!.rca as Record<string, unknown>).status).toBe('timeout');
  }, 30_000);
});
```

- [ ] **Step 2: 跑测试**

```bash
cd apps/api && npx vitest run test/rca-worker-timeout.test.ts
```
Expected: PASS（若 FAIL，修 runWithTimeout——常见错：steer 的 Promise.race 缺 timer 清理导致进程悬挂，确认 `clearTimeout` 覆盖两个计时器）。

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/rca-worker-timeout.test.ts
git commit -m "test(rca): 超时护栏——steer 收尾/abort/timeout 行兜底"
```

---

### Task 7: defect-rca skill 内容 + seed + deploy.sh

**Files:**
- Create: `apps/api/scripts/defect-rca-content/SKILL.md`
- Create: `apps/api/scripts/seed-defect-rca.mjs`
- Create: `apps/api/test/rca-skill-seed.test.ts`
- Modify: `infra/docker/deploy.sh`（L129 skill-creator seed 块后）

- [ ] **Step 1: 写 SKILL.md**（`apps/api/scripts/defect-rca-content/SKILL.md`）

````markdown
---
name: defect-rca
description: 对失败测试用例做根因分析：先分类（系统缺陷/用例自身问题/环境问题），仅对系统缺陷结合被测系统代码仓取证，产出根因描述、代码证据与修复建议，并通过 save_rca_result 工具落库。
---

# 缺陷根因分析（defect-rca）

对计划运行产出的失败用例做根因分析。核心纪律：**先分类，后深挖；系统缺陷必须落到代码仓证据（file:line）；每个失败用例恰好调用一次 save_rca_result。**

## 输入

用户消息里有失败用例清单，每条含 `planRunCaseId`（落库主键，原样回传）、caseTitle、reportId、运行级 error、失败步骤摘要。

## 工作流（逐用例执行）

1. **取数据**：用 `query_stats`（action=report_detail，reportId 来自清单）看完整步骤时间线；步骤摘要缺失或需要更多上下文时必须补取。截图路径仅作参考，你无法读图，以文本证据为准。
2. **分类判定**（给出依据后再下结论）：
   - `case_issue` 用例自身问题：定位器失效但页面功能正常、断言条件写错、步骤顺序/前置数据不成立、用例依赖了偶现时序。特征：换一个正确选择器/断言就能过，产品行为无异常。
   - `environment` 环境问题：服务不可达、超时、登录态失效、配置缺失、依赖三方故障。特征：错误集中在连接/超时/401/403/5xx 网关层，与具体业务功能无关。
   - `system_defect` 系统缺陷：按用例描述的操作走完，产品实际行为与需求不符（功能缺失、计算错误、状态不流转、数据丢失、权限漏洞、UI 展示错误等）。
   - `other`：证据不足无法归类（用 status=error 如实说明缺什么证据）。
3. **非系统缺陷**：直接 `save_rca_result(status=skipped, category=..., confidence=..., summary=一句话结论)`。不深挖、不写 evidence。有把握才给 high 置信；拿不准在 summary 里写明不确定点。
4. **系统缺陷深挖**（结合代码仓 `./repo`，用 repo_ls / repo_read / repo_grep）：
   a. 从失败步骤的报错信息、断言内容、操作目标定位涉及的**功能模块**（不要 grep 原始报错字符串了事——先想清楚这个失败意味着什么用户可见行为，再找实现该行为的代码）。
   b. 追调用链：入口 → 服务层 → 数据层，找到**产生错误行为的具体位置**。前端问题定位组件与状态逻辑；接口问题定位 handler 与校验；数据问题定位 SQL/迁移。
   c. 证据要求：1-5 条 `{file, lines, note}`，note 说明这行代码为什么构成根因。找不到确凿位置时降低 confidence 并在 summary 说明已排查路径。
   d. `save_rca_result(status=analyzed, category=system_defect, evidence=[...], suggestion=修复建议)`。suggestion 写修复方向（改哪里、怎么改），不写完整代码。
5. **降级**：repo 工具报「未就绪/不可用」时，先用清单+报告数据完成分类；系统缺陷证据不足的，evidence 留空、confidence=low、summary 注明「代码仓不可用，仅基于执行数据判定」。**不要因为 repo 不可用就停止处理剩余用例。**

## 收尾

全部用例处理完后发一条结案总结（≤10 行）：总数、各类数量、系统缺陷清单（一句话根因）、低置信项提醒。

## 禁止

- 一条用例调用多次 save_rca_result（写错了等工具返回错误后重调用是可以的）。
- 使用 status=timeout（系统保留）。
- 把整个文件内容贴进 summary——summary 只写根因描述，细节放 evidence.note。
````

- [ ] **Step 2: 写 seed 脚本**（`apps/api/scripts/seed-defect-rca.mjs`——复制 seed-skill-creator.mjs 全文，仅改三处：`CONTENT_DIR` 指向 `defect-rca-content`、`NAME = 'defect-rca'`、头部注释改成一句「defect-rca skill 种子：落盘目录树 + upsert 元数据；缺失才铺，改文案须手动重铺（删目录或手动 cp）。」）

- [ ] **Step 3: 写守卫测试** `apps/api/test/rca-skill-seed.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** defect-rca skill 内容守卫:frontmatter name 与目录名一致、seed 脚本指向正确内容目录。
 *  防手滑改名导致 seed 落盘目录与 DB name 不一致（pi loader 按 name=目录名发现技能）。 */
describe('defect-rca skill 内容', () => {
  it('SKILL.md frontmatter name=defect-rca 且 description 非空', async () => {
    const md = await readFile(join(__dirname, '../scripts/defect-rca-content/SKILL.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---/.exec(md);
    expect(fm).not.toBeNull();
    const name = /name:\s*(.+)/.exec(fm![1]!)?.[1]?.trim();
    expect(name).toBe('defect-rca');
    const desc = /description:\s*(.+)/.exec(fm![1]!)?.[1]?.trim() ?? '';
    expect(desc.length).toBeGreaterThan(10);
  });

  it('seed 脚本指向 defect-rca-content 且 NAME=defect-rca', async () => {
    const seed = await readFile(join(__dirname, '../scripts/seed-defect-rca.mjs'), 'utf8');
    expect(seed).toContain("defect-rca-content");
    expect(seed).toContain("'defect-rca'");
  });
});
```

- [ ] **Step 4: 跑测试**

```bash
cd apps/api && npx vitest run test/rca-skill-seed.test.ts
```
Expected: PASS。

- [ ] **Step 5: deploy.sh 接 seed**（L129 skill-creator seed 块后加）

```bash
echo "== seed defect-rca =="
docker exec "$(api_replica)" node /repo/apps/api/scripts/seed-defect-rca.mjs \
  || echo "WARN: defect-rca seed 失败，RCA 线程将看不到该技能（不影响其余功能）"
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/scripts/defect-rca-content/SKILL.md apps/api/scripts/seed-defect-rca.mjs apps/api/test/rca-skill-seed.test.ts infra/docker/deploy.sh
git commit -m "feat(rca): defect-rca skill 正文+seed(缺失才铺)+deploy 接入"
```

---

### Task 8: 报告详情回带 rca + web 类型

**Files:**
- Modify: `apps/api/src/routes/reports.ts:78-93`
- Modify: `apps/api/test/rca-enabled.test.ts`（追加 describe）
- Modify: `apps/web/src/api/client.ts`（类型 + patch 入参）

- [ ] **Step 1: 追加失败测试**（rca-enabled.test.ts 末尾）

```ts
describe('报告详情回带 rca', () => {
  it('属于 planRunCase 的报告带出 rca;独立报告无 rca 字段', async () => {
    const { reportsRoute } = await import('../src/routes/reports.js');
    const { projectId, groupId, versionId } = await seedProject(pool);
    const r = await pool.query(
      `INSERT INTO plan_runs(plan_id, project_id, status, strategy) VALUES (gen_random_uuid(), $1, 'failed', 'run_all') RETURNING id`,
      [projectId],
    );
    const runId = r.rows[0]!.id as string;
    const c = await pool.query(
      `INSERT INTO test_cases(group_id, title, version_id) VALUES ($1, '带RCA用例', $2) RETURNING id`,
      [groupId, versionId],
    );
    const caseId = c.rows[0]!.id as string;
    const rep = await pool.query(
      `INSERT INTO reports(case_id, status, step_results) VALUES ($1, 'failed', '[]'::jsonb) RETURNING id`,
      [caseId],
    );
    const reportId = rep.rows[0]!.id as string;
    await pool.query(
      `INSERT INTO plan_run_cases(plan_run_id, case_id, "order", status, step_kind, report_id, rca) VALUES ($1, $2, 1, 'failed', 'business', $3, $4::jsonb)`,
      [runId, caseId, reportId, JSON.stringify({ status: 'analyzed', category: 'system_defect', confidence: 'high', summary: '根因X' })],
    );
    // 挂路由（本文件 app 未挂 reports，动态建一个）
    const { default: express } = await import('express');
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const { userId, username, orgId, orgPath } = await seedOrg(pool);
    const { managerUserOf } = await import('./helpers/auth.js');
    const app2 = express();
    app2.use(express.json());
    app2.use('/api', (req: import('express').Request & { user?: unknown }, _res, next) => {
      req.user = managerUserOf(userId, username, orgId, orgPath);
      next();
    });
    app2.use('/api/reports', reportsRoute);
    app2.use(errorHandler);
    const linked = await request(app2).get(`/api/reports/${reportId}`);
    expect(linked.status).toBe(200);
    expect(linked.body.planRunId).toBe(runId);
    expect(linked.body.rca.summary).toBe('根因X');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/api && npx vitest run test/rca-enabled.test.ts
```
Expected: 新 describe FAIL（body.rca 为 undefined）。

- [ ] **Step 3: 实现 reports.ts**

prcRows 的 select 加 `rca: planRunCases.rca`：

```ts
  const prcRows = await db
    .select({ planRunId: planRunCases.planRunId, reportId: planRunCases.reportId, reportIds: planRunCases.reportIds, caseId: planRunCases.caseId, rca: planRunCases.rca })
    .from(planRunCases)
    .where(eq(planRunCases.caseId, report.caseId))
    .limit(50);
```

末段响应带上（无 link 分支不动）：

```ts
  res.json(await attachCreator({ ...report, planRunId: link.planRunId, planId: planRun?.planId ?? null, rca: link.rca ?? null }));
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/api && npx vitest run test/rca-enabled.test.ts test/reports.test.ts
```

- [ ] **Step 5: web 类型**（`apps/web/src/api/client.ts`）

`ExecutionPlan` 前新增：

```ts
export interface RcaEvidence { file: string; lines?: string; note?: string }
export interface RcaResult {
  status: 'analyzed' | 'skipped' | 'timeout' | 'error';
  category: 'system_defect' | 'case_issue' | 'environment' | 'other';
  confidence?: 'high' | 'medium' | 'low';
  summary: string;
  evidence?: RcaEvidence[];
  suggestion?: string;
  analyzedAt?: string;
  threadId?: string;
}
```

- `ExecutionPlan` 加 `rcaEnabled?: boolean;`
- `PlanRunDetail.cases[]` 元素加 `rca?: RcaResult | null;`
- `Report` 接口加 `rca?: RcaResult | null; planRunId?: string | null;`
- `plans.patch` body 的 Partial 联合里加 `rcaEnabled: boolean;`

- [ ] **Step 6: 验证 + Commit**

```bash
cd apps/web && npx tsc --noEmit
```

```bash
git add apps/api/src/routes/reports.ts apps/api/test/rca-enabled.test.ts apps/web/src/api/client.ts
git commit -m "feat(rca): 报告详情回带 rca + web 类型与 patch 入参"
```

---

### Task 9: 前端 UI（开关/RCA 区块/文案）

**Files:**
- Create: `apps/web/src/components/RcaBlock.tsx`
- Modify: `apps/web/src/pages/PlanDetail.tsx`（L430 `)}` 后、L431 `</div>` 前）
- Modify: `apps/web/src/pages/PlanRunDetail.tsx`（L151 `c.error` 行后）
- Modify: `apps/web/src/pages/ReportDetail.tsx`
- Modify: `apps/web/src/i18n/locales/{zh-CN,en-US}/{plans,reports}.json`

- [ ] **Step 1: RcaBlock 组件**（两页共用；PlanRunDetail 传 threadJump 显示跳转按钮）

```tsx
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import Button from './ui/Button';
import type { RcaResult } from '../api/client';

/** RCA 分类徽章配色:系统缺陷红/环境黄/用例问题与其他灰。 */
const CATEGORY_STYLE: Record<RcaResult['category'], { bg: string; fg: string }> = {
  system_defect: { bg: 'var(--destructive-soft, var(--destructive))', fg: 'var(--destructive)' },
  environment: { bg: 'var(--warning-soft)', fg: 'var(--warning)' },
  case_issue: { bg: 'var(--muted)', fg: 'var(--muted-foreground)' },
  other: { bg: 'var(--muted)', fg: 'var(--muted-foreground)' },
};

/** 根因分析展示块:PlanRunDetail 失败行与 ReportDetail 共用。
 *  timeout/error 只显示状态行;skipped 显示一句话结论;analyzed 全量(徽章/摘要/证据/建议/线程跳转)。 */
export default function RcaBlock({ rca, threadJump }: { rca: RcaResult; threadJump?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (rca.status === 'timeout') {
    return <div className="mt-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('reports:rca.statusTimeout')}</div>;
  }
  if (rca.status === 'error') {
    return <div className="mt-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('reports:rca.statusError')}: {rca.summary}</div>;
  }
  const style = CATEGORY_STYLE[rca.category];
  return (
    <div className="mt-1.5 rounded-[var(--radius-sm)] px-3 py-2 text-[12px]" style={{ background: 'var(--muted-soft, var(--muted))' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-semibold px-2 py-[1px] rounded-full" style={{ background: style.bg, color: style.fg }}>
          {t(`reports:rca.category.${rca.category}`)}
        </span>
        {rca.confidence && <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t(`reports:rca.confidence.${rca.confidence}`)}</span>}
        <span className="flex-1" />
        {threadJump && rca.threadId && (
          <Button variant="ghost" size="sm" onClick={() => navigate('assistant')} title={t('reports:rca.openThread')}>
            <Icon name="sparkles" size={12} />
            {t('reports:rca.openThread')}
          </Button>
        )}
      </div>
      <div className="mt-1" style={{ color: 'var(--foreground)' }}>{rca.summary}</div>
      {(rca.evidence?.length ?? 0) > 0 && (
        <div className="mt-1.5">
          <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('reports:rca.evidence')}</div>
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {(rca.evidence ?? []).map((ev, i) => (
              <li key={i} className="font-mono text-[11px]" style={{ color: 'var(--foreground)' }}>
                {ev.file}{ev.lines ? `:${ev.lines}` : ''}{ev.note ? ` — ${ev.note}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {rca.suggestion && (
        <div className="mt-1.5 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          <span style={{ color: 'var(--foreground)' }}>{t('reports:rca.suggestion')}</span>：{rca.suggestion}
        </div>
      )}
    </div>
  );
}
```

注：`navigate('assistant')` 相对路径基于当前路由（`/p/:projectId/v/:versionId/reports/...`）不成立——改为完整路径：PlanRunDetail/ReportDetail 里已有 `projectId`/`versionId` params。给 RcaBlock 加参 `assistantPath: string`，调用方传 `` `/p/${projectId}/v/${versionId}/assistant` ``。实现时以此为准（上面 `navigate('assistant')` 仅示意）。

- [ ] **Step 2: PlanDetail 开关**（L430 的 `)}` 之后插入）

```tsx
            <div className="mt-4 hairline-top pt-3">
              <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                <input
                  type="checkbox"
                  checked={plan.rcaEnabled ?? false}
                  disabled={patchPlan.isPending}
                  onChange={(e) => patchPlan.mutate({ rcaEnabled: e.target.checked })}
                />
                {t('plans:enableRca')}
              </label>
              <div className="mt-1 pl-6 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('plans:enableRcaHint')}</div>
            </div>
```

- [ ] **Step 3: PlanRunDetail 失败行**（L151 `{c.error && ...}` 之后加）

```tsx
                    {c.status === 'failed' && c.rca && <RcaBlock rca={c.rca} threadJump assistantPath={`/p/${projectId}/v/${versionId}/assistant`} />}
```
import 区加 `import RcaBlock from '../components/RcaBlock';`

- [ ] **Step 4: ReportDetail 区块**（概览区（`data.summary` 附近）之后、步骤时间线之前插入；具体锚点：summary 卡片的闭合 `</div>` 后）

```tsx
  const rca = (data as { rca?: RcaResult | null }).rca ?? null;
```
（放 `const stepResults = ...` 之前；页面顶部 import `RcaBlock` 与 `RcaResult` 类型。）渲染：

```tsx
        {rca && (
          <div className="shrink-0 bg-card border rounded-[var(--radius-md)] p-4">
            <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-2" style={{ color: 'var(--muted-foreground)' }}>{t('reports:rca.title')}</div>
            <RcaBlock rca={rca} threadJump assistantPath={`/p/${projectId}/v/${versionId}/assistant`} />
          </div>
        )}
```
ReportDetail 已有 `projectId`/`versionId` params（确认：页面从报告路由进入，params 若缺则从 report.planRunId 链路取——实现时以页面现有 params 为准；都没有就从 `useParams` 补，报告路由挂在版本空间下有这两个参数）。

- [ ] **Step 5: 文案**

`zh-CN/plans.json` 追加：

```json
  "enableRca": "失败根因分析（AI）",
  "enableRcaHint": "计划运行结束后，AI 助手自动分析失败用例：判定为系统缺陷的结合代码仓给出根因与修复建议；用例自身/环境问题只记录一句结论。",
```

`zh-CN/reports.json` 追加：

```json
  "rca": {
    "title": "根因分析",
    "statusTimeout": "分析超时，未完成",
    "statusError": "分析失败",
    "openThread": "查看分析线程",
    "evidence": "代码证据",
    "suggestion": "修复建议",
    "category": { "system_defect": "系统缺陷", "case_issue": "用例问题", "environment": "环境问题", "other": "其他" },
    "confidence": { "high": "高置信", "medium": "中置信", "low": "低置信" }
  },
```

`en-US` 两文件给同 key 英文（enableRca: "Failure root cause analysis (AI)"；hint 一句英文；rca.title "Root Cause Analysis"，category: System defect / Case issue / Environment / Other，confidence: High / Medium / confidence low "Low confidence"，evidence "Code evidence"，suggestion "Suggested fix"，openThread "View analysis thread"，statusTimeout "Analysis timed out"，statusError "Analysis failed"）。

- [ ] **Step 6: 验证**

```bash
cd apps/web && npx tsc --noEmit && npm run build
```
Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/RcaBlock.tsx apps/web/src/pages/PlanDetail.tsx apps/web/src/pages/PlanRunDetail.tsx apps/web/src/pages/ReportDetail.tsx apps/web/src/i18n/locales
git commit -m "feat(rca): 前端——计划开关/运行详情与报告的 RCA 区块/文案"
```

---

### Task 10: 全量验证与手动链路

- [ ] **Step 1: api 全量相关测试**

```bash
cd apps/api && npm run typecheck && npx vitest run test/rca-enabled.test.ts test/rca-save-tool.test.ts test/rca-trigger.test.ts test/rca-worker.test.ts test/rca-worker-timeout.test.ts test/rca-skill-seed.test.ts test/plans.test.ts test/exec-queue.test.ts test/space-router.test.ts test/space-session.test.ts test/reports.test.ts
```
Expected: PASS（除已知基线噪声）。

- [ ] **Step 2: lint**

```bash
cd apps/api && npm run lint
```
Expected: 无新增告警（未使用变量等就地修掉）。

- [ ] **Step 3: dev 手动链路**（dev 环境须带 `ENCRYPTION_KEY`+`CHROMIUM_PATH`；DB itest-pg admin/Itest@2026）

1. `psql` 手动补列（dev 无自动 push）：执行 Task 1 Step 2 的五条 DO 语句指向 itest 库；或 `npx drizzle-kit push`（若非交互卡住则手跑 SQL）。
2. seed：`DATABASE_URL=... PI_DATA_DIR=./.data node scripts/seed-defect-rca.mjs`，验证 `.data/skills/defect-rca/SKILL.md` 落盘、`assistant_skills` 有行。
3. Web 建计划勾「失败根因分析」，用 FORCE_FAIL 不可用（那是测试钩子）——造一个必败用例（指向不存在元素），一键执行。
4. 验证点：执行结束后「AI 助手」出现「根因分析 · …」线程；线程里有分类过程与结案总结；计划运行详情失败行出现 RCA 区块；报告详情出现根因分析卡片；「查看分析线程」跳助手页。

- [ ] **Step 4: Commit（如有零散修正）**

```bash
git add -A && git commit -m "chore(rca): 全量验证修正" --allow-empty
```

---

## 自查记录

- **Spec 覆盖**：开关（T1/T2/T9）、快照（T2）、触发（T4）、编排/会话/幂等/守卫（T5）、超时护栏（T5/T6）、skill+seed（T7）、save_rca_result 工具与 purpose 闸门（T3）、结果结构（T3 落库 schema=T2 的 jsonb 定义）、报告回带（T8）、前端两页+线程跳转（T9）、rca.status=error 的产生者=工具枚举放行（T3）、timeout 仅 worker（T3 拒绝 + T6 兜底）。✅
- **类型一致**：`RcaJob`（rcaQueue 定义、worker/index 使用）、`RcaResult`（client.ts 定义、RcaBlock/页面使用）、`purpose`（context/session/tools/index 一致）。✅
- **已知风险**：pi 会话在长转中 `sendSpaceUserMessage` 的 Promise.race 放弃后，残留 turn 由 steer/abort 收束（T6 锁定）；`ai_threads.purpose` 不加 FK（schedule_id 先例）。
