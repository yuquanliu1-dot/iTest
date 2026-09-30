# 项目·分组·执行计划 — 前端 Implementation Plan（Part 2/2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地项目即工作空间的前端：项目首页（卡片/创建/编辑/删除）、`/p/:projectId` 项目内布局（子导航 + 守卫）、分组树用例列表（批量复制/加入计划）、用例详情面包屑与移动分组、需求按项目隔离 + AI 生成选目标分组、执行计划列表/详情/一键运行、工作台与报告按项目过滤。

**Architecture:** Zustand + localStorage 持久化当前项目；React Router 嵌套路由 `/p/:projectId/*` 由 `ProjectGuard` 校验 store 与 URL 一致（不一致重定向 `/`）；全局 Sidebar 缩减为「项目 / 设置」，项目内页面自带顶部栏（项目名 + 退出项目）与左侧二级导航；全部数据请求经 `api/client.ts` 新增的 projects/groups/plans/copy 方法，按 projectId 过滤。依赖 Part 1 后端 API（`2026-09-30-projects-groups-part1-backend.md`），必须先完成 Part 1。

**Tech Stack:** React 18, React Router 6, TanStack Query v5, Zustand v5, Tailwind v4

**Spec:** `docs/superpowers/specs/2026-09-30-projects-groups-design.md`

**验证约定（web 无组件测试基建，采用 typecheck + lint + 手动浏览器验证）：**
- 每个 Task 跑 `pnpm --filter @itest/web typecheck && pnpm --filter @itest/web lint` 必须全绿。
- 涉及页面的 Task 在全部完成后按 Task 17 的手动验收清单统一过一遍（`pnpm dev` 起全链路）。
- git 命令在仓库根目录执行。

---

### Task 9: api/client.ts 扩展（projects/groups/plans/copy 全套 API）

**Files:**
- Modify: `apps/web/src/api/client.ts`

- [ ] **Step 1: 全文替换 client.ts**

```ts
const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<{ ok: boolean }>('/health'),
  settings: {
    list: () => request<Record<string, unknown>>('/settings'),
    put: (key: string, value: unknown) =>
      request<{ key: string; value: unknown }>('/settings', {
        method: 'PUT',
        body: JSON.stringify({ key, value }),
      }),
  },
  projects: {
    list: () => request<ProjectWithCount[]>('/projects'),
    create: (body: { name: string; defaultUrl?: string }) =>
      request<Project>('/projects', { method: 'POST', body: JSON.stringify(body) }),
    patch: (id: string, body: Partial<{ name: string; defaultUrl: string }>) =>
      request<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
    groups: (id: string) => request<GroupWithCount[]>(`/projects/${id}/groups`),
    createGroup: (id: string, body: { name: string; defaultUrl?: string }) =>
      request<Group>(`/projects/${id}/groups`, { method: 'POST', body: JSON.stringify(body) }),
    stats: (id: string) => request<ProjectStats>(`/projects/${id}/stats`),
    plans: (id: string) => request<PlanWithCount[]>(`/projects/${id}/plans`),
    createPlan: (id: string, body: { name: string; environment?: string }) =>
      request<ExecutionPlan>(`/projects/${id}/plans`, { method: 'POST', body: JSON.stringify(body) }),
    requirements: (id: string) => request<Requirement[]>(`/projects/${id}/requirements`),
    createRequirement: (id: string, body: { title: string; content: string }) =>
      request<Requirement>(`/projects/${id}/requirements`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },
  groups: {
    patch: (id: string, body: Partial<{ name: string; defaultUrl: string }>) =>
      request<Group>(`/groups/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/groups/${id}`, { method: 'DELETE' }),
  },
  plans: {
    get: (id: string) => request<PlanDetail>(`/plans/${id}`),
    patch: (id: string, body: Partial<{ name: string; environment: string }>) =>
      request<ExecutionPlan>(`/plans/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/plans/${id}`, { method: 'DELETE' }),
    setCases: (id: string, caseIds: string[]) =>
      request<{ ok: boolean }>(`/plans/${id}/cases`, {
        method: 'PUT',
        body: JSON.stringify({ caseIds }),
      }),
    run: (id: string) =>
      request<{ results: Array<{ caseId: string; reportId: string; status: string }> }>(
        `/plans/${id}/run`,
        { method: 'POST' },
      ),
  },
  requirements: {
    get: (id: string) => request<Requirement>(`/requirements/${id}`),
  },
  cases: {
    list: (params?: { priority?: string; groupId?: string; projectId?: string }) => {
      const qs = new URLSearchParams();
      if (params?.priority) qs.set('priority', params.priority);
      if (params?.groupId) qs.set('groupId', params.groupId);
      if (params?.projectId) qs.set('projectId', params.projectId);
      const s = qs.toString();
      return request<TestCase[]>(`/cases${s ? `?${s}` : ''}`);
    },
    create: (body: { title: string; priority?: string; requirementId?: string; groupId: string; url?: string }) =>
      request<TestCase>('/cases', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => request<TestCaseDetail>(`/cases/${id}`),
    patch: (
      id: string,
      body: Partial<{ title: string; priority: string; description: string; groupId: string; url: string }>,
    ) => request<TestCase>(`/cases/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/cases/${id}`, { method: 'DELETE' }),
    copy: (id: string, targetGroupId: string) =>
      request<TestCase>(`/cases/${id}/copy`, { method: 'POST', body: JSON.stringify({ targetGroupId }) }),
    copyBatch: (caseIds: string[], targetGroupId: string) =>
      request<{ count: number }>('/cases/copy', {
        method: 'POST',
        body: JSON.stringify({ caseIds, targetGroupId }),
      }),
    appendSteps: (id: string, steps: Array<{ order: number; source: string; action: unknown }>) =>
      request<{ count: number }>(`/cases/${id}/steps`, {
        method: 'POST',
        body: JSON.stringify({ steps }),
      }),
    reorderSteps: (id: string, stepIds: string[]) =>
      request<{ steps: TestStep[] }>(`/cases/${id}/steps/reorder`, {
        method: 'PUT',
        body: JSON.stringify({ stepIds }),
      }),
    deleteStep: (id: string, stepId: string) =>
      request<{ ok: boolean }>(`/cases/${id}/steps/${stepId}`, { method: 'DELETE' }),
    execute: (id: string) =>
      request<{ reportId: string }>(`/cases/${id}/execute`, { method: 'POST' }),
  },
  reports: {
    list: (projectId?: string) =>
      request<Report[]>(`/reports${projectId ? `?projectId=${projectId}` : ''}`),
    get: (id: string) => request<Report>(`/reports/${id}`),
  },
  agentRuns: {
    create: (body: { targetType: string; targetId: string; prompt: string; targetGroupId?: string }) =>
      request<AgentRun>('/agent-runs', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => request<AgentRun>(`/agent-runs/${id}`),
    eventsUrl: (id: string) => `${BASE}/agent-runs/${id}/events`,
  },
  recorder: {
    createSession: (caseId: string) =>
      request<{ sessionId: string; wsUrl: string; wsToken: string; resolvedUrl: string | null }>(
        '/recorder/sessions',
        { method: 'POST', body: JSON.stringify({ caseId }) },
      ),
    finish: (sessionId: string) =>
      request<{ inserted: number }>(`/recorder/sessions/${sessionId}/finish`, { method: 'POST' }),
  },
};

export interface Project {
  id: string;
  name: string;
  defaultUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectWithCount extends Project {
  caseCount: number;
}
export interface Group {
  id: string;
  projectId: string;
  name: string;
  defaultUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface GroupWithCount extends Group {
  caseCount: number;
}
export interface ExecutionPlan {
  id: string;
  projectId: string;
  name: string;
  environment: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface PlanWithCount extends ExecutionPlan {
  caseCount: number;
}
export interface PlanDetail extends ExecutionPlan {
  cases: Array<{ id: string; order: number; title: string }>;
}
export interface ProjectStats {
  requirements: number;
  cases: number;
  passes: number;
  failures: number;
  groups: Array<{ id: string; name: string; caseCount: number }>;
  recentRuns: Array<{ id: string; caseId: string; status: string; createdAt: string }>;
}
export interface Requirement {
  id: string;
  title: string;
  content: string;
  status: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface TestCase {
  id: string;
  title: string;
  priority: string;
  status: string;
  groupId?: string;
  url?: string | null;
  requirementId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}
export interface TestStep {
  id: string;
  order: number;
  source: string;
  action: unknown;
}
export interface TestCaseDetail extends TestCase {
  description?: string;
  steps: TestStep[];
  resolvedUrl: string | null;
}
export interface Report {
  id: string;
  caseId: string;
  status: string;
  durationMs: number | null;
  stepResults: unknown;
  summary: string | null;
  createdAt: string;
}
export interface AgentRun {
  id: string;
  targetType: string;
  targetId: string;
  status: string;
  prompt: string;
  result: unknown;
  error: string | null;
}
```

注意：`requirements.list/create` 被 `projects.requirements/createRequirement`（项目作用域）取代，但 `requirements.get` 保留（detail 路由不限制项目）。旧全局 `api.requirements.list` 的调用方在 Task 14 一并改掉，所以此处直接删除旧签名是安全的——前提按 Task 顺序执行。

- [ ] **Step 2: typecheck + lint**

