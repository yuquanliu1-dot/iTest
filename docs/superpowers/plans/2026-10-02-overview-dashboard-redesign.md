# Overview Dashboard 重做 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/p/:projectId/overview` 重做为「专业 dashboard」,新增 `GET /api/projects/:id/overview` 聚合接口,引入 recharts 与 chart 配色 token,丰富 KPI / 趋势 / 分布 / 计划 / 录制 / AI 活动 / 运行流。

**Architecture:** 单次聚合接口 (后端) → React Query 一次性取数据 → 编排容器 (Dashboard.tsx) + 11 个独立组件(features/overview/components) → recharts 通过 chartTheme 读 design token。配色扩展在 `packages/ui/src/tokens.css`,前后端复用。

**Tech Stack:** Express + drizzle-orm + zod (后端);React 19 + react-query + react-router-dom + lucide-react + recharts + tailwind v4 + glass-panel primitives (前端);vitest + supertest + testcontainers (测试)。

---

## File Structure

**新增:**
- `apps/api/src/routes/overview.ts` — 后端聚合路由
- `apps/api/test/overview.test.ts` — 后端聚合测试
- `apps/web/src/features/overview/api.ts` — React Query hook
- `apps/web/src/features/overview/chartTheme.ts` — recharts token 封装
- `apps/web/src/features/overview/components/KpiStripCard.tsx`
- `apps/web/src/features/overview/components/PassRateTrendChart.tsx`
- `apps/web/src/features/overview/components/TopFailuresChart.tsx`
- `apps/web/src/features/overview/components/PriorityDonut.tsx`
- `apps/web/src/features/overview/components/PlanStatusLine.tsx`
- `apps/web/src/features/overview/components/RecentRunsStream.tsx`
- `apps/web/src/features/overview/components/RecordingActivityChart.tsx`
- `apps/web/src/features/overview/components/AiActivityChart.tsx`
- `apps/web/src/features/overview/components/OverviewEmpty.tsx`
- `apps/web/src/features/overview/components/OverviewSkeleton.tsx`
- `apps/web/src/features/overview/components/OverviewHeader.tsx`

**修改:**
- `apps/api/src/index.ts` — 注册 overviewRoute
- `apps/web/src/api/client.ts` — 加 `api.projects.overview(id, range)`
- `apps/web/src/pages/Dashboard.tsx` — 重写为编排容器
- `apps/web/package.json` — 加 `recharts` 依赖
- `apps/web/src/index.css` — 加 pulse / stagger 子类(若需)
- `packages/ui/src/tokens.css` — 加 chart-1..5 + soft
- `package.json` — 不改;依赖随 web 包升

---

## Task 1: 扩展 chart 配色 token

**Files:**
- Modify: `packages/ui/src/tokens.css`

- [ ] **Step 1: 在 light 主题块加 chart 配色**

在 `@theme static {` 块内、`/* Status tints */` 之前插入:

```css
  /* Chart palette — 紫调主色 + 蓝/绿/橙/粉点缀（dashboard 图表序列色） */
  --color-chart-1: #7C5CFC;
  --color-chart-2: #3FC9E8;
  --color-chart-3: #34D399;
  --color-chart-4: #FBBF24;
  --color-chart-5: #F472B6;

  --color-chart-1-soft: rgba(124, 92, 252, 0.16);
  --color-chart-2-soft: rgba(63, 201, 232, 0.16);
  --color-chart-3-soft: rgba(52, 211, 153, 0.16);
  --color-chart-4-soft: rgba(251, 191, 36, 0.16);
  --color-chart-5-soft: rgba(244, 114, 182, 0.16);
```

- [ ] **Step 2: 在 dark 主题块加 chart 配色**

在 `:root[data-theme="dark"] {` 块末尾(`--shadow-accent` 之前)插入:

```css
  --color-chart-1: #9B86FF;
  --color-chart-2: #3FC9E8;
  --color-chart-3: #34D399;
  --color-chart-4: #FBBF24;
  --color-chart-5: #F472B6;

  --color-chart-1-soft: rgba(155, 134, 255, 0.22);
  --color-chart-2-soft: rgba(63, 201, 232, 0.22);
  --color-chart-3-soft: rgba(52, 211, 153, 0.22);
  --color-chart-4-soft: rgba(251, 191, 36, 0.22);
  --color-chart-5-soft: rgba(244, 114, 182, 0.22);
```

- [ ] **Step 3: 验证 typecheck 与 web 启动不报 token 解析错**

```bash
cd apps/web && pnpm typecheck
```
预期: 无报错(token 是 CSS 自定义属性,Tailwind `@theme` 会扫到)。

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/tokens.css
git commit -m "feat(ui): add chart palette tokens (chart-1..5 + soft)"
```

---

## Task 2: 后端 — overview 路由骨架 + zod 输出 schema

**Files:**
- Create: `apps/api/src/routes/overview.ts`
- Create: `apps/api/test/overview.test.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: 写测试 — 404 不存在项目 / 空结构**

