# 版本空间 AI 助手 Plan 3(前端 AI-First 对话+舞台)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 进入版本空间落地即 AI 对话(`/p/:projectId/v/:versionId/assistant`),对话可驱动平台操作,右侧舞台实时展示 AI 正操作的对象,敏感操作出确认卡。

**Architecture:** 后端先修 Plan 1 遗留的两处契约缺陷(建线程吞错、SSE 早订阅丢事件),前端新建 `features/space-assistant/`,复用 react-pi 体系:`createPiHttpClient({ baseUrl: '/api/assistant' })` + `usePiRuntime`,自定义 SSE 事件(confirm_request/stage/announce)经 client.subscribe 分流进 zustand store。AssistantPage 管线程,SpaceWorkspace 提供共享 runtime 的分栏容器(左对话/右舞台)。

**Tech Stack:** express + vitest + testcontainers(api);React 18 + react-router + @tanstack/react-query + @assistant-ui/react 0.15.22 + @assistant-ui/react-pi 0.0.25 + zustand + Tailwind v4(web)。

**分支:** `feat/space-assistant-plan3`(从 main 新建)。全程不 push;完成后按 Plan 1/2 惯例由用户裁决合并方式。

**关键契约事实(已实测核实,写代码时勿再猜):**

- 后端 `/api/assistant`(apps/api/src/pi/space/router.ts):`POST /threads` body `{metadata:{versionId}}` → PiThreadSnapshot;`GET /threads?versionId=` → `[{id,title,status,createdAt,updatedAt}]`(后端 limit 20,按 updatedAt 倒序);`POST /threads/:id/messages` body `{input:{content}}` → 204;`POST /threads/:id/cancel` → 204;`POST /threads/:id/confirm` body `{confirmId,approved}` → 204 / 404(过期);SSE `GET /threads/:id/events` 首帧 `{type:'snapshot',...}`,自定义事件 `confirm_request`/`stage`/`announce`。
- `RepoUnavailableError(reason, message)`,reason ∈ 'no_repo'|'clone_failed'|'auth_failed'|'dirty'|'fetch_failed'(apps/api/src/pi/repo.ts:25-29)。
- `HttpError(status, code, message)` → errorHandler 输出 `{ error: code, message }`(apps/api/src/middleware/errorHandler.ts:16-18)。
- `createPiHttpClient(options?: { baseUrl?: string; ... })`,默认 baseUrl `/api/pi`;`sendMessage` 默认发 `{ input }`(与本 router 期望一致,**无需覆写**);`subscribe(threadId, listener, {includeSnapshot})` 走 SSE `GET {baseUrl}/threads/:id/events`;未知事件类型 reducer 原样忽略(react-pi types.d.ts `PiUnknownClientEventBody`)。`PiThreadSnapshot.lastError?: string` 字段存在,可承载建线程警告。
- `usePiRuntime({ client, initialThreadId })`;`useAui()` 来自 `@assistant-ui/react`;`aui.thread.composer().setText(text)` 是 ComposerMethods 上的官方方法(core/dist/store/scopes/composer.d.ts:75)。
- 前端体系:`request<T>`/`ApiError`/`qs` 在 apps/web/src/api/client.ts 头部;toast 用 `useUIStore((s)=>s.showToast)(msg,'success'|'error')`;PageShell `contained` 模式用于全高页面;按钮 `Button`(variant ghost/danger,size sm);空态 `EmptyState {icon,title,description}`;路由块在 App.tsx `v/:versionId` 下。
- 测试经验:api 测试对 src 模块必须**测试体内动态 `await import`**(顶部静态 import 会在 beforeAll 设 DATABASE_URL 前固化 db 连接);全量跑加 `--minWorkers=1 --maxWorkers=3` 消 testcontainers flake。

---

### Task 1: api — 建线程错误透出 + SSE 早订阅竞态修复

Plan 1 遗留两处缺陷:(a) `POST /threads` 把 LLM 未配置等初始化失败静默吞掉,前端只见"空线程";(b) `GET /threads/:id/events` 在 session 未构建时订阅到 noop 上,后续 confirm_request/stage 事件全部丢失。本任务修根因并锁契约。

语义决策(按设计 §8 与 Plan 1 评审 backlog):
- **LLM 未配置 / 其它初始化失败 → 502 阻断**,删除刚落的线程行(不留孤儿),前端引导设置页。
- **repo checkout 失败(非 no_repo)→ 不阻断**:session 照常建立(repoAvailable=false),把原因记在 record 上,`POST /threads` 响应附 `lastError`,前端展示黄条警告(对话可用,repo_* 工具会失败)。
- **no_repo → 完全静默**(现状语义,未配仓库不是错误)。
- **events 路由订阅前先 `ensureSpaceRecord`**(幂等单飞,已有缓存直接返回),失败保留空快照语义。

**Files:**
- Modify: `apps/api/src/pi/space/session.ts`
- Modify: `apps/api/src/pi/space/router.ts`
- Test: `apps/api/test/space-router.test.ts`
- Test: `apps/api/test/space-session.test.ts`

- [ ] **Step 1: 写失败测试 — router 契约(space-router.test.ts)**

在 `describe('space wire contract', ...)` 内,**替换**现有用例 `POST /threads:工厂抛错(LLM 未配置等)仍返回空快照`(74-84 行)为以下两个用例(旧用例断言的正是要修掉的吞错行为):

```ts
  it('POST /threads:LLM 未配置 → 502 llm_not_configured,线程行不残留', async () => {
    const { versionId } = await seedProject(pool);
    const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
    const { HttpError } = await import('../src/middleware/errorHandler.js');
    setSpaceSessionFactory(async () => {
      throw new HttpError(502, 'llm_not_configured', 'LLM 未配置:请先到设置页配置模型');
    });
    const r = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('llm_not_configured');
    expect(r.body.message).toContain('LLM 未配置');
    // 初始化失败的线程行必须清掉,不进列表
    const rows = await pool.query(`SELECT count(*)::int AS n FROM ai_threads WHERE kind='version'`);
    expect(rows.rows[0]!.n).toBe(0);
    // 其它初始化错误 → 500 session_init_failed
    setSpaceSessionFactory(async () => { throw new Error('boom'); });
    const r2 = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    expect(r2.status).toBe(500);
    expect(r2.body.error).toBe('session_init_failed');
    setSpaceSessionFactory(async () => makeFakeSession() as never);
  });

  it('POST /threads:repo checkout 失败(非 no_repo)不阻断,响应附 lastError', async () => {
    const { versionId } = await seedProject(pool);
    const { setSpaceSessionFactory } = await import('../src/pi/space/session.js');
    // 先建一个注入 repoIssue 的 record:直接 SQL 落行 + 走 events 前的 ensure 不行(此处直接 POST),
    // 所以用「工厂正常 + checkout 桩抛 auth_failed」的方式 —— checkout 桩在 space-session.test.ts,
    // 这里退而求其次:直接调内部导出验证 router 读 spaceRepoIssue。改为端到端:插行 + GET 触发 ensure 不产 lastError,
    // 因此本用例只锁「POST 响应不带 issue 时无 lastError 字段污染」。
    setSpaceSessionFactory(async () => makeFakeSession() as never);
    const r = await request(app).post('/api/assistant/threads').send({ metadata: { versionId } });
    expect(r.status).toBe(200);
    expect(r.body.lastError).toBeUndefined();
  });
```