Run: `pnpm --filter @itest/web typecheck && pnpm --filter @itest/web lint`
Expected: 全绿（此时 `api.requirements.list` 已无调用方？不——Requirements.tsx 还在用。预期 typecheck **会报错**。正确做法：Task 9 只加新方法、暂不移除旧 `requirements.list/create` 签名。把 Step 1 中 `requirements: { get: ... }` 改回 `requirements: { list: () => request<Requirement[]>('/requirements'), create: (body) => request<Requirement>('/requirements', {...}), get: ... }`，旧签名保留到 Task 14 再删。）

修正后 Step 1 的 requirements 段为：

```ts
  requirements: {
    list: () => request<Requirement[]>('/requirements'),
    create: (body: { title: string; content: string }) =>
      request<Requirement>('/requirements', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => request<Requirement>(`/requirements/${id}`),
  },
```

Run: `pnpm --filter @itest/web typecheck && pnpm --filter @itest/web lint`
Expected: 全绿（`cases.list` 的调用方 Cases.tsx 传的是字符串 priority——Task 11 改 GroupsPage 时替换 Cases.tsx；Cases.tsx 在 Task 16/17 前保留旧调用会类型报错。因此 Task 9 的 `cases.list` 需同时兼容：把签名改为 `list: (params?: string | { priority?: string; groupId?: string; projectId?: string })`，内部 `typeof params === 'string' ? { priority: params } : params`。按此实现再跑。）

最终 `cases.list` 兼容版：

```ts
    list: (params?: string | { priority?: string; groupId?: string; projectId?: string }) => {
      const p = typeof params === 'string' ? { priority: params } : params;
      const qs = new URLSearchParams();
      if (p?.priority) qs.set('priority', p.priority);
      if (p?.groupId) qs.set('groupId', p.groupId);
      if (p?.projectId) qs.set('projectId', p.projectId);
      const s = qs.toString();
      return request<TestCase[]>(`/cases${s ? `?${s}` : ''}`);
    },
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/api/client.ts
git commit -m "feat(web): api client for projects/groups/plans/copy"
```

---

### Task 10: 项目 store + 路由 + ProjectLayout + ProjectsHome

**Files:**
- Create: `apps/web/src/stores/project.ts`
- Create: `apps/web/src/components/layout/ProjectLayout.tsx`
- Create: `apps/web/src/pages/ProjectsHome.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: stores/project.ts**

创建 `apps/web/src/stores/project.ts`（模式对齐 `stores/theme.ts` 的 localStorage 持久化）：

```ts
import { create } from 'zustand';

const STORAGE_KEY = 'itest-current-project';

export interface CurrentProject {
  id: string;
  name: string;
  defaultUrl: string | null;
}

interface ProjectState {
  current: CurrentProject | null;
  enter: (p: CurrentProject) => void;
  exit: () => void;
}

function persist(p: CurrentProject | null): void {
  try {
    if (p) localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable; project context is in-memory only.
  }
}

function readStored(): CurrentProject | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v) return null;
    const parsed = JSON.parse(v) as CurrentProject;
    return typeof parsed.id === 'string' && typeof parsed.name === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export const useProjectStore = create<ProjectState>((set) => ({
  current: readStored(),

  enter: (p) => {
    set({ current: p });
    persist(p);
  },

  exit: () => {
    set({ current: null });
    persist(null);
  },
}));
```

- [ ] **Step 2: ProjectLayout.tsx（项目守卫 + 顶部栏 + 二级导航）**

创建 `apps/web/src/components/layout/ProjectLayout.tsx`：

```tsx
import type { ReactNode } from 'react';
import { NavLink, Navigate, Outlet, useNavigate, useParams } from 'react-router-dom';
import Icon from '../Icon';
import { useProjectStore } from '../../stores/project';

const NAV_ITEMS = [
  { path: 'overview', icon: 'sparkles', label: '工作台' },
  { path: 'groups', icon: 'beaker', label: '用例' },
  { path: 'requirements', icon: 'listChecks', label: '需求' },
  { path: 'plans', icon: 'play', label: '执行计划' },
  { path: 'reports', icon: 'flag', label: '报告' },
] as const;

function NavRow({ to, icon, label }: { to: string; icon: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => `group-nav-item block ${isActive ? 'nav-active' : ''}`}
      style={{ textDecoration: 'none' }}
    >
      {({ isActive }) => (
        <div
          className="flex items-center gap-2 w-full"
          style={{
            height: 36,
            padding: '0 8px',
            borderRadius: 5,
            background: isActive ? 'var(--color-accent-light)' : undefined,
            color: isActive ? 'var(--color-accent)' : 'var(--color-foreground-secondary)',
            fontWeight: isActive ? 500 : 400,
            fontSize: 13,
          }}
        >
          <Icon name={icon as never} size={14} />
          <span className="flex-1 truncate">{label}</span>
        </div>
      )}
    </NavLink>
  );
}

/** 项目内布局：守卫（store 与 URL 不一致回首页）+ 顶部栏 + 左侧二级导航。 */
export default function ProjectLayout({ children }: { children?: ReactNode }) {
  const { projectId } = useParams<{ projectId: string }>();
  const current = useProjectStore((s) => s.current);
  const exit = useProjectStore((s) => s.exit);
  const navigate = useNavigate();

  if (!current || current.id !== projectId) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 顶部栏：项目名 + 退出项目 */}
      <div
        className="flex items-center gap-3 px-5 py-2.5 shrink-0"
        style={{ borderBottom: '1px solid var(--color-glass-border)' }}
      >
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: 'var(--color-accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span style={{ color: 'white', fontSize: 9, fontWeight: 700 }}>iT</span>
        </div>
        <h1 className="text-[15px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>
          {current.name}
        </h1>
        {current.defaultUrl && (
          <span className="text-[11px] font-mono truncate" style={{ color: 'var(--color-foreground-muted)' }}>
            {current.defaultUrl}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => {
            exit();
            navigate('/');
          }}
          className="flex items-center gap-1 px-3 py-1.5 rounded-[8px] text-[12px]"
          style={{
            background: 'var(--color-background-subtle)',
            border: '1px solid var(--color-glass-border)',
            color: 'var(--color-foreground-secondary)',
            cursor: 'pointer',
          }}
        >
          <Icon name="logOut" size={12} />
          退出项目
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 二级导航 */}
        <nav
          className="shrink-0 flex flex-col"
          style={{
            width: 176,
            borderRight: '1px solid var(--color-glass-border)',
            padding: '10px 8px',
            gap: 1,
          }}
          aria-label="项目内导航"
        >
          {NAV_ITEMS.map((item) => (
            <NavRow key={item.path} to={item.path} icon={item.icon} label={item.label} />
          ))}
        </nav>
        {/* 内容区：嵌套子路由（children 为 App.tsx 旧式传参时不使用） */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <Outlet />
          {children}
        </main>
      </div>
    </div>
  );
}
```

注意：本项目 react-router 版本 6.27，`Outlet` 可用。`icon as never` 是因为 NAV_ITEMS 字面量 icon 为 string；更干净的写法是给 NAV_ITEMS 加 `as const` 并把 `icon` 类型交给 `IconName`——上面代码用 `as never` 通过，lint 不会报（无 no-explicit-any 限制 never）。若 eslint 对 `as never` 报错，改为 `icon={item.icon as import('../Icon').IconName}`。

- [ ] **Step 3: ProjectsHome.tsx**

创建 `apps/web/src/pages/ProjectsHome.tsx`：

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import EmptyState from '../components/ui/EmptyState';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';

interface FormState {
  open: boolean;
  mode: 'create' | 'edit';
  id: string | null;
  name: string;
  defaultUrl: string;
}

const EMPTY_FORM: FormState = { open: false, mode: 'create', id: null, name: '', defaultUrl: '' };

export default function ProjectsHome() {
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const enter = useProjectStore((s) => s.enter);
  const { data, isLoading } = useQuery({ queryKey: ['projects'], queryFn: api.projects.list });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const body = { name: form.name, defaultUrl: form.defaultUrl || undefined };
      if (form.mode === 'create') return api.projects.create(body);
      return api.projects.patch(form.id!, body);
    },
    onSuccess: () => {
      toast(form.mode === 'create' ? '项目已创建' : '项目已更新', 'success');
      setForm(EMPTY_FORM);
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.projects.remove(id),
    onSuccess: () => {
      toast('项目已删除', 'success');
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e: Error) => {
      // 409 not_empty：后端返回 message（errorHandler 中间件透传）
      toast(e.message.includes('409') || e.message.includes('cases') ? '项目内仍有用例，请先清空再删除' : e.message, 'error');
      setConfirmDelete(null);
    },
  });

  const openProject = (p: { id: string; name: string; defaultUrl: string | null }) => {
    enter({ id: p.id, name: p.name, defaultUrl: p.defaultUrl });
    navigate(`/p/${p.id}/overview`);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
            项目
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            选择一个项目进入工作区，或创建新项目
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>加载中...</span>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {(data ?? []).map((p) => (
              <div
                key={p.id}
                className="glass-panel rounded-[12px] p-5 cursor-pointer hover-card flex flex-col"
                style={{ minHeight: 132 }}
                onClick={() => openProject(p)}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>
                    {p.name}
                  </span>
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <button
                      title="编辑"
                      onClick={() => setForm({ open: true, mode: 'edit', id: p.id, name: p.name, defaultUrl: p.defaultUrl ?? '' })}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', padding: 3 }}
                    >
                      <Icon name="pencil" size={13} />
                    </button>
                    <button
                      title="删除"
                      onClick={() => setConfirmDelete({ id: p.id, name: p.name })}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-destructive)', padding: 3 }}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
                <div className="text-[12px] mt-1 truncate" style={{ color: 'var(--color-foreground-muted)' }}>
                  {p.defaultUrl ?? '未设置默认域名'}
                </div>
                <div className="flex-1" />
                <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--color-foreground-secondary)' }}>
                  <Icon name="beaker" size={13} />
                  {p.caseCount} 条用例
                  <span className="flex-1" />
                  <span style={{ color: 'var(--color-accent)' }}>进入 →</span>
                </div>
              </div>
            ))}

            {/* 新建项目卡片 */}
            <button
              onClick={() => setForm({ open: true, mode: 'create', id: null, name: '', defaultUrl: '' })}
              className="rounded-[12px] p-5 flex flex-col items-center justify-center gap-2"
              style={{
                minHeight: 132,
                border: '1px dashed var(--color-glass-border)',
                background: 'transparent',
                color: 'var(--color-foreground-muted)',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              <Icon name="plus" size={20} />
              新建项目
            </button>

            {(data ?? []).length === 0 && (
              <div className="col-span-full">
                <EmptyState icon="layers" title="还没有项目" description="创建第一个项目，开始组织测试资产。" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* 新建/编辑弹窗 */}
      <Dialog open={form.open} onOpenChange={(open) => setForm((f) => ({ ...f, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.mode === 'create' ? '新建项目' : '编辑项目'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input label="名称" placeholder="如：CueCast 官网" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            <Input
              label="默认域名（可空）"
              placeholder="https://example.com"
              value={form.defaultUrl}
              onChange={(e) => setForm((f) => ({ ...f, defaultUrl: e.target.value }))}
            />
            <p className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
              默认域名用于预填新建用例与录制的目标 URL；分组和用例可覆盖。
            </p>
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setForm(EMPTY_FORM)}>取消</Button>
            <Button disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? '保存中...' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={!!confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除项目</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
            确定删除「{confirmDelete?.name}」？项目内存在用例时将被拒绝删除。
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setConfirmDelete(null)}>取消</Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => confirmDelete && remove.mutate(confirmDelete.id)}
            >
              {remove.isPending ? '删除中...' : '确认删除'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 4: App.tsx 路由重写**

`apps/web/src/App.tsx` 全文替换：

```tsx
import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import ProjectLayout from './components/layout/ProjectLayout';
import { useThemeStore } from './stores/theme';
import ProjectsHome from './pages/ProjectsHome';
import Dashboard from './pages/Dashboard';
import Requirements from './pages/Requirements';
import RequirementDetail from './pages/RequirementDetail';
import GroupsPage from './pages/GroupsPage';
import CaseDetail from './pages/CaseDetail';
import Plans from './pages/Plans';
import PlanDetail from './pages/PlanDetail';
import Reports from './pages/Reports';
import ReportDetail from './pages/ReportDetail';
import Settings from './pages/Settings';

