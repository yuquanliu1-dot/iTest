# 用例状态生命周期实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 test_cases.status 落地四态生命周期（draft/review/ready/deprecated）：API 可写、四个 UI 入口、deprecated 执行拦截。

**Architecture:** 方案 A——PATCH /cases/:id 加 zod 枚举字段（透传现有 update 即生效）、镜像 batch-delete 新增 POST /cases/batch-status、runPlan 业务循环跳过 deprecated 记 skipped；Web 侧新增 CaseStatusMenu 共享组件 + format 标签映射 + statusTone 补 review 色。DB 零迁移。

**Tech Stack:** Express + zod + drizzle（apps/api）；React 19 + react-query + createPortal（apps/web）；vitest + testcontainers（API 路由测试）。

**Spec:** docs/superpowers/specs/2026-10-02-case-status-design.md

**回归红线：** 存量用例（全 draft）渲染与现状一致；非 deprecated 执行路径零变化；commit 一律显式文件清单，禁止 `git add -A`（工作树有用户未跟踪文件）。

---

### Task 1: API — PATCH status + POST /cases/batch-status

**Files:**
- Modify: `apps/api/src/routes/cases.ts`（PatchBody :40-42；batch-delete 后 :318 加新路由）
- Test: `apps/api/test/cases-status.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `apps/api/test/cases-status.test.ts`（样板照抄 cases-copy.test.ts:1-51——testcontainers + supertest + seedOrg/seedProject + 注入管理员身份，只挂 casesRoute）：

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
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  const { default: express } = await import('express');
  const { casesRoute } = await import('../src/routes/cases.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  app = express();
  app.use(express.json());
  const { userId, username, orgId, orgPath } = await seedOrg(pool);
  const { managerUserOf } = await import('./helpers/auth.js');
  app.use('/api', (req, _res, next) => {
    req.user = managerUserOf(userId, username, orgId, orgPath);
    next();
  });
  app.use('/api/cases', casesRoute);
  app.use(errorHandler);
});

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

async function makeCase(groupId: string, title: string): Promise<{ id: string }> {
  const c = await request(app).post('/api/cases').send({ title, groupId });
  return c.body as { id: string };
}

describe('case status', () => {
  it('create 默认 draft', async () => {
    const { groupId } = await seedProject(pool);
    const c = await makeCase(groupId, '默认态');
    const detail = await request(app).get(`/api/cases/${c.id}`);
    expect(detail.body.status).toBe('draft');
  });

  it('PATCH 合法 status 更新成功', async () => {
    const { groupId } = await seedProject(pool);
    const c = await makeCase(groupId, '流转');
    const r = await request(app).patch(`/api/cases/${c.id}`).send({ status: 'review' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('review');
    const again = await request(app).patch(`/api/cases/${c.id}`).send({ status: 'deprecated' });
    expect(again.body.status).toBe('deprecated');
    // 自由回退
    const back = await request(app).patch(`/api/cases/${c.id}`).send({ status: 'draft' });
    expect(back.body.status).toBe('draft');
  });

  it('PATCH 非法 status 422', async () => {
    const { groupId } = await seedProject(pool);
    const c = await makeCase(groupId, '非法值');
    const r = await request(app).patch(`/api/cases/${c.id}`).send({ status: 'done' });
    expect(r.status).toBe(422);
  });

  it('batch-status 批量更新并返回 count', async () => {
    const { groupId } = await seedProject(pool);
    const c1 = await makeCase(groupId, 'a');
    const c2 = await makeCase(groupId, 'b');
    const r = await request(app).post('/api/cases/batch-status').send({ caseIds: [c1.id, c2.id], status: 'ready' });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    const list = await request(app).get(`/api/cases?groupId=${groupId}`);
    expect(list.body.every((c: { status: string }) => c.status === 'ready')).toBe(true);
  });

  it('batch-status 含未知 id 404；空数组 422；非法枚举 422', async () => {
    const { groupId } = await seedProject(pool);
    const c1 = await makeCase(groupId, 'x');
    const unknown = await request(app)
      .post('/api/cases/batch-status')
      .send({ caseIds: [c1.id, '00000000-0000-0000-0000-000000000000'], status: 'ready' });
    expect(unknown.status).toBe(404);
    const empty = await request(app).post('/api/cases/batch-status').send({ caseIds: [], status: 'ready' });
    expect(empty.status).toBe(422);
    const bad = await request(app).post('/api/cases/batch-status').send({ caseIds: [c1.id], status: 'done' });
    expect(bad.status).toBe(422);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/api exec vitest run cases-status`