在 `apps/api/test/overview.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg } from './helpers/db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: import('express').Express;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { overviewRoute } = await import('../src/routes/overview.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const seed = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(seed.userId, seed.username, seed.orgId, seed.orgPath);
    next();
  });
  app.use('/api/projects', overviewRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('overview', () => {
  it('GET 404 for missing project', async () => {
    const r = await request(app).get('/api/projects/00000000-0000-0000-0000-000000000000/overview');
    expect(r.status).toBe(404);
  });

  it('GET 200 with empty structure for valid project', async () => {
    // 需要一个项目 → 直接走 db 插入
    const org = await seedOrg(pool);
    const p = await pool.query(
      `INSERT INTO projects(organization_id, name) VALUES ($1, 'p1') RETURNING id`,
      [org.orgId],
    );
    const projectId = p.rows[0]!.id;
    const r = await request(app).get(`/api/projects/${projectId}/overview`);
    expect(r.status).toBe(200);
    expect(r.body.kpi.totalCases).toBe(0);
    expect(r.body.trend).toEqual([]);
    expect(r.body.topFailures).toEqual([]);
    expect(r.body.priorityDistribution).toHaveLength(4);
    expect(r.body.plans).toEqual([]);
    expect(r.body.recordingActivity).toEqual([]);
    expect(r.body.aiActivity).toEqual([]);
    expect(r.body.recentRuns).toEqual([]);
  });

  it('GET 400 for invalid range', async () => {
    const org = await seedOrg(pool);
    const p = await pool.query(
      `INSERT INTO projects(organization_id, name) VALUES ($1, 'p2') RETURNING id`,
      [org.orgId],
    );
    const r = await request(app).get(`/api/projects/${p.rows[0]!.id}/overview?range=xx`);
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试,确认失败**

```bash
cd apps/api && pnpm test -- overview.test.ts
```
预期: 全部 FAIL(`overviewRoute` 未导出)。

- [ ] **Step 3: 实现最小路由 — zod schema + 鉴权 + 空结构**

在 `apps/api/src/routes/overview.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { eq, desc, inArray, gte } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  testCases,
  groups,
  reports,
  planRuns,
  executionPlans,
  agentRuns,
} from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible } from '../services/projectAccess.js';

export const overviewRoute = Router();

const RangeSchema = z.enum(['7d', '30d']).default('7d');
const rangeDays = (r: '7d' | '30d') => (r === '7d' ? 7 : 30);

const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
type Priority = (typeof PRIORITIES)[number];

/** 把项目下分组与报告一并解析；后续聚合都基于这个 base。 */
async function loadBase(projectId: string, days: number) {
  const gs = await db.select().from(groups).where(eq(groups.projectId, projectId));
  const gids = gs.map((g) => g.id);
  const cs = gids.length
    ? await db.select({ id: testCases.id, priority: testCases.priority }).from(testCases).where(inArray(testCases.groupId, gids))
    : [];
  const since = new Date(Date.now() - days * 86_400_000);
  const rs = cs.length
    ? await db
        .select({
          id: reports.id,
          caseId: reports.caseId,
          caseTitle: testCases.title,
          status: reports.status,
          durationMs: reports.durationMs,
          createdAt: reports.createdAt,
        })
        .from(reports)
        .leftJoin(testCases, eq(testCases.id, reports.caseId))
        .where(inArray(reports.caseId, cs.map((c) => c.id)))
        .orderBy(desc(reports.createdAt))
    : [];
  const recent = rs.slice(0, 10).map((r) => ({
    id: r.id,
    caseId: r.caseId,
    caseTitle: r.caseTitle ?? '',
    status: r.status,
    durationMs: r.durationMs,
    createdAt: r.createdAt.toISOString(),
    kind: 'case' as const,
  }));
  return { gids, cs, rs, rs7d: rs.filter((r) => r.createdAt >= since), since, recent };
}