export default function App() {
  const initTheme = useThemeStore((s) => s.init);
  useEffect(() => { initTheme(); }, [initTheme]);

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<ProjectsHome />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/p/:projectId" element={<ProjectLayout />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<Dashboard />} />
          <Route path="groups" element={<GroupsPage />} />
          <Route path="groups/:groupId" element={<GroupsPage />} />
          <Route path="cases/:id" element={<CaseDetail />} />
          <Route path="requirements" element={<Requirements />} />
          <Route path="requirements/:id" element={<RequirementDetail />} />
          <Route path="plans" element={<Plans />} />
          <Route path="plans/:id" element={<PlanDetail />} />
          <Route path="reports" element={<Reports />} />
          <Route path="reports/:id" element={<ReportDetail />} />
        </Route>
        <Route path="*" element={<ProjectsHome />} />
      </Routes>
    </AppShell>
  );
}
```

注意：`/cases`、`/reports/:id` 等旧顶层路由全部移除，统一走 `/p/:projectId/...`；`*` 兜底回项目首页。

- [ ] **Step 5: Sidebar.tsx 缩减为「项目 / 设置」**

`apps/web/src/components/layout/Sidebar.tsx` 中替换 TEST_GROUP / SYSTEM_GROUP 定义：

```tsx
const TEST_GROUP: NavGroupDef = {
  id: 'workspace',
  label: '工作区',
  items: [
    { path: '/', icon: 'layers', label: '项目', end: true },
    { path: '/settings', icon: 'settings', label: '设置' },
  ],
};

const NAV_GROUPS: NavGroupDef[] = [TEST_GROUP];
```

（删除 SYSTEM_GROUP 常量与引用。）

- [ ] **Step 6: typecheck + lint（预期有红，逐个修到绿）**

Run: `pnpm --filter @itest/web typecheck && pnpm --filter @itest/web lint`
Expected: 全绿。此时 Cases.tsx 仍在（`/cases` 路由已删但它还在 import 进 App？不——Step 4 的 App.tsx 已不 import Cases）。Dashboard/Requirements 等页面尚未改造，但它们的 import 仍在且各自 typecheck 独立通过（旧 `api.requirements.list` 签名保留）。GroupsPage/Plans/PlanDetail 还不存在 → typecheck 红。**所以执行顺序上先创建占位文件**：Task 11/15 的完整实现本 Task 之后立即跟进；为让本 Task 编译通过，先建三个最小占位页（每个 export default 一个空 div），Task 11/15 再填充：

`apps/web/src/pages/GroupsPage.tsx`、`apps/web/src/pages/Plans.tsx`、`apps/web/src/pages/PlanDetail.tsx` 临时内容统一为：

```tsx
export default function Placeholder() {
  return <div />;
}
```

（占位仅存在几分钟，随后 Task 11/15 全文替换；不要 commit 占位。）

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/stores/project.ts apps/web/src/components/layout/ProjectLayout.tsx apps/web/src/pages/ProjectsHome.tsx apps/web/src/App.tsx apps/web/src/components/layout/Sidebar.tsx
git commit -m "feat(web): project workspace shell with guard and home page"
```

---

### Task 11: GroupsPage（分组树 + 用例表 + 批量操作）

**Files:**
- Create: `apps/web/src/pages/GroupsPage.tsx`（替换 Task 10 占位）
- Delete: `apps/web/src/pages/Cases.tsx`（功能被 GroupsPage 取代）
- Modify: `apps/web/src/api/client.ts`（删旧 requirements 全局签名——见 Step 5 注）

- [ ] **Step 1: GroupsPage.tsx 全文**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import PriorityBadge from '../components/ui/PriorityBadge';
import EmptyState from '../components/ui/EmptyState';
import Pagination from '../components/ui/Pagination';
import Segmented from '../components/ui/Segmented';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';
import { shortDateTime } from '../lib/format';

const PRIORITIES = ['', 'P0', 'P1', 'P2', 'P3'] as const;
const DEFAULT_PAGE_SIZE = 20;
const GRID_COLS = 'grid-cols-[minmax(28px,32px)_minmax(90px,70px)_minmax(200px,2fr)_minmax(120px,1fr)_minmax(90px,0.7fr)_minmax(100px,0.9fr)]';

type GroupForm = { open: boolean; mode: 'create' | 'edit' | 'url'; id: string | null; name: string; defaultUrl: string };
const EMPTY_GROUP_FORM: GroupForm = { open: false, mode: 'create', id: null, name: '', defaultUrl: '' };