> 注:repo 失败 → `lastError` 的端到端断言放在 space-session.test.ts(那边有 checkout 桩);router 这里锁「无 issue 时响应干净」即可。

同一文件,**新增** SSE 竞态回归用例(放在现有 events 用例之后):

```ts
  it('events 对无 record 的持久化线程先 ensure:后续自定义事件可达(修复早订阅竞态)', async () => {
    const { versionId } = await seedProject(pool);
    const id = crypto.randomUUID();
    // 直接 SQL 落行:resetSpaceSessions 后 record 不存在 —— 旧实现订阅到 noop 上,emit 会丢
    await pool.query(`INSERT INTO ai_threads(id, kind, version_id, pi_thread_id) VALUES ($1,'version',$2,'')`, [id, versionId]);

    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/assistant/threads/${id}/events`);
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      expect(Buffer.from((await reader.read()).value!).toString('utf8')).toContain('snapshot');
      const { emitThreadEvent } = await import('../src/pi/space/session.js');
      emitThreadEvent(id, { type: 'stage', kind: 'case', id: 'c1', action: 'create' });
      const second = await reader.read();
      expect(Buffer.from(second.value!).toString('utf8')).toContain('stage');
      await reader.cancel();
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
```

- [ ] **Step 2: 写失败测试 — session 行为(space-session.test.ts)**

文件顶部 import 行加 `vi`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
```

紧随 import 块之后(`let container` 之前)加可注入 checkout 桩 + vi.mock:

```ts
// checkoutRepoForVersion 可注入桩;impl 为 undefined 时走真实实现(既有 no_repo 用例不受影响)
const mockCheckout = { impl: undefined as undefined | ((versionId: string) => Promise<string>) };

vi.mock('../src/pi/repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pi/repo.js')>();
  return {
    ...actual,
    checkoutRepoForVersion: (versionId: string) =>
      mockCheckout.impl ? mockCheckout.impl(versionId) : actual.checkoutRepoForVersion(versionId),
  };
});
```

在 `describe('space session supervisor', ...)` 内新增用例:

```ts
  it('checkout 失败(非 no_repo):session 照常建立但记录 repoIssue;no_repo 仍完全静默', async () => {
    const { versionId } = await seedProject(pool);
    const threadId = await insertSpaceThread(versionId);
    const { ensureSpaceRecord, spaceRepoIssue } = await import('../src/pi/space/session.js');
    const { RepoUnavailableError } = await import('../src/pi/repo.js');
    mockCheckout.impl = async () => { throw new RepoUnavailableError('auth_failed', 'PAT 无效'); };
    try {
      const rec = await ensureSpaceRecord(threadId);
      expect(rec.versionId).toBe(versionId);
      expect(spaceRepoIssue(threadId)).toContain('auth_failed');
    } finally {
      mockCheckout.impl = undefined;
    }
  }, 30_000);
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd apps/api && pnpm vitest run test/space-router.test.ts test/space-session.test.ts --minWorkers=1 --maxWorkers=3`
Expected: FAIL — 新用例 502/lastError/spaceRepoIssue 断言不满足(现实现吞错/无 ensure/无导出)。

- [ ] **Step 4: 实现 session.ts 修改**

(a) `ThreadRecord` 接口(apps/api/src/pi/space/session.ts:36-44)加一个字段:

```ts
interface ThreadRecord {
  threadId: string;
  versionId: string;
  session: SpaceSessionLike;
  listeners: Set<(e: unknown) => void>;
  unsub: () => void;
  seq: number;
  turnIndex: number;
  /** 非 no_repo 的仓库不可用原因说明(auth_failed 等);null = 正常或未配仓库(no_repo 静默)。 */
  repoIssue: string | null;
}
```

(b) `buildSpaceRecord` 的 repo 探测段(79-87 行)替换为:

```ts
  // repo 探测:no_repo 完全静默;其它失败 session 照常建立(repoAvailable=false),
  // 原因记在 record 上由 router 随建线程响应透出(前端黄条警告,不阻断对话)
  let cwd: string | null = null;
  let repoAvailable = false;
  let repoIssue: string | null = null;
  try {
    cwd = await checkoutRepoForVersion(row.versionId);
    repoAvailable = true;
  } catch (e) {
    if (!(e instanceof RepoUnavailableError)) throw e;
    if (e.reason !== 'no_repo') repoIssue = `${e.message}(${e.reason})`;
  }
```

同函数 `rec` 构造(90-98 行)补字段:

```ts
  const rec: ThreadRecord = {
    threadId,
    versionId: row.versionId,
    session,
    listeners: new Set(),
    unsub: () => { /* assigned below */ },
    seq: 0,
    turnIndex: -1,
    repoIssue,
  };
```

(c) `threadStatus` 函数之后(187 行附近)新增导出:

```ts
/** 线程构建时记录的仓库问题(非 no_repo);无 record 或无问题返回 null。 */
export function spaceRepoIssue(threadId: string): string | null {
  return records.get(threadId)?.repoIssue ?? null;
}
```

(d) 工厂 LLM 检查(215-217 行)改为抛 HttpError(与 router 同一错误通道,router 原样透传):

```ts
async function createSpaceSessionFactory(ctx: SpaceThreadContext): Promise<SpaceSessionLike> {
  const cfg = await readLlmConfig();
  if (!cfg) {
    const { HttpError } = await import('../../middleware/errorHandler.js');
    throw new HttpError(502, 'llm_not_configured', 'LLM 未配置:请先到设置页配置模型');
  }
```

> 用动态 import 避免模块加载顺序变化;`ctx` 参数在该分支未用到,保持原签名。

- [ ] **Step 5: 实现 router.ts 修改**

(a) import 行(18-19 行)补 `spaceRepoIssue`:

```ts
import {
  cancelThread, ensureSpaceRecord, sendSpaceUserMessage, snapshotOfThread, spaceRepoIssue, subscribeThread, threadStatus,
} from './session.js';
```

(b) `POST /threads`(41-52 行)替换为:

```ts
spaceRoute.post('/threads', async (req, res) => {
  const body = req.body as { metadata?: { versionId?: string } };
  const versionId = body.metadata?.versionId;
  if (!versionId) throw new HttpError(400, 'bad_request', 'metadata.versionId required');
  await assertVersionVisible(versionId, req.user as AuthUser);
  // 每次调用新建一线程(一版本多线程)。初始化失败(LLM 未配置等)→ 删行并透出错误,
  // 前端引导设置页;repo 不可用不阻断(session 照常建,原因经 lastError 透出)。
  const threadId = randomUUID();
  await db.insert(aiThreads).values({ id: threadId, kind: 'version', versionId, piThreadId: '' });
  try {
    await ensureSpaceRecord(threadId);
  } catch (e) {
    await db.delete(aiThreads).where(eq(aiThreads.id, threadId));
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, 'session_init_failed', e instanceof Error ? e.message : '会话初始化失败');
  }
  const snap = threadSnapshotResponse(threadId) as { lastError?: string };
  const issue = spaceRepoIssue(threadId);
  if (issue) snap.lastError = `仓库暂不可用:${issue};对话可用,repo 类工具在修复仓库配置前会失败`;
  res.json(snap);
});
```

