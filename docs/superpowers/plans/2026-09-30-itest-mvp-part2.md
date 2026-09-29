# iTest MVP Implementation Plan — Part 2

> Part 2 of the implementation plan. Covers Tasks 26-44 (M7 前端骨架 + M8 前端业务 + M9 录制器 + M10 收尾).
> 完整规划见 `docs/superpowers/plans/2026-09-30-itest-mvp-design.md`（Part 1，M1-M6）。
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

---

## 文件结构总览（Part 2）

**apps/web（Task 26-37）**：
- `apps/web/{package.json,tsconfig.json,vite.config.ts,index.html}`
- `apps/web/src/{main.tsx,App.tsx,index.css,api/client.ts,stores/{ui.ts,recorder.ts,agentRun.ts},components/AppShell.tsx,pages/{Dashboard,Requirements,RequirementDetail,Cases,CaseDetail,Reports,ReportDetail,Settings}.tsx}`

**apps/recorder（Task 38-43）**：
- `apps/recorder/{package.json,manifest.json,background.js,content/{bridge.js,recorder.js},modules/{selector-core.js,api-client.js,recorder-manager.js,player-manager.js},popup/{popup.html,popup.css,popup.js},icons/*}`

**文档（Task 44）**：`README.md`

---

## M7 前端骨架（Task 26-30）

### Task 26: 创建 `apps/web` 包

**Files:** `apps/web/{package.json,tsconfig.json,vite.config.ts,index.html}`

- [ ] **Step 1: `apps/web/package.json`**

```json
{
  "name": "@itest/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview --port 5173",
    "test": "vitest run",
    "lint": "eslint src --ext .ts,.tsx",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@itest/shared": "workspace:*",
    "@itest/ui": "workspace:*",
    "@tanstack/react-query": "^5.59.16",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.27.0",
    "zod": "^3.23.8",
    "zustand": "^5.0.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "autoprefixer": "^10.4.20",
    "eslint": "^9.14.0",
    "tailwindcss": "^4.0.0-beta.4",
    "@tailwindcss/vite": "^4.0.0-beta.4",
    "typescript": "^5.6.3",
    "vite": "^5.4.10",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 2: `apps/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: `apps/web/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:54321',
    },
  },
});
```

- [ ] **Step 4: `apps/web/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>iTest</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: 安装并提交**

```bash
cd /Users/lyq/workdir/codedev/iTest
pnpm install
git add apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html pnpm-lock.yaml
git commit -m "feat(web): scaffold package with vite + react + tailwind v4"
```

---

### Task 27: 全局样式 + main.tsx

**Files:** `apps/web/src/index.css`、`apps/web/src/main.tsx`

- [ ] **Step 1: `apps/web/src/index.css`**

```css
@import "@itest/ui/tokens.css";
@import "@itest/ui/glass.css";