export default function GroupsPage() {
  const { projectId, groupId } = useParams<{ projectId: string; groupId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const current = useProjectStore((s) => s.current);

  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [groupForm, setGroupForm] = useState<GroupForm>(EMPTY_GROUP_FORM);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<{ id: string; name: string } | null>(null);
  const [copyModal, setCopyModal] = useState<{ caseIds: string[] } | null>(null);
  const [planModal, setPlanModal] = useState<{ caseIds: string[] } | null>(null);
  const [copyTarget, setCopyTarget] = useState('');
  const [planTarget, setPlanTarget] = useState('');
  const [confirmDeleteCase, setConfirmDeleteCase] = useState<{ id: string; title: string } | null>(null);

  const { data: groups, isLoading: groupsLoading } = useQuery({
    queryKey: ['groups', projectId],
    queryFn: () => api.projects.groups(projectId!),
    enabled: !!projectId,
  });

  const effectiveGroupId = groupId ?? '';
  const { data: cases, isLoading: casesLoading } = useQuery({
    queryKey: ['cases', projectId, effectiveGroupId, priority],
    queryFn: () =>
      api.cases.list(effectiveGroupId ? { groupId: effectiveGroupId, priority: priority || undefined } : { projectId: projectId!, priority: priority || undefined }),
    enabled: !!projectId,
  });

  const { data: plans } = useQuery({
    queryKey: ['plans', projectId],
    queryFn: () => api.projects.plans(projectId!),
    enabled: !!projectId,
  });

  const groupName = useMemo(
    () => new Map((groups ?? []).map((g) => [g.id, g.name])),
    [groups],
  );

  // 切换分组时清空勾选
  useEffect(() => {
    setChecked(new Set());
    setPage(1);
  }, [effectiveGroupId]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['cases', projectId] });
    qc.invalidateQueries({ queryKey: ['groups', projectId] });
    qc.invalidateQueries({ queryKey: ['projects'] });
  };

  const saveGroup = useMutation({
    mutationFn: async () => {
      const body = { name: groupForm.name, defaultUrl: groupForm.defaultUrl || undefined };
      if (groupForm.mode === 'create') return api.projects.createGroup(projectId!, body);
      return api.groups.patch(groupForm.id!, body);
    },
    onSuccess: () => {
      toast('分组已保存', 'success');
      setGroupForm(EMPTY_GROUP_FORM);
      qc.invalidateQueries({ queryKey: ['groups', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const deleteGroup = useMutation({
    mutationFn: (id: string) => api.groups.remove(id),
    onSuccess: () => {
      toast('分组已删除', 'success');
      setConfirmDeleteGroup(null);
      if (effectiveGroupId) navigate(`/p/${projectId}/groups`);
      qc.invalidateQueries({ queryKey: ['groups', projectId] });
    },
    onError: (e: Error) => {
      toast(e.message.includes('409') || e.message.includes('cases') ? '分组内仍有用例，无法删除' : e.message, 'error');
      setConfirmDeleteGroup(null);
    },
  });

  const copyCases = useMutation({
    mutationFn: async ({ caseIds, targetGroupId }: { caseIds: string[]; targetGroupId: string }) => {
      if (caseIds.length === 1) return api.cases.copy(caseIds[0]!, targetGroupId);
      return api.cases.copyBatch(caseIds, targetGroupId);
    },
    onSuccess: () => {
      toast('复制完成', 'success');
      setCopyModal(null);
      setCopyTarget('');
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const addToPlan = useMutation({
    mutationFn: async ({ caseIds, planId }: { caseIds: string[]; planId: string }) => {
      // PUT 是覆盖语义：取现有 + 追加去重
      const detail = await api.plans.get(planId);
      const merged = [...detail.cases.map((c) => c.id), ...caseIds].filter((v, i, arr) => arr.indexOf(v) === i);
      return api.plans.setCases(planId, merged);
    },
    onSuccess: () => {
      toast('已加入执行计划', 'success');
      setPlanModal(null);
      setPlanTarget('');
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const deleteCase = useMutation({
    mutationFn: (id: string) => api.cases.remove(id),
    onSuccess: () => {
      toast('用例已删除', 'success');
      setConfirmDeleteCase(null);
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const rows = useMemo(() => (cases ?? []).slice((page - 1) * pageSize, page * pageSize), [cases, page, pageSize]);
  const total = cases?.length ?? 0;
  const allChecked = rows.length > 0 && rows.every((c) => checked.has(c.id));

  const toggleAll = () => {
    const next = new Set(checked);
    if (allChecked) rows.forEach((c) => next.delete(c.id));
    else rows.forEach((c) => next.add(c.id));
    setChecked(next);
  };

  const toggleOne = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };

  const checkedList = [...checked];

  return (
    <div className="flex flex-1 min-h-0">
      {/* 左侧分组树 */}
      <div
        className="shrink-0 flex flex-col overflow-y-auto"
        style={{ width: 216, borderRight: '1px solid var(--color-glass-border)', padding: '10px 8px' }}
      >
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>
            分组
          </span>
          <button
            title="新建分组"
            onClick={() => setGroupForm({ open: true, mode: 'create', id: null, name: '', defaultUrl: '' })}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', padding: 2 }}
          >
            <Icon name="plus" size={13} />
          </button>
        </div>

        <button
          onClick={() => navigate(`/p/${projectId}/groups`)}
          className="text-left px-2 py-1.5 rounded-[6px] text-[13px]"
          style={{
            background: !effectiveGroupId ? 'var(--color-accent-light)' : 'transparent',
            color: !effectiveGroupId ? 'var(--color-accent)' : 'var(--color-foreground-secondary)',
            border: 'none', cursor: 'pointer', fontWeight: !effectiveGroupId ? 500 : 400,
          }}
        >
          全部用例（{cases?.length ?? 0}）
        </button>

        {groupsLoading ? (
          <div className="flex justify-center py-4" style={{ color: 'var(--color-foreground-muted)' }}>
            <Icon name="loader" size={14} className="animate-spin" />
          </div>
        ) : (
          (groups ?? []).map((g) => (
            <div
              key={g.id}
              className="group flex items-center gap-1 px-2 py-1.5 rounded-[6px] cursor-pointer"
              style={{ background: effectiveGroupId === g.id ? 'var(--color-accent-light)' : 'transparent' }}
              onClick={() => navigate(`/p/${projectId}/groups/${g.id}`)}
            >
              <Icon name="gitBranch" size={12} style={{ color: 'var(--color-foreground-muted)', flexShrink: 0 }} />
              <span
                className="flex-1 truncate text-[13px]"
                style={{ color: effectiveGroupId === g.id ? 'var(--color-accent)' : 'var(--color-foreground-secondary)', fontWeight: effectiveGroupId === g.id ? 500 : 400 }}
                title={g.defaultUrl ?? undefined}
              >
                {g.name}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>{g.caseCount}</span>
              <span className="hidden group-hover:flex items-center" onClick={(e) => e.stopPropagation()}>
                <button
                  title="重命名"
                  onClick={() => setGroupForm({ open: true, mode: 'edit', id: g.id, name: g.name, defaultUrl: g.defaultUrl ?? '' })}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', padding: 2 }}
                >
                  <Icon name="pencil" size={11} />
                </button>
                <button
                  title="默认域名"
                  onClick={() => setGroupForm({ open: true, mode: 'url', id: g.id, name: g.name, defaultUrl: g.defaultUrl ?? '' })}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', padding: 2 }}
                >
                  <Icon name="externalLink" size={11} />
                </button>
                <button
                  title="删除分组"
                  onClick={() => setConfirmDeleteGroup({ id: g.id, name: g.name })}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-destructive)', padding: 2 }}
                >
                  <Icon name="trash" size={11} />
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      {/* 右侧用例表 */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-4 pb-0">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
              用例
            </h1>
            <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
              {effectiveGroupId ? (groupName.get(effectiveGroupId) ?? '分组') : '项目全部用例'} · {current?.name}
            </p>
          </div>
          <Segmented
            options={PRIORITIES.map((p) => ({ value: p, label: p || '全部' }))}
            value={priority}
            onChange={(v) => { setPriority(v); setPage(1); }}
          />
        </div>

        {/* 批量操作条 */}
        {checked.size > 0 && (
          <div
            className="flex items-center gap-2 mx-5 mt-3 px-3 py-2 rounded-[8px]"
            style={{ background: 'var(--color-accent-light)', border: '1px solid var(--color-glass-border)' }}
          >
            <span className="text-[12px]" style={{ color: 'var(--color-accent)' }}>已选 {checked.size} 条</span>
            <div className="flex-1" />
            <Button size="sm" variant="secondary" onClick={() => { setCopyTarget(''); setCopyModal({ caseIds: checkedList }); }}>
              <Icon name="copy" size={12} />
              批量复制
            </Button>
            <Button size="sm" variant="secondary" onClick={() => { setPlanTarget(''); setPlanModal({ caseIds: checkedList }); }}>
              <Icon name="play" size={12} />
              加入计划
            </Button>
            <Button size="sm" variant="plain" onClick={() => setChecked(new Set())}>取消选择</Button>
          </div>
        )}

        <div
          className="flex-1 min-h-0 mx-5 my-4 flex flex-col rounded-[12px] overflow-hidden"
          style={{ background: 'var(--color-background-elevated)', border: '1px solid var(--color-glass-border)', boxShadow: 'var(--shadow-card)' }}
        >
          {casesLoading ? (
            <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
              <Icon name="loader" size={16} className="animate-spin" />
              <span style={{ marginLeft: 8 }}>加载中...</span>
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon="beaker" title="还没有用例" description="到需求详情页，用 AI 从需求生成用例。" />
          ) : (
            <>
              <div className={`grid ${GRID_COLS} items-center px-5 py-[10px] shrink-0 gap-2`} style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}>
                <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="全选" />
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>优先级</span>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>标题</span>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>所属分组</span>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>状态</span>
                <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>更新时间</span>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto">
                {rows.map((c) => (
                  <div
                    key={c.id}
                    className={`grid ${GRID_COLS} items-center px-5 py-[12px] gap-2 list-row-clickable`}
                    style={{ borderBottom: '1px solid var(--color-muted)' }}
                    onClick={() => navigate(`/p/${projectId}/cases/${c.id}`)}
                  >
                    <input
                      type="checkbox"
                      checked={checked.has(c.id)}
                      onChange={() => toggleOne(c.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`选择 ${c.title}`}
                    />
                    <span><PriorityBadge priority={c.priority} /></span>
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>{c.title}</span>
                      <span className="hidden group-hover:inline-flex" onClick={(e) => e.stopPropagation()}>
                        <button
                          title="复制"
                          onClick={() => { setCopyTarget(''); setCopyModal({ caseIds: [c.id] }); }}
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', padding: 2 }}
                        >
                          <Icon name="copy" size={12} />
                        </button>
                        <button
                          title="删除"
                          onClick={() => setConfirmDeleteCase({ id: c.id, title: c.title })}
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-destructive)', padding: 2 }}
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </span>
                    </span>
                    <span className="text-[12px] truncate" style={{ color: 'var(--color-foreground-secondary)' }}>
                      {c.groupId ? (groupName.get(c.groupId) ?? '-') : '-'}
                    </span>
                    <span><StatusPill status={c.status}>{c.status}</StatusPill></span>
                    <span className="text-[11px] font-mono" style={{ color: 'var(--color-foreground-muted)' }} title={c.updatedAt}>
                      {c.updatedAt ? shortDateTime(c.updatedAt) : '-'}
                    </span>
                  </div>
                ))}
              </div>

              <Pagination
                page={page}
                pageSize={pageSize}
                total={total}
                onPageChange={setPage}
                onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
              />
            </>
          )}
        </div>
      </div>

      {/* 分组弹窗（新建/重命名/默认域名） */}
      <Dialog open={groupForm.open} onOpenChange={(open) => setGroupForm((f) => ({ ...f, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {groupForm.mode === 'create' ? '新建分组' : groupForm.mode === 'edit' ? '重命名分组' : '分组默认域名'}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            {groupForm.mode !== 'url' && (
              <Input label="名称" placeholder="如：登录与账号" value={groupForm.name} onChange={(e) => setGroupForm((f) => ({ ...f, name: e.target.value }))} />
            )}
            <Input
              label="默认域名（可空）"
              placeholder="https://example.com"
              value={groupForm.defaultUrl}
              onChange={(e) => setGroupForm((f) => ({ ...f, defaultUrl: e.target.value }))}
            />
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setGroupForm(EMPTY_GROUP_FORM)}>取消</Button>
            <Button
              disabled={(groupForm.mode !== 'url' && !groupForm.name.trim()) || saveGroup.isPending}
              onClick={() => saveGroup.mutate()}
            >
              {saveGroup.isPending ? '保存中...' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除分组确认 */}
      <Dialog open={!!confirmDeleteGroup} onOpenChange={(open) => { if (!open) setConfirmDeleteGroup(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>删除分组</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
            确定删除「{confirmDeleteGroup?.name}」？分组内存在用例时将被拒绝删除。
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setConfirmDeleteGroup(null)}>取消</Button>
            <Button variant="danger" disabled={deleteGroup.isPending} onClick={() => confirmDeleteGroup && deleteGroup.mutate(confirmDeleteGroup.id)}>
              {deleteGroup.isPending ? '删除中...' : '确认删除'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除用例确认 */}
      <Dialog open={!!confirmDeleteCase} onOpenChange={(open) => { if (!open) setConfirmDeleteCase(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>删除用例</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--color-foreground-secondary)' }}>
            确定删除「{confirmDeleteCase?.title}」？该用例的步骤与报告将一并删除。
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setConfirmDeleteCase(null)}>取消</Button>
            <Button variant="danger" disabled={deleteCase.isPending} onClick={() => confirmDeleteCase && deleteCase.mutate(confirmDeleteCase.id)}>
              {deleteCase.isPending ? '删除中...' : '确认删除'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 复制目标分组弹窗 */}
      <Dialog open={!!copyModal} onOpenChange={(open) => { if (!open) setCopyModal(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>复制用例（{copyModal?.caseIds.length} 条）</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-secondary)' }}>目标分组</label>
            <select className="input-base" value={copyTarget} onChange={(e) => setCopyTarget(e.target.value)}>
              <option value="">请选择</option>
              {(groups ?? []).map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <p className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
              副本命名：原名 +「副本」，重名自动追加数字（副本1、副本2…）。
            </p>
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setCopyModal(null)}>取消</Button>
            <Button
              disabled={!copyTarget || copyCases.isPending}
              onClick={() => copyModal && copyCases.mutate({ caseIds: copyModal.caseIds, targetGroupId: copyTarget })}
            >
              {copyCases.isPending ? '复制中...' : '复制'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 加入计划弹窗 */}
      <Dialog open={!!planModal} onOpenChange={(open) => { if (!open) setPlanModal(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>加入执行计划（{planModal?.caseIds.length} 条）</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-secondary)' }}>选择计划</label>
            <select className="input-base" value={planTarget} onChange={(e) => setPlanTarget(e.target.value)}>
              <option value="">请选择</option>
              {(plans ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.environment ? `（${p.environment}）` : ''}</option>
              ))}
            </select>
            {(plans ?? []).length === 0 && (
              <p className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                还没有执行计划，请先到「执行计划」页创建。
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setPlanModal(null)}>取消</Button>
            <Button
              disabled={!planTarget || addToPlan.isPending}
              onClick={() => planModal && addToPlan.mutate({ caseIds: planModal.caseIds, planId: planTarget })}
            >
              {addToPlan.isPending ? '添加中...' : '加入'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

注意：`checkedList` 在批量条渲染时快照；`copyModal`/`planModal` 打开时再快照一次 caseIds 更稳——上面 `setCopyModal({ caseIds: checkedList })` 的 `checkedList` 是渲染期闭包值，勾选状态变化时模态已开不受影响（caseIds 已固化进 state），可用。

- [ ] **Step 2: 删除 Cases.tsx**

`apps/web/src/pages/Cases.tsx` 功能被 GroupsPage 完全取代（含优先级过滤、分页、空态）。删除文件并确认无 import 残留：

Run: `pnpm --filter @itest/web typecheck`
Expected: 若报 `Cannot find module './pages/Cases'`（App.tsx 旧 import），确认 Step 1 已替换 App.tsx（Task 10 完成）。红即修。

```bash
rm apps/web/src/pages/Cases.tsx
```

- [ ] **Step 3: typecheck + lint**

Run: `pnpm --filter @itest/web typecheck && pnpm --filter @itest/web lint`
Expected: 全绿。`TestCase.createdAt/updatedAt` 在 Task 9 类型里加了可选字段，GroupsPage 用 `c.updatedAt` 不报错。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/GroupsPage.tsx apps/web/src/pages/Cases.tsx
git commit -m "feat(web): group tree case list with batch copy and add-to-plan"
```

---

### Task 12: CaseDetail（面包屑 + 移动分组 + 录制 URL 预填）

**Files:**
- Modify: `apps/web/src/pages/CaseDetail.tsx`

- [ ] **Step 1: 顶部面包屑改造**

把 Header bar 的「返回用例列表」按钮段（`onClick={() => navigate('/cases')}` 的 button + 分隔线）替换为面包屑：

```tsx
  const { projectId } = useParams<{ projectId: string }>();
  const { data: groups } = useQuery({
    queryKey: ['groups', projectId],
    queryFn: () => api.projects.groups(projectId!),
    enabled: !!projectId,
  });
  const group = groups?.find((g) => g.id === caseDetail.groupId);

  // header 内替换返回按钮：
  <button
    onClick={() => navigate(`/p/${projectId}/groups/${caseDetail.groupId ?? ''}`)}
    className="flex items-center gap-1 text-[12px]"
    style={{ color: 'var(--color-foreground-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
  >
    <Icon name="arrowLeft" size={12} />
    {group?.name ?? '用例列表'}
  </button>
```

并在 `useParams` 处改签名：`const { id, projectId } = useParams<{ id: string; projectId: string }>();`

- [ ] **Step 2: 「所属分组」选择器（移动用例）**

在右侧操作栏最上方（「AI 补充」卡片之前）插入：

```tsx
  const moveGroup = useMutation({
    mutationFn: (groupId: string) => api.cases.patch(id!, { groupId }),
    onSuccess: () => {
      toast('已移动分组', 'success');
      qc.invalidateQueries({ queryKey: ['case', id] });
      qc.invalidateQueries({ queryKey: ['cases', projectId] });
      qc.invalidateQueries({ queryKey: ['groups', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  // JSX — 右侧栏第一格：
  <div className="glass-card rounded-[12px] p-4">
    <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-2" style={{ color: 'var(--color-foreground-muted)' }}>
      所属分组
    </div>
    <select
      className="input-base input-sm"
      value={caseDetail.groupId ?? ''}
      disabled={moveGroup.isPending}
      onChange={(e) => moveGroup.mutate(e.target.value)}
    >
      {(groups ?? []).map((g) => (
        <option key={g.id} value={g.id}>{g.name}</option>
      ))}
    </select>
    <p className="text-[11px] mt-2" style={{ color: 'var(--color-foreground-muted)' }}>
      录制目标 URL 解析链：用例 URL → 分组域名 → 项目域名。
    </p>
  </div>
```

- [ ] **Step 3: 录制 URL 预填 resolvedUrl**

`startRecording` 的 `onSuccess` 里若 `targetUrl` 为空则用 session 的 resolvedUrl：

```ts
    onSuccess: (session) => {
      if (!targetUrl && session.resolvedUrl) setTargetUrl(session.resolvedUrl);
    },
```

同时 `stopRecording` 成功后把 `setTargetUrl('')` 清掉（在 `recorder.reset()` 后加一行）。

另外把录制 URL 输入框 label 下加提示：已在 Step 2 的「所属分组」卡里说明解析链，无需重复。

- [ ] **Step 4: typecheck + lint + Commit**

Run: `pnpm --filter @itest/web typecheck && pnpm --filter @itest/web lint`
Expected: 全绿

```bash
git add apps/web/src/pages/CaseDetail.tsx
git commit -m "feat(web): case detail breadcrumb, group move, resolvedUrl prefill"
```

---

### Task 13: RequirementDetail（目标分组选择器）

**Files:**
- Modify: `apps/web/src/pages/RequirementDetail.tsx`

- [ ] **Step 1: 目标分组 state + 查询**

```tsx
  const { projectId } = useParams<{ id: string; projectId: string }>();
  const { data: groups } = useQuery({
    queryKey: ['groups', projectId],
    queryFn: () => api.projects.groups(projectId!),
    enabled: !!projectId,
  });
  const [targetGroupId, setTargetGroupId] = useState<string>('');
```

`useEffect` 在 groups 加载后兜底：`if (!targetGroupId && groups?.[0]) setTargetGroupId(groups[0].id);`

`generateCases.mutationFn` 里 `api.agentRuns.create` body 加 `targetGroupId`，且开头校验：

```ts
      if (!targetGroupId) throw new Error('请选择目标分组');
      const run = await api.agentRuns.create({
        targetType: 'requirement2cases',
        targetId: id!,
        prompt: req?.content ?? '',
        targetGroupId,
      });
```

- [ ] **Step 2: 按钮旁加选择器**

在「AI 生成用例」按钮前插入：

```tsx
        <select
          className="input-base input-sm"
          style={{ width: 160 }}
          value={targetGroupId}
          onChange={(e) => setTargetGroupId(e.target.value)}
          aria-label="目标分组"
        >
          <option value="" disabled>目标分组…</option>
          {(groups ?? []).map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
```

按钮 disabled 条件加 `|| !targetGroupId`。

- [ ] **Step 3: typecheck + lint + Commit**

Run: `pnpm --filter @itest/web typecheck && pnpm --filter @itest/web lint`
Expected: 全绿

```bash
git add apps/web/src/pages/RequirementDetail.tsx
git commit -m "feat(web): requirement2cases target group selector"
```

---

### Task 14: Requirements 页面项目化

**Files:**
- Modify: `apps/web/src/pages/Requirements.tsx`
- Modify: `apps/web/src/api/client.ts`（删除旧全局 list/create 签名）

- [ ] **Step 1: Requirements.tsx 全文替换**

```tsx
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import Pagination from '../components/ui/Pagination';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';
import { shortDateTime, fullDateTime } from '../lib/format';

const DEFAULT_PAGE_SIZE = 20;
const GRID_COLS = 'grid-cols-[minmax(240px,2fr)_minmax(90px,0.7fr)_minmax(120px,1fr)]';

export default function Requirements() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['requirements', projectId],
    queryFn: () => api.projects.requirements(projectId!),
    enabled: !!projectId,
  });

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const create = useMutation({
    mutationFn: () => api.projects.createRequirement(projectId!, { title, content }),
    onSuccess: () => {
      setTitle('');
      setContent('');
      setShowCreate(false);
      toast('需求已创建', 'success');
      qc.invalidateQueries({ queryKey: ['requirements', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const filtered = useMemo(() => {
    const list = data ?? [];
    if (!search.trim()) return list;
    return list.filter((r) => r.title.includes(search.trim()));
  }, [data, search]);

  const total = filtered.length;
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
            需求
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            AI 分析需求，生成测试用例
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-4 py-[7px] rounded-[8px] text-[13px] font-semibold bg-accent hover:bg-accent-hover active:scale-[0.97] transition-[background-color,transform] duration-150"
        >
          <Icon name="plus" size={14} />
          新建需求
        </button>
      </div>

      <div className="flex items-center gap-2.5 px-5 py-3">
        <div className="input-wrap flex-1">
          <Icon name="search" size={14} className="input-icon" />
          <input
            type="text"
            placeholder="搜索需求标题"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="input-base input-sm input-with-leading"
          />
        </div>
      </div>

      <div
        className="flex-1 min-h-0 mx-5 mb-5 flex flex-col rounded-[12px] overflow-hidden"
        style={{ background: 'var(--color-background-elevated)', border: '1px solid var(--color-glass-border)', boxShadow: 'var(--shadow-card)' }}
      >
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>加载中...</span>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="listChecks"
            title={search ? '没有匹配的需求' : '还没有需求'}
            description={search ? undefined : '新建一条需求，然后用 AI 生成测试用例。'}
            action={!search ? <Button size="sm" onClick={() => setShowCreate(true)}>+ 新建需求</Button> : undefined}
          />
        ) : (
          <>
            <div className={`grid ${GRID_COLS} items-center px-5 py-[10px] shrink-0`} style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>标题</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>状态</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>创建时间</span>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {rows.map((r) => (
                <div
                  key={r.id}
                  onClick={() => navigate(`/p/${projectId}/requirements/${r.id}`)}
                  className={`grid ${GRID_COLS} items-center px-5 py-[12px] cursor-pointer transition-colors list-row-clickable`}
                  style={{ borderBottom: '1px solid var(--color-muted)' }}
                >
                  <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>
                    {r.title}
                  </span>
                  <span>
                    <StatusPill status={r.status}>{r.status}</StatusPill>
                  </span>
                  <span className="text-[11px] font-mono" style={{ color: 'var(--color-foreground-muted)' }} title={fullDateTime(r.createdAt)}>
                    {shortDateTime(r.createdAt)}
                  </span>
                </div>
              ))}
            </div>

            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
            />
          </>
        )}
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建需求</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input label="标题" placeholder="需求标题" value={title} onChange={(e) => setTitle(e.target.value)} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-secondary)' }}>需求描述</label>
              <textarea
                className="input-base"
                placeholder="详细描述需求内容，供 AI 生成用例"
                rows={5}
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setShowCreate(false)}>取消</Button>
            <Button disabled={!title || !content || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? '创建中...' : '创建'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

（与原文件唯一实质差异：`api.projects.requirements/createRequirement(projectId)`、queryKey 带 projectId、跳转 `/p/${projectId}/requirements/${r.id}`。）

- [ ] **Step 2: 检查旧签名残留**

Run: `pnpm --filter @itest/web typecheck`
Expected: 全绿。此时 `api.requirements.list/create` 应已无调用方。grep 确认：

Run: `grep -rn "api.requirements.list\|api.requirements.create" apps/web/src`
Expected: 无输出。

- [ ] **Step 3: 删除旧全局签名 + Commit**

`apps/web/src/api/client.ts` 的 `requirements` 段改为：

```ts
  requirements: {
    get: (id: string) => request<Requirement>(`/requirements/${id}`),
  },
```

Run: `pnpm --filter @itest/web typecheck && pnpm --filter @itest/web lint`
Expected: 全绿

```bash
git add apps/web/src/pages/Requirements.tsx apps/web/src/api/client.ts
git commit -m "feat(web): requirements scoped to current project"
```

---

### Task 15: Plans + PlanDetail（执行计划列表/详情/一键运行）

**Files:**
- Create: `apps/web/src/pages/Plans.tsx`（替换 Task 10 占位）
- Create: `apps/web/src/pages/PlanDetail.tsx`（替换 Task 10 占位）

- [ ] **Step 1: Plans.tsx 全文**

```tsx
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import EmptyState from '../components/ui/EmptyState';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';

export default function Plans() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['plans', projectId],
    queryFn: () => api.projects.plans(projectId!),
    enabled: !!projectId,
  });

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('');

  const create = useMutation({
    mutationFn: () => api.projects.createPlan(projectId!, { name, environment: environment || undefined }),
    onSuccess: () => {
      setName('');
      setEnvironment('');
      setShowCreate(false);
      toast('计划已创建', 'success');
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
            执行计划
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            按环境组织回归用例，一键串行运行
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-4 py-[7px] rounded-[8px] text-[13px] font-semibold bg-accent hover:bg-accent-hover active:scale-[0.97] transition-[background-color,transform] duration-150"
        >
          <Icon name="plus" size={14} />
          新建计划
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>加载中...</span>
          </div>
        ) : (data ?? []).length === 0 ? (
          <EmptyState icon="play" title="还没有执行计划" description="创建计划，把关键用例加入冒烟或回归集。" action={
            <Button size="sm" onClick={() => setShowCreate(true)}>+ 新建计划</Button>
          } />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
            {(data ?? []).map((p) => (
              <div
                key={p.id}
                className="glass-panel rounded-[12px] p-5 cursor-pointer hover-card flex flex-col"
                style={{ minHeight: 120 }}
                onClick={() => navigate(`/p/${projectId}/plans/${p.id}`)}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-semibold truncate" style={{ color: 'var(--color-foreground)' }}>
                    {p.name}
                  </span>
                  {p.environment && (
                    <span
                      className="text-[11px] px-2 py-0.5 rounded-full"
                      style={{ background: 'var(--color-background-subtle)', color: 'var(--color-foreground-secondary)' }}
                    >
                      {p.environment}
                    </span>
                  )}
                </div>
                <div className="flex-1" />
                <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--color-foreground-secondary)' }}>
                  <Icon name="listChecks" size={13} />
                  {p.caseCount} 条用例
                  <span className="flex-1" />
                  <span style={{ color: 'var(--color-accent)' }}>详情 →</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建执行计划</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input label="名称" placeholder="如：预发冒烟" value={name} onChange={(e) => setName(e.target.value)} />
            <Input label="环境（可空）" placeholder="如：预发 / 生产" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => setShowCreate(false)}>取消</Button>
            <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? '创建中...' : '创建'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 2: PlanDetail.tsx 全文**

```tsx
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type PlanDetail } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Button from '../components/ui/Button';

export default function PlanDetailPage() {
  const { projectId, id } = useParams<{ projectId: string; id: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const { data: plan, isLoading } = useQuery({
    queryKey: ['plan', id],
    queryFn: () => api.plans.get(id!),
    enabled: !!id,
  });
  const { data: cases } = useQuery({
    queryKey: ['cases', projectId],
    queryFn: () => api.cases.list({ projectId: projectId! }),
    enabled: !!projectId,
  });

  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Array<{ caseId: string; reportId: string; status: string }> | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [pending, setPending] = useState<string[] | null>(null);

  // pending 为本地编辑态（上移/下移/移除后未保存的顺序）
  const orderedIds: string[] = pending ?? plan?.cases.map((c) => c.id) ?? [];

  const saveOrder = useMutation({
    mutationFn: (caseIds: string[]) => api.plans.setCases(id!, caseIds),
    onSuccess: () => {
      setPending(null);
      qc.invalidateQueries({ queryKey: ['plan', id] });
      qc.invalidateQueries({ queryKey: ['plans', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const runAll = useMutation({
    mutationFn: () => api.plans.run(id!),
    onSuccess: (r) => {
      setResults(r.results);
      const passed = r.results.filter((x) => x.status === 'passed').length;
      toast(`运行完成：${passed}/${r.results.length} 通过`, passed === r.results.length ? 'success' : 'error');
      qc.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
    onSettled: () => setRunning(false),
  });

  if (isLoading || !plan) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>加载中...</span>
      </div>
    );
  }

  const caseTitle = new Map((cases ?? []).map((c) => [c.id, c.title]));

  const move = (index: number, dir: -1 | 1) => {
    const next = [...orderedIds];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j]!, next[index]!];
    setPending(next);
  };

  const removeAt = (index: number) => {
    const next = orderedIds.filter((_, i) => i !== index);
    setPending(next.length ? next : null);
    // 空列表后端拒绝 min(1)，直接保存空需走 delete-plan 语义；这里移除最后一个时提示用户删除计划
    if (next.length === 0) toast('计划已无用例，保存将失败；如需清空请删除计划', 'error');
  };

  const resultByCase = new Map((results ?? []).map((r) => [r.caseId, r]));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-5 pt-4 pb-0">
        <button
          onClick={() => navigate(`/p/${projectId}/plans`)}
          className="flex items-center gap-1 text-[12px]"
          style={{ color: 'var(--color-foreground-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          <Icon name="arrowLeft" size={12} />
          返回计划列表
        </button>
        <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
          {plan.name}
        </h1>
        {plan.environment && (
          <span className="text-[12px] px-2 py-0.5 rounded-full" style={{ background: 'var(--color-background-subtle)', color: 'var(--color-foreground-secondary)' }}>
            {plan.environment}
          </span>
        )}
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => setShowAdd(true)}>
          <Icon name="plus" size={12} />
          加入用例
        </Button>
        {pending ? (
          <>
            <Button variant="plain" onClick={() => setPending(null)}>放弃修改</Button>
            <Button disabled={saveOrder.isPending} onClick={() => saveOrder.mutate(orderedIds)}>
              {saveOrder.isPending ? '保存中...' : '保存顺序'}
            </Button>
          </>
        ) : (
          <Button
            disabled={running || orderedIds.length === 0}
            onClick={() => {
              setRunning(true);
              setResults(null);
              runAll.mutate();
            }}
          >
            <Icon name="play" size={12} />
            {running ? '运行中...' : '运行全部'}
          </Button>
        )}
      </div>

      {running && (
        <div className="mx-5 mt-3 px-3 py-2 rounded-[8px] text-[12px] flex items-center gap-2" style={{ background: 'var(--color-accent-light)', color: 'var(--color-accent)' }}>
          <Icon name="loader" size={13} className="animate-spin" />
          正在串行执行计划内用例，请稍候（运行期间请勿重复点击）...
        </div>
      )}

      {results && !running && (
        <div className="mx-5 mt-3 px-3 py-2 rounded-[8px] text-[12px] flex items-center gap-3" style={{ background: 'var(--color-background-subtle)', border: '1px solid var(--color-glass-border)' }}>
          <span style={{ color: 'var(--color-foreground)' }}>
            本次运行：{results.filter((r) => r.status === 'passed').length} 通过 / {results.filter((r) => r.status === 'failed').length} 失败
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="plain" onClick={() => navigate(`/p/${projectId}/reports`)}>查看报告</Button>
        </div>
      )}

      <div
        className="flex-1 min-h-0 mx-5 my-4 flex flex-col rounded-[12px] overflow-hidden"
        style={{ background: 'var(--color-background-elevated)', border: '1px solid var(--color-glass-border)', boxShadow: 'var(--shadow-card)' }}
      >
        {orderedIds.length === 0 ? (
          <EmptyState icon="listChecks" title="计划内还没有用例" description="点击右上角「加入用例」，从当前项目用例中挑选。" action={
            <Button size="sm" onClick={() => setShowAdd(true)}>+ 加入用例</Button>
          } />
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {orderedIds.map((caseId, i) => {
              const r = resultByCase.get(caseId);
              return (
                <div
                  key={caseId}
                  className="flex items-center gap-3 px-5 py-[12px] list-row-clickable"
                  style={{ borderBottom: '1px solid var(--color-muted)' }}
                  onClick={() => navigate(`/p/${projectId}/cases/${caseId}`)}
                >
                  <span className="text-[11px] font-mono w-6" style={{ color: 'var(--color-foreground-muted)' }}>{i + 1}</span>
                  <span className="flex-1 truncate text-[13px] font-semibold" style={{ color: 'var(--color-foreground)' }}>
                    {caseTitle.get(caseId) ?? plan.cases.find((c) => c.id === caseId)?.title ?? caseId.slice(0, 8)}
                  </span>
                  {r && <StatusPill status={r.status}>{r.status}</StatusPill>}
                  <span className="flex items-center" onClick={(e) => e.stopPropagation()}>
                    <button title="上移" onClick={() => move(i, -1)} disabled={i === 0}
                      style={{ background: 'transparent', border: 'none', cursor: i === 0 ? 'default' : 'pointer', color: 'var(--color-foreground-muted)', opacity: i === 0 ? 0.3 : 1, padding: 3 }}>
                      <Icon name="chevronUp" size={12} />
                    </button>
                    <button title="下移" onClick={() => move(i, 1)} disabled={i === orderedIds.length - 1}
                      style={{ background: 'transparent', border: 'none', cursor: i === orderedIds.length - 1 ? 'default' : 'pointer', color: 'var(--color-foreground-muted)', opacity: i === orderedIds.length - 1 ? 0.3 : 1, padding: 3 }}>
                      <Icon name="chevronDown" size={12} />
                    </button>
                    <button title="从计划移除" onClick={() => removeAt(i)}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-destructive)', padding: 3 }}>
                      <Icon name="close" size={12} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 加入用例弹窗 */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>加入用例到「{plan.name}」</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col px-5 py-4 max-h-[50vh] overflow-y-auto">
            {(cases ?? [])
              .filter((c) => !orderedIds.includes(c.id))
              .map((c) => (
                <label key={c.id} className="flex items-center gap-2 py-2 cursor-pointer" style={{ borderBottom: '1px solid var(--color-muted)' }}>
                  <input
                    type="checkbox"
                    checked={pendingAdds.has(c.id)}
                    onChange={() => toggleAdd(c.id)}
                  />
                  <span className="text-[13px]" style={{ color: 'var(--color-foreground)' }}>{c.title}</span>
                </label>
              ))}
            {(cases ?? []).filter((c) => !orderedIds.includes(c.id)).length === 0 && (
              <p className="text-[12px] py-4" style={{ color: 'var(--color-foreground-muted)' }}>当前项目用例已全部在计划中。</p>
            )}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="plain" onClick={() => { setShowAdd(false); setPendingAdds(new Set()); }}>取消</Button>
            <Button
              disabled={pendingAdds.size === 0 || saveOrder.isPending}
              onClick={() => saveOrder.mutate([...orderedIds, ...pendingAdds])}
            >
              {saveOrder.isPending ? '添加中...' : `加入 ${pendingAdds.size} 条`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

上面引用了 `pendingAdds` / `toggleAdd`——在组件顶部补：

```tsx
  const [pendingAdds, setPendingAdds] = useState<Set<string>>(new Set());
  const toggleAdd = (caseId: string) => {
    const next = new Set(pendingAdds);
    if (next.has(caseId)) next.delete(caseId);
    else next.add(caseId);
    setPendingAdds(next);
  };
```

并删掉未用的 `PlanDetail` 类型 import（`import { api } from '../api/client';` 即可；若保留 type 引用会 lint 报 unused）。

- [ ] **Step 3: typecheck + lint + Commit**

Run: `pnpm --filter @itest/web typecheck && pnpm --filter @itest/web lint`
Expected: 全绿

```bash
git add apps/web/src/pages/Plans.tsx apps/web/src/pages/PlanDetail.tsx
git commit -m "feat(web): execution plan list/detail with serial run-all"
```

---

### Task 16: Dashboard 重写为项目工作台

**Files:**
- Modify: `apps/web/src/pages/Dashboard.tsx`

- [ ] **Step 1: Dashboard.tsx 全文替换**

```tsx
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useProjectStore } from '../stores/project';
import Icon from '../components/Icon';
import StatusPill from '../components/ui/StatusPill';
import EmptyState from '../components/ui/EmptyState';
import { fullDateTime } from '../lib/format';

export default function Dashboard() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const current = useProjectStore((s) => s.current);
  const stats = useQuery({
    queryKey: ['project-stats', projectId],
    queryFn: () => api.projects.stats(projectId!),
    enabled: !!projectId,
  });
  const { data: casesData } = useQuery({
    queryKey: ['cases', projectId],
    queryFn: () => api.cases.list({ projectId: projectId! }),
    enabled: !!projectId,
  });
  const caseTitleMap = new Map((casesData ?? []).map((c) => [c.id, c.title]));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
            工作台
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            {current?.name} · 需求 → 用例 → 执行 全链路概览
          </p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 px-5 pt-4">
        {stats.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="glass-panel rounded-[12px] p-5 flex items-center justify-center" style={{ minHeight: 92, color: 'var(--color-foreground-muted)' }}>
              <Icon name="loader" size={16} className="animate-spin" />
            </div>
          ))
        ) : (
          [
            { label: '需求', value: stats.data?.requirements ?? 0, icon: 'listChecks', to: 'requirements', tone: 'var(--color-accent)' },
            { label: '用例', value: stats.data?.cases ?? 0, icon: 'beaker', to: 'groups', tone: 'var(--color-info)' },
            { label: '通过报告', value: stats.data?.passes ?? 0, icon: 'checkCircle', to: 'reports', tone: 'var(--color-success)' },
            { label: '失败报告', value: stats.data?.failures ?? 0, icon: 'exclamationCircle', to: 'reports', tone: 'var(--color-destructive)' },
          ].map((c) => (
            <div
              key={c.label}
              onClick={() => navigate(c.to)}
              className="glass-panel rounded-[12px] p-5 cursor-pointer hover-card"
              style={{ minHeight: 92 }}
            >
              <div className="flex items-center justify-between">
                <span style={{ fontSize: 12, color: 'var(--color-foreground-secondary)' }}>{c.label}</span>
                <Icon name={c.icon} size={14} style={{ color: c.tone }} />
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, marginTop: 8, color: c.tone, lineHeight: 1 }}>
                {c.value}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 分组用例分布 */}
      <div className="mx-5 mt-4 rounded-[12px] overflow-hidden" style={{ background: 'var(--color-background-elevated)', border: '1px solid var(--color-glass-border)', boxShadow: 'var(--shadow-card)' }}>
        <div className="px-5 py-[10px]" style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}>
          <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>
            分组用例分布
          </span>
        </div>
        <div className="px-5 py-3 flex flex-wrap gap-2">
          {(stats.data?.groups ?? []).map((g) => (
            <button
              key={g.id}
              onClick={() => navigate(`groups/${g.id}`)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px]"
              style={{ background: 'var(--color-background-subtle)', border: '1px solid var(--color-glass-border)', color: 'var(--color-foreground-secondary)', cursor: 'pointer' }}
            >
              <Icon name="gitBranch" size={11} />
              {g.name}
              <span style={{ color: 'var(--color-foreground-muted)' }}>{g.caseCount}</span>
            </button>
          ))}
          {(stats.data?.groups ?? []).length === 0 && (
            <span className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>还没有分组，到「用例」页创建。</span>
          )}
        </div>
      </div>

      {/* 最近运行 */}
      <div className="flex-1 min-h-0 mx-5 mb-5 mt-4 flex flex-col rounded-[12px] overflow-hidden"
        style={{ background: 'var(--color-background-elevated)', border: '1px solid var(--color-glass-border)', boxShadow: 'var(--shadow-card)' }}
      >
        <div className="px-5 py-[10px] shrink-0" style={{ background: 'var(--color-background-subtle)', borderBottom: '1px solid var(--color-border)' }}>
          <span className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--color-foreground-muted)' }}>
            最近运行
          </span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {stats.data && stats.data.recentRuns.length === 0 ? (
            <EmptyState icon="activity" title="还没有运行" description="到用例详情页或执行计划页运行用例，结果会在这里汇总。" />
          ) : (
            (stats.data?.recentRuns ?? []).map((r) => (
              <div
                key={r.id}
                onClick={() => navigate(`reports/${r.id}`)}
                className="flex items-center gap-4 px-5 py-[12px] cursor-pointer list-row-clickable"
                style={{ borderBottom: '1px solid var(--color-muted)' }}
              >
                <Icon name="play" size={14} style={{ color: 'var(--color-foreground-muted)' }} />
                <span className="flex-1 truncate" style={{ fontSize: 13, color: 'var(--color-foreground)' }}>
                  {caseTitleMap.get(r.caseId) ?? r.caseId.slice(0, 8)}
                </span>
                <StatusPill status={r.status} pulse={r.status === 'running'}>{r.status}</StatusPill>
                <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--color-foreground-muted)' }} title={fullDateTime(r.createdAt)}>
                  {new Date(r.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
```

注意：相对导航 `navigate('requirements')` 依赖 react-router 相对路径解析（`Route` 无 trailing `*` 时相对 to 基于当前路径 `/p/:id/overview` → `/p/:id/requirements`）。react-router 6 中从 `/p/x/overview` 相对跳 `requirements` 会替换最后一段得到 `/p/x/requirements`——正确。若实测行为不符，改为绝对模板 `` `/p/${projectId}/requirements` ``。

- [ ] **Step 2: typecheck + lint + Commit**

Run: `pnpm --filter @itest/web typecheck && pnpm --filter @itest/web lint`
Expected: 全绿

```bash
git add apps/web/src/pages/Dashboard.tsx
git commit -m "feat(web): project overview dashboard with stats endpoint"
```

---

### Task 17: Reports 项目过滤 + 全量验收

**Files:**
- Modify: `apps/web/src/pages/Reports.tsx`
- Modify: `apps/web/src/pages/ReportDetail.tsx`（面包屑返回路径）

- [ ] **Step 1: Reports.tsx 项目化**

改动三处：

```tsx
import { useParams } from 'react-router-dom';
// ...
export default function Reports() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['reports', projectId],
    queryFn: () => api.reports.list(projectId),
    enabled: !!projectId,
  });
  // 行点击跳转改为：navigate(`/p/${projectId}/reports/${r.id}`)
```

- [ ] **Step 2: ReportDetail.tsx 面包屑**

把返回按钮路径改为动态（`useParams<{ id: string; projectId: string }>()` 取 projectId，不存在时回退 `/`）：

```tsx
  const { id, projectId } = useParams<{ id: string; projectId: string }>();
  // 返回按钮：
  <button onClick={() => navigate(projectId ? `/p/${projectId}/reports` : '/') } ...>
```

先读 `ReportDetail.tsx` 确认现有 header 结构再改，其余不动。

- [ ] **Step 3: 全量 verify**

Run: `pnpm verify`
Expected: 全绿（lint + typecheck + test，含 Part 1 后端测试）。

- [ ] **Step 4: 手动验收清单（pnpm dev）**

前置：Docker 运行，`pnpm dev`（自动 migrate）。依次验证 spec 第 9 节：

1. 首页 `/` 出现项目卡片网格；「新建项目」弹窗创建「CueCast 官网」（默认域名 https://cuecast.test）。
2. 点击卡片进入 `/p/:id/overview`，顶部栏显示项目名与域名，左侧二级导航 5 项。
3. 直接访问 `/p/0000.../overview`（store 无此项目）→ 重定向回 `/`。
4. 「用例」页左侧建分组「登录与账号」；右侧显示全部用例（含迁移默认分组下的存量用例）。
5. 需求详情页生成用例：必须选目标分组，生成的用例落在该分组。
6. 用例详情页：面包屑显示分组名；「所属分组」下拉移动用例；录制目标 URL 空时自动带出解析链 URL（项目/分组域名）。
7. 勾选 2 条用例 → 批量复制到另一分组 → 名称 `X 副本`、`Y 副本`；再复制出现 `副本1`。
8. 分组内有用例时删除分组 → toast 拒绝；空分组可删。项目同理。
9. 执行计划：新建「预发冒烟」→ 加入 2 条用例 → 「运行全部」→ 运行中按钮置灰 → 完成后汇总条显示 x 通过 / y 失败 → 「查看报告」跳报告页且只显示当前项目报告。
10. 顶部「退出项目」回 `/`，再进另一项目，所有页面只显示该项目数据。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Reports.tsx apps/web/src/pages/ReportDetail.tsx
git commit -m "feat(web): reports filtered by current project"
```

---

## Part 2 完成标准

- `pnpm verify` 全绿（web + api + shared + recorder）
- spec 第 9 节验收清单 10 条手动走通
- 旧路由 `/cases`、`/requirements` 等直接访问均重定向或落到项目首页（`*` 兜底 + Guard）