(c) events 路由(118-130 行)替换为:

```ts
spaceRoute.get('/threads/:id/events', async (req, res) => {
  await assertSpaceThreadVisible(req.params.id!, req.user as AuthUser);
  sseHeaders(res);
  // 订阅前先确保 session 已构建:SSE 早于首条消息时若无 record,listener 会注册到
  // noop 上,后续 confirm_request/stage 全丢;ensure 幂等单飞,已有缓存直接返回。
  // 失败(LLM 未配置等)保留空快照语义,不中断连接。
  try { await ensureSpaceRecord(req.params.id!); } catch { /* 线程无法活跃,仍可接收快照 */ }
  try {
    const send = (e: unknown) => sseSend(res, e as unknown as Parameters<typeof sseSend>[1]);
    // subscribeThread 自带 snapshot(无活跃 session 时发合法空快照);
    // confirm_request / 舞台事件经 emitThreadEvent 走同一 listeners 通道。
    const unsub = subscribeThread(req.params.id!, send, { includeSnapshot: true });
    req.on('close', () => { unsub(); });
  } catch {
    res.end();
  }
});
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd apps/api && pnpm vitest run test/space-router.test.ts test/space-session.test.ts --minWorkers=1 --maxWorkers=3`
Expected: PASS(全部用例,含既有用例无回归)。

- [ ] **Step 7: 全量 api 回归**

Run: `cd apps/api && pnpm test -- --minWorkers=1 --maxWorkers=3`
Expected: 全绿(约 75 files)。若个别文件 testcontainers "Hook timed out",隔离重跑该文件确认非回归。

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/pi/space/session.ts apps/api/src/pi/space/router.ts apps/api/test/space-router.test.ts apps/api/test/space-session.test.ts
git commit -m "fix(api): 空间助手建线程错误透出与 SSE 早订阅竞态修复"
```

---

### Task 2: web — api.assistant 命名空间 + 路由接线 + AssistantPage(线程管理)

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/layout/AppIconRail.tsx`
- Modify: `apps/web/src/pages/ProjectsHome.tsx`
- Create: `apps/web/src/pages/AssistantPage.tsx`

- [ ] **Step 1: client.ts 加类型与命名空间**

(a) 在 `export interface Scenario {...}` 块之后(client.ts 约 732 行处)加:

```ts
export interface AssistantThread {
  id: string;
  title: string | null;
  status: 'running' | 'idle';
  createdAt?: string;
  updatedAt?: string;
}
```

(b) 在 `aiWorkspace: {...}` 命名空间结束(`},` 约 497 行)与 `registerAdmin` 之间插入:

```ts
  assistant: {
    listThreads: (versionId: string) =>
      request<AssistantThread[]>(`/assistant/threads${qs({ versionId })}`),
    /** 返回 Pi 快照;lastError=建线程时的非阻断警告(repo 不可用等)。 */
    createThread: (versionId: string) =>
      request<{ metadata: { id: string }; lastError?: string }>('/assistant/threads', {
        method: 'POST',
        body: JSON.stringify({ metadata: { versionId } }),
      }),
    confirm: (threadId: string, confirmId: string, approved: boolean) =>
      request<void>(`/assistant/threads/${threadId}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ confirmId, approved }),
      }),
  },
```

- [ ] **Step 2: App.tsx 路由**

(a) import 区(`import Dashboard from './pages/Dashboard';` 附近)加:

```ts
import AssistantPage from './pages/AssistantPage';
```

(b) `v/:versionId` 块中,把 `<Route index element={<Navigate to="overview" replace />} />` 改为落地 assistant,并新增 assistant 路由:

```tsx
          <Route path="v/:versionId">
            <Route index element={<Navigate to="assistant" replace />} />
            <Route path="assistant" element={<AssistantPage />} />
            <Route path="overview" element={<Dashboard />} />
```

(其余路由行不动。)

- [ ] **Step 3: AppIconRail 导航项**

`PROJECT_ITEMS` 数组(AppIconRail.tsx:32-37)首位加 AI 助手:

```ts
const PROJECT_ITEMS: ProjectNavItem[] = [
  { title: 'AI 助手', path: 'assistant', icon: 'message' },
  { title: '工作台', path: 'overview', icon: 'sparkles' },
  { title: '用例', path: 'groups', icon: 'beaker', related: ['cases', 'ai'] },
  { title: '执行计划', path: 'plans', icon: 'play' },
  { title: '执行历史', path: 'reports', icon: 'flag' },
];
```

- [ ] **Step 4: ProjectsHome 落地路由**

`enterVersion`(ProjectsHome.tsx:206-210)的 navigate 目标改为 assistant:

```ts
  const enterVersion = (projectId: string, projectName: string, v: ProjectVersion) => {
    enter({ id: projectId, name: projectName, versionId: v.id, versionName: v.name });
    switchVersion(v.id, v.name);
    navigate(`/p/${projectId}/v/${v.id}/assistant`);
  };
```

- [ ] **Step 5: 新建 AssistantPage.tsx**

创建 `apps/web/src/pages/AssistantPage.tsx`,完整内容:

```tsx
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import {
  PageShell,
  PageShellActions,
  PageShellContent,
  PageShellDescription,
  PageShellHeader,
  PageShellTitle,
} from '../components/layout/PageShell';

/**
 * 版本空间 AI 助手(AI-First 主入口):进入版本空间落地即对话。
 * 页面层只负责线程管理(最近线程下拉 + 新建 + 初始化错误引导);
 * 对话与舞台由 SpaceWorkspace 渲染(Task 3 接入)。
 */