Expected: PATCH 测试返回 200 但 `r.body.status` 仍是 `'draft'`（zod strip 掉未知字段，update 不含 status）；batch-status 测试 404（路由不存在）。

- [ ] **Step 3: 实现**

`apps/api/src/routes/cases.ts` —— PatchBody 加 status（:40-42）：

```ts
const PatchBody = CaseBodyBase.partial()
  .extend({
    scenarioId: z.string().uuid().nullable().optional(),
    status: z.enum(['draft', 'review', 'ready', 'deprecated']).optional(),
  })
  .superRefine(checkWindowStrategy);
```

PATCH handler（:175-227）**不用改**：`const { tagIds: incomingTagIds, ...rest } = body` 的 rest 已含 status，`.set({ ...rest, updatedAt: new Date() })` 自动生效。

batch-delete 路由（:308-318）之后加：

```ts
casesRoute.post('/batch-status', async (req, res) => {
  const body = z
    .object({
      caseIds: z.array(z.string().uuid()).min(1),
      status: z.enum(['draft', 'review', 'ready', 'deprecated']),
    })
    .parse(req.body);
  // 与 batch-delete 一致：先按可见性逐个校验，违规直接 404
  for (const id of body.caseIds) {
    await assertCaseVisible(id, req.user!);
  }
  const updated = await db
    .update(testCases)
    .set({ status: body.status, updatedAt: new Date() })
    .where(inArray(testCases.id, body.caseIds))
    .returning({ id: testCases.id });
  res.json({ count: updated.length });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/api exec vitest run cases-status`
Expected: 5 passed

- [ ] **Step 5: typecheck + commit**

```bash
pnpm --filter @itest/api typecheck
git add apps/api/src/routes/cases.ts apps/api/test/cases-status.test.ts
git commit -m "feat(api): case status transitions via PATCH and batch-status endpoint"
```

---

### Task 2: runPlan 跳过 deprecated 用例

**Files:**
- Modify: `apps/api/src/execute/runPlan.ts`（cases 查询 :72-76；业务循环 :169-184）
- Test: `apps/api/test/plans.test.ts`（fail_fast 用例 :171-206 后追加）

依赖 Task 1（测试用 PATCH status 造数据）。

- [ ] **Step 1: 写失败测试**

在 `apps/api/test/plans.test.ts` 的 fail_fast 用例后追加（样板同 :171-206，**全部用例 deprecated，不触碰 playwright**）：

```ts
  it('deprecated cases skipped without execution, plan_run.status=passed', async () => {
    const { projectId, groupId } = await seedProject(pool);
    const c1 = await makeCase(groupId, 'c1');
    const c2 = await makeCase(groupId, 'c2');
    await request(app).patch(`/api/cases/${c1}`).send({ status: 'deprecated' });
    await request(app).patch(`/api/cases/${c2}`).send({ status: 'deprecated' });
    const plan = await request(app).post(`/api/projects/${projectId}/plans`).send({ name: 'P' });
    await request(app).put(`/api/plans/${plan.body.id}/cases`).send({ caseIds: [c1, c2] });

    const r = await request(app).post(`/api/plans/${plan.body.id}/run`);
    expect(r.status).toBe(200);
    const runId = r.body.runId as string;

    let detail: { body: { status: string; failedCases: number | null; skippedCases: number | null; passedCases: number | null; cases: Array<{ order: number; status: string }> } };
    for (let i = 0; i < 50; i++) {
      detail = await request(app).get(`/api/plan-runs/${runId}`);
      if (detail!.body.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(detail!.body.status).toBe('passed');
    expect(detail!.body.skippedCases).toBe(2);
    expect(detail!.body.passedCases).toBe(0);
    const byOrder = new Map(detail!.body.cases.map((c) => [c.order, c.status]));
    expect(byOrder.get(1)).toBe('skipped');
    expect(byOrder.get(2)).toBe('skipped');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/api exec vitest run plans`