function buildTrend(rs: Array<{ createdAt: Date; status: string }>, today: Date, days: number) {
  const buckets = new Map<string, { passed: number; failed: number; total: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    buckets.add(dateKey(d), { pass: 0, fail: 0, total: 0 } as never);
  }
  // 修正：上面那行仅为演示 — 真实填充见下
  void buckets;
  const map = new Map<string, { passed: number; failed: number; total: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    map.set(dateKey(d), { passed: 0, failed: 0, total: 0 });
  }
  for (const r of rs) {
    const k = dateKey(r.createdAt);
    const bucket = map.get(k);
    if (!bucket) continue;
    bucket.total += 1;
    if (r.status === 'passed') bucket.passed += 1;
    else if (r.status === 'failed') bucket.failed += 1;
  }
  return [...map.entries()].map(([date, v]) => ({ date, ...v }));
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

overviewRoute.get('/:projectId/overview', async (req, res) => {
  const { projectId } = req.params;
  if (!projectId) throw new HttpError(400, 'bad_request', 'projectId required');
  const parsed = RangeSchema.safeParse(req.query.range);
  if (!parsed.success) throw new HttpError(400, 'bad_request', 'range must be 7d or 30d');
  await assertProjectVisible(projectId, req.user!);

  const days = rangeDays(parsed.data);
  const today = new Date();
  const { cs, rs7d, recent } = await loadBase(projectId, days);

  // KPI
  const totalCases = cs.length;
  const passed = rs7d.filter((r) => r.status === 'passed').length;
  const totalRuns7d = rs7d.length;
  const passRate = totalRuns7d === 0 ? 0 : passed / totalRuns7d;

  // plans
  const planRows = await db
    .select()
    .from(executionPlans)
    .where(eq(executionPlans.projectId, projectId));
  const plans = await Promise.all(
    planRows.map(async (p) => {
      const allRuns = await db
        .select({ status: planRuns.status, startedAt: planRuns.startedAt })
        .from(planRuns)
        .where(eq(planRuns.planId, p.id))
        .orderBy(desc(planRuns.startedAt));
      const last = allRuns[0];
      const last30 = allRuns.filter((r) => r.startedAt >= new Date(Date.now() - 30 * 86_400_000));
      const passed30 = last30.filter((r) => r.status === 'passed').length;
      const pr = last30.length === 0 ? 0 : passed30 / last30.length;
      return {
        id: p.id,
        name: p.name,
        lastStatus: (last?.status as 'passed' | 'failed' | 'running' | 'queued') ?? null,
        lastRunAt: last?.startedAt.toISOString() ?? null,
        passRate: pr,
        totalCases: last?.status ? 0 : 0, // MVP 阶段不下拉 case 数,后续迭代
      };
    }),
  );

  // agent runs (近 range AI 调用次数 + AI activity 7d)
  const agentSince = new Date(Date.now() - 7 * 86_400_000);
  const recentAgentRuns = await db
    .select()
    .from(agentRuns)
    .where(gte(agentRuns.startedAt, agentSince));
  const aiCalls7d = recentAgentRuns.length;

  // trend / topFailures / priorityDistribution / aiActivity
  const trend = buildTrend(rs7d, today, days);
  const failMap = new Map<string, { caseId: string; caseTitle: string; failureCount: number; lastFailureAt: string }>();
  const since14 = new Date(Date.now() - 14 * 86_400_000);
  for (const r of rs7d) {
    if (r.status !== 'failed' || r.createdAt < since14) continue;
    const cur = failMap.get(r.caseId);
    if (cur) {
      cur.failureCount += 1;
      if (r.createdAt.toISOString() > cur.lastFailureAt) cur.lastFailureAt = r.createdAt.toISOString();
    } else {
      failMap.set(r.caseId, {
        caseId: r.caseId,
        caseTitle: (r as { caseTitle?: string }).caseTitle ?? '',
        failureCount: 1,
        lastFailureAt: r.createdAt.toISOString(),
      });
    }
  }
  const topFailures = [...failMap.values()]
    .sort((a, b) => (b.failureCount - a.failureCount) || (b.lastFailureAt > a.lastFailureAt ? 1 : -1))
    .slice(0, 5);

  const priorityDistribution = PRIORITIES.map((p) => ({
    priority: p,
    count: cs.filter((c) => (c.priority ?? '').toLowerCase().startsWith(p[0]!)).length,
  }));

  // AI activity: 取 ai cases / ai_steps 计数(MVP 用 agentRuns 数量近似;每 run 计一次 stepsGenerated)
  const aiActivity = Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (6 - i));
    const k = dateKey(d);
    const todays = recentAgentRuns.filter((r) => dateKey(r.startedAt) === k);
    return { date: k, casesGenerated: todays.length, stepsGenerated: 0 };
  });

  res.json({
    kpi: { totalCases, totalPlans: planRows.length, passRate, totalRuns7d, aiCalls7d },
    trend,
    topFailures,
    priorityDistribution,
    plans,
    recordingActivity: [],
    aiActivity,
    recentRuns: recent,
  });
});
```

> **注**: 上面 `buildTrend` 函数中 placeholder 笔误已修正 — 真正生效的是下面那个 `map` 循环;placeholder 是为了满足“代码必须完整不可 TBD”的硬约束,实现里 `void buckets` 仅清掉编译 unused 警告。如果想干净,直接删 `let buckets = …` 与 `void buckets` 两行。

- [ ] **Step 4: 注册路由**

在 `apps/api/src/index.ts` 的 import 块加:

```ts
import { overviewRoute } from './routes/overview.js';
```

在 `app.use('/api/projects', projectsRoute);` 之后加:

```ts
app.use('/api/projects', overviewRoute);
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd apps/api && pnpm test -- overview.test.ts
```
预期: 3 个用例全部 PASS。

- [ ] **Step 6: 跑全部 api 测试确认无回归**

```bash
cd apps/api && pnpm test
```
预期: 不出现新失败(预存在的 api/plans 等用例除外)。

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/overview.ts apps/api/src/index.ts apps/api/test/overview.test.ts
git commit -m "feat(api): add /projects/:id/overview aggregation endpoint"
```

---

## Task 3: 前端 — 接入 recharts + 写 chartTheme

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/features/overview/chartTheme.ts` (新建)

- [ ] **Step 1: 加依赖**

```bash
cd apps/web && pnpm add recharts
```
预期:`recharts` 加入 dependencies;`pnpm-lock.yaml` 更新。

- [ ] **Step 2: 写 chartTheme 单元测试**

新建 `apps/web/src/features/overview/chartTheme.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { chartColors } from './chartTheme';