export default function AssistantPage() {
  const { versionId } = useParams<{ projectId: string; versionId: string }>();
  const navigate = useNavigate();
  const threadsQ = useQuery({
    queryKey: ['assistant-threads', versionId],
    queryFn: () => api.assistant.listThreads(versionId!),
    enabled: !!versionId,
  });
  const [threadId, setThreadId] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  // 非阻断警告(repo 不可用等,后端经快照 lastError 透出):对话仍可用
  const [warning, setWarning] = useState<string | null>(null);

  // 首次进入自动选中最近一条线程;无线程时保持空态
  useEffect(() => {
    if (threadId) return;
    const first = threadsQ.data?.[0];
    if (first) setThreadId(first.id);
  }, [threadsQ.data, threadId]);

  const create = useMutation({
    mutationFn: () => api.assistant.createThread(versionId!),
    onSuccess: (snap) => {
      setInitError(null);
      setWarning(snap.lastError ?? null);
      setThreadId(snap.metadata.id);
      void threadsQ.refetch();
    },
    onError: (e: Error) => setInitError(e.message),
  });

  const llmMissing = initError?.includes('LLM 未配置') ?? false;
  const threads = threadsQ.data ?? [];

  return (
    <PageShell contained>
      <PageShellHeader>
        <PageShellTitle>AI 助手</PageShellTitle>
        <PageShellActions>
          <select
            className="input-base input-sm max-w-[280px]"
            value={threadId ?? ''}
            onChange={(e) => setThreadId(e.target.value || null)}
            aria-label="历史对话"
          >
            {!threadId && <option value="">开始新对话</option>}
            {threadId && !threads.some((t) => t.id === threadId) && (
              <option value={threadId}>新对话</option>
            )}
            {threads.map((t) => (
              <option key={t.id} value={t.id}>{t.title || '新对话'}</option>
            ))}
          </select>
          <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? '创建中…' : '新对话'}
          </Button>
        </PageShellActions>
        <PageShellDescription>用一句话管理用例、环境与计划;意图不明时 AI 会主动追问</PageShellDescription>
      </PageShellHeader>

      <PageShellContent className="min-h-0">
        {initError ? (
          <div
            className="rounded-[var(--radius-sm)] px-4 py-3 text-[13px]"
            style={{ border: '1px solid var(--destructive)', color: 'var(--destructive)' }}
          >
            {initError}
            <div className="flex gap-2 mt-2">
              {llmMissing && <Button size="sm" onClick={() => navigate('/settings')}>去设置模型</Button>}
              <Button size="sm" variant="ghost" disabled={create.isPending} onClick={() => create.mutate()}>重试</Button>
            </div>
          </div>
        ) : (
          <>
            {warning && (
              <div
                className="rounded-[var(--radius-sm)] px-4 py-2.5 text-[12px] shrink-0"
                style={{ border: '1px solid rgba(217,119,6,0.45)', color: '#b45309', background: 'rgba(217,119,6,0.08)' }}
              >
                {warning}
              </div>
            )}
            {threadId ? (
              <div className="flex-1 min-h-0 flex items-center justify-center text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
                对话区载入中…
              </div>
            ) : (
              <EmptyState
                icon="message"
                title="开始与 AI 的第一次对话"
                description="试试「看看现在有哪些环境」或「帮我建三条登录用例」。"
              />
            )}
          </>
        )}
      </PageShellContent>
    </PageShell>
  );
}
```

> 「对话区载入中…」占位在 Task 3 换成 `<SpaceWorkspace key={threadId} threadId={threadId} />`。

- [ ] **Step 6: 类型检查**

Run: `cd apps/web && pnpm typecheck`
Expected: 无错误。

- [ ] **Step 7: 浏览器冒烟(接线正确性)**

dev server 已在主 checkout 运行(web 5173 / api 54321;如未起,`pnpm -F @itest/web dev` 与 `pnpm -F @itest/api dev`)。浏览器登录 admin/admin123:
1. 首页任一项目展开版本行点「进入」→ 落地 `/p/:projectId/v/:versionId/assistant`,左侧图标栏「AI 助手」高亮(首位)。
2. 空态显示「开始与 AI 的第一次对话」;点「新对话」→ 创建成功、下拉出现「新对话」条目、内容区显示占位。
3. 直接访问 `/p/:projectId/v/:versionId`(不带子路径)→ 重定向到 `assistant`。
4. 「工作台」等旧入口仍可达,「AI 助手」高亮不与用例(related: cases/ai)冲突。

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/App.tsx apps/web/src/components/layout/AppIconRail.tsx apps/web/src/pages/ProjectsHome.tsx apps/web/src/pages/AssistantPage.tsx
git commit -m "feat(web): 版本空间 AI 助手落地页与线程管理,进入版本默认对话"
```

---

### Task 3: web — SpaceWorkspace 运行时容器 + SpaceThreadPane 对话流

**Files:**
- Create: `apps/web/src/features/space-assistant/SpaceWorkspace.tsx`
- Create: `apps/web/src/features/space-assistant/SpaceThreadPane.tsx`
- Modify: `apps/web/src/pages/AssistantPage.tsx`

- [ ] **Step 1: 新建 SpaceThreadPane.tsx**

创建 `apps/web/src/features/space-assistant/SpaceThreadPane.tsx`,完整内容(渲染结构沿用 ai-workspace/ThreadPane,无 metadata 覆写需求):

```tsx
import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ReasoningMessagePartProps,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';

/**
 * 空间助手对话流:只渲染 pi 契约的结构原语,运行时由 SpaceWorkspace 的
 * AssistantRuntimeProvider 提供。composer 上方为确认卡插槽(Task 4 接入)。
 */
export default function SpaceThreadPane() {
  return (
    <div className="flex flex-col h-full">
      <ThreadPrimitive.Root className="flex flex-col h-full">
        <ThreadPrimitive.Viewport className="flex-1 min-h-0 overflow-y-auto p-4">
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
        <ThreadPrimitive.ViewportFooter className="border-t p-3" style={{ borderColor: 'var(--border)' }}>
          <ComposerPrimitive.Root className="flex items-end gap-2">
            <ComposerPrimitive.Input
              minRows={1}
              maxRows={6}
              placeholder="让 AI 查环境、建用例、排计划…"
              className="flex-1 resize-none rounded-md border px-3 py-2 text-[13px] outline-none"
              style={{ borderColor: 'var(--border)', background: 'var(--popover)', color: 'var(--foreground)' }}
            />
            <ThreadPrimitive.If running={false}>
              <ComposerPrimitive.Send
                className="shrink-0 rounded-md px-3 py-2 text-[13px] text-white"
                style={{ background: 'var(--primary)' }}
              >
                发送
              </ComposerPrimitive.Send>
            </ThreadPrimitive.If>
            <ThreadPrimitive.If running>
              <ComposerPrimitive.Cancel
                className="shrink-0 rounded-md px-3 py-2 text-[13px] text-white"
                style={{ background: 'var(--destructive)' }}
              >
                停止
              </ComposerPrimitive.Cancel>
            </ThreadPrimitive.If>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Root>
    </div>
  );
}

function UserMessage() {
  return (
    <div className="flex justify-end mb-3">
      <div
        className="max-w-[85%] rounded-lg px-3 py-2 text-[13px] whitespace-pre-wrap"
        style={{ background: 'var(--primary-soft)', color: 'var(--foreground)' }}
      >
        <MessagePrimitive.Parts />
      </div>
    </div>
  );
}

function AssistantMessage() {
  return (
    <div className="mb-3 text-[13px] whitespace-pre-wrap" style={{ color: 'var(--foreground)' }}>
      <MessagePrimitive.Parts
        components={{
          Reasoning: ThinkingPart,
          tools: { Fallback: ToolActivity },
        }}
      />
    </div>
  );
}

/** thinking 段:进行中给"思考中…"心跳提示,完成后收起(推理文本不常驻聊天区)。 */
function ThinkingPart({ status }: ReasoningMessagePartProps) {
  if (status.type !== 'running') return null;
  return (
    <div className="mb-1 animate-pulse text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
      思考中…
    </div>
  );
}

/** 空间工具 → 活动行文案;未知工具返回 null 不渲染。 */
function toolMeta(toolName: string, args: unknown): { icon: string; label: string; summary: string } | null {
  const a = (args ?? {}) as Record<string, unknown>;
  const action = typeof a.action === 'string' ? a.action : '';
  if (toolName === 'inspect_page') return { icon: '🔍', label: '抓取页面', summary: typeof a.url === 'string' ? a.url : '' };
  if (toolName === 'announce_plan') return { icon: '📣', label: '生成计划', summary: typeof a.summary === 'string' ? a.summary : '' };
  if (toolName === 'manage_cases') return { icon: '📝', label: '用例管理', summary: action };
  if (toolName === 'manage_scenarios') return { icon: '🗂', label: '场景管理', summary: action };
  if (toolName === 'manage_environments') return { icon: '🌐', label: '环境管理', summary: action };
  if (toolName === 'manage_plans') return { icon: '📋', label: '计划管理', summary: action };
  if (toolName.startsWith('repo_')) {
    return { icon: '📂', label: '读取仓库', summary: typeof a.path === 'string' ? a.path : (typeof a.command === 'string' ? a.command : '') };
  }
  return null;
}

/** 工具调用活动行:进行中/完成/失败三态,让操作过程有渐进反馈。 */
function ToolActivity(part: ToolCallMessagePartProps) {
  const meta = toolMeta(part.toolName, part.args);
  if (!meta) return null;
  const running = part.status.type === 'running';
  return (
    <div className="mb-1 flex min-w-0 items-center gap-1.5 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
      <span>{meta.icon}</span>
      <span className="truncate">
        {meta.label}
        {meta.summary ? `：${meta.summary}` : ''}
      </span>
      {running ? (
        <span className="animate-pulse">进行中…</span>
      ) : (
        <span className="shrink-0" style={{ color: part.isError ? 'var(--destructive)' : 'var(--primary)' }}>
          {part.isError ? '✗ 失败' : '✓'}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 新建 SpaceWorkspace.tsx**

创建 `apps/web/src/features/space-assistant/SpaceWorkspace.tsx`,完整内容:

```tsx
import { useMemo } from 'react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { createPiHttpClient, usePiRuntime } from '@assistant-ui/react-pi';
import SpaceThreadPane from './SpaceThreadPane';