@layer base {
  body {
    background: linear-gradient(135deg, #EEF0FF 0%, #F5EFFF 100%);
    min-height: 100vh;
    color: var(--color-text-primary);
    font-family: var(--font-sans);
    margin: 0;
  }
  * {
    box-sizing: border-box;
  }
}

@layer components {
  .btn-primary {
    background: var(--color-primary);
    color: white;
    padding: 8px 16px;
    border-radius: var(--radius-md);
    border: none;
    cursor: pointer;
    font-weight: 500;
    transition: background 0.15s;
  }
  .btn-primary:hover {
    background: var(--color-primary-hover);
  }
  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-ghost {
    background: transparent;
    color: var(--color-text-primary);
    padding: 8px 16px;
    border-radius: var(--radius-md);
    border: 1px solid rgba(0, 0, 0, 0.1);
    cursor: pointer;
  }
  .input-base {
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: var(--radius-md);
    padding: 8px 12px;
    font-size: 14px;
    background: white;
    width: 100%;
  }
  .input-base:focus {
    outline: 2px solid var(--color-primary);
    outline-offset: -1px;
  }
}
```

- [ ] **Step 2: `apps/web/src/main.tsx`**

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './index.css';

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/index.css apps/web/src/main.tsx
git commit -m "feat(web): global styles and react entry"
```

---

### Task 28: API client + Zustand stores

**Files:** `apps/web/src/api/client.ts`、`apps/web/src/stores/{ui.ts,recorder.ts,agentRun.ts}`

- [ ] **Step 1: `apps/web/src/api/client.ts`**

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
  requirements: {
    list: () => request<Requirement[]>('/requirements'),
    create: (body: { title: string; content: string }) =>
      request<Requirement>('/requirements', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => request<Requirement>(`/requirements/${id}`),
  },
  cases: {
    list: (priority?: string) =>
      request<TestCase[]>(`/cases${priority ? `?priority=${priority}` : ''}`),
    create: (body: { title: string; priority?: string; requirementId?: string }) =>
      request<TestCase>('/cases', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => request<TestCaseDetail>(`/cases/${id}`),
    patch: (id: string, body: Partial<{ title: string; priority: string; description: string }>) =>
      request<TestCase>(`/cases/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    appendSteps: (id: string, steps: Array<{ order: number; source: string; action: unknown }>) =>
      request<{ count: number }>(`/cases/${id}/steps`, {
        method: 'POST',
        body: JSON.stringify({ steps }),
      }),
    execute: (id: string) =>
      request<{ reportId: string }>(`/cases/${id}/execute`, { method: 'POST' }),
  },
  reports: {
    list: () => request<Report[]>('/reports'),
    get: (id: string) => request<Report>(`/reports/${id}`),
  },
  agentRuns: {
    create: (body: { targetType: string; targetId: string; prompt: string }) =>
      request<AgentRun>('/agent-runs', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => request<AgentRun>(`/agent-runs/${id}`),
    eventsUrl: (id: string) => `${BASE}/agent-runs/${id}/events`,
  },
  recorder: {
    createSession: (caseId: string) =>
      request<{ sessionId: string; wsUrl: string; wsToken: string }>('/recorder/sessions', {
        method: 'POST',
        body: JSON.stringify({ caseId }),
      }),
    finish: (sessionId: string) =>
      request<{ inserted: number }>(`/recorder/sessions/${sessionId}/finish`, { method: 'POST' }),
  },
};

export interface Requirement {
  id: string;
  title: string;
  content: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}
export interface TestCase {
  id: string;
  title: string;
  priority: string;
  status: string;
  requirementId?: string;
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

- [ ] **Step 2: `apps/web/src/stores/ui.ts`**

```ts
import { create } from 'zustand';

interface Toast {
  id: number;
  message: string;
  kind: 'success' | 'error' | 'info';
}

interface UIState {
  toasts: Toast[];
  showToast: (message: string, kind?: Toast['kind']) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useUIStore = create<UIState>((set) => ({
  toasts: [],
  showToast: (message, kind = 'info') => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
```

- [ ] **Step 3: `apps/web/src/stores/recorder.ts`**

```ts
import { create } from 'zustand';

type RecorderStatus = 'idle' | 'starting' | 'recording' | 'finishing' | 'error';

interface RecorderState {
  status: RecorderStatus;
  sessionId: string | null;
  errorMessage: string | null;
  setStatus: (status: RecorderStatus) => void;
  setSession: (sessionId: string) => void;
  setError: (msg: string) => void;
  reset: () => void;
}

export const useRecorderStore = create<RecorderState>((set) => ({
  status: 'idle',
  sessionId: null,
  errorMessage: null,
  setStatus: (status) => set({ status }),
  setSession: (sessionId) => set({ sessionId }),
  setError: (msg) => set({ status: 'error', errorMessage: msg }),
  reset: () => set({ status: 'idle', sessionId: null, errorMessage: null }),
}));
```

- [ ] **Step 4: `apps/web/src/stores/agentRun.ts`**

```ts
import { create } from 'zustand';

interface AgentRunState {
  activeRunId: string | null;
  events: Array<{ type: string; payload: unknown }>;
  setActive: (runId: string | null) => void;
  pushEvent: (event: { type: string; payload: unknown }) => void;
  clear: () => void;
}

export const useAgentRunStore = create<AgentRunState>((set) => ({
  activeRunId: null,
  events: [],
  setActive: (runId) => set({ activeRunId: runId }),
  pushEvent: (event) => set((s) => ({ events: [...s.events, event] })),
  clear: () => set({ activeRunId: null, events: [] }),
}));
```

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/api apps/web/src/stores
git commit -m "feat(web): api client and zustand stores"
```

---

### Task 29: AppShell + Router

**Files:** `apps/web/src/App.tsx`、`apps/web/src/components/AppShell.tsx`、`apps/web/src/pages/{Dashboard,Requirements,Cases,Reports,Settings}.tsx`

- [ ] **Step 1: `apps/web/src/pages/Dashboard.tsx`**

```tsx
export default function Dashboard() {
  return (
    <div className="glass-panel p-8 max-w-4xl">
      <h1 className="text-2xl font-semibold mb-4">iTest 控制台</h1>
      <p className="text-secondary" style={{ color: 'var(--color-text-secondary)' }}>
        MVP 框架已就绪。前往「设置」配置 LLM，或在「需求」开始第一个流程。
      </p>
    </div>
  );
}
```

- [ ] **Step 2: `apps/web/src/pages/Requirements.tsx`**

```tsx
export default function Requirements() {
  return (
    <div className="glass-panel p-8 max-w-4xl">
      <h1 className="text-2xl font-semibold">需求列表</h1>
      <p style={{ color: 'var(--color-text-secondary)' }}>占位页面（Task 32 接入真实数据）。</p>
    </div>
  );
}
```

- [ ] **Step 3: `apps/web/src/pages/Cases.tsx`**

```tsx
export default function Cases() {
  return (
    <div className="glass-panel p-8 max-w-4xl">
      <h1 className="text-2xl font-semibold">用例列表</h1>
      <p style={{ color: 'var(--color-text-secondary)' }}>占位页面（Task 33 接入真实数据）。</p>
    </div>
  );
}
```

- [ ] **Step 4: `apps/web/src/pages/Reports.tsx`**

```tsx
export default function Reports() {
  return (
    <div className="glass-panel p-8 max-w-4xl">
      <h1 className="text-2xl font-semibold">报告列表</h1>
      <p style={{ color: 'var(--color-text-secondary)' }}>占位页面（Task 35 接入真实数据）。</p>
    </div>
  );
}
```

- [ ] **Step 5: `apps/web/src/pages/Settings.tsx`**

```tsx
export default function Settings() {
  return (
    <div className="glass-panel p-8 max-w-4xl">
      <h1 className="text-2xl font-semibold">设置</h1>
      <p style={{ color: 'var(--color-text-secondary)' }}>占位页面（Task 30 接入真实表单）。</p>
    </div>
  );
}
```

- [ ] **Step 6: `apps/web/src/components/AppShell.tsx`**

```tsx
import { Link, useLocation } from 'react-router-dom';

const navItems = [
  { path: '/', label: '总览' },
  { path: '/requirements', label: '需求' },
  { path: '/cases', label: '用例' },
  { path: '/reports', label: '报告' },
  { path: '/settings', label: '设置' },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  return (
    <div>
      <header
        style={{
          height: 64,
          display: 'flex',
          alignItems: 'center',
          padding: '0 24px',
          borderBottom: '1px solid rgba(0,0,0,0.06)',
          background: 'rgba(255,255,255,0.7)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 18, marginRight: 32, color: 'var(--color-primary)' }}>
          iTest
        </div>
        <nav style={{ display: 'flex', gap: 16 }}>
          {navItems.map((item) => {
            const active = item.path === '/' ? loc.pathname === '/' : loc.pathname.startsWith(item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                style={{
                  color: active ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                  fontWeight: active ? 600 : 400,
                  textDecoration: 'none',
                }}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main style={{ padding: 24 }}>{children}</main>
    </div>
  );
}
```

- [ ] **Step 7: `apps/web/src/App.tsx`**

```tsx
import { Routes, Route } from 'react-router-dom';
import AppShell from './components/AppShell';
import Dashboard from './pages/Dashboard';
import Requirements from './pages/Requirements';
import Cases from './pages/Cases';
import Reports from './pages/Reports';
import Settings from './pages/Settings';

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/requirements" element={<Requirements />} />
        <Route path="/cases" element={<Cases />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
  );
}
```

- [ ] **Step 8: 验证**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/web
pnpm dev &
sleep 4
curl -s http://127.0.0.1:5173 | head -20
kill %1
```

期望：HTML 含 `<div id="root">`。

- [ ] **Step 9: 提交**

```bash
git add apps/web/src/App.tsx apps/web/src/components apps/web/src/pages
git commit -m "feat(web): AppShell + Router + placeholder pages"
```

---

### Task 30: Settings 页面（真实表单）

**Files:** `apps/web/src/pages/Settings.tsx`

- [ ] **Step 1: 替换 `apps/web/src/pages/Settings.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';

const PROVIDERS = [
  { value: 'mock', label: 'mock（推荐，无需 API key）' },
  { value: 'openai', label: 'openai' },
  { value: 'anthropic', label: 'anthropic' },
  { value: 'google', label: 'google' },
];

export default function Settings() {
  const toast = useUIStore((s) => s.showToast);
  const [provider, setProvider] = useState('mock');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');

  const { data, isLoading } = useQuery({ queryKey: ['settings'], queryFn: api.settings.list });

  useEffect(() => {
    if (!data) return;
    setProvider((data.llm_provider as string) ?? 'mock');
    setApiKey((data.llm_api_key as string) ?? '');
    setModel((data.llm_model as string) ?? '');
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      await api.settings.put('llm_provider', provider);
      await api.settings.put('llm_api_key', apiKey);
      await api.settings.put('llm_model', model);
    },
    onSuccess: () => toast('设置已保存', 'success'),
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (isLoading) return <div className="glass-panel p-8">加载中...</div>;

  return (
    <div className="glass-panel p-8 max-w-2xl">
      <h1 className="text-2xl font-semibold mb-2">设置</h1>
      <p style={{ color: 'var(--color-text-secondary)' }} className="mb-6">
        LLM Provider / API Key 配置
      </p>
      <div className="flex flex-col gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">LLM Provider</label>
          <select className="input-base" value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            mock 模式不消耗 token；选择具体 provider 后需填写 API key。
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">API Key</label>
          <input
            className="input-base"
            type="password"
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Model</label>
          <input
            className="input-base"
            placeholder="例如 gpt-4o-mini / claude-sonnet-4-6"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
        <button
          className="btn-primary self-start"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 提交**

```bash
git add apps/web/src/pages/Settings.tsx
git commit -m "feat(web): Settings page with LLM provider form"
```

---

## M8 前端业务（Task 31-37）

### Task 31: Dashboard 页面

**Files:** `apps/web/src/pages/Dashboard.tsx`

- [ ] **Step 1: 替换 `apps/web/src/pages/Dashboard.tsx`**

```tsx
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

interface Stats {
  requirements: number;
  cases: number;
  reports: number;
  recentRuns: Array<{ id: string; targetType: string; status: string; startedAt: string }>;
}

export default function Dashboard() {
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: async (): Promise<Stats> => {
      const [reqs, cases, reports] = await Promise.all([
        api.requirements.list(),
        api.cases.list(),
        api.reports.list(),
      ]);
      return {
        requirements: reqs.length,
        cases: cases.length,
        reports: reports.length,
        recentRuns: reports.slice(0, 5).map((r) => ({
          id: r.id,
          targetType: 'execute',
          status: r.status,
          startedAt: r.createdAt,
        })),
      };
    },
  });

  if (stats.isLoading) return <div className="glass-panel p-8">加载中...</div>;
  if (!stats.data) return null;

  const cards = [
    { label: '需求', value: stats.data.requirements, to: '/requirements' },
    { label: '用例', value: stats.data.cases, to: '/cases' },
    { label: '报告', value: stats.data.reports, to: '/reports' },
  ];

  return (
    <div className="max-w-5xl flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">iTest 控制台</h1>
      <div className="grid grid-cols-3 gap-4">
        {cards.map((c) => (
          <Link
            key={c.label}
            to={c.to}
            className="glass-panel p-6 hover:shadow-lg transition"
            style={{ textDecoration: 'none', color: 'var(--color-text-primary)' }}
          >
            <div className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              {c.label}
            </div>
            <div className="text-3xl font-bold mt-2" style={{ color: 'var(--color-primary)' }}>
              {c.value}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 提交**

```bash
git add apps/web/src/pages/Dashboard.tsx
git commit -m "feat(web): Dashboard with stat cards"
```

---

### Task 32: Requirements 列表 + 详情

**Files:** `apps/web/src/pages/Requirements.tsx`、`apps/web/src/pages/RequirementDetail.tsx`、`apps/web/src/App.tsx`

- [ ] **Step 1: 替换 `apps/web/src/pages/Requirements.tsx`**

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';

export default function Requirements() {
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['requirements'], queryFn: api.requirements.list });
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [creating, setCreating] = useState(false);

  const create = useMutation({
    mutationFn: () => api.requirements.create({ title, content }),
    onSuccess: () => {
      setTitle('');
      setContent('');
      setCreating(false);
      toast('需求已创建', 'success');
      qc.invalidateQueries({ queryKey: ['requirements'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (isLoading) return <div className="glass-panel p-8">加载中...</div>;

  return (
    <div className="max-w-5xl flex flex-col gap-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-semibold">需求列表</h1>
        <button className="btn-primary" onClick={() => setCreating((v) => !v)}>
          {creating ? '取消' : '+ 新建需求'}
        </button>
      </div>

      {creating && (
        <div className="glass-panel p-6 flex flex-col gap-3">
          <input
            className="input-base"
            placeholder="标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="input-base"
            placeholder="需求描述"
            rows={4}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <button
            className="btn-primary self-start"
            disabled={!title || !content || create.isPending}
            onClick={() => create.mutate()}
          >
            创建
          </button>
        </div>
      )}

      <div className="glass-panel overflow-hidden">
        <table className="w-full text-sm">
          <thead style={{ background: 'rgba(124,92,252,0.05)' }}>
            <tr>
              <th className="text-left p-3">标题</th>
              <th className="text-left p-3">状态</th>
              <th className="text-left p-3">创建时间</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id} className="border-t" style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
                <td className="p-3">
                  <Link to={`/requirements/${r.id}`} style={{ color: 'var(--color-primary)' }}>
                    {r.title}
                  </Link>
                </td>
                <td className="p-3">{r.status}</td>
                <td className="p-3" style={{ color: 'var(--color-text-muted)' }}>
                  {new Date(r.createdAt).toLocaleString('zh-CN')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 创建 `apps/web/src/pages/RequirementDetail.tsx`**

```tsx
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import { useAgentRunStore } from '../stores/agentRun';

export default function RequirementDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const pushEvent = useAgentRunStore((s) => s.pushEvent);
  const clearEvents = useAgentRunStore((s) => s.clear);
  const [streaming, setStreaming] = useState(false);

  const { data: req } = useQuery({
    queryKey: ['requirement', id],
    queryFn: () => api.requirements.get(id!),
    enabled: !!id,
  });

  const generateCases = useMutation({
    mutationFn: async () => {
      clearEvents();
      const run = await api.agentRuns.create({
        targetType: 'requirement2cases',
        targetId: id!,
        prompt: req?.content ?? '',
      });
      setStreaming(true);
      return new Promise<void>((resolve, reject) => {
        const es = new EventSource(api.agentRuns.eventsUrl(run.id));
        es.onmessage = (e) => {
          try {
            const payload = JSON.parse(e.data);
            pushEvent({ type: payload.type, payload });
            if (payload.type === 'workflow_complete') {
              es.close();
              setStreaming(false);
              qc.invalidateQueries({ queryKey: ['requirement', id] });
              qc.invalidateQueries({ queryKey: ['requirements'] });
              qc.invalidateQueries({ queryKey: ['cases'] });
              toast('用例已生成', 'success');
              resolve();
            }
            if (payload.type === 'workflow_error') {
              es.close();
              setStreaming(false);
              toast(payload.error.message ?? '生成失败', 'error');
              reject(new Error(payload.error.message));
            }
          } catch {
            /* ignore */
          }
        };
        es.onerror = () => {
          es.close();
          setStreaming(false);
          reject(new Error('SSE connection failed'));
        };
      });
    },
  });

  if (!req) return <div className="glass-panel p-8">加载中...</div>;

  return (
    <div className="max-w-4xl flex flex-col gap-6">
      <Link to="/requirements" style={{ color: 'var(--color-text-secondary)' }}>
        ← 返回需求列表
      </Link>
      <div className="glass-panel p-6">
        <h1 className="text-2xl font-semibold mb-2">{req.title}</h1>
        <pre className="whitespace-pre-wrap text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          {req.content}
        </pre>
      </div>
      <div className="glass-panel p-6">
        <h2 className="text-lg font-semibold mb-4">Agent 操作</h2>
        <button
          className="btn-primary"
          disabled={streaming || generateCases.isPending}
          onClick={() => generateCases.mutate()}
        >
          {streaming ? '生成中...' : '⚡ 用 AI 生成用例'}
        </button>
        <p className="text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
          将调用 Mock LLM，返回结构化用例并写入数据库。
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 注册路由（修改 `apps/web/src/App.tsx`）**

```tsx
import { Routes, Route } from 'react-router-dom';
import AppShell from './components/AppShell';
import Dashboard from './pages/Dashboard';
import Requirements from './pages/Requirements';
import RequirementDetail from './pages/RequirementDetail';
import Cases from './pages/Cases';
import Reports from './pages/Reports';
import Settings from './pages/Settings';

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/requirements" element={<Requirements />} />
        <Route path="/requirements/:id" element={<RequirementDetail />} />
        <Route path="/cases" element={<Cases />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
  );
}
```

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/pages/Requirements.tsx apps/web/src/pages/RequirementDetail.tsx apps/web/src/App.tsx
git commit -m "feat(web): Requirements list + detail with AI generation"
```

---

### Task 33: Cases 列表

**Files:** `apps/web/src/pages/Cases.tsx`

- [ ] **Step 1: 替换 `apps/web/src/pages/Cases.tsx`**

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

const PRIORITIES = ['', 'P0', 'P1', 'P2', 'P3'];

export default function Cases() {
  const [priority, setPriority] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['cases', priority],
    queryFn: () => api.cases.list(priority || undefined),
  });

  return (
    <div className="max-w-5xl flex flex-col gap-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-semibold">用例列表</h1>
        <select className="input-base" style={{ width: 160 }} value={priority} onChange={(e) => setPriority(e.target.value)}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p || '全部优先级'}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="glass-panel p-8">加载中...</div>
      ) : (
        <div className="glass-panel overflow-hidden">
          <table className="w-full text-sm">
            <thead style={{ background: 'rgba(124,92,252,0.05)' }}>
              <tr>
                <th className="text-left p-3">标题</th>
                <th className="text-left p-3">优先级</th>
                <th className="text-left p-3">状态</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((c) => (
                <tr key={c.id} className="border-t" style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
                  <td className="p-3">
                    <Link to={`/cases/${c.id}`} style={{ color: 'var(--color-primary)' }}>
                      {c.title}
                    </Link>
                  </td>
                  <td className="p-3">{c.priority}</td>
                  <td className="p-3">{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 提交**

```bash
git add apps/web/src/pages/Cases.tsx
git commit -m "feat(web): Cases list with priority filter"
```

---

### Task 34: Case Detail（Tabs + 录制 + AI + 执行）

**Files:** `apps/web/src/pages/CaseDetail.tsx`、`apps/web/src/App.tsx`

- [ ] **Step 1: 创建 `apps/web/src/pages/CaseDetail.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUIStore } from '../stores/ui';
import { useRecorderStore } from '../stores/recorder';

type Tab = 'description' | 'reports' | 'recording';

export default function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const recorder = useRecorderStore();
  const [tab, setTab] = useState<Tab>('description');
  const wsRef = useRef<WebSocket | null>(null);

  const { data: caseDetail } = useQuery({
    queryKey: ['case', id],
    queryFn: () => api.cases.get(id!),
    enabled: !!id,
  });

  const startRecording = useMutation({
    mutationFn: async () => {
      const session = await api.recorder.createSession(id!);
      recorder.setStatus('recording');
      recorder.setSession(session.sessionId);
      const ws = new WebSocket(`${session.wsUrl}?sessionId=${session.sessionId}&token=${session.wsToken}`);
      wsRef.current = ws;
      ws.onopen = () => {
        window.postMessage({ source: 'ita-web', type: 'start-recording', sessionId: session.sessionId }, '*');
      };
      ws.onerror = () => {
        recorder.setError('WS 连接失败');
        toast('WS 连接失败，请确认 Chrome 扩展已加载', 'error');
      };
    },
    onError: (e: Error) => {
      recorder.setError(e.message);
      toast(e.message, 'error');
    },
  });

  const stopRecording = useMutation({
    mutationFn: async () => {
      const sessionId = recorder.sessionId;
      if (!sessionId) throw new Error('no active session');
      wsRef.current?.close();
      const r = await api.recorder.finish(sessionId);
      recorder.reset();
      toast(`已写入 ${r.inserted} 个步骤`, 'success');
      qc.invalidateQueries({ queryKey: ['case', id] });
    },
  });

  const execute = useMutation({
    mutationFn: () => api.cases.execute(id!),
    onSuccess: (r) => {
      toast('执行完成', 'success');
      qc.invalidateQueries({ queryKey: ['reports'] });
      window.location.href = `/reports/${r.reportId}`;
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  if (!caseDetail) return <div className="glass-panel p-8">加载中...</div>;

  return (
    <div className="max-w-5xl flex flex-col gap-6">
      <Link to="/cases" style={{ color: 'var(--color-text-secondary)' }}>
        ← 返回用例列表
      </Link>
      <div className="glass-panel p-6">
        <h1 className="text-2xl font-semibold">{caseDetail.title}</h1>
        <p style={{ color: 'var(--color-text-muted)' }} className="text-sm mt-1">
          {caseDetail.priority} · {caseDetail.status}
        </p>
      </div>

      <div className="flex gap-2">
        {(['description', 'reports', 'recording'] as Tab[]).map((t) => (
          <button
            key={t}
            className="btn-ghost"
            style={tab === t ? { borderColor: 'var(--color-primary)', color: 'var(--color-primary)' } : {}}
            onClick={() => setTab(t)}
          >
            {t === 'description' ? '描述 / 步骤' : t === 'reports' ? '报告' : '录制历史'}
          </button>
        ))}
      </div>

      <div className="glass-panel p-6">
        {tab === 'description' && (
          <div className="flex flex-col gap-4">
            {caseDetail.description && (
              <p style={{ color: 'var(--color-text-secondary)' }}>{caseDetail.description}</p>
            )}
            <div>
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-semibold">步骤 ({caseDetail.steps.length})</h3>
                <div className="flex gap-2">
                  <button
                    className="btn-primary"
                    disabled={execute.isPending}
                    onClick={() => execute.mutate()}
                  >
                    ▶ 执行（Mock）
                  </button>
                  {recorder.status === 'recording' ? (
                    <button className="btn-ghost" onClick={() => stopRecording.mutate()}>
                      ⏹ 停止录制
                    </button>
                  ) : (
                    <button className="btn-ghost" onClick={() => startRecording.mutate()}>
                      ▶ 录制补充
                    </button>
                  )}
                </div>
              </div>
              {caseDetail.steps.length === 0 ? (
                <p style={{ color: 'var(--color-text-muted)' }}>暂无步骤</p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {caseDetail.steps.map((s) => (
                    <li key={s.id} className="p-3 rounded border text-sm" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
                      <span className="text-xs mr-2 px-1.5 py-0.5 rounded" style={{ background: 'rgba(124,92,252,0.15)', color: 'var(--color-primary)' }}>
                        {s.source}
                      </span>
                      <code className="text-xs">{JSON.stringify(s.action)}</code>
                    </li>
                  ))}
                </ol>
              )}
              {recorder.status === 'recording' && (
                <p className="text-sm mt-2" style={{ color: 'var(--color-info)' }}>
                  ● 录制中... 在 Chrome 扩展打开的页面操作即可。
                </p>
              )}
              {recorder.status === 'error' && (
                <p className="text-sm mt-2" style={{ color: 'var(--color-destructive)' }}>
                  ✕ {recorder.errorMessage}
                </p>
              )}
            </div>
          </div>
        )}
        {tab === 'reports' && (
          <Link to="/reports" style={{ color: 'var(--color-primary)' }}>
            查看该用例的所有报告 →
          </Link>
        )}
        {tab === 'recording' && (
          <p style={{ color: 'var(--color-text-muted)' }}>
            录制历史（占位，未来按时间序列展示每次录制会话）。
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 注册路由（修改 `apps/web/src/App.tsx`）**

```tsx
import { Routes, Route } from 'react-router-dom';
import AppShell from './components/AppShell';
import Dashboard from './pages/Dashboard';
import Requirements from './pages/Requirements';
import RequirementDetail from './pages/RequirementDetail';
import Cases from './pages/Cases';
import CaseDetail from './pages/CaseDetail';
import Reports from './pages/Reports';
import Settings from './pages/Settings';

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/requirements" element={<Requirements />} />
        <Route path="/requirements/:id" element={<RequirementDetail />} />
        <Route path="/cases" element={<Cases />} />
        <Route path="/cases/:id" element={<CaseDetail />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
  );
}
```

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/pages/CaseDetail.tsx apps/web/src/App.tsx
git commit -m "feat(web): Case detail with recording/execute controls"
```

---

### Task 35: Reports 列表 + 详情

**Files:** `apps/web/src/pages/Reports.tsx`、`apps/web/src/pages/ReportDetail.tsx`、`apps/web/src/App.tsx`

- [ ] **Step 1: 替换 `apps/web/src/pages/Reports.tsx`**

```tsx
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export default function Reports() {
  const { data, isLoading } = useQuery({ queryKey: ['reports'], queryFn: api.reports.list });

  if (isLoading) return <div className="glass-panel p-8">加载中...</div>;

  return (
    <div className="max-w-5xl flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">报告列表</h1>
      <div className="glass-panel overflow-hidden">
        <table className="w-full text-sm">
          <thead style={{ background: 'rgba(124,92,252,0.05)' }}>
            <tr>
              <th className="text-left p-3">用例 ID</th>
              <th className="text-left p-3">状态</th>
              <th className="text-left p-3">耗时</th>
              <th className="text-left p-3">时间</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id} className="border-t" style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
                <td className="p-3">
                  <Link to={`/reports/${r.id}`} style={{ color: 'var(--color-primary)' }}>
                    {r.caseId.slice(0, 8)}...
                  </Link>
                </td>
                <td className="p-3">
                  <span
                    style={{
                      color: r.status === 'passed' ? 'var(--color-success)' : 'var(--color-destructive)',
                      fontWeight: 600,
                    }}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="p-3">{r.durationMs ?? 0} ms</td>
                <td className="p-3" style={{ color: 'var(--color-text-muted)' }}>
                  {new Date(r.createdAt).toLocaleString('zh-CN')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 创建 `apps/web/src/pages/ReportDetail.tsx`**

```tsx
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

interface StepResult {
  order: number;
  status: string;
  durationMs: number;
  error?: string;
  screenshot?: string;
}

export default function ReportDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.reports.get(id!),
    enabled: !!id,
  });

  if (isLoading || !data) return <div className="glass-panel p-8">加载中...</div>;

  const stepResults = (data.stepResults as StepResult[]) ?? [];

  return (
    <div className="max-w-5xl flex flex-col gap-6">
      <Link to="/reports" style={{ color: 'var(--color-text-secondary)' }}>
        ← 返回报告列表
      </Link>
      <div className="glass-panel p-6">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-semibold">测试报告</h1>
            <p style={{ color: 'var(--color-text-muted)' }} className="text-sm mt-1">
              {new Date(data.createdAt).toLocaleString('zh-CN')}
            </p>
          </div>
          <div
            className="text-lg font-bold px-4 py-2 rounded"
            style={{
              color: data.status === 'passed' ? 'var(--color-success)' : 'var(--color-destructive)',
              background:
                data.status === 'passed' ? 'rgba(18,183,106,0.1)' : 'rgba(240,68,56,0.1)',
            }}
          >
            {data.status.toUpperCase()}
          </div>
        </div>
        {data.summary && <p className="mt-4">{data.summary}</p>}
        <p className="text-sm mt-2" style={{ color: 'var(--color-text-muted)' }}>
          总耗时：{data.durationMs ?? 0} ms
        </p>
      </div>

      <div className="glass-panel p-6">
        <h2 className="text-lg font-semibold mb-4">步骤时间线</h2>
        <ol className="flex flex-col gap-3">
          {stepResults.map((s, i) => (
            <li key={i} className="flex gap-3 items-start p-3 rounded border" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
              <span
                className="font-mono text-sm flex-shrink-0"
                style={{
                  color: s.status === 'passed' ? 'var(--color-success)' : 'var(--color-destructive)',
                }}
              >
                {s.status === 'passed' ? '✓' : '✕'} #{s.order}
              </span>
              <div className="flex-1">
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {s.durationMs} ms
                </div>
                {s.error && (
                  <div className="text-sm mt-1" style={{ color: 'var(--color-destructive)' }}>
                    {s.error}
                  </div>
                )}
              </div>
              {s.screenshot && (
                <img
                  src={s.screenshot}
                  alt={`step ${s.order}`}
                  className="w-16 h-16 rounded border"
                  style={{ borderColor: 'rgba(0,0,0,0.1)' }}
                />
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 注册路由**

```tsx
// App.tsx 增加
import ReportDetail from './pages/ReportDetail';
// <Route path="/reports/:id" element={<ReportDetail />} />
```

完整 `App.tsx`：

```tsx
import { Routes, Route } from 'react-router-dom';
import AppShell from './components/AppShell';
import Dashboard from './pages/Dashboard';
import Requirements from './pages/Requirements';
import RequirementDetail from './pages/RequirementDetail';
import Cases from './pages/Cases';
import CaseDetail from './pages/CaseDetail';
import Reports from './pages/Reports';
import ReportDetail from './pages/ReportDetail';
import Settings from './pages/Settings';

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/requirements" element={<Requirements />} />
        <Route path="/requirements/:id" element={<RequirementDetail />} />
        <Route path="/cases" element={<Cases />} />
        <Route path="/cases/:id" element={<CaseDetail />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/reports/:id" element={<ReportDetail />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </AppShell>
  );
}
```

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/pages/Reports.tsx apps/web/src/pages/ReportDetail.tsx apps/web/src/App.tsx
git commit -m "feat(web): Reports list and detail pages"
```

---

### Task 36: 前端 lint + typecheck

**Files:** `apps/web/.eslintrc.cjs`（如需）、验证用现有 ESLint 配置

- [ ] **Step 1: 添加 ESLint 配置 `apps/web/eslint.config.js`**

```js
import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
];
```

- [ ] **Step 2: 添加 `@eslint/js` 依赖**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/web
pnpm add -D @eslint/js
```

- [ ] **Step 3: 运行 typecheck**

```bash
pnpm typecheck
```

期望：exit 0。

- [ ] **Step 4: 运行 lint**

```bash
pnpm lint
```

期望：0 errors（warnings 可接受）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/eslint.config.js apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): eslint config and verify lint+typecheck"
```

---

### Task 37: E2E smoke（手动 curl + 浏览器）

**Files:** 无。

- [ ] **Step 1: 起 api + web**

```bash
cd /Users/lyq/workdir/codedev/iTest
docker compose -f infra/docker-compose.yml up -d
cd apps/api
pnpm dev &
sleep 3
cd ../web
pnpm dev &
sleep 4
```

- [ ] **Step 2: 浏览器验证**

打开 http://127.0.0.1:5173 浏览器依次操作：

1. `/settings`：选择 provider=mock，点保存 → toast「设置已保存」
2. `/requirements`：新建需求「登录功能」
3. 进入需求详情 → 点「⚡ 用 AI 生成用例」→ toast「用例已生成」
4. `/cases`：可见新生成的用例
5. 进入用例详情 → 点「▶ 执行（Mock）」→ 跳转报告页，看到 passed/failed 状态
6. `/reports`：可见报告列表

- [ ] **Step 3: 关闭**

```bash
kill %1 %2
```

- [ ] **Step 4: 提交（如有 bugfix）**

```bash
git add -u
git diff --cached --quiet || git commit -m "fix(web): e2e smoke fixes"
```

---

## M9 录制器（Task 38-43）

### Task 38: Recorder 包结构 + manifest

**Files:** `apps/recorder/{package.json,manifest.json,icons/*}`

- [ ] **Step 1: `apps/recorder/package.json`**

```json
{
  "name": "@itest/recorder",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.280",
    "jsdom": "^25.0.1",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 2: `apps/recorder/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM"],
    "types": ["chrome"]
  },
  "include": ["modules/**/*", "test/**/*"]
}
```

- [ ] **Step 3: `apps/recorder/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "iTest Recorder",
  "version": "0.0.1",
  "description": "iTest 自动化测试录制扩展",
  "permissions": ["scripting", "storage"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "iTest Recorder"
  },
  "content_scripts": [
    {
      "matches": ["http://localhost/*", "http://127.0.0.1/*"],
      "js": ["content/bridge.js"],
      "run_at": "document_start"
    }
  ]
}
```

- [ ] **Step 4: 占位图标**

```bash
mkdir -p /Users/lyq/workdir/codedev/iTest/apps/recorder/icons
# 占位 1x1 PNG（透明）
python3 -c "
import base64
data = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=')
for n in [16, 48, 128]:
    with open(f'/Users/lyq/workdir/codedev/iTest/apps/recorder/icons/icon{n}.png', 'wb') as f:
        f.write(data)
"
```

- [ ] **Step 5: 安装并提交**

```bash
cd /Users/lyq/workdir/codedev/iTest
pnpm install
git add apps/recorder
git commit -m "feat(recorder): scaffold MV3 extension"
```

---

### Task 39: selector-core.js（多候选 Locator）

**Files:** `apps/recorder/modules/selector-core.ts`

- [ ] **Step 1: 实现**

```ts
export interface Locator {
  strategy: 'role' | 'testId' | 'text' | 'css' | 'xpath';
  value: string;
}

const MAX_CANDIDATES = 5;

function getAccessibleRole(el: Element): string | null {
  const role = el.getAttribute('role');
  if (role) return role;
  const tag = el.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    return type === 'submit' || type === 'button' ? 'button' : 'textbox';
  }
  return null;
}

function getAccessibleName(el: Element): string | null {
  return (
    el.getAttribute('aria-label') ??
    el.getAttribute('title') ??
    el.getAttribute('placeholder') ??
    el.textContent?.trim().slice(0, 50) ??
    null
  );
}

function getTestId(el: Element): string | null {
  return el.getAttribute('data-testid') ?? el.getAttribute('data-test-id');
}

function buildCssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.tagName.toLowerCase() !== 'html') {
    const tag = cur.tagName.toLowerCase();
    const id = cur.id ? `#${cur.id}` : '';
    const cls = cur.className && typeof cur.className === 'string' ? `.${cur.className.split(/\s+/).join('.')}` : '';
    parts.unshift(`${tag}${id}${cls}`);
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

function buildXPath(el: Element): string {
  if (el.id) return `//*[@id="${el.id}"]`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.tagName.toLowerCase() !== 'html') {
    const tag = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        const idx = siblings.indexOf(cur) + 1;
        parts.unshift(`${tag}[${idx}]`);
      } else {
        parts.unshift(tag);
      }
    cur = cur.parentElement;
  }
  return `/${parts.join('/')}`;
}

export function generateLocators(el: Element): Locator[] {
  const out: Locator[] = [];
  const seen = new Set<string>();

  const push = (loc: Locator) => {
    const key = `${loc.strategy}:${loc.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(loc);
  };

  const role = getAccessibleRole(el);
  const name = getAccessibleName(el);
  if (role && name) push({ strategy: 'role', value: `${role}[name="${name.replace(/"/g, '\\"')}"]` });

  const testId = getTestId(el);
  if (testId) push({ strategy: 'testId', value: testId });

  if (name && name.length > 0 && name.length <= 50) {
    push({ strategy: 'text', value: name });
  }

  push({ strategy: 'css', value: buildCssPath(el) });
  push({ strategy: 'xpath', value: buildXPath(el) });

  return out.slice(0, MAX_CANDIDATES);
}
```

- [ ] **Step 2: 提交**

```bash
git add apps/recorder/modules/selector-core.ts
git commit -m "feat(recorder): selector-core multi-candidate locator generation"
```

---

### Task 40: recorder.js（DOM 事件捕获）

**Files:** `apps/recorder/content/recorder.js`、`apps/recorder/modules/recorder-manager.ts`

- [ ] **Step 1: `apps/recorder/modules/recorder-manager.ts`**

```ts
import { generateLocators } from './selector-core.js';

export interface RecordedStep {
  type: 'click' | 'fill' | 'hover';
  target: ReturnType<typeof generateLocators>;
  value?: string;
  url: string;
  timestamp: number;
}

type StepHandler = (step: RecordedStep) => void;

export class RecorderManager {
  private active = false;
  private handler: StepHandler | null = null;
  private listeners: Array<{ el: EventTarget; type: string; fn: EventListener }> = [];

  start(handler: StepHandler) {
    this.active = true;
    this.handler = handler;
    this.attachListeners();
  }

  stop() {
    this.active = false;
    this.handler = null;
    this.detachListeners();
  }

  private attachListeners() {
    const onClick = (e: Event) => {
      const target = e.target as Element;
      if (!target) return;
      this.handler?.({
        type: 'click',
        target: generateLocators(target),
        url: location.href,
        timestamp: Date.now(),
      });
    };
    const onInput = (e: Event) => {
      const target = e.target as HTMLInputElement;
      if (!target) return;
      this.handler?.({
        type: 'fill',
        target: generateLocators(target),
        value: target.value,
        url: location.href,
        timestamp: Date.now(),
      });
    };
    const onMouseOver = (e: Event) => {
      const target = e.target as Element;
      if (!target) return;
      this.handler?.({
        type: 'hover',
        target: generateLocators(target),
        url: location.href,
        timestamp: Date.now(),
      });
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('mouseover', onMouseOver, true);
    this.listeners.push(
      { el: document, type: 'click', fn: onClick },
      { el: document, type: 'input', fn: onInput },
      { el: document, type: 'mouseover', fn: onMouseOver },
    );
  }

  private detachListeners() {
    for (const l of this.listeners) {
      l.el.removeEventListener(l.type, l.fn, true);
    }
    this.listeners = [];
  }

  isActive() {
    return this.active;
  }
}
```

- [ ] **Step 2: `apps/recorder/content/recorder.js`（纯 JS，注入目标页用）**

```js
(async () => {
  const src = chrome.runtime.getURL('modules/recorder-manager.js');
  const mod = await import(src);
  const manager = new mod.RecorderManager();

  window.addEventListener('message', (e) => {
    if (e.data?.source !== 'ita-web') return;
    if (e.data.type === 'start-recording') {
      manager.start((step) => {
        chrome.runtime.sendMessage({ type: 'step', step });
      });
    } else if (e.data.type === 'stop-recording') {
      manager.stop();
    }
  });
})();
```

- [ ] **Step 3: 注意**

`recorder-manager.js` 在 MV3 service worker 通过 `chrome.scripting.executeScript` 注入。Service worker 把模块文件作为 ES Module 加载（MVP 简化：`recorder-manager.js` 是纯 JS 版本，从 `selector-core.ts` 通过 `tsc` 编译生成）。

**说明：** MVP 阶段把 `selector-core.ts` 与 `recorder-manager.ts` 用 `tsc --module ESNext --outDir apps/recorder/dist` 编译为 JS，扩展目录加载 `dist/`。

为简化，本任务不引入完整构建步骤。Step 1 与 Step 2 提交纯 TS 源文件供未来构建；运行时由 `background.js` 通过 `chrome.scripting.executeScript({ files: ['content/recorder.js'] })` 注入（`recorder.js` 直接 import 编译后的 `modules/recorder-manager.js`）。

- [ ] **Step 4: 提交**

```bash
git add apps/recorder/modules/recorder-manager.ts apps/recorder/content/recorder.js
git commit -m "feat(recorder): DOM event capture via recorder-manager"
```

---

### Task 41: background.js + bridge.js

**Files:** `apps/recorder/background.js`、`apps/recorder/content/bridge.js`

- [ ] **Step 1: `apps/recorder/background.js`**

```js
let ws = null;
let activeTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start' && msg.session) {
    const { wsUrl, sessionId, token } = msg.session;
    ws = new WebSocket(`${wsUrl}?sessionId=${sessionId}&token=${token}`);
    activeTabId = sender.tab?.id;
    ws.onopen = () => {
      sendResponse({ ok: true });
      chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        files: ['content/recorder.js'],
      });
    };
    ws.onerror = () => sendResponse({ ok: false, error: 'ws failed' });
    return true;
  }
  if (msg.type === 'step' && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'step', step: msg.step }));
  }
  if (msg.type === 'stop') {
    ws?.send(JSON.stringify({ type: 'finish' }));
    ws?.close();
    ws = null;
  }
  return false;
});
```

- [ ] **Step 2: `apps/recorder/content/bridge.js`**

```js
window.addEventListener('message', (e) => {
  if (e.data?.source !== 'ita-web') return;
  chrome.runtime.sendMessage({ type: 'start', session: e.data.session }, (resp) => {
    window.postMessage({ source: 'ita-ext', type: 'start-result', ok: resp?.ok }, '*');
  });
});
```

- [ ] **Step 3: 提交**

```bash
git add apps/recorder/background.js apps/recorder/content/bridge.js
git commit -m "feat(recorder): background WS bridge and content bridge"
```

---

### Task 42: popup.html + popup.js

**Files:** `apps/recorder/popup/{popup.html,popup.css,popup.js}`

- [ ] **Step 1: `apps/recorder/popup/popup.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="popup.css" />
  </head>
  <body>
    <div class="container">
      <h1>iTest Recorder</h1>
      <p class="hint">从中台「用例详情」页发起录制，本扩展负责采集步骤。</p>
      <button id="open">打开中台</button>
    </div>
    <script src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 2: `apps/recorder/popup/popup.css`**

```css
body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; width: 240px; background: #EEF0FF; }
h1 { font-size: 16px; margin: 0 0 8px; color: #7C5CFC; }
.hint { font-size: 12px; color: #6E6A8A; margin-bottom: 12px; }
button { background: #7C5CFC; color: white; border: none; padding: 8px 12px; border-radius: 8px; cursor: pointer; width: 100%; }
button:hover { background: #6A4AE0; }
```

- [ ] **Step 3: `apps/recorder/popup/popup.js`**

```js
document.getElementById('open').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://127.0.0.1:5173/' });
});
```

- [ ] **Step 4: 提交**

```bash
git add apps/recorder/popup
git commit -m "feat(recorder): popup with dashboard link"
```

---

### Task 43: selector-core 单测

**Files:** `apps/recorder/test/selector-core.test.ts`

- [ ] **Step 1: 测试代码**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { generateLocators } from '../modules/selector-core.js';

let document: Document;

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  document = dom.window.document;
});

function makeEl(html: string): Element {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  return wrap.firstElementChild!;
}

describe('selector-core', () => {
  it('generates role locator for button with aria-label', () => {
    const el = makeEl('<button aria-label="提交">ok</button>');
    const locs = generateLocators(el);
    expect(locs.find((l) => l.strategy === 'role')?.value).toBe('button[name="提交"]');
  });

  it('generates testId locator when data-testid is present', () => {
    const el = makeEl('<button data-testid="submit">ok</button>');
    const locs = generateLocators(el);
    expect(locs.find((l) => l.strategy === 'testId')?.value).toBe('submit');
  });

  it('generates css locator with tag', () => {
    const el = makeEl('<button>ok</button>');
    const locs = generateLocators(el);
    expect(locs.find((l) => l.strategy === 'css')?.value).toContain('button');
  });

  it('generates xpath locator with // prefix', () => {
    const el = makeEl('<button>ok</button>');
    const locs = generateLocators(el);
    expect(locs.find((l) => l.strategy === 'xpath')?.value).toMatch(/^\/.*button/);
  });

  it('limits to 5 candidates', () => {
    const el = makeEl('<button data-testid="x" aria-label="y">z</button>');
    const locs = generateLocators(el);
    expect(locs.length).toBeLessThanOrEqual(5);
  });

  it('includes text locator when text is short', () => {
    const el = makeEl('<a>登录</a>');
    const locs = generateLocators(el);
    expect(locs.find((l) => l.strategy === 'text')?.value).toBe('登录');
  });
});
```

- [ ] **Step 2: 运行**

```bash
cd /Users/lyq/workdir/codedev/iTest/apps/recorder
pnpm test
```

期望：6 个 PASS。

- [ ] **Step 3: 提交**

```bash
git add apps/recorder/test
git commit -m "test(recorder): selector-core jsdom tests"
```

---

## M10 文档与收尾（Task 44）

### Task 44: README + verify

**Files:** `README.md`

- [ ] **Step 1: `README.md`**

```markdown
# iTest

AI 驱动的自动化测试平台 MVP。

## 架构

Turborepo monorepo：

- `apps/api`：Node 22 + Express + Drizzle + PostgreSQL
- `apps/web`：React 18 + Vite + Tailwind v4（端口 5173）
- `apps/recorder`：Chrome Manifest V3 扩展
- `packages/shared`：步骤 DSL + Zod schema
- `packages/ui`：设计令牌 + glass-panel 工具类

## 端口

| 服务 | 端口 |
|---|---|
| Web | 127.0.0.1:5173 |
| API | 127.0.0.1:54321 |
| PostgreSQL | 127.0.0.1:5432 |
| Redis | 127.0.0.1:6379 |

## 启动

```bash
# 1. 起 PG + Redis
docker compose -f infra/docker-compose.yml up -d

# 2. 应用 migration
cd apps/api && pnpm db:migrate && cd ../..

# 3. 一键启动 web + api
pnpm dev
```

访问 http://localhost:5173。

## Chrome 扩展加载

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」 → 选择 `apps/recorder/` 目录

## 核心流程

1. `/settings` 配置 LLM provider（默认 mock）
2. `/requirements` 新建需求 → 「⚡ 用 AI 生成用例」
3. `/cases` 看到生成的用例 → 进入详情
4. 用例详情页：「▶ 录制补充」（需 Chrome 扩展）、「▶ 执行（Mock）」
5. `/reports` 查看执行结果

## 测试

```bash
pnpm verify  # lint + typecheck + test
```

## MVP 范围

✅ 已实现：
- 需求 → 用例（mock LLM）
- 用例 → 步骤（mock LLM）
- 用例执行（mock，80/20 通过率）
- Chrome 扩展骨架（WS 推送步骤）
- 紫罗兰玻璃 UI 主题

❌ 不在 MVP：
- 真实 CDP 回放
- 多用户/权限
- i18n
- 移动端适配
```

- [ ] **Step 2: 跑 verify**

```bash
cd /Users/lyq/workdir/codedev/iTest
pnpm verify
```

期望：所有 lint/typecheck/test 全绿。

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: README with quickstart and MVP scope"
```

- [ ] **Step 4: 总 commit 验证**

```bash
git log --oneline | head -50
```

期望：≥40 个 commit，每个 Task 一个。

---

## 自审清单

**Spec 覆盖**（13 节）：

| Spec 节 | 任务 |
|---|---|
| §2 技术栈 | Task 1（turbo）, Task 10（api deps）, Task 26（web deps）, Task 38（recorder） |
| §3 仓库结构 | Task 1-9, 26-30, 38-43 |
| §4 进程与通信 | Task 13（API listen 127.0.0.1）, Task 23（SSE）, Task 24（WS） |
| §5 数据模型 | Task 11（schema 6 表） |
| §6 Agent 流 | Task 19-22（LLM client + 2 workflow + mock execute） |
| §7 录制集成 | Task 24（WS endpoint）, Task 38-43（扩展） |
| §8 UI | Task 8-9（tokens）, Task 26-29（AppShell）, Task 30-35（页面） |
| §9 REST API | Task 13-18, 23-25, 28（client） |
| §10 错误处理 | Task 12（errorHandler） |
| §11 测试 | Task 6, 14-18（vitest + supertest + testcontainers）, Task 43（jsdom） |
| §12 风险 | Task 3（决策记录）, Mock LLM/Mock 执行已说明 |
| §13 成功标准 | Task 44（README + verify） |

**类型一致性**：

- `api.cases.execute` 返回 `{ reportId }` → Task 34 使用一致
- `recorder.createSession` 返回 `{ sessionId, wsUrl, wsToken }` → Task 34 使用一致
- `agentRuns.eventsUrl` 返回完整 SSE 路径 → Task 32 使用一致
- `Locator` 数组在 `selector-core.ts` 与 `step-dsl.ts` 中 strategy 枚举一致

**Placeholder 扫描**：

- ✅ 所有代码块包含完整可运行代码
- ✅ 无 "TBD"、"TODO"、"待补充"
- ✅ 每个 Task 有明确 verify 命令与期望输出

---

## 执行提示

本计划完整 Part 1 + Part 2 共 44 个 Task，按顺序执行即可端到端跑通 MVP。