Expected: 新用例 FAIL——deprecated 用例被正常执行，runCase 因无 chromium 步骤为空跑（或超时），status 不符合断言。注意：若本机无 CHROMIUM_PATH，runCase 会抛错记 failed，断言 `status === 'passed'` 仍失败。

- [ ] **Step 3: 实现**

`apps/api/src/execute/runPlan.ts`：

cases 查询（:72-76）加 join 取 status：

```ts
  const cases = await db
    .select({ caseId: planCases.caseId, order: planCases.order, status: testCases.status })
    .from(planCases)
    .innerJoin(testCases, eq(testCases.id, planCases.caseId))
    .where(eq(planCases.planId, plan.id))
    .orderBy(asc(planCases.order));
```

（planCases.caseId FK cascade，join 安全不丢行。）

业务循环内，`const c = cases[i]!;`（:184）之后、insert 'running'（:185）之前插入：

```ts
    if (c.status === 'deprecated') {
      await db.insert(planRunCases).values({
        planRunId,
        caseId: c.caseId,
        order: i + 1,
        status: 'skipped',
        stepKind: 'business',
        finishedAt: new Date(),
        durationMs: 0,
        error: 'case deprecated',
      });
      publish(planRunId, { type: 'plan_run_case_complete', caseId: c.caseId, stepKind: 'business', status: 'skipped' });
      skipped += 1;
      continue;
    }
```

（skipped 计数进 summary 与 skippedCases；finalStatus 判定 :240 只看 failed，不受影响。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @itest/api exec vitest run plans`
Expected: 全部通过（含既有 fail_fast/cancel 用例，确认无回归）

- [ ] **Step 5: typecheck + commit**

```bash
pnpm --filter @itest/api typecheck
git add apps/api/src/execute/runPlan.ts apps/api/test/plans.test.ts
git commit -m "feat(execute): plan runs skip deprecated cases as skipped"
```

---

### Task 3: Web 基础 — 标签映射 + statusTone + client 方法

**Files:**
- Modify: `apps/web/src/lib/format.ts`（文件尾追加）
- Test: `apps/web/src/lib/format.test.ts`（新建；若已存在则追加 describe）
- Modify: `apps/web/src/components/ui/StatusPill.tsx`（statusTone :19-27）
- Test: `apps/web/src/components/ui/StatusPill.test.ts`（新建）
- Modify: `apps/web/src/api/client.ts`（TestCase 附近 + cases.patch 类型 + removeBatch 旁）

- [ ] **Step 1: 写失败测试**

`apps/web/src/lib/format.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { caseStatusLabel } from './format';

describe('caseStatusLabel', () => {
  it('四态中文映射', () => {
    expect(caseStatusLabel('draft')).toBe('草稿');
    expect(caseStatusLabel('review')).toBe('评审中');
    expect(caseStatusLabel('ready')).toBe('就绪');
    expect(caseStatusLabel('deprecated')).toBe('废弃');
  });

  it('未知值回退原文', () => {
    expect(caseStatusLabel('weird')).toBe('weird');
  });
});
```

`apps/web/src/components/ui/StatusPill.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { statusTone } from './StatusPill';

describe('statusTone', () => {
  it('用例四态配色', () => {
    expect(statusTone('draft')).toBe('muted');
    expect(statusTone('review')).toBe('warning');
    expect(statusTone('ready')).toBe('success');
    expect(statusTone('deprecated')).toBe('muted');
  });

  it('既有映射不回归', () => {
    expect(statusTone('passed')).toBe('success');
    expect(statusTone('running')).toBe('accent');
    expect(statusTone('failed')).toBe('destructive');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @itest/web test`
Expected: format.test.ts 报 `caseStatusLabel` 未导出；StatusPill.test.ts `statusTone('review')` 得 'muted' ≠ 'warning'。

- [ ] **Step 3: 实现**

`apps/web/src/lib/format.ts` 文件尾追加（照 stepKindLabel 模式）：

```ts
/** 用例状态中文名（仅展示用，存储值仍为英文）。 */
export const CASE_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  review: '评审中',
  ready: '就绪',
  deprecated: '废弃',
};

export function caseStatusLabel(status: string): string {
  return CASE_STATUS_LABELS[status] ?? status;
}
```

`apps/web/src/components/ui/StatusPill.tsx` statusTone 的 warning 行改为：

```ts
    case 'queued': case 'pending': case 'review': return 'warning';
```

同时更新函数头注释：`passed/completed/ready=success，running=accent（配 pulse 点），queued/pending/review=warning，failed=destructive，其余（draft/deprecated）=muted。`

`apps/web/src/api/client.ts`：

TestCase 接口（:463）上方加：

```ts
export type CaseStatus = 'draft' | 'review' | 'ready' | 'deprecated';
```

cases.patch 的 body 类型（:132-147）加一行 `status: CaseStatus;`（与 scenarioId 并列）。

removeBatch（:149-153）旁加：

```ts
    updateStatusBatch: (caseIds: string[], status: CaseStatus) =>
      request<{ count: number }>('/cases/batch-status', {
        method: 'POST',
        body: JSON.stringify({ caseIds, status }),
      }),
```

- [ ] **Step 4: 跑测试 + typecheck 确认通过**

Run: `pnpm --filter @itest/web test && pnpm --filter @itest/web typecheck`
Expected: 既有 33 用例 + 新 4 用例全过；typecheck 干净。

- [ ] **Step 5: commit**

```bash
git add apps/web/src/lib/format.ts apps/web/src/lib/format.test.ts apps/web/src/components/ui/StatusPill.tsx apps/web/src/components/ui/StatusPill.test.ts apps/web/src/api/client.ts
git commit -m "feat(web): case status labels, review tone, and batch-status client"
```

---

### Task 4: CaseStatusMenu 共享组件

**Files:**
- Create: `apps/web/src/components/CaseStatusMenu.tsx`

组件无测试基建（与既有一致），靠 typecheck + Task 8 浏览器 QA。

- [ ] **Step 1: 实现组件**

`apps/web/src/components/CaseStatusMenu.tsx`（portal 弹层照 CaseDetail tagPicker 的 stopPropagation 模式，CaseDetail.tsx:174-187）：

```tsx
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type CaseStatus } from '../api/client';
import { useUIStore } from '../stores/ui';
import { caseStatusLabel } from '../lib/format';
import StatusPill from './ui/StatusPill';

const STATUSES: CaseStatus[] = ['draft', 'review', 'ready', 'deprecated'];

/** 可点击的状态 pill：弹出单选菜单改用例状态。详情页头部与用例列表行复用。 */
export default function CaseStatusMenu({
  caseId,
  status,
  projectId,
  onChanged,
}: {
  caseId: string;
  status: string;
  /** 传入则同时 invalidate 该项目的用例列表（列表行内场景） */
  projectId?: string;
  onChanged?: (next: CaseStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const qc = useQueryClient();
  const toast = useUIStore((s) => s.showToast);

  const patch = useMutation({
    mutationFn: (next: CaseStatus) => api.cases.patch(caseId, { status: next }),
    onSuccess: (_r, next) => {
      qc.invalidateQueries({ queryKey: ['case', caseId] });
      if (projectId) qc.invalidateQueries({ queryKey: ['cases', projectId] });
      toast(`状态已改为${caseStatusLabel(next)}`, 'success');
      setOpen(false);
      onChanged?.(next);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  useEffect(() => {
    if (!open) return;
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 4, left: Math.max(8, rect.left) });
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        title="点击修改状态"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
      >
        <StatusPill status={status}>{caseStatusLabel(status)}</StatusPill>
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            className="rounded-[8px] overflow-hidden popover-in"
            style={{
              position: 'fixed',
              top: anchor.top,
              left: anchor.left,
              minWidth: 120,
              zIndex: 9999,
              border: '1px solid var(--color-glass-border)',
              background: 'var(--color-background-elevated)',
              boxShadow: 'var(--shadow-modal)',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                disabled={patch.isPending}
                onClick={() => patch.mutate(s)}
                className="w-full text-left px-3 py-1.5 text-[12px] cursor-pointer hover:bg-[var(--color-background-subtle)] flex items-center justify-between gap-2"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: s === status ? 'var(--color-accent)' : 'var(--color-foreground)',
                }}
              >
                {caseStatusLabel(s)}
                {s === status && <span>✓</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}
```

- [ ] **Step 2: typecheck + commit**

Run: `pnpm --filter @itest/web typecheck`
Expected: 干净

```bash
git add apps/web/src/components/CaseStatusMenu.tsx
git commit -m "feat(web): CaseStatusMenu popover for inline status switching"
```

---

### Task 5: CaseDetail 接入 — pill 换菜单 + deprecated 执行确认

**Files:**
- Modify: `apps/web/src/pages/CaseDetail.tsx`（头部 :490；执行按钮 :492-499；import 区）

- [ ] **Step 1: 实现**

import 区：`import CaseStatusMenu from '../components/CaseStatusMenu';`；若 StatusPill 在本文件仅 :490 一处使用（grep 确认），删除其 import。

头部 pill（:490）替换：

```tsx
        <CaseStatusMenu caseId={caseDetail.id} status={caseDetail.status} />
```

执行按钮（:492-499）onClick 改为：

```tsx
          onClick={() => {
            if (caseDetail.status === 'deprecated' && !window.confirm('用例已废弃，仍要执行？')) return;
            execute.mutate();
          }}
```

- [ ] **Step 2: typecheck + commit**

Run: `pnpm --filter @itest/web typecheck`
Expected: 干净

```bash
git add apps/web/src/pages/CaseDetail.tsx
git commit -m "feat(web): case detail status menu and deprecated-run confirm"
```

---

### Task 6: GroupsPage 接入 — 行内切换 + 批量改状态 + 状态筛选 + 废弃行降透明度

**Files:**
- Modify: `apps/web/src/pages/GroupsPage.tsx`（state 区 :40 附近；filteredCases :236-239；批量工具条 :519-540；行 :569-574/:606；标签筛选触发器旁 :431；import 区）

- [ ] **Step 1: 实现**

import 区加 `import CaseStatusMenu from '../components/CaseStatusMenu';` 与 `import type { CaseStatus } from '../api/client';`（与现有 api import 合并）。StatusPill 若仅 :606 一处使用则删 import。

state 区（tagFilter 旁 :42）加：

```ts
  const [statusFilter, setStatusFilter] = useState<'' | CaseStatus>('');
```

批量 mutation（batchDelete 附近 :205-234）加：

```ts
  const batchStatus = useMutation({
    mutationFn: (status: CaseStatus) => api.cases.updateStatusBatch(checkedList, status),
    onSuccess: (r) => {
      toast(`已更新 ${r.count} 条`, 'success');
      setChecked(new Set());
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
```

filteredCases（:236-239）改为：

```ts
  const filteredCases = useMemo(() => {
    let list = cases ?? [];
    if (tagFilter.size > 0) list = list.filter((c) => (c.tags ?? []).some((t) => tagFilter.has(t.id)));
    if (statusFilter) list = list.filter((c) => c.status === statusFilter);
    return list;
  }, [cases, tagFilter, statusFilter]);
```

标签筛选触发器（:431 区域）旁加状态筛选下拉（同工具行内、`input-base input-sm`）：

```tsx
                <select
                  className="input-base input-sm"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as '' | CaseStatus)}
                  title="按状态过滤"
                >
                  <option value="">全部状态</option>
                  <option value="draft">草稿</option>
                  <option value="review">评审中</option>
                  <option value="ready">就绪</option>
                  <option value="deprecated">废弃</option>
                </select>
```

批量工具条（:526-537 按钮组中、「批量删除」前）加：

```tsx
            <select
              className="input-base input-sm"
              value=""
              disabled={batchStatus.isPending}
              onChange={(e) => {
                if (e.target.value) batchStatus.mutate(e.target.value as CaseStatus);
              }}
              title="批量修改选中用例状态"
            >
              <option value="">改状态…</option>
              <option value="draft">→ 草稿</option>
              <option value="review">→ 评审中</option>
              <option value="ready">→ 就绪</option>
              <option value="deprecated">→ 废弃</option>
            </select>
```

行容器（:569-574）style 加废弃降透明：

```tsx
                    style={{ borderBottom: '1px solid var(--color-muted)', opacity: c.status === 'deprecated' ? 0.55 : 1 }}
```

行内 pill（:606）替换（包一层 span 阻断行跳转）：

```tsx
                    <span onClick={(e) => e.stopPropagation()}>
                      <CaseStatusMenu caseId={c.id} status={c.status} projectId={projectId} />
                    </span>
```

- [ ] **Step 2: typecheck + commit**

Run: `pnpm --filter @itest/web typecheck`
Expected: 干净

```bash
git add apps/web/src/pages/GroupsPage.tsx
git commit -m "feat(web): list inline status switch, batch status, and status filter"
```

---

### Task 7: PlanDetail 选例弹窗 — deprecated 标灰 + 状态 pill

**Files:**
- Modify: `apps/web/src/pages/PlanDetail.tsx`（添加用例弹窗行 :362-375；import 区）

选例弹窗无全选（selectedAdd 初始为空），spec 的「默认不选」天然满足，只需标灰提示。

- [ ] **Step 1: 实现**

import 区：`import { caseStatusLabel } from '../lib/format';`；`import StatusPill from '../components/ui/StatusPill';`（若本文件未引入——:330 已在用则跳过）。

候选行（:362-375）改为（style 加 opacity，title 前插 deprecated pill）：

```tsx
                  <div
                    key={c.id}
                    className="flex items-center gap-2 px-3 py-2 rounded-[6px] cursor-pointer hover-card"
                    style={{ opacity: c.status === 'deprecated' ? 0.55 : 1 }}
                    onClick={() => {
                      const next = new Set(selectedAdd);
                      if (checked) next.delete(c.id);
                      else next.add(c.id);
                      setSelectedAdd(next);
                    }}
                  >
                    <input type="checkbox" readOnly checked={checked} />
                    <span className="text-[12px] flex-1 truncate" style={{ color: 'var(--color-foreground)' }}>{c.title}</span>
                    {c.status === 'deprecated' && (
                      <StatusPill status={c.status}>{caseStatusLabel(c.status)}</StatusPill>
                    )}
                    <span className="text-[10px]" style={{ color: 'var(--color-foreground-muted)' }}>{c.priority}</span>
                  </div>
```

- [ ] **Step 2: typecheck + commit**

Run: `pnpm --filter @itest/web typecheck`
Expected: 干净

```bash
git add apps/web/src/pages/PlanDetail.tsx
git commit -m "feat(web): dim deprecated cases in plan case picker"
```

---

### Task 8: 回归 QA + 收尾

**Files:** 无新改动（发现问题则回对应 Task 修复）

- [ ] **Step 1: 全量测试 + typecheck**

```bash
pnpm --filter @itest/web test && pnpm --filter @itest/web typecheck && pnpm --filter @itest/api typecheck
pnpm --filter @itest/api exec vitest run cases-status plans
```

Expected: web 全过；api 新用例全过（apps/api 全量有 3 个既知失败 cases 用例，与本功能无关，见 memory）。

- [ ] **Step 2: 浏览器回归（dev server 5173 已在跑，admin/admin123）**

清单：
1. GroupsPage 列表：pill 显示中文（草稿）；点击弹出 4 态菜单 → 切「就绪」→ pill 变绿 + toast；刷新后保持
2. 行内切换不触发行跳转（点 pill 弹层期间不进详情页）
3. 状态筛选下拉 × 标签筛选组合过滤正确；分页正常
4. 多选 →「改状态…」→ 就绪 → toast「已更新 N 条」+ 多选清空 + 列表刷新
5. deprecated 用例行降透明度
6. CaseDetail：头部 pill 可切换；deprecated 用例点「执行」弹确认，取消不跑、确认照跑；非 deprecated 直接跑
7. PlanDetail 添加用例弹窗：deprecated 候选标灰 + 废弃 pill，仍可勾选加入
8. 计划运行含 deprecated 用例 → SSE 面板/详情显示 skipped，skippedCases 计数正确，plan 终态不受影响
9. 回归：存量 draft 用例列表/详情渲染与之前一致；步骤编辑抽屉、拖拽排序不受影响
10. 复制一个 deprecated 用例 → 副本状态为「草稿」（copyOneCase 不复制 status，默认值生效）

- [ ] **Step 3: 收尾报告 + 最终代码评审**

按 subagent-driven-development 流程派最终评审；报告遗留问题（如 ENCRYPTION_KEY 环境缺失属既有问题，不在本范围）。