interface Props {
  threadId: string;
}

/**
 * 空间助手运行时容器:client 指向 /api/assistant(与 /api/pi 同契约的子集),
 * AssistantRuntimeProvider 包住对话流与舞台(Task 5),两栏共享 aui 上下文。
 * 父级以 key=threadId 挂载本组件:切换线程即重挂载出全新 runtime。
 */
export default function SpaceWorkspace({ threadId }: Props) {
  const client = useMemo(() => createPiHttpClient({ baseUrl: '/api/assistant' }), []);
  const runtime = usePiRuntime({ client, initialThreadId: threadId });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 min-h-0" style={{ borderRight: '1px solid var(--border)' }}>
          <SpaceThreadPane />
        </div>
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          {/* 舞台区(Task 5 接入 StagePanel) */}
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
```

- [ ] **Step 3: AssistantPage 接入**

AssistantPage.tsx:顶部加 `import SpaceWorkspace from '../features/space-assistant/SpaceWorkspace';`,把「对话区载入中…」占位块替换为:

```tsx
            {threadId ? (
              <SpaceWorkspace key={threadId} threadId={threadId} />
            ) : (
```

(占位 div 删除;`warning` 分支保持在外层。)

- [ ] **Step 4: 类型检查**

Run: `cd apps/web && pnpm typecheck`
Expected: 无错误。

- [ ] **Step 5: 浏览器验证(对话主链路)**

1. 进入版本空间 assistant 页,选/新建线程 → 输入「现在有哪些环境?」发送:
   - 用户消息气泡右对齐;「思考中…」心跳出现后消失;AI 文本流式出现并直答环境清单(上下文摘要已注入,免查直答)。
2. 输入「帮我在冒烟测试分组建两条登录用例」→ 聊天区出现 `📝 用例管理：create` 活动行,进行中→✓;完成后 AI 汇总。
3. 流式期间发送按钮变「停止」,点击停止 → 运行终止不崩。
4. 刷新页面 → 线程历史消息经快照恢复(GET /threads/:id)。
5. 下拉切换到另一线程 → 对话流随 key 重挂载切换,历史互不串。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/space-assistant/SpaceWorkspace.tsx apps/web/src/features/space-assistant/SpaceThreadPane.tsx apps/web/src/pages/AssistantPage.tsx
git commit -m "feat(web): 空间助手对话流,复用 react-pi 契约直连 /api/assistant"
```

---

### Task 4: web — 自定义 SSE 事件消费 + 确认卡

自定义事件(confirm_request/stage/announce)与 pi 契约事件同流。react-pi 对未知事件类型原样忽略,所以在本任务的 client.subscribe 分流:每条事件先喂空间事件 store,再交给 runtime。

**Files:**
- Create: `apps/web/src/features/space-assistant/spaceEventsStore.ts`
- Create: `apps/web/src/features/space-assistant/ConfirmCard.tsx`
- Modify: `apps/web/src/features/space-assistant/SpaceWorkspace.tsx`
- Modify: `apps/web/src/features/space-assistant/SpaceThreadPane.tsx`

- [ ] **Step 1: 新建 spaceEventsStore.ts**

创建 `apps/web/src/features/space-assistant/spaceEventsStore.ts`,完整内容:

```ts
import { create } from 'zustand';

/** 后端 confirm_request 事件(pick 相关字段;confirmId 去重用)。 */
export interface SpaceConfirmRequest {
  confirmId: string;
  toolName: string;
  action: string;
  summary: string;
  diff?: string;
  risk: 'update' | 'delete' | 'secret';
}

export type StageKind = 'case' | 'scenario' | 'environment' | 'plan' | 'group';

export interface StageObject {
  key: string;
  kind: StageKind;
  id: string;
  action: string;
  diff?: string;
}

export interface AnnounceState {
  summary: string;
  total: number;
  done: number;
}

interface SpaceEventsState {
  confirms: SpaceConfirmRequest[];
  stageHistory: StageObject[];
  announce: AnnounceState | null;
  /** Pi client 订阅分流入口:只认空间自定义事件,pi 契约事件忽略。 */
  ingest: (e: Record<string, unknown>) => void;
  removeConfirm: (confirmId: string) => void;
  reset: () => void;
}

const MAX_STAGE_HISTORY = 50;
let stageSeq = 0;

export const useSpaceEventsStore = create<SpaceEventsState>((set) => ({
  confirms: [],
  stageHistory: [],
  announce: null,
  ingest: (e) => {
    if (e.type === 'confirm_request') {
      const c = e as unknown as SpaceConfirmRequest;
      set((s) => (s.confirms.some((x) => x.confirmId === c.confirmId) ? s : { confirms: [...s.confirms, c] }));
      return;
    }
    if (e.type === 'stage') {
      const obj: StageObject = {
        key: `s${++stageSeq}`,
        kind: e.kind as StageKind,
        id: e.id as string,
        action: e.action as string,
        ...(typeof e.diff === 'string' ? { diff: e.diff } : {}),
      };
      set((s) => ({
        stageHistory: [...s.stageHistory, obj].slice(-MAX_STAGE_HISTORY),
        // announce 后的 stage 事件驱动进度;无 announce 时静默累计不展示
        announce: s.announce ? { ...s.announce, done: s.announce.done + 1 } : s.announce,
      }));
      return;
    }
    if (e.type === 'announce') {
      set({
        announce: { summary: String(e.summary ?? ''), total: Number(e.total ?? 0), done: 0 },
      });
      return;
    }
    if (e.type === 'agent_start') {
      // 新一轮开始:清掉上一轮的 announce 进度(舞台历史保留)
      set((s) => (s.announce ? { announce: null } : s));
    }
  },
  removeConfirm: (confirmId) =>
    set((s) => ({ confirms: s.confirms.filter((c) => c.confirmId !== confirmId) })),
  reset: () => set({ confirms: [], stageHistory: [], announce: null }),
}));
```

> 已知限制(记录到代码注释即可,不做机制):SSE 断线重连只重放 snapshot,挂起中的确认卡会丢,后端 5 分钟超时后 AI 会收到"用户取消"。快照帧(type='snapshot')不在上述分支内,天然忽略。

- [ ] **Step 2: 新建 ConfirmCard.tsx**

创建 `apps/web/src/features/space-assistant/ConfirmCard.tsx`,完整内容:

```tsx
import { useMutation } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import { useSpaceEventsStore, type SpaceConfirmRequest } from './spaceEventsStore';

const RISK_META: Record<SpaceConfirmRequest['risk'], { label: string; color: string; bg: string }> = {
  update: { label: '更新', color: 'var(--primary)', bg: 'var(--primary-soft)' },
  delete: { label: '删除', color: 'var(--destructive)', bg: 'rgba(239,68,68,0.10)' },
  secret: { label: '密钥', color: '#b45309', bg: 'rgba(217,119,6,0.12)' },
};

/** 确认卡:钉在 composer 上方;确认/取消 → POST /confirm,404(过期)也收卡并提示。 */
export default function ConfirmCard({ threadId }: { threadId: string }) {
  const confirms = useSpaceEventsStore((s) => s.confirms);
  const removeConfirm = useSpaceEventsStore((s) => s.removeConfirm);
  const toast = useUIStore((s) => s.showToast);
  const decide = useMutation({
    mutationFn: (v: { confirmId: string; approved: boolean }) =>
      api.assistant.confirm(threadId, v.confirmId, v.approved),
    onSuccess: (_r, v) => removeConfirm(v.confirmId),
    onError: (e: Error, v) => {
      removeConfirm(v.confirmId);
      toast(e.message, 'error');
    },
  });
  if (confirms.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 pb-2">
      {confirms.map((c) => {
        const meta = RISK_META[c.risk] ?? RISK_META.update;
        const pending = decide.isPending;
        return (
          <div
            key={c.confirmId}
            className="rounded-[var(--radius-sm)] px-3 py-2.5"
            style={{ border: `1px solid ${meta.color}`, background: 'var(--popover)' }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="text-[10px] px-1.5 py-[1px] rounded font-medium shrink-0"
                style={{ color: meta.color, background: meta.bg }}
              >
                {meta.label}
              </span>
              <span className="text-[13px] font-medium truncate" style={{ color: 'var(--foreground)' }}>
                {c.summary}
              </span>
            </div>
            {c.diff && (
              <details className="mt-1.5">
                <summary className="text-[12px] cursor-pointer" style={{ color: 'var(--muted-foreground)' }}>
                  查看变更明细
                </summary>
                <pre
                  className="mt-1 text-[11px] whitespace-pre-wrap max-h-40 overflow-y-auto"
                  style={{ color: 'var(--muted-foreground)' }}
                >
                  {c.diff}
                </pre>
              </details>
            )}
            <div className="flex justify-end gap-2 mt-2">
              <button
                type="button"
                className="rounded-md px-2.5 py-1 text-[12px]"
                style={{ border: '1px solid var(--border)', color: 'var(--muted-foreground)', background: 'transparent' }}
                disabled={pending}
                onClick={() => decide.mutate({ confirmId: c.confirmId, approved: false })}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-md px-2.5 py-1 text-[12px] text-white"
                style={{ background: meta.color }}
                disabled={pending}
                onClick={() => decide.mutate({ confirmId: c.confirmId, approved: true })}
              >
                {pending ? '处理中…' : '确认执行'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: SpaceWorkspace 分流 + 重置**

SpaceWorkspace.tsx 修改为(完整替换):

```tsx
import { useEffect, useMemo } from 'react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { createPiHttpClient, usePiRuntime, type PiClientEvent } from '@assistant-ui/react-pi';
import SpaceThreadPane from './SpaceThreadPane';
import { useSpaceEventsStore } from './spaceEventsStore';

interface Props {
  threadId: string;
}

/**
 * 空间助手运行时容器:client 指向 /api/assistant(与 /api/pi 同契约的子集);
 * subscribe 分流:自定义事件(confirm_request/stage/announce)先进空间事件 store,
 * 再原样交给 runtime(pi 契约事件 runtime 自己处理,自定义事件其 reducer 忽略)。
 * 父级以 key=threadId 挂载本组件:切换线程即重挂载出全新 runtime。
 */
export default function SpaceWorkspace({ threadId }: Props) {
  const client = useMemo(() => {
    const base = createPiHttpClient({ baseUrl: '/api/assistant' });
    const ingest = useSpaceEventsStore.getState().ingest;
    return {
      ...base,
      subscribe: (tid: string, listener: (e: PiClientEvent) => void, options?: { includeSnapshot?: boolean }) =>
        base.subscribe(
          tid,
          (e) => {
            ingest(e as unknown as Record<string, unknown>);
            listener(e);
          },
          options,
        ),
    };
  }, []);
  // 线程切换(mount)时清掉上一线程的确认卡与舞台状态
  useEffect(() => {
    useSpaceEventsStore.getState().reset();
  }, [threadId]);
  const runtime = usePiRuntime({ client, initialThreadId: threadId });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 min-h-0" style={{ borderRight: '1px solid var(--border)' }}>
          <SpaceThreadPane threadId={threadId} />
        </div>
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          {/* 舞台区(Task 5 接入 StagePanel) */}
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
```

- [ ] **Step 4: SpaceThreadPane 挂确认卡**

SpaceThreadPane.tsx:
(a) 签名与顶部 import 改为:

```tsx
import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ReasoningMessagePartProps,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import ConfirmCard from './ConfirmCard';

export default function SpaceThreadPane({ threadId }: { threadId: string }) {
```

(b) ViewportFooter 内、ComposerPrimitive.Root 之前插一行:

```tsx
        <ThreadPrimitive.ViewportFooter className="border-t p-3" style={{ borderColor: 'var(--border)' }}>
          <ConfirmCard threadId={threadId} />
          <ComposerPrimitive.Root className="flex items-end gap-2">
```

- [ ] **Step 5: 类型检查**

Run: `cd apps/web && pnpm typecheck`
Expected: 无错误。

- [ ] **Step 6: 浏览器验证(确认门控全分支)**

1. 「删除用例xxx」(用已有真实用例名)→ composer 上方出现红徽标「删除」确认卡;点「取消」→ AI 回复已取消,卡片消失,用例仍在。
2. 再次发起删除 → 点「确认执行」→ 卡片消失,舞台(下一任务)与用例库中该用例删除。
3. 「把环境 staging 的 baseUrl 改成 http://x.example.com」→ 蓝徽标「更新」卡,「查看变更明细」展开显示 diff;确认后生效。
4. 「设置环境 xxx 的 db 密码为 supersecret」→ 琥珀徽标「密钥」卡,summary 不含明文;确认后 AI 收到成功且任何回复不含明文。
5. 确认卡挂起期间刷新页面 → 卡片消失(已知限制),约 5 分钟后 AI 侧超时收尾;可再发起。
6. 切换线程 → 确认卡与舞台状态清空。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/space-assistant/spaceEventsStore.ts apps/web/src/features/space-assistant/ConfirmCard.tsx apps/web/src/features/space-assistant/SpaceWorkspace.tsx apps/web/src/features/space-assistant/SpaceThreadPane.tsx
git commit -m "feat(web): 空间助手确认卡与自定义 SSE 事件消费"
```

---

### Task 5: web — StagePanel 舞台(对象卡 + announce 进度 + 跳转/就此提问)

**Files:**
- Create: `apps/web/src/features/space-assistant/StagePanel.tsx`
- Modify: `apps/web/src/features/space-assistant/SpaceWorkspace.tsx`

- [ ] **Step 1: 新建 StagePanel.tsx**

创建 `apps/web/src/features/space-assistant/StagePanel.tsx`,完整内容:

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAui } from '@assistant-ui/react';
import { api } from '../../api/client';
import Icon from '../../components/Icon';
import Button from '../../components/ui/Button';
import { useSpaceEventsStore, type StageObject } from './spaceEventsStore';

const KIND_LABEL: Record<StageObject['kind'], string> = {
  case: '用例', scenario: '场景', environment: '环境', plan: '计划', group: '分组',
};

const ACTION_LABEL: Record<string, string> = {
  create: '新建', update: '更新', delete: '删除', upsert: '保存',
  move_group: '移动分组', create_group: '新建分组',
  add_cases: '添加用例', remove_cases: '移除用例', set_secret: '设置密钥',
};
const actionLabel = (a: string) => ACTION_LABEL[a] ?? a;

function openPathFor(o: StageObject, projectId: string, versionId: string): string {
  const base = `/p/${projectId}`;
  if (o.kind === 'case') return `${base}/v/${versionId}/cases/${o.id}`;
  if (o.kind === 'plan') return `${base}/v/${versionId}/plans/${o.id}`;
  if (o.kind === 'environment') return `${base}/environments`;
  return `${base}/v/${versionId}/groups`;
}

interface Props {
  projectId: string;
  versionId: string;
}

/**
 * 舞台:展示 AI 最近操作的对象(stage 事件流)。批量操作 = 历史列表 + 点选详情;
 * announce 事件驱动进度条。卡片底部跳传统页 + 「就此提问」显式注入 composer。
 */
export default function StagePanel({ projectId, versionId }: Props) {
  const stageHistory = useSpaceEventsStore((s) => s.stageHistory);
  const announce = useSpaceEventsStore((s) => s.announce);
  const navigate = useNavigate();
  const aui = useAui();
  const latest = stageHistory[stageHistory.length - 1] ?? null;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // 新 stage 到来自动切到最新对象;用户点选历史后保持所选
  useEffect(() => {
    if (latest) setSelectedKey(latest.key);
  }, [latest]);
  const selected = stageHistory.find((o) => o.key === selectedKey) ?? latest;

  const caseQ = useQuery({
    queryKey: ['cases', selected?.id],
    queryFn: () => api.cases.get(selected!.id),
    enabled: selected?.kind === 'case',
    retry: false,
  });
  const planQ = useQuery({
    queryKey: ['plans', selected?.id],
    queryFn: () => api.plans.get(selected!.id),
    enabled: selected?.kind === 'plan',
    retry: false,
  });
  const envsQ = useQuery({
    queryKey: ['environments', projectId],
    queryFn: () => api.environments.list(projectId),
    enabled: selected?.kind === 'environment',
  });
  const scenariosQ = useQuery({
    queryKey: ['scenarios', projectId],
    queryFn: () => api.scenarios.listForProject(projectId),
    enabled: selected?.kind === 'scenario',
  });

  // 选中对象的展示标题(取不到时不渲染「就此提问」)
  let title: string | null = null;
  let body: React.ReactNode = null;
  if (selected?.kind === 'case') {
    const c = caseQ.data;
    if (c) {
      title = c.title;
      body = (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] px-1.5 py-[1px] rounded" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>{c.priority}</span>
            <span className="text-[10px] px-1.5 py-[1px] rounded" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>{c.status}</span>
          </div>
          {c.url && <div className="text-[12px] break-all" style={{ color: 'var(--muted-foreground)' }}>{c.url}</div>}
          {c.description && <p className="text-[12px] whitespace-pre-wrap" style={{ color: 'var(--muted-foreground)' }}>{c.description}</p>}
        </div>
      );
    } else if (caseQ.isError) {
      body = <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>用例已不存在(可能已被删除)。</p>;
    }
  } else if (selected?.kind === 'plan') {
    const p = planQ.data;
    if (p) {
      title = p.name;
      body = (
        <div className="flex flex-col gap-1.5">
          <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>编排 {p.cases.length} 条用例</div>
          <ol className="text-[12px] pl-4 list-decimal" style={{ color: 'var(--muted-foreground)' }}>
            {p.cases.slice(0, 10).map((c) => <li key={c.id} className="truncate">{c.title}</li>)}
          </ol>
          {p.cases.length > 10 && <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>…等 {p.cases.length} 条</div>}
        </div>
      );
    } else if (planQ.isError) {
      body = <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>计划已不存在。</p>;
    }
  } else if (selected?.kind === 'environment') {
    const env = (envsQ.data ?? []).find((e) => e.id === selected.id);
    if (env) {
      title = env.name;
      body = (
        <div className="flex flex-col gap-1.5">
          {env.isDefault && <span className="text-[10px] px-1.5 py-[1px] rounded self-start" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>默认环境</span>}
          {env.baseUrl && <div className="text-[12px] break-all" style={{ color: 'var(--muted-foreground)' }}>{env.baseUrl}</div>}
          <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            凭据对象 {env.objects.length} 个
          </div>
        </div>
      );
    }
  } else if (selected?.kind === 'scenario') {
    const sc = (scenariosQ.data ?? []).find((x) => x.id === selected.id);
    if (sc) {
      title = sc.title;
      body = sc.description ? <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>{sc.description}</p> : null;
    }
  } else if (selected) {
    // group:无单查接口,展示 diff 或引导文案
    body = selected.diff
      ? <pre className="text-[11px] whitespace-pre-wrap" style={{ color: 'var(--muted-foreground)' }}>{selected.diff}</pre>
      : <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>分组已更新,可在用例库查看。</p>;
  }

  const askAbout = () => {
    if (!selected || !title) return;
    aui.thread.composer().setText(`关于${KIND_LABEL[selected.kind]}「${title}」：`);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        className="px-4 py-2.5 text-[12px] font-medium shrink-0"
        style={{ borderBottom: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
      >
        舞台
      </div>
      {announce && (
        <div className="px-4 py-2.5 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={12} className="animate-spin shrink-0" />
            <span className="truncate">{announce.summary}</span>
            <span className="shrink-0">{Math.min(announce.done, announce.total)}/{announce.total}</span>
          </div>
          <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: 'var(--muted)' }}>
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${announce.total ? Math.min(100, (announce.done / announce.total) * 100) : 0}%`,
                background: 'var(--primary)',
              }}
            />
          </div>
        </div>
      )}
      {stageHistory.length > 1 && (
        <div className="shrink-0 max-h-32 overflow-y-auto" style={{ borderBottom: '1px solid var(--border)' }}>
          {[...stageHistory].reverse().map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => setSelectedKey(o.key)}
              className="block w-full text-left px-4 py-1.5 text-[12px] truncate"
              style={{
                background: o.key === selected?.key ? 'var(--muted)' : 'transparent',
                color: o.key === selected?.key ? 'var(--foreground)' : 'var(--muted-foreground)',
              }}
            >
              {KIND_LABEL[o.kind]} · {actionLabel(o.action)}
            </button>
          ))}
        </div>
      )}
      {!selected ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[12px] px-6 text-center" style={{ color: 'var(--muted-foreground)' }}>
            AI 创建或修改的用例、环境、计划会展示在这里
          </p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          <div className="flex items-center gap-2 mb-2">
            <span
              className="text-[10px] px-1.5 py-[1px] rounded shrink-0"
              style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}
            >
              {KIND_LABEL[selected.kind]}
            </span>
            <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>{actionLabel(selected.action)}</span>
          </div>
          {title && <h3 className="text-[14px] font-semibold mb-2" style={{ color: 'var(--foreground)' }}>{title}</h3>}
          {body ?? <Icon name="loader" size={14} className="animate-spin" />}
        </div>
      )}
      {selected && (
        <div
          className="flex items-center gap-2 px-4 py-2.5 shrink-0"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <Button size="sm" variant="ghost" onClick={() => navigate(openPathFor(selected, projectId, versionId))}>
            <Icon name="externalLink" size={12} />
            {selected.kind === 'environment' ? '环境管理' : selected.kind === 'plan' ? '打开计划' : '在用例库打开'} →
          </Button>
          {title && (
            <Button size="sm" variant="ghost" onClick={askAbout}>
              就此提问
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: SpaceWorkspace 接入舞台**

SpaceWorkspace.tsx:
(a) import 加 `import StagePanel from './StagePanel';` 与 `useParams`:

```tsx
import { useParams } from 'react-router-dom';
```

(b) Props 增加projectId/versionId 并从路由取:

```tsx
interface Props {
  threadId: string;
}
```

组件签名与右栏改为:

```tsx
export default function SpaceWorkspace({ threadId }: Props) {
  const { projectId, versionId } = useParams<{ projectId: string; versionId: string }>();
  ...
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          <StagePanel projectId={projectId!} versionId={versionId!} />
        </div>
```

(替换掉 Task 3 的空占位注释 div。)

- [ ] **Step 3: 类型检查**

Run: `cd apps/web && pnpm typecheck`
Expected: 无错误。

- [ ] **Step 4: 浏览器验证(舞台全链路)**

1. 「帮我建 3 条登录用例」→ AI 发 announce(📣)→ 舞台顶部出现进度条,随 stage 事件 1/3→3/3;每条用例入历史列表,自动选中最新一条,详情卡显示标题/优先级/URL。
2. 点历史列表其它行 → 详情切换;新 stage 到来又自动跳最新。
3. 详情卡「在用例库打开 →」→ 跳 `/cases/:id` 用例详情;plan 卡「打开计划」→ 计划详情;environment 卡「环境管理」→ 项目环境页。
4. 点「就此提问」→ composer 出现「关于用例「xxx」：」,可继续输入并发送,AI 围绕该对象回答。
5. 「制定一个冒烟计划包含刚才的用例」→ 计划卡显示编排列表。
6. 空线程(新对话)舞台显示占位文案。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/space-assistant/StagePanel.tsx apps/web/src/features/space-assistant/SpaceWorkspace.tsx
git commit -m "feat(web): 空间助手舞台区,对象卡+批量进度+跳转与显式提问"
```

---

### Task 6: 收尾 — 全量回归 + 设计对照验证

**Files:** 无新改动(如验证发现缺陷,修复后补提交)。

- [ ] **Step 1: 全量测试 + 构建**

```bash
cd apps/api && pnpm test -- --minWorkers=1 --maxWorkers=3
cd apps/web && pnpm typecheck && pnpm build
cd apps/api && pnpm typecheck
```

Expected: api 全绿;web typecheck/build 通过。

- [ ] **Step 2: 设计 §6/§8 验收清单(逐条人工核)**

- 落地即对话:进入版本 → assistant;rail「AI 助手」首位高亮 ✓
- 分栏:左对话右舞台;舞台按 kind 切换 ✓
- 「在用例库打开 →」各 kind 跳转正确 ✓
- 「就此提问」注入 composer ✓
- 线程下拉(最近 20,后端截断)+ 新建 ✓
- 确认分级:create 自动;update 显示 diff;delete/secret 必须确认;密钥永不回显 ✓
- 主动追问:输入「帮我配一下环境」(信息不足)→ AI 先追问 URL/名称,不猜参数 ✓
- LLM 未配置:建线程 502 → 红条 + 「去设置模型」按钮(api 测试已锁,浏览器可用错误配置复验一次)✓
- repo 不可用(如改错 PAT):建线程成功 + 顶部黄条警告,对话可用 ✓
- 断线恢复:刷新页面消息快照恢复 ✓
- 旧页面无回归:overview/groups/cases/ai/plans/reports/environments 全部正常 ✓

- [ ] **Step 3: 最终整体 review(按 subagent-driven-development 惯例派最终审查代理),随后按 Plan 1/2 惯例向用户提供合并方式选择**

---

## Self-Review 记录

- **Spec 覆盖**:§6 路由(T2)/舞台(T4+T5)/上下文注入(Plan 2 已有)/主动追问(prompt 侧 Plan 2 已有,验收核)/线程管理(T2);§8 错误处理(T1 LLM/repo、T2 前端引导、确认超时为 Plan 1 已有机制);§9 测试策略(T1 契约测试 + T6 手动清单)。§7 数据模型属 Plan 1 已交付(0026/0027 已合),不重复。
- **占位符扫描**:各步骤均含完整代码;T5 中 `body ?? <loader/>` 的 `React.ReactNode` 需 `import type React from 'react'`?— 不需要,TSX 下 `React.ReactNode` 类型引用需 `import type { ReactNode } from 'react'` 并写作 `ReactNode`(实现者按 typecheck 报错即知,已在代码中用 `React.ReactNode` 之处若报错改为 `ReactNode`)。
- **类型一致性**:`api.assistant.createThread` 返回 `{metadata:{id}; lastError?}` 与 AssistantPage 用法一致;store 的 `StageObject.key` 与 StagePanel `selectedKey` 一致;`SpaceThreadPane` 的 props 随 Task 4 从无参变为 `{threadId}`(两步内自洽)。