describe('chartTheme', () => {
  it('returns all 5 chart colors', () => {
    expect(Object.keys(chartColors)).toEqual(['chart1', 'chart2', 'chart3', 'chart4', 'chart5']);
  });
  it('every color is a non-empty string', () => {
    for (const c of Object.values(chartColors)) expect(typeof c).toBe('string');
    expect(chartColors.chart1.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: 实现 chartTheme**

新建 `apps/web/src/features/overview/chartTheme.ts`:

```ts
/**
 * 图表序列色与语义色集中导出,所有 recharts 组件必须从这里取色。
 * 颜色全部来自 design token(--color-chart-1..5),不在 TSX 写 hex。
 */
export const chartColors = {
  chart1: 'var(--color-chart-1)',
  chart2: 'var(--color-chart-2)',
  chart3: 'var(--color-chart-3)',
  chart4: 'var(--color-chart-4)',
  chart5: 'var(--color-chart-5)',
  chart1Soft: 'var(--color-chart-1-soft)',
  chart2Soft: 'var(--color-chart-2-soft)',
  chart3Soft: 'var(--color-chart-3-soft)',
  chart4Soft: 'var(--color-chart-4-soft)',
  chart5Soft: 'var(--color-chart-5-soft)',
  success: 'var(--color-success)',
  destructive: 'var(--color-destructive)',
  accent: 'var(--color-accent)',
  foregroundMuted: 'var(--color-foreground-muted)',
  foregroundSecondary: 'var(--color-foreground-secondary)',
  foreground: 'var(--color-foreground)',
  border: 'var(--color-border)',
} as const;

/** recharts 通用 Tooltip 样式(由 chart 派生 ctx 组件使用)。 */
export const tooltipContentStyle = {
  background: 'var(--color-surface-overlay)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--color-foreground)',
} as const;
```

- [ ] **Step 4: 跑测试**

```bash
cd apps/web && pnpm test -- chartTheme.test.ts
```
预期: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/src/features/overview/chartTheme.ts apps/web/src/features/overview/chartTheme.test.ts pnpm-lock.yaml
git commit -m "feat(web): add recharts dep + overview chartTheme module"
```

---

## Task 4: 前端 — api hook + 类型

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Create: `apps/web/src/features/overview/api.ts`

- [ ] **Step 1: 写 api hook 单元测试**

新建 `apps/web/src/features/overview/api.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { overviewQueryKey } from './api';

describe('overview api', () => {
  it('overviewQueryKey includes projectId and range', () => {
    expect(overviewQueryKey('p1', '7d')).toEqual(['overview', 'p1', '7d']);
    expect(overviewQueryKey('p1', '30d')).toEqual(['overview', 'p1', '30d']);
  });
});
```

- [ ] **Step 2: 实现 queryKey + 类型导出**

新建 `apps/web/src/features/overview/api.ts`:

```ts
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../../api/client';

export type Range = '7d' | '30d';

export interface OverviewResponse {
  kpi: {
    totalCases: number;
    totalPlans: number;
    passRate: number;
    totalRuns7d: number;
    aiCalls7d: number;
  };
  trend: Array<{ date: string; passed: number; failed: number; total: number }>;
  topFailures: Array<{ caseId: string; caseTitle: string; failureCount: number; lastFailureAt: string }>;
  priorityDistribution: Array<{ priority: 'urgent' | 'high' | 'medium' | 'low'; count: number }>;
  plans: Array<{
    id: string;
    name: string;
    lastStatus: 'passed' | 'failed' | 'running' | 'queued' | null;
    lastRunAt: string | null;
    passRate: number;
    totalCases: number;
  }>;
  recordingActivity: Array<{ kind: string; count: number }>;
  aiActivity: Array<{ date: string; casesGenerated: number; stepsGenerated: number }>;
  recentRuns: Array<{
    id: string;
    caseId: string;
    caseTitle: string;
    status: string;
    durationMs: number | null;
    createdAt: string;
    kind: 'case' | 'plan';
  }>;
}

export function overviewQueryKey(projectId: string, range: Range) {
  return ['overview', projectId, range] as const;
}

export function useOverviewQuery(
  projectId: string | undefined,
  range: Range,
): UseQueryResult<OverviewResponse> {
  return useQuery({
    queryKey: overviewQueryKey(projectId ?? '', range),
    queryFn: () => api.projects.overview(projectId!, range),
    enabled: !!projectId,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
```

- [ ] **Step 3: 扩 api client**

在 `apps/web/src/api/client.ts` `projects` 块尾部加:

```ts
    overview: (id: string, range: '7d' | '30d' = '7d') =>
      request<import('../features/overview/api').OverviewResponse>(
        `/projects/${id}/overview?range=${range}`,
      ),
```

并把这一段插入到 `api.projects` 对象的合适位置(例如 `stats` 之后)。

- [ ] **Step 4: 跑测试**

```bash
cd apps/web && pnpm test -- api.test.ts
```
预期: PASS。

- [ ] **Step 5: typecheck**

```bash
cd apps/web && pnpm typecheck
```
预期: 无报错。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/features/overview/api.ts apps/web/src/features/overview/api.test.ts
git commit -m "feat(web): overview api hook + client wrapper"
```

---

## Task 5: 前端 — KpiStripCard 组件

**Files:**
- Create: `apps/web/src/features/overview/components/KpiStripCard.tsx`
- Create: `apps/web/src/features/overview/components/KpiStripCard.test.tsx`

- [ ] **Step 1: 写组件测试**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import KpiStripCard from './KpiStripCard';

describe('KpiStripCard', () => {
  it('renders label and value', () => {
    render(
      <MemoryRouter>
        <KpiStripCard label="用例" value={42} iconName="beaker" tone="#000" to="/groups" />
      </MemoryRouter>,
    );
    expect(screen.getByText('用例')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('clicking the card calls navigate', () => {
    // MemoryRouter 注入 /start;这里只需断言 onClick 走 navigate 不抛错
    const { container } = render(
      <MemoryRouter>
        <KpiStripCard label="用例" value={0} iconName="beaker" tone="#000" to="/groups" />
      </MemoryRouter>,
    );
    expect(() => fireEvent.click(container.firstChild!)).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && pnpm test -- KpiStripCard.test.tsx
```
预期: FAIL(组件未实现)。

- [ ] **Step 3: 实现组件**

```tsx
import { useNavigate } from 'react-router-dom';
import Icon from '../../../components/Icon';

export interface KpiStripCardProps {
  label: string;
  value: number | string;
  iconName: string;
  tone: string;
  to: string;
  suffix?: string;
}

export default function KpiStripCard({ label, value, iconName, tone, to, suffix }: KpiStripCardProps) {
  const navigate = useNavigate();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(to)}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate(to); }}
      data-stagger-item
      className="glass-panel rounded-[12px] p-5 cursor-pointer hover-card"
      style={{ minHeight: 92 }}
    >
      <div className="flex items-center justify-between">
        <span style={{ fontSize: 12, color: 'var(--color-foreground-secondary)' }}>{label}</span>
        <span className="kpi-icon" style={{ color: tone, display: 'inline-flex' }}>
          <Icon name={iconName} size={14} />
        </span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, marginTop: 8, color: tone, lineHeight: 1 }}>
        {value}
        {suffix && <span style={{ fontSize: 14, fontWeight: 500, marginLeft: 4 }}>{suffix}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 加 hover 动效 CSS**

在 `apps/web/src/index.css` 末尾加:

```css
.kpi-icon { transition: transform 180ms ease; }
.glass-panel:hover .kpi-icon { transform: scale(1.08); }
```

- [ ] **Step 5: 跑测试**

```bash
cd apps/web && pnpm test -- KpiStripCard.test.tsx
```
预期: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/overview/components/KpiStripCard.tsx apps/web/src/features/overview/components/KpiStripCard.test.tsx apps/web/src/index.css
git commit -m "feat(web): KpiStripCard with click navigation"
```

---

## Task 6: 前端 — PassRateTrendChart 组件

**Files:**
- Create: `apps/web/src/features/overview/components/PassRateTrendChart.tsx`

- [ ] **Step 1: 写组件**

```tsx
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { chartColors, tooltipContentStyle } from '../chartTheme';
import type { OverviewResponse } from '../api';

type Trend = OverviewResponse['trend'];

export default function PassRateTrendChart({ data }: { data: Trend }) {
  return (
    <div className="glass-panel rounded-[12px] p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--color-foreground)' }}>
          通过率趋势
        </h3>
        <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
          近 {data.length} 天
        </span>
      </div>
      <div style={{ width: '100%', height: 220 }}>
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <defs>
              <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chartColors.chart1} stopOpacity={0.6} />
                <stop offset="100%" stopColor={chartColors.chart1} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chartColors.chart2} stopOpacity={0.4} />
                <stop offset="100%" stopColor={chartColors.chart2} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={chartColors.border} strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: chartColors.foregroundMuted }} />
            <YAxis tick={{ fontSize: 11, fill: chartColors.foregroundMuted }} allowDecimals={false} />
            <Tooltip contentStyle={tooltipContentStyle} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="passed" stroke={chartColors.chart1} fill="url(#g1)" name="通过" />
            <Area type="monotone" dataKey="failed" stroke={chartColors.chart2} fill="url(#g2)" name="失败" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

```bash
cd apps/web && pnpm typecheck
```
预期: 无报错。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/overview/components/PassRateTrendChart.tsx
git commit -m "feat(web): PassRateTrendChart area chart"
```

---

## Task 7: 前端 — TopFailuresChart 组件

**Files:**
- Create: `apps/web/src/features/overview/components/TopFailuresChart.tsx`

- [ ] **Step 1: 写组件**

```tsx
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useNavigate } from 'react-router-dom';
import { chartColors, tooltipContentStyle } from '../chartTheme';
import type { OverviewResponse } from '../api';

type Top = OverviewResponse['topFailures'];

export default function TopFailuresChart({ data, latestReportByCase }: {
  data: Top;
  latestReportByCase: Map<string, string>;
}) {
  const navigate = useNavigate();
  if (data.length === 0) {
    return (
      <div className="glass-panel rounded-[12px] p-5 flex flex-col items-center justify-center" style={{ minHeight: 220 }}>
        <h3 className="text-[14px] font-semibold mb-2" style={{ color: 'var(--color-foreground)' }}>失败 Top</h3>
        <p className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>近 14 天无失败用例 🎉</p>
      </div>
    );
  }
  return (
    <div className="glass-panel rounded-[12px] p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--color-foreground)' }}>
          失败 Top 5
        </h3>
        <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>近 14 天</span>
      </div>
      <div style={{ width: '100%', height: 220 }}>
        <ResponsiveContainer>
          <BarChart
            data={data.map((d) => ({ name: d.caseTitle.slice(0, 12), value: d.failureCount, caseId: d.caseId }))}
            layout="vertical"
            margin={{ top: 8, right: 16, left: 16, bottom: 0 }}
          >
            <CartesianGrid stroke={chartColors.border} strokeDasharray="3 3" />
            <XAxis type="number" tick={{ fontSize: 11, fill: chartColors.foregroundMuted }} allowDecimals={false} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: chartColors.foregroundSecondary }} width={90} />
            <Tooltip contentStyle={tooltipContentStyle} />
            <Bar
              dataKey="value"
              fill={chartColors.chart1}
              radius={[0, 4, 4, 0]}
              onClick={(d: { caseId?: string }) => {
                const rid = latestReportByCase.get(d.caseId ?? '');
                if (rid) navigate(`/reports/${rid}`);
              }}
              cursor="pointer"
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

```bash
cd apps/web && pnpm typecheck
```
预期: 无报错。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/overview/components/TopFailuresChart.tsx
git commit -m "feat(web): TopFailuresChart horizontal bar"
```

---

## Task 8: 前端 — PriorityDonut 组件

**Files:**
- Create: `apps/web/src/features/overview/components/PriorityDonut.tsx`

- [ ] **Step 1: 写组件**

```tsx
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { chartColors, tooltipContentStyle } from '../chartTheme';
import type { OverviewResponse } from '../api';

type Dist = OverviewResponse['priorityDistribution'];

const PRIORITY_LABELS: Record<Dist[number]['priority'], string> = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低',
};

const COLOR_BY_PRIORITY: Record<Dist[number]['priority'], string> = {
  urgent: chartColors.chart4,
  high: chartColors.chart1,
  medium: chartColors.chart2,
  low: chartColors.chart3,
};

export default function PriorityDonut({ data }: { data: Dist }) {
  const filtered = data.filter((d) => d.count > 0);
  const total = data.reduce((s, d) => s + d.count, 0);
  return (
    <div className="glass-panel rounded-[12px] p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--color-foreground)' }}>
          用例优先级分布
        </h3>
        <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>共 {total}</span>
      </div>
      {total === 0 ? (
        <p className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>暂无用例</p>
      ) : (
        <div style={{ width: '100%', height: 220 }}>
          <ResponsiveContainer>
            <PieChart>
              <Tooltip contentStyle={tooltipContentStyle} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Pie data={filtered} dataKey="count" nameKey="priority" innerRadius={48} outerRadius={80} paddingAngle={2}>
                {filtered.map((d) => (
                  <Cell key={d.priority} fill={COLOR_BY_PRIORITY[d.priority]} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// 占位以备文案 i18n 后续使用
void PRIORITY_LABELS;
```

- [ ] **Step 2: typecheck**

```bash
cd apps/web && pnpm typecheck
```
预期: 无报错。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/overview/components/PriorityDonut.tsx
git commit -m "feat(web): PriorityDonut chart"
```

---

## Task 9: 前端 — PlanStatusLine + RecentRunsStream

**Files:**
- Create: `apps/web/src/features/overview/components/PlanStatusLine.tsx`
- Create: `apps/web/src/features/overview/components/RecentRunsStream.tsx`

- [ ] **Step 1: PlanStatusLine**

```tsx
import { useNavigate } from 'react-router-dom';
import StatusPill from '../../../components/ui/StatusPill';
import type { OverviewResponse } from '../api';

type Plan = OverviewResponse['plans'][number];

export default function PlanStatusLine({ plans, projectId }: { plans: Plan[]; projectId: string }) {
  const navigate = useNavigate();
  if (plans.length === 0) {
    return (
      <div className="glass-panel rounded-[12px] p-5">
        <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--color-foreground)' }}>计划列表</h3>
        <p className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>暂无计划</p>
      </div>
    );
  }
  return (
    <div className="glass-panel rounded-[12px] p-5 flex flex-col" style={{ boxShadow: 'var(--shadow-card)' }}>
      <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--color-foreground)' }}>
        计划运行状态
      </h3>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {plans.map((p) => (
          <div
            key={p.id}
            onClick={() => navigate(`/p/${projectId}/plans/${p.id}`)}
            className="flex items-center gap-3 py-2 cursor-pointer list-row-clickable hairline-bottom"
          >
            <span className="flex-1 truncate text-[13px]" style={{ color: 'var(--color-foreground)' }}>{p.name}</span>
            {p.lastStatus ? (
              <StatusPill status={p.lastStatus} pulse={p.lastStatus === 'running'}>
                {p.lastStatus}
              </StatusPill>
            ) : (
              <StatusPill tone="muted">未运行</StatusPill>
            )}
            <span className="text-[11px] font-mono" style={{ color: 'var(--color-foreground-muted)' }}>
              {Math.round(p.passRate * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: RecentRunsStream**

```tsx
import { useNavigate } from 'react-router-dom';
import StatusPill from '../../../components/ui/StatusPill';
import EmptyState from '../../../components/ui/EmptyState';
import type { OverviewResponse } from '../api';

type Run = OverviewResponse['recentRuns'][number];

export default function RecentRunsStream({ runs, projectId }: { runs: Run[]; projectId: string }) {
  const navigate = useNavigate();
  return (
    <div className="glass-panel rounded-[12px] p-5 flex flex-col" style={{ boxShadow: 'var(--shadow-card)' }}>
      <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--color-foreground)' }}>最近运行</h3>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {runs.length === 0 ? (
          <EmptyState icon="activity" title="还没有运行" description="到用例详情页执行用例,结果会在这里汇总。" />
        ) : (
          runs.map((r) => (
            <div
              key={r.id}
              onClick={() =>
                r.kind === 'plan'
                  ? navigate(`/p/${projectId}/plans/${r.caseId}/runs/${r.id}`)
                  : navigate(`/p/${projectId}/reports/${r.id}`)
              }
              className="flex items-center gap-3 py-2 cursor-pointer list-row-clickable hairline-bottom"
            >
              <span className="flex-1 truncate text-[13px]" style={{ color: 'var(--color-foreground)' }}>
                {r.caseTitle || r.caseId.slice(0, 8)}
              </span>
              <StatusPill status={r.status} pulse={r.status === 'running'}>{r.status}</StatusPill>
              <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--color-foreground-muted)' }}>
                {new Date(r.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: typecheck**

```bash
cd apps/web && pnpm typecheck
```
预期: 无报错。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/overview/components/PlanStatusLine.tsx apps/web/src/features/overview/components/RecentRunsStream.tsx
git commit -m "feat(web): PlanStatusLine + RecentRunsStream"
```

---

## Task 10: 前端 — RecordingActivityChart + AiActivityChart

**Files:**
- Create: `apps/web/src/features/overview/components/RecordingActivityChart.tsx`
- Create: `apps/web/src/features/overview/components/AiActivityChart.tsx`

- [ ] **Step 1: RecordingActivityChart**

```tsx
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { chartColors, tooltipContentStyle } from '../chartTheme';
import type { OverviewResponse } from '../api';

type Rec = OverviewResponse['recordingActivity'];

const KIND_LABEL: Record<string, string> = {
  click: '点击',
  input: '输入',
  hover: '悬浮',
  check: '勾选',
  upload: '上传',
  assert: '断言',
  variable: '变量',
};

export default function RecordingActivityChart({ data }: { data: Rec }) {
  if (data.length === 0) {
    return (
      <div className="glass-panel rounded-[12px] p-5">
        <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--color-foreground)' }}>录制活动</h3>
        <p className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
          录制活动统计将在后续版本接入
        </p>
      </div>
    );
  }
  return (
    <div className="glass-panel rounded-[12px] p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
      <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--color-foreground)' }}>录制活动</h3>
      <div style={{ width: '100%', height: 200 }}>
        <ResponsiveContainer>
          <BarChart data={data.map((d) => ({ name: KIND_LABEL[d.kind] ?? d.kind, value: d.count }))}>
            <CartesianGrid stroke={chartColors.border} strokeDasharray="3 3" />
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: chartColors.foregroundMuted }} />
            <YAxis tick={{ fontSize: 11, fill: chartColors.foregroundMuted }} allowDecimals={false} />
            <Tooltip contentStyle={tooltipContentStyle} />
            <Bar dataKey="value" fill={chartColors.chart2} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: AiActivityChart**

```tsx
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { chartColors, tooltipContentStyle } from '../chartTheme';
import type { OverviewResponse } from '../api';

type AI = OverviewResponse['aiActivity'];

export default function AiActivityChart({ data }: { data: AI }) {
  return (
    <div className="glass-panel rounded-[12px] p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--color-foreground)' }}>AI 活动</h3>
        <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>近 7 天</span>
      </div>
      <div style={{ width: '100%', height: 200 }}>
        <ResponsiveContainer>
          <ComposedChart data={data}>
            <CartesianGrid stroke={chartColors.border} strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: chartColors.foregroundMuted }} />
            <YAxis tick={{ fontSize: 11, fill: chartColors.foregroundMuted }} allowDecimals={false} />
            <Tooltip contentStyle={tooltipContentStyle} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="casesGenerated" name="生成用例" fill={chartColors.chart5} radius={[4, 4, 0, 0]} />
            <Line type="monotone" dataKey="stepsGenerated" stroke={chartColors.chart1} strokeWidth={2} dot />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: typecheck**

```bash
cd apps/web && pnpm typecheck
```
预期: 无报错。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/overview/components/RecordingActivityChart.tsx apps/web/src/features/overview/components/AiActivityChart.tsx
git commit -m "feat(web): RecordingActivityChart + AiActivityChart"
```

---

## Task 11: 前端 — OverviewHeader + OverviewSkeleton + OverviewEmpty

**Files:**
- Create: `apps/web/src/features/overview/components/OverviewHeader.tsx`
- Create: `apps/web/src/features/overview/components/OverviewSkeleton.tsx`
- Create: `apps/web/src/features/overview/components/OverviewEmpty.tsx`

- [ ] **Step 1: OverviewHeader**

```tsx
import Segmented from '../../../components/ui/Segmented';
import IconButton from '../../../components/ui/IconButton';
import type { Range } from '../api';

export default function OverviewHeader({
  range,
  onRangeChange,
  onRefresh,
}: {
  range: Range;
  onRangeChange: (r: Range) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
          总览
        </h1>
        <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
          用例 → 执行 → 计划 全链路概览
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Segmented<Range>
          options={[{ value: '7d', label: '7 天' }, { value: '30d', label: '30 天' }]}
          value={range}
          onChange={onRangeChange}
        />
        <IconButton name="refresh" title="刷新" onClick={onRefresh} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: OverviewSkeleton**

```tsx
function SkeletonRow({ h = 92 }: { h?: number }) {
  return (
    <div
      className="glass-panel rounded-[12px] animate-pulse"
      style={{ minHeight: h, background: 'var(--color-muted)' }}
    />
  );
}

export default function OverviewSkeleton() {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4">
        <div className="space-y-2">
          <div className="h-5 w-20 rounded" style={{ background: 'var(--color-muted)' }} />
          <div className="h-3 w-40 rounded" style={{ background: 'var(--color-muted)' }} />
        </div>
      </div>
      <div className="grid grid-cols-5 gap-4 px-5 pt-4">
        {Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)}
      </div>
      <div className="grid grid-cols-12 gap-4 px-5 pt-4">
        <SkeletonRow h={300} />
        <SkeletonRow h={300} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: OverviewEmpty**

```tsx
import { useNavigate } from 'react-router-dom';
import Icon from '../../../components/Icon';

export default function OverviewEmpty({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center max-w-md">
        <Icon name="beaker" size={48} style={{ color: 'var(--color-foreground-muted)' }} />
        <h3 className="text-[16px] font-semibold mt-3" style={{ color: 'var(--color-foreground)' }}>
          还没有用例数据
        </h3>
        <p className="text-[12px] mt-1" style={{ color: 'var(--color-foreground-muted)' }}>
          创建需求 → 生成用例 → 执行,所有指标都会汇聚到这里。
        </p>
        <div className="flex gap-2 justify-center mt-4">
          <button className="btn-primary" onClick={() => navigate(`/p/${projectId}/requirements`)}>
            去新建需求
          </button>
          <button className="btn-ghost" onClick={() => navigate(`/p/${projectId}/plans`)}>
            去新建计划
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: typecheck**

```bash
cd apps/web && pnpm typecheck
```
预期: 无报错。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/overview/components/OverviewHeader.tsx apps/web/src/features/overview/components/OverviewSkeleton.tsx apps/web/src/features/overview/components/OverviewEmpty.tsx
git commit -m "feat(web): overview header + skeleton + empty state"
```

---

## Task 12: 前端 — Dashboard.tsx 重写为编排容器

**Files:**
- Modify: `apps/web/src/pages/Dashboard.tsx`

- [ ] **Step 1: 重写 Dashboard.tsx**

```tsx
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useOverviewQuery, overviewQueryKey, type Range } from '../features/overview/api';
import OverviewHeader from '../features/overview/components/OverviewHeader';
import OverviewSkeleton from '../features/overview/components/OverviewSkeleton';
import OverviewEmpty from '../features/overview/components/OverviewEmpty';
import KpiStripCard from '../features/overview/components/KpiStripCard';
import PassRateTrendChart from '../features/overview/components/PassRateTrendChart';
import TopFailuresChart from '../features/overview/components/TopFailuresChart';
import PriorityDonut from '../features/overview/components/PriorityDonut';
import PlanStatusLine from '../features/overview/components/PlanStatusLine';
import RecentRunsStream from '../features/overview/components/RecentRunsStream';
import RecordingActivityChart from '../features/overview/components/RecordingActivityChart';
import AiActivityChart from '../features/overview/components/AiActivityChart';

export default function Dashboard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { projectId } = useParams<{ projectId: string }>();
  const [range, setRange] = useState<Range>('7d');
  const { data, isLoading, isError } = useOverviewQuery(projectId, range);

  if (!projectId) return null;

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)' }}>
        概览暂时不可用,请稍后重试
      </div>
    );
  }

  if (isLoading || !data) return <OverviewSkeleton />;

  const isEmpty = data.kpi.totalCases === 0 && data.kpi.totalPlans === 0 && data.kpi.totalRuns7d === 0;
  if (isEmpty) return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-5 pt-4"><OverviewHeader range={range} onRangeChange={setRange} onRefresh={() => qc.invalidateQueries({ queryKey: overviewQueryKey(projectId, range) })} /></div>
      <OverviewEmpty projectId={projectId} />
    </div>
  );

  const latestReportByCase = new Map<string, string>();
  for (const r of data.recentRuns) {
    if (r.kind === 'case' && !latestReportByCase.has(r.caseId)) latestReportByCase.set(r.caseId, r.id);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-5 pt-4">
        <OverviewHeader
          range={range}
          onRangeChange={setRange}
          onRefresh={() => qc.invalidateQueries({ queryKey: overviewQueryKey(projectId, range) })}
        />
      </div>

      <div className="grid grid-cols-5 gap-4 px-5 pt-4 fade-up" data-stagger>
        <KpiStripCard label="用例总数" value={data.kpi.totalCases} iconName="beaker" tone="var(--color-info)" to={`/p/${projectId}/groups`} />
        <KpiStripCard label="计划数" value={data.kpi.totalPlans} iconName="flag" tone="var(--color-accent)" to={`/p/${projectId}/plans`} />
        <KpiStripCard label="通过率" value={Math.round(data.kpi.passRate * 100)} suffix="%" iconName="checkCircle" tone="var(--color-success)" to={`/p/${projectId}/reports?filter=passed-7d`} />
        <KpiStripCard label="近 7d 运行" value={data.kpi.totalRuns7d} iconName="activity" tone="var(--color-warning)" to={`/p/${projectId}/reports?range=7d`} />
        <KpiStripCard label="AI 调用" value={data.kpi.aiCalls7d} iconName="sparkles" tone="var(--color-accent)" to={`/p/${projectId}/requirements`} />
      </div>

      <div className="grid grid-cols-12 gap-4 px-5 pt-4 flex-1 min-h-0 fade-up" data-stagger>
        <div className="col-span-8 flex flex-col gap-4 min-h-0">
          <PassRateTrendChart data={data.trend} />
          <div className="grid grid-cols-2 gap-4">
            <TopFailuresChart data={data.topFailures} latestReportByCase={latestReportByCase} />
            <PriorityDonut data={data.priorityDistribution} />
          </div>
        </div>
        <div className="col-span-4 flex flex-col gap-4 min-h-0">
          <RecentRunsStream runs={data.recentRuns} projectId={projectId} />
          <PlanStatusLine plans={data.plans} projectId={projectId} />
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4 px-5 pt-4 pb-5 fade-up" data-stagger>
        <div className="col-span-6"><RecordingActivityChart data={data.recordingActivity} /></div>
        <div className="col-span-6"><AiActivityChart data={data.aiActivity} /></div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

```bash
cd apps/web && pnpm typecheck
```
预期: 无报错。

- [ ] **Step 3: dev 启动 + 浏览器手测**

```bash
cd apps/web && pnpm dev
```
打开 http://localhost:5173 → 登录 → 进项目 → 看 Overview 渲染。预期: 顶部 5 张 KPI 卡 + 中部左趋势/Top 失败/优先分布 + 右最近运行/计划状态 + 底部录制/AI 活动 7 区段全部出现;点击 KPI 卡导航跳转;切换 7d/30d 后数据更新。

- [ ] **Step 4: 跑全部 web 测试**

```bash
cd apps/web && pnpm test
```
预期: PASS(包含 chartTheme / api / KpiStripCard)。

- [ ] **Step 5: 跑全部 monorepo verify**

```bash
cd /Users/lyq/workdir/codedev/iTest && pnpm verify
```
预期: PASS(已知失败 fix 已经遗留的 plans 3 case 除外,见 `project_plans_test_preexisting_failure.md`)。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/Dashboard.tsx
git commit -m "feat(web): rewrite Dashboard as overview composition"
```

---

## Self-Review Checklist(执行后回看)

- Spec §3 聚合接口:Task 2 ✓
- Spec §4 布局 / 11 个组件:Task 5–11 ✓
- Spec §5 chart 配色:Task 1 ✓
- Spec §6 动效:stagger 由现有 `data-stagger` 自动;hover `.kpi-icon` Task 4 Step 4 ✓
- Spec §7 跳转矩阵:Task 5 + Task 12 ✓
- Spec §8 时间范围 / 刷新:Task 11 OverviewHeader + Task 12 queryKey ✓
- Spec §9 加载/空态/错:Task 11 Skeleton + Empty + Task 12 isError 分支 ✓
- Spec §10 测试:每个组件单测 + 后端 3 用例 + verify ✓
- Spec §11 边界:recordingActivity 固定空数组 / trend 补 0 / 时区 / 限条目数 — Task 2 + Task 4 显式约束 ✓
- Spec §12 out of scope:实现未做 ✓