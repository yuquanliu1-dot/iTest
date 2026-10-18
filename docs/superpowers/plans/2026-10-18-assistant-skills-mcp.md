# AI 助手 Skills + MCP 支持实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给版本空间 AI 助手（pi-coding-agent v0.99.2 × Claude API）加 Skills（S1 DB 常驻指令 + S2 pi 原生按需技能）与 MCP（DB 配置 + `pi.registerMcpServer` 通用通道），不改助手核心链路、不引入新容器局部状态（`/api/assistant` 已由 nginx 粘性钉单副本）。

**Architecture:** 两个特性共用「**DB 配置 + 会话时加载**」模式，全在 `apps/api/src/pi/space/session.ts` 的工厂 `createSpaceSessionFactory` 汇合：

| 特性 | 持久化 | 加载点 |
|---|---|---|
| S1 guides | `assistant_guides` 表 | `buildSpaceSystemPrompt` 第三参（随 SSE/消息同链，改 DB 即热生效于新线程） |
| S2 skills | `workspaceDir/.pi/skills/` 目录 | `DefaultResourceLoader additionalSkillPaths` + `read_skill` 工具 + 自渲染 skills 段 |
| MCP | `assistant_mcp_servers` 表 | `pi.registerMcpServer` + `createMcpExtension`（`session_start` 时建连） |

三者的 extensionFactories 顺序铁律 = **skills → mcp → identity**（见关键事实 §1：identity 的 `before_agent_start` 渲染 `event.systemPrompt` 快照并冻结后续 section 变更）。

**Tech Stack:** 零新 npm 包。复用 `@earendil-works/pi-coding-agent`（`createMcpExtension` / `loadSkills` / `DefaultResourceLoader` / `defineTool`）、drizzle-orm + pg、express Router、vitest + testcontainers。

---

## 关键事实（全部对安装的 pi 0.99.2 dist 逐行验证过，实现时勿重探）

1. **extensionFactories 顺序 = skills → mcp → identity。** `emitBeforeAgentStart`（`dist/core/runner.js:1115-1136`）逐个调用 handler；`event.systemPrompt` 是 **getter**，从共享的 mutable `currentOptions` 重新渲染；任一 handler 返回 `{systemPrompt}` 即 set `forceSystemPrompt`，**冻结后续 section 变更**。identity 扩展读取 `event.systemPrompt` 做 preamble 改写并返回 `{systemPrompt}`——所以 skills/mcp 的 section 变更必须在其前发生。注入顺序：skills 段 → mcp_servers 段 → identity 的 forceSystemPrompt。
2. **`bindExtensions` 是 MCP 生效的硬前提。** `session_start` 只在 `AgentSession.bindExtensions()` 里 emit（`dist/core/agent-session.js:2536`）。`createMcpExtension` 的 `session_start` handler 读 `pi.getMcpServers()` 并后台建连——**不 bind 则 MCP 工具永远不会注册**（正是 spec 里说「无自动测试覆盖」的盲区，Task 1 spike 专门打它）。`ExtensionBindings` 全字段可选：`{ uiContext?, mode?, commandContextActions?, abortHandler?, shutdownHandler?, onError? }`；`ExtensionMode = "tui"|"rpc"|"json"|"print"`；`onError?: (e: ExtensionError) => void`。
3. **MCP hermetic 装载。** `createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: true }) })` 返回 `ExtensionFactory = (pi) => void`（`dist/extensions/mcp/index.js:184`）。默认 `loadConfig` 读 agentDir/project 的 `mcp.json`——传 hermetic 版本让 `pi.registerMcpServer`（`ExtensionAPI.registerMcpServer(name, config)`）成为唯一来源。`McpServerConfig`（`dist/core/mcp-servers.d.ts`）＝ `McpStdioServerConfig{type?,command,args?,env?,exposure?,description?,enabled?,timeout?}` | `McpHttpServerConfig{type:'http',url,headers?,oauth?...}`。`McpExposure = "codemode"|"deferred"|"direct"|"hidden"`（**无 oauth**）。工具名 = `mcp__<server>__<tool>`（`-`→`_`）。首个 prompt 只等 `direct` 工具的 server（`startupWaitMs` 缺省 10000）。
4. **S2 skills 必须自渲染 `sections.skills`。** `dist/core/system-prompt.js:99`：`skillFileReadTool = ["read","bash"].find(t => selectedTools.includes(t))`——助手 `noTools:'builtin'` 无 read/bash → skills 段永不渲染，即使 `additionalSkillPaths` 生效。修法：在 identity 之前的 `before_agent_start` handler 里 `event.systemPromptOptions.sections.skills = <自渲染 XML>`。`loadSkills({cwd, agentDir, skillPaths, includeDefaults})` 是**同步**的，返回 `{skills, diagnostics}`；`DefaultResourceLoader.additionalSkillPaths?: string[]`（`dist/core/resource-loader.d.ts:76`）；`Session.getAllTools(): ToolInfo[]` 是公开方法（spike 断言点）。
5. **seed 行数与 spec 的差异（有意为之）。** spec §测试写「4 行（REQ_DESIGN_METHOD + CASE_AUTHORING_FLOW × zh/en）」，但 REQ_DESIGN_METHOD 只有一份中文源文本。**本计划 seed 3 行**：REQ_DESIGN_METHOD(`lang='any'`，同时命中 zh/en，行为与现状零变化) + CASE_AUTHORING_FLOW_ZH(`zh`) + CASE_AUTHORING_FLOW_EN(`en`)。migrate seed 测试断言 **3 行**，不是 4。
6. **`read_skill` 必须双守卫。** `path.join(skillsRoot, '/abs/path')` 会塌缩成绝对路径（`path.join` 第二个参数绝对时丢弃第一个）——所以先拒 `path.isAbsolute(skillName)`，再 `path.normalize(path.join(...))` 后查 `.startsWith(skillsRoot + path.sep)`。缺任一都逃逸。
7. **CRUD 鉴权**：`requireManager` 是位于路由层的中间件（`apps/api/src/middleware/auth.ts:83`；projects.ts 同款 per-route 用法）。挂载写法 `spaceRoute.use('/guides', requireManager, guidesRoute)`（`_res` 层，spaceRoute 挂在 `/api/assistant`，全局 requireAuth 已在 index.ts 更外层）。member（`isEffectiveManager` = `managerOrgPaths ∩ orgPath subtree` 为空）→ 403。
8. **测试基建**：testcontainers `postgres:16-alpine` + `test/helpers/db.ts` 的 `SCHEMA_SQL` 全量建表串（**新表必须同步追加进 SCHEMA_SQL**，测试容器不走 migrate）；`seedProject(pool)` 造 project+group+version；`managerUserOf/memberUserOf/authCookie`；`resetSeedOrgCache(pool)` 在 TRUNCATE 后必须重置。测试从 `apps/api` 跑：`TESTCONTAINERS_RYUK_DISABLED=true pnpm exec vitest run test/<file>`；typecheck：`pnpm typecheck`。
9. **settings seed 格式**：`INSERT INTO settings(key,value) VALUES ('llm_provider','"openai"'),('llm_api_key','"sk-test"'),('llm_model','"gpt-4o-mini"')`（value 是 JSONB 字符串字面量）。`readLlmConfig` 要求 provider 合法 + apiKey/model 非空。

## 不做的事（spec 明确 out of scope）

- skills/MCP 管理 UI（只出后端 CRUD）
- MCP OAuth（loopback 回调不适合服务端，配置时拒绝）
- MCP 到具体外部系统的绑定示例（只做通用通道 + stdio echo 冒烟）
- 动 `recorder/ws`、`liveView` 等其他容器局部状态

---

## 文件结构

**新增**：
- `apps/api/test/fixtures/mcp-echo-server.mjs` — 零依赖 stdio NDJSON MCP echo server（Task 1）
- `apps/api/src/pi/space/mcp.ts` — loader seam + `buildMcpExtensionFactory`（Task 1）+ DB 加载 + 守卫（Task 3）
- `apps/api/src/pi/space/guides.ts` — `loadActiveGuides` / `buildGuidesSection` / 类型（Task 2）
- `apps/api/src/db/seed.ts` — `seedAssistantGuides`（Task 2）
- `apps/api/src/pi/space/guidesRoute.ts` — S1 CRUD（Task 2）
- `apps/api/src/pi/space/mcpServersRoute.ts` — MCP CRUD（Task 3）
- `apps/api/src/pi/space/tools/readSkill.ts` — `read_skill` 工具 + skills 段渲染 + 加载（Task 4）
- `apps/api/test/assistant-mcp-spike.test.ts` — 真实 MCP 链路 spike（Task 1）+ DB 加载/守卫（Task 3）
- `apps/api/test/space-guides.test.ts` — S1 CRUD + seed 幂等 + scope 优先级（Task 2）

**修改**：
- `apps/api/src/pi/space/session.ts` — export 工厂 + MCP 扩展（Task 1）+ guides 加载（Task 2）+ skills 扩展与 additionalSkillPaths（Task 4）；移除 CASE_AUTHORING_FLOW_ZH/EN 常量（Task 2）
- `apps/api/src/pi/space/reqDesign.ts` — 导出 CASE_AUTHORING_FLOW_ZH/EN（自 session.ts 迁来，Task 2）
- `apps/api/src/pi/space/router.ts` — 挂 `/guides`、`/mcp-servers`（requireManager）
- `apps/api/src/db/schema.ts` — `assistant_guides` + `assistant_mcp_servers` 两表（Task 2）
- `apps/api/src/db/migrate.ts` — push 成功后跑 `seedAssistantGuides`（Task 2）
- `apps/api/test/helpers/db.ts` — SCHEMA_SQL 追加两表（Task 2）
- `apps/api/test/space-session.test.ts` — prompt 断言改传 guides fixture（Task 2）
- `apps/api/src/pi/space/tools/context.ts` — `SpaceToolsContext.workspaceDir`（Task 4）
- `apps/api/src/pi/space/tools/index.ts` — 装配 `read_skill`（Task 4）

---

## Task 1: MCP Spike（真实链路可行性证明，零 LLM 调用）

**为什么先做**：`createMcpExtension` 在 headless 嵌入场景无自动测试覆盖（堪比之前 exec worker ESM require 崩溃的盲区）。本 task 用真实 `registerMcpServer` + `createMcpExtension` 建一个 stdio echo MCP server，断言「session_start 触发 → server 建连初始化 → 工具注册为 `mcp__echo__echo`」全套走通。

**Files:**
- Create: `apps/api/test/fixtures/mcp-echo-server.mjs`
- Create: `apps/api/src/pi/space/mcp.ts`
- Modify: `apps/api/src/pi/space/session.ts`（export 工厂 + MCP 扩展 + bindExtensions）
- Create: `apps/api/test/assistant-mcp-spike.test.ts`

- [ ] **Step 1: 写 stdio echo MCP server fixture**

Create `apps/api/test/fixtures/mcp-echo-server.mjs`:

```js
// 零依赖 stdio NDJSON MCP echo server（冒烟/测试用）。
// 协议：每个 JSON-RPC 消息一行；initialize 成功时写 MCP_ECHO_MARKER 文件（用于测试断言"已建连"），
// 随后注册一个 echo 工具。tools/call 原样回显 text。
import fs from 'node:fs';
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (method === 'initialize') {
    if (process.env.MCP_ECHO_MARKER) fs.writeFileSync(process.env.MCP_ECHO_MARKER, new Date().toISOString());
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '0.0.1' } } });
    return;
  }
  // notification（无 id）：silent
  if (id === undefined || id === null) return;
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0', id,
      result: { tools: [{ name: 'echo', description: '回显文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] },
    });
    return;
  }
  if (method === 'tools/call' && params?.name === 'echo') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(params.arguments?.text ?? '') }] } });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
});
```

- [ ] **Step 2: 写 mcp.ts（loader seam + 扩展装配）**

Create `apps/api/src/pi/space/mcp.ts`:

```ts
/**
 * 空间助手 MCP 支持：DB 配置 + pi.registerMcpServer 通用通道（spec 2026-10-18）。
 *
 * pi 集成 = createMcpExtension（ExtensionFactory，session_start 建连）+ ExtensionAPI.registerMcpServer。
 * 本模块提供：
 *  - loader seam：setMcpServersLoader / getMcpServersForThread。Task 1 默认空集；
 *    Task 3 把默认翻成 DB 查询 loadEnabledMcpServers。测试用 setMcpServersLoader 注入桩。
 *  - buildMcpExtensionFactory：把 server 列表装配成「注册 + 建连装载」两个 extension factory。
 *
 * 顺序约束（见计划头部关键事实 §1）：session.ts 里 skills → mcp → identity。
 * bindExtensions 必需：pi 的 session_start 只在 bindExtensions 里 emit，MCP 建连在 session_start 做。
 */
import { createMcpExtension } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { McpServerConfig } from '@earendil-works/pi-coding-agent';
import { logger } from '../../logger.js';

export interface AssistantMcpServer {
  name: string;
  config: McpServerConfig;
}

export interface McpThreadCtx {
  threadId: string;
  projectId: string;
  versionId: string;
}

type McpServersLoader = (ctx: McpThreadCtx) => Promise<AssistantMcpServer[]>;

let serversLoader: McpServersLoader | null = null;

/** 注入 MCP server loader（测试桩 / Task 3 默认翻 DB）。传 null 恢复默认。 */
export function setMcpServersLoader(fn: McpServersLoader | null): void {
  serversLoader = fn;
}

/** 线程创建时取 MCP servers。默认（无显式 loader）返回空集——Task 3 改为 DB 加载。 */
export async function getMcpServersForThread(ctx: McpThreadCtx): Promise<AssistantMcpServer[]> {
  if (!serversLoader) return [];
  try {
    return await serversLoader(ctx);
  } catch (e) {
    logger.warn({ err: e, threadId: ctx.threadId }, 'mcp servers load failed; continuing without');
    return [];
  }
}

/** 装配 MCP 扩展：先 registerMcpServer 前置注册，再 createMcpExtension hermetic 建连。
 *  两个 factory 都进 session.ts 的 extensionFactories，且必须排在 identity 前。 */
export function buildMcpExtensionFactory(servers: AssistantMcpServer[]): {
  register: { name: string; hidden: boolean; factory: (pi: ExtensionAPI) => void };
  connect: { name: string; hidden: boolean; factory: ReturnType<typeof createMcpExtension> };
} {
  return {
    register: {
      name: 'itest-space-mcp-register',
      hidden: true,
      factory: (pi: ExtensionAPI) => {
        for (const s of servers) pi.registerMcpServer(s.name, s.config);
      },
    },
    connect: {
      name: 'itest-space-mcp',
      hidden: true,
      // hermetic：不读 mcp.json，pi.registerMcpServer 是唯一来源
      factory: createMcpExtension({
        loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: true }),
      }),
    },
  };
}
```

- [ ] **Step 3: 改 session.ts——export 工厂 + MCP 扩展 + bindExtensions**

Modify `apps/api/src/pi/space/session.ts`:

3a. import（第 15 行 `REQ_DESIGN_METHOD`、第 18 行 `defineTool` 之间附近追加）：

```ts
import { buildMcpExtensionFactory, getMcpServersForThread } from './mcp.js';
```

3b. 第 387 行工厂签名加 `export`（并保持 body 前行为不变）：

```ts
export async function createSpaceSessionFactory(ctx: SpaceThreadContext): Promise<SpaceSessionLike> {
```

3c. 在 `const tools = rawTools.map(...)` 之后、`const base = ...` 之前插入 MCP server 获取（放在 loader 构造前的任何位置均可，这里就近 loader）：

```ts
  // MCP servers：会话创建时读取（DB 驱动/测试桩）。无 server 时 register 为 no-op、connect 挂空配置。
  const mcpServers = await getMcpServersForThread({ threadId: ctx.threadId, projectId: ctx.projectId, versionId: ctx.versionId });
  const mcpExtensions = buildMcpExtensionFactory(mcpServers);
```

3d. `extensionFactories`（第 454-464 行）改为 —— 注意顺序：MCP 两个 factory **在 identity 之前**（identity 渲染 `event.systemPrompt` 快照，返回 `{systemPrompt}` 冻结后续变更；mcp_servers 段必须已就位）：

```ts
    extensionFactories: [
      // Task 4 的 skills 自渲染扩展将插在这里（在 MCP 之前）。
      // MCP：注册 + hermetic 建连装载。必须在 identity 前——identity 的 before_agent_start
      // 渲染 event.systemPrompt（含 mcp_servers 段）并返回 {systemPrompt}，会冻结后续 section 变更。
      mcpExtensions.register,
      mcpExtensions.connect,
      {
        name: 'itest-space-identity',
        hidden: true,
        factory: (pi) => {
          pi.on('before_agent_start', (event) => {
            const rewritten = rewriteSpacePreamble(event.systemPrompt, aiLangFrom(ctx.lang));
            if (rewritten !== undefined) return { systemPrompt: rewritten };
            return undefined;
          });
        },
      },
    ],
```

3e. `createAgentSession({...})` 之后、`await db.update(aiThreads)...` 之前插入 bindExtensions：

```ts
  // bindExtensions 必需：pi 的 session_start 只在 bindExtensions 时触发（agent-session.js:2536）。
  // createMcpExtension 在 session_start 读 pi.getMcpServers() 并后台建连——不 bind 则 MCP 工具永不注册。
  // （Task 1 spike 的核心验证点。若实测 mode:'print' 在 headless 嵌入下行为异常，改传 {} 即可——
  //   ExtensionBindings 全字段可选，mode 只影响 setUIContext。）
  await session.bindExtensions({
    mode: 'print',
    onError: (e) => { logger.warn({ err: e }, 'assistant extension error'); },
  });
```

注意：`session` 是从 `createAgentSession({...})` 解构出来的 `session`，其类型有 `bindExtensions`。

- [ ] **Step 4: 写 spike 测试（真实链路 + 零 LLM）**

Create `apps/api/test/assistant-mcp-spike.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL } from './helpers/db.js';
import { emptyRepoState } from '../src/pi/space/tools/context.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(SCHEMA_SQL);
  // LLM settings：工厂要求 readLlmConfig 非空（spike 不触发任何 LLM 调用，只建会话 + 断言工具注册）
  await pool.query(`INSERT INTO settings(key, value) VALUES
    ('llm_provider','"openai"'),
    ('llm_api_key','"sk-test"'),
    ('llm_model','"gpt-4o-mini"')`);
}, 60_000);

afterAll(async () => {
  const { pool: dbPool } = await import('../src/db/client.js');
  await dbPool.end();
  await pool.end();
  await container.stop();
});

describe('MCP spike: registerMcpServer + createMcpExtension 真实链路', () => {
  it('stdio echo server 经 createSpaceSessionFactory 建会话后注册为 mcp__echo__echo', async () => {
    const marker = `/tmp/mcp-echo-marker-${Date.now()}.ok`;
    const { setMcpServersLoader } = await import('../src/pi/space/mcp.js');
    const { createSpaceSessionFactory } = await import('../src/pi/space/session.js');
    setMcpServersLoader(async () => [{
      name: 'echo',
      config: {
        type: 'stdio',
        command: process.execPath,
        args: [FIXTURE],
        exposure: 'direct',
        env: { MCP_ECHO_MARKER: marker },
      },
    }]);
    const session = await createSpaceSessionFactory({
      threadId: '00000000-0000-0000-0000-0000000000aa',
      versionId: '00000000-0000-0000-0000-0000000000bb',
      projectId: '00000000-0000-0000-0000-0000000000cc',
      repo: emptyRepoState(),
      createdByUserId: null,
      lang: 'zh-CN',
    });
    try {
      // 轮询：MCP 连接是后台的，直至 initialize 已执行（marker 文件落盘）
      let markerSeen = false;
      for (let i = 0; i < 60; i++) {
        try { await fs.access(marker); markerSeen = true; break; } catch { await new Promise((r) => setTimeout(r, 250)); }
      }
      expect(markerSeen, 'echo server 未在 15s 内完成 initialize（session_start 可能未触发 / bindExtensions 缺失）').toBe(true);
      // 工具注册断言（零 LLM 调用）：AgentSession.getAllTools()
      const tools = (session as unknown as { getAllTools(): { name: string }[] }).getAllTools().map((t) => t.name);
      expect(tools).toContain('mcp__echo__echo');
    } finally {
      await (session as unknown as { dispose(): Promise<void> }).dispose().catch(() => undefined);
      setMcpServersLoader(null);
      await fs.rm(marker, { force: true }).catch(() => undefined);
    }
  }, 60_000);
});
```

- [ ] **Step 5: 跑 spike，必须一次通过**

Run（从 `apps/api`）：

```bash
TESTCONTAINERS_RYUK_DISABLED=true pnpm exec vitest run test/assistant-mcp-spike.test.ts
```

Expected: `1 passed`。失败时先看是不是「echo server 未在 15s 内完成 initialize」——那是 `session_start` 没触发（bindExtensions 缺失或顺序错），不是 fixture 问题。

- [ ] **Step 6: typecheck + 提交**

Run: `cd apps/api && pnpm typecheck` — Expected: 0 errors.

```bash
git add apps/api/test/fixtures/mcp-echo-server.mjs apps/api/src/pi/space/mcp.ts apps/api/src/pi/space/session.ts apps/api/test/assistant-mcp-spike.test.ts
git commit -m "feat(pi): MCP spike——registerMcpServer+createMcpExtension 真实链路(stdio echo+getAllTools 零 LLM 断言),factory 补 bindExtensions"
```

**Task 1 完成标志**：spike 测试绿 + `mcp__echo__echo` 工具注册成立；不满意的唯一失败形态是 session_start 未触发。

---

## Task 2: S1 guides（DB 常驻指令）

**Files:**
- Modify: `apps/api/src/db/schema.ts`（追加两表，MCP 表一并建，Task 3 用）
- Modify: `apps/api/test/helpers/db.ts`（SCHEMA_SQL 同步）
- Create: `apps/api/src/db/seed.ts`
- Modify: `apps/api/src/db/migrate.ts`
- Create: `apps/api/src/pi/space/guides.ts`
- Modify: `apps/api/src/pi/space/reqDesign.ts`（导出两个 flow 常量）
- Modify: `apps/api/src/pi/space/session.ts`（移除常量、prompt 接 guides）
- Create: `apps/api/src/pi/space/guidesRoute.ts`
- Modify: `apps/api/src/pi/space/router.ts`
- Create: `apps/api/test/space-guides.test.ts`
- Modify: `apps/api/test/space-session.test.ts`

- [ ] **Step 1: schema.ts 追加两表**

Append to `apps/api/src/db/schema.ts` (末尾，`environmentObjects` 之后)。`assistant_mcp_servers` 一并建（Task 3 用，一次 push 到位）：

```ts
// ── AI 助手 Skills S1：常驻流程/知识指令（DB 驱动，热生效于新线程）──
// scope 覆盖：version > project > global（加载期排序，见 pi/space/guides.ts loadActiveGuides）。
export const assistantGuides = pgTable('assistant_guides', {
  id: uuid('id').primaryKey().defaultRandom(),
  scope: varchar('scope', { length: 16 }).notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').references(() => projectVersions.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 16 }).notNull(),
  body: text('body').notNull(),
  lang: varchar('lang', { length: 8 }).notNull().default('any'),
  sort: integer('sort').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  enabledIdx: index('assistant_guides_enabled_idx').on(t.scope, t.enabled),
}));

// ── AI 助手 MCP 通用通道（DB 配置；会话创建时 registerMcpServer 加载）──
export const assistantMcpServers = pgTable('assistant_mcp_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 120 }).notNull(),
  kind: varchar('kind', { length: 8 }).notNull().default('stdio'),
  command: text('command'),
  args: jsonb('args').$type<string[]>(),
  url: text('url'),
  env: jsonb('env').$type<Record<string, string>>(),
  exposure: varchar('exposure', { length: 12 }).notNull().default('codemode'),
  scope: varchar('scope', { length: 16 }).notNull().default('global'),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').references(() => projectVersions.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  nameUq: unique('assistant_mcp_servers_name_uq').on(t.name),
  enabledIdx: index('assistant_mcp_servers_enabled_idx').on(t.enabled),
}));
```

确认 `schema.ts` 顶部已 import `unique`（现有表如 `projectVersions` 用了 `unique(...)`，已就绪）。

- [ ] **Step 2: SCHEMA_SQL 同步**

Append to `apps/api/test/helpers/db.ts` 的 SCHEMA_SQL 模板串末尾（`ai_stage_cases` 行之后、反引号之前）：

```sql
CREATE TABLE assistant_guides (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope varchar(16) NOT NULL, project_id uuid REFERENCES projects(id) ON DELETE CASCADE, version_id uuid REFERENCES project_versions(id) ON DELETE CASCADE, kind varchar(16) NOT NULL, body text NOT NULL, lang varchar(8) NOT NULL DEFAULT 'any', sort integer NOT NULL DEFAULT 0, enabled boolean NOT NULL DEFAULT true, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE INDEX assistant_guides_enabled_idx ON assistant_guides(scope, enabled);
CREATE TABLE assistant_mcp_servers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(120) NOT NULL, kind varchar(8) NOT NULL DEFAULT 'stdio', command text, args jsonb, url text, env jsonb, exposure varchar(12) NOT NULL DEFAULT 'codemode', scope varchar(16) NOT NULL DEFAULT 'global', project_id uuid REFERENCES projects(id) ON DELETE CASCADE, version_id uuid REFERENCES project_versions(id) ON DELETE CASCADE, enabled boolean NOT NULL DEFAULT true, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(), CONSTRAINT assistant_mcp_servers_name_uq UNIQUE(name));
CREATE INDEX assistant_mcp_servers_enabled_idx ON assistant_mcp_servers(enabled);
```

（`project_versions` 在 SCHEMA_SQL 第 56 行已存在，FK 引用成立。）

- [ ] **Step 3: reqDesign.ts 导出两个 flow 常量**

Append to `apps/api/src/pi/space/reqDesign.ts`（文件末尾）：

```ts
/** 用例创建流程指引（S1 seed 用，zh）。自 session.ts 迁来：改为 DB 常驻 → 热生效 + 可运营。 */
export const CASE_AUTHORING_FLOW_ZH = `## 用例创建流程
1. 拿到需求后先生成**自然语言步骤**的用例草稿（含断言），把步骤贴在对话里与用户讨论确认,不要立刻 stage_case。
2. 讨论过程中用户可要求实测：调 verify_case(caseId=草稿 localId) 在真实浏览器跑自然语言步骤（AI 相执行）,前端有 live view 视频流给用户观看。
3. 用户确认步骤后调 stage_case 暂存：步骤保持自然语言形态,**不要急着生成 compiled 机械 DSL**。
4. 引导用户在右侧暂存区勾选保存。
5. 保存后主动询问：「用例已保存,是否需要 solidify 固化为机械步骤？」
6. 用户同意后调 solidify_case 把自然语言步骤编译为机械 DSL（产出仍走暂存勾选落库）。
7. 编译完成后调 verify_case 实际跑 DSL 验收；出错由你根据失败归因修复 compiled 后重跑,直到通过。

**批量场景**：一次需求产出多条用例时，按「逐条讨论 → 逐条暂存」串行推进,不要一次性铺开所有草稿——用户需要逐条审,铺开等于把确认门稀释掉。每条讨论确认后再 stage_case,下一条再开始讨论。实测环节用户确认要多条一起跑时可以接力：一条 AI 相跑完出结论再开下一条,不要并发。`;

/** 用例创建流程指引（S1 seed 用，en）。 */
export const CASE_AUTHORING_FLOW_EN = `## Case authoring workflow
1. On receiving a requirement, draft the case with **natural-language steps** (plus assertions) and discuss with the user first — do NOT call stage_case immediately.
2. During discussion the user may ask to actually run it: call verify_case(caseId=<draft localId>) to execute NL steps in a real browser (AI-driven), with a live video stream shown to the user.
3. After the user confirms the steps, call stage_case to stage the draft: keep steps in natural language, do NOT generate compiled mechanical DSL yet.
4. Guide the user to check and save from the staging panel on the right.
5. After save, proactively ask: "Case saved — solidify into mechanical steps now?"
6. If the user agrees, call solidify_case to compile NL steps into mechanical DSL (output still goes through staging + save).
7. Then call verify_case to actually run the DSL for acceptance; on failure, fix the compiled output per failure attribution and re-run until it passes.

**Batch mode**: when one requirement yields multiple cases, drive them serially as "discuss one → stage one". Do NOT dump all drafts at once — the user reviews one at a time, and bulk-dumping dilutes the confirmation gate. Start the next discussion only after the current one is confirmed and staged. For live-test runs the user may approve several at once: chain them serially, starting the next only after the current AI phase finishes; never run them concurrently.`;
```

- [ ] **Step 4: 写 guides.ts（类型 + 加载 + 渲染）**

Create `apps/api/src/pi/space/guides.ts`:

```ts
/**
 * S1 常驻指令（assistant_guides）加载与渲染。
 * 加载点 = buildSpaceSystemPrompt 第三参 → 每轮 builderSystemPrompt 重算 → DB 改动对新线程热生效。
 */
import { and, eq, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantGuides } from '../../db/schema.js';
import { aiLangFrom, type AiLang } from '../../agent/langDirective.js';

export type AssistantGuideRow = typeof assistantGuides.$inferSelect;

/** 会话 lang → guide lang 匹配值；en-US → 'en'，其余（含 zh-CN/无）→ 'zh'。 */
export function guideLangOf(lang?: AiLang): 'zh' | 'en' {
  return aiLangFrom(lang ?? null) === 'en-US' ? 'en' : 'zh';
}

const SCOPE_RANK: Record<string, number> = { version: 0, project: 1, global: 2 };

/** 加载当前 (lang, projectId, versionId) 的启用 guides，按 scope 优先级 + sort 稳定排序。
 *  scope 优先级：version > project > global（同 scope 按 sort，再按 createdAt 保序）。
 *  同一 kind 可叠加（无互斥去重，由运营侧负责语义）。 */
export async function loadActiveGuides(opts: { projectId: string; versionId: string; lang?: AiLang }): Promise<AssistantGuideRow[]> {
  const rows = await db
    .select()
    .from(assistantGuides)
    .where(and(
      eq(assistantGuides.enabled, true),
      or(
        eq(assistantGuides.lang, 'any'),
        eq(assistantGuides.lang, guideLangOf(opts.lang)),
      ),
      or(
        eq(assistantGuides.scope, 'global'),
        and(eq(assistantGuides.scope, 'project'), eq(assistantGuides.projectId, opts.projectId)),
        and(eq(assistantGuides.scope, 'version'), eq(assistantGuides.versionId, opts.versionId)),
      ),
    ));
  return rows.sort((a, b) =>
    SCOPE_RANK[a.scope]! - SCOPE_RANK[b.scope]!
    || a.sort - b.sort
    || a.createdAt.getTime() - b.createdAt.getTime());
}

/** 渲染 guides 为 system prompt 尾部两节：flow → # 流程指令，reference → # 知识参考。无则返回空串。 */
export function buildGuidesSection(guides: Array<Pick<AssistantGuideRow, 'kind' | 'body'>>): string {
  const flow = guides.filter((g) => g.kind === 'flow').map((g) => g.body).join('\n\n');
  const ref = guides.filter((g) => g.kind === 'reference').map((g) => g.body).join('\n\n');
  const parts: string[] = [];
  if (flow) parts.push(`# 流程指令\n\n${flow}`);
  if (ref) parts.push(`# 知识参考\n\n${ref}`);
  return parts.join('\n\n');
}
```

- [ ] **Step 5: 写 seed.ts + migrate.ts 挂钩**

Create `apps/api/src/db/seed.ts`:

```ts
/**
 * 启动 seed：assistant_guides 内置行为（REQ_DESIGN_METHOD + CASE_AUTHORING_FLOW × zh/en）。
 * 固定 UUID 幂等（ON CONFLICT (id) DO NOTHING），二次启动不重复插。
 *
 * ⚠ spec §测试 写的「4 行」不成立：REQ_DESIGN_METHOD 只有一份中文源文本，
 *   用 lang='any'（同时命中 zh/en）保持行为零变化 → seed 实际 3 行。
 */
import { REQ_DESIGN_METHOD, CASE_AUTHORING_FLOW_ZH, CASE_AUTHORING_FLOW_EN } from '../pi/space/reqDesign.js';

const GUIDE_SEED = [
  { id: '00000000-0000-0000-0000-000000000001', kind: 'flow', lang: 'any', body: REQ_DESIGN_METHOD },
  { id: '00000000-0000-0000-0000-000000000002', kind: 'flow', lang: 'zh', body: CASE_AUTHORING_FLOW_ZH },
  { id: '00000000-0000-0000-0000-000000000003', kind: 'flow', lang: 'en', body: CASE_AUTHORING_FLOW_EN },
] as const;

/** 幂等 seed；失败时向上抛 → migrate 入口 catch → process.exit(1)（不让容器带着残缺 seed 起）。 */
export async function seedAssistantGuides(client: Pick<import('pg').Client, 'query'>): Promise<void> {
  for (const g of GUIDE_SEED) {
    await client.query(
      `INSERT INTO assistant_guides (id, scope, kind, lang, body, sort, enabled)
       VALUES ($1, 'global', $2, $3, $4, 0, true)
       ON CONFLICT (id) DO NOTHING`,
      [g.id, g.kind, g.lang, g.body],
    );
  }
}
```

Modify `apps/api/src/db/migrate.ts`：

```ts
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { logger } from '../logger.js';
import { seedAssistantGuides } from './seed.js';
```
（import 追加 seed；LOCK_ID 等不变）

在 `if (r.status !== 0) process.exit(r.status ?? 1);` 之后、`finally` 之前插入：

```ts
    // seed：S1 常驻指令（REQ_DESIGN_METHOD / CASE_AUTHORING_FLOW）。幂等（ON CONFLICT DO NOTHING）。
    await seedAssistantGuides(client);
```

- [ ] **Step 6: 改 session.ts——移除常量、prompt 接 guides**

6a. 删除第 353-373 行的 `CASE_AUTHORING_FLOW_ZH` / `CASE_AUTHORING_FLOW_EN` 两个 const（已迁到 reqDesign.ts），并把第 15 行 import 改为：

```ts
import { type AssistantGuideRow, buildGuidesSection, loadActiveGuides } from './guides.js';
```

6b. prompt 函数（第 375-385 行）整体替换为：

```ts
/** 空间助手 system prompt：风格约束 + guides(需求设计方法/流程指令/知识参考) + 工作空间 + 版本上下文摘要。
 *  guides 由 loadActiveGuides 在工厂按 (lang, projectId, versionId) 查得；无摘要时省略上下文段。
 *  内容顺序与原硬编码一致（风格 → 需求设计/流程 → 工作空间 → 版本上下文），seed 后行为零变化。 */
export function buildSpaceSystemPrompt(
  summaryText: string | null,
  lang?: AiLang,
  guides: Array<Pick<AssistantGuideRow, 'kind' | 'body'>> = [],
): string {
  const isEn = aiLangFrom(lang ?? null) === 'en-US';
  const style = isEn
    ? '## Output style\n- The user writes in English. All replies MUST be in English (code, commands, and English terms may stay). This constraint covers every piece of user-visible text, including final replies, process explanations before tool calls, and reasoning monologues — do not write Chinese sentences like 「让我检查一下」, if you need to check something just call a tool.\n- Do not use emoji; emphasize with markdown bold, and enumerate with lists/tables.'
    : '## 输出风格\n- 用户使用简体中文提问,全部回复一律用简体中文(代码、命令、英文术语可保留原文)。这条约束覆盖**每一条**用户可见文本,包括最终答复、调用工具前的过程说明、以及思考/推理独白——不要出现「Let me check」「I found that」「I should」这类英文句子,想查什么直接调工具即可。\n- 不要使用 emoji;强调用 markdown 加粗,列举用列表/表格。';
  const workspace = '## 工作空间\n- 当前目录是版本专属工作空间，项目仓库已检出到 ./repo 子目录；读取代码请优先使用 repo_ls / repo_read / repo_grep 工具。';
  const guidesSection = buildGuidesSection(guides);
  const body = [style, guidesSection, workspace].filter(Boolean).join('\n\n');
  if (!summaryText) return body;
  return `${body}\n\n## 版本空间上下文\n${summaryText}`;
}
```

6c. 工厂内，`summaryText` 构建之后（约第 444 行）、`const loader = new DefaultResourceLoader(...)` 之前插入：

```ts
  // S1 常驻指令：按 (lang, projectId, versionId) 查启用 guides（scope 覆盖 version>project>global）。
  const guides = await loadActiveGuides({ projectId: ctx.projectId, versionId: ctx.versionId, lang: ctx.lang });
```

6d. `appendSystemPromptOverride`（第 450 行）改为：

```ts
    appendSystemPromptOverride: (base) => [...base, buildSpaceSystemPrompt(summaryText, ctx.lang, guides)],
```

- [ ] **Step 7: guidesRoute.ts CRUD**

Create `apps/api/src/pi/space/guidesRoute.ts`:

```ts
/**
 * assistant_guides 最小 CRUD（管理端，无 UI；管理 UI 归后续需求）。
 * 挂载于 /api/assistant/guides，router.ts 处 requireManager 保护。
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantGuides } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';

export const guidesRoute = Router();

const SCOPE = ['global', 'project', 'version'] as const;
const KIND = ['flow', 'reference'] as const;
const LANG = ['zh', 'en', 'any'] as const;

guidesRoute.get('/', async (req, res) => {
  const q = req.query;
  const conds: SQL[] = [];
  if (typeof q.scope === 'string' && q.scope) conds.push(eq(assistantGuides.scope, q.scope));
  if (typeof q.projectId === 'string' && q.projectId) conds.push(eq(assistantGuides.projectId, q.projectId));
  if (typeof q.versionId === 'string' && q.versionId) conds.push(eq(assistantGuides.versionId, q.versionId));
  if (typeof q.kind === 'string' && q.kind) conds.push(eq(assistantGuides.kind, q.kind));
  if (typeof q.lang === 'string' && q.lang) conds.push(eq(assistantGuides.lang, q.lang));
  // and(...[]) 返回 undefined = 无过滤（drizzle 语义）
  const rows = await db.select().from(assistantGuides)
    .where(and(...conds))
    .orderBy(asc(assistantGuides.sort), desc(assistantGuides.createdAt));
  res.json(rows);
});

guidesRoute.post('/', async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const scope = b.scope as string;
  if (!SCOPE.includes(scope as never)) throw new HttpError(400, 'bad_request', 'scope 必须是 global|project|version');
  if (scope === 'project' && typeof b.projectId !== 'string') throw new HttpError(400, 'bad_request', 'scope=project 需要 projectId');
  if (scope === 'version' && typeof b.versionId !== 'string') throw new HttpError(400, 'bad_request', 'scope=version 需要 versionId');
  const kind = b.kind as string;
  if (!KIND.includes(kind as never)) throw new HttpError(400, 'bad_request', 'kind 必须是 flow|reference');
  if (typeof b.body !== 'string' || !b.body.trim()) throw new HttpError(400, 'bad_request', 'body 必填');
  const lang = (b.lang as string) ?? 'any';
  if (!LANG.includes(lang as never)) throw new HttpError(400, 'bad_request', 'lang 必须是 zh|en|any');
  const rows = await db.insert(assistantGuides).values({
    id: randomUUID(),
    scope,
    projectId: scope === 'project' ? (b.projectId as string) : null,
    versionId: scope === 'version' ? (b.versionId as string) : null,
    kind,
    body: (b.body as string).trim(),
    lang,
    sort: typeof b.sort === 'number' ? b.sort : 0,
    enabled: b.enabled === false ? false : true,
  }).returning();
  res.status(201).json(rows[0]);
});

guidesRoute.patch('/:id', async (req, res) => {
  const patch: Partial<typeof assistantGuides.$inferInsert> = {};
  const p = req.body as Record<string, unknown>;
  if ('kind' in p) {
    if (!KIND.includes(p.kind as never)) throw new HttpError(400, 'bad_request', 'kind 必须是 flow|reference');
    patch.kind = p.kind as string;
  }
  if ('scope' in p) {
    const scope = p.scope as string;
    if (!SCOPE.includes(scope as never)) throw new HttpError(400, 'bad_request', 'scope 必须是 global|project|version');
    patch.scope = scope;
    patch.projectId = scope === 'project' ? (p.projectId as string | null) : null;
    patch.versionId = scope === 'version' ? (p.versionId as string | null) : null;
  } else {
    if ('projectId' in p) patch.projectId = p.projectId as string | null;
    if ('versionId' in p) patch.versionId = p.versionId as string | null;
  }
  if ('body' in p) patch.body = typeof p.body === 'string' ? p.body.trim() : (p.body as string);
  if ('lang' in p) {
    if (!LANG.includes(p.lang as never)) throw new HttpError(400, 'bad_request', 'lang 必须是 zh|en|any');
    patch.lang = p.lang as string;
  }
  if ('sort' in p) patch.sort = typeof p.sort === 'number' ? p.sort : undefined;
  if ('enabled' in p) patch.enabled = p.enabled === false ? false : true;
  const updated = await db.update(assistantGuides)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(assistantGuides.id, req.params.id))
    .returning();
  if (updated.length === 0) throw new HttpError(404, 'not_found', 'guide 不存在');
  res.json(updated[0]);
});

guidesRoute.delete('/:id', async (req, res) => {
  const deleted = await db.delete(assistantGuides)
    .where(eq(assistantGuides.id, req.params.id))
    .returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'guide 不存在');
  res.status(204).end();
});
```

- [ ] **Step 8: router.ts 挂载 `/guides`（requireManager）**

Modify `apps/api/src/pi/space/router.ts`：

8a. import 追加（第 13 行 `import { stageRoute } ...` 附近）：

```ts
import { requireManager } from '../../middleware/auth.js';
import { guidesRoute } from './guidesRoute.js';
```

8b. 文件末尾 `spaceRoute.use(stageRoute);` 之后追加（`/mcp-servers` 挂载在 Task 3）：

```ts
// 管理端 CRUD：requireManager 保护（member → 403）。挂在 /api/assistant 之下，
// 全局 requireAuth 由更外层 index.ts 统一承担（router.ts 自身不重复鉴权）。
spaceRoute.use('/guides', requireManager, guidesRoute);
```

- [ ] **Step 9: 写 space-guides.test.ts（seed 幂等 + 加载语义 + CRUD/鉴权）**

Create `apps/api/test/space-guides.test.ts`（testcontainers + supertest，路由挂 manager/member 两个 app 对照鉴权）：

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SCHEMA_SQL, seedOrg, seedProject } from './helpers/db.js';

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
  // 只清 guides/mcp 两表（不动 org/project 行），org 缓存仍有效，无需 resetSeedOrgCache
  await pool.query(`TRUNCATE assistant_guides, assistant_mcp_servers`);
});

describe('S1 guides：seed 幂等 + loadActiveGuides 语义 + CRUD/鉴权', () => {
  it('seedAssistantGuides 跑两遍仍是 3 行（REQ_DESIGN_METHOD·any + FLOW·zh/en）', async () => {
    const { seedAssistantGuides } = await import('../src/db/seed.js');
    await seedAssistantGuides(pool);
    const first = (await pool.query(`SELECT count(*)::int n FROM assistant_guides`)).rows[0]!.n as number;
    await seedAssistantGuides(pool); // 模拟容器二次启动
    const second = (await pool.query(`SELECT count(*)::int n FROM assistant_guides`)).rows[0]!.n as number;
    expect(first).toBe(3);
    expect(second).toBe(3); // ON CONFLICT (id) DO NOTHING 幂等
    const rows = (await pool.query(`SELECT lang::text lang, kind::text kind FROM assistant_guides ORDER BY id`)).rows;
    expect(rows.map((r) => `${r.kind}:${r.lang}`).sort()).toEqual(['flow:any', 'flow:en', 'flow:zh']);
  });

  it('loadActiveGuides：scope version>project>global + sort + lang/enabled 过滤', async () => {
    const { projectId, versionId } = await seedProject(pool);
    await pool.query(`INSERT INTO assistant_guides (id, scope, kind, body, lang, sort, project_id, version_id, enabled) VALUES
      ($1,'version','flow','V-BODY','zh',0,NULL,$2,true),
      ($3,'project','flow','P-BODY','zh',0,$4,NULL,true),
      ($5,'global','flow','G-BODY','zh',1,NULL,NULL,true),
      ($6,'global','reference','REF-BODY','zh',0,NULL,NULL,true),
      ($7,'global','flow','G-OFF','zh',0,NULL,NULL,false),
      ($8,'global','flow','G-EN','en',0,NULL,NULL,true)`,
      [randomUUID(), versionId, randomUUID(), projectId, randomUUID(), randomUUID(), randomUUID(), randomUUID()]);
    const { loadActiveGuides } = await import('../src/pi/space/guides.js');
    const rows = await loadActiveGuides({ projectId, versionId, lang: 'zh-CN' });
    expect(rows.map((r) => r.body)).toEqual(['V-BODY', 'P-BODY', 'REF-BODY', 'G-BODY']);
    expect(rows.every((r) => r.enabled)).toBe(true); // G-OFF 不注入
    expect(rows.every((r) => r.lang === 'zh' || r.lang === 'any')).toBe(true); // G-EN 不注入
  });

  it('CRUD：manager 建/查/改/删全通；member 一律 403', async () => {
    const created = await request(managerApp).post('/api/assistant/guides')
      .send({ scope: 'global', kind: 'flow', body: 'HELLO', lang: 'zh' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const listed = await request(managerApp).get('/api/assistant/guides?lang=zh');
    expect(listed.status).toBe(200);
    expect(listed.body.map((g: { id: string }) => g.id)).toContain(id);
    const patched = await request(managerApp).patch(`/api/assistant/guides/${id}`).send({ enabled: false, body: 'HELLO2' });
    expect(patched.status).toBe(200);
    expect(patched.body.enabled).toBe(false);
    expect((await request(managerApp).delete(`/api/assistant/guides/${id}`)).status).toBe(204);
    expect((await request(managerApp).get('/api/assistant/guides')).body.length).toBe(0);
    // member：requireManager → 403（managerOrgPaths 为空，isEffectiveManager=false）
    expect((await request(memberApp).post('/api/assistant/guides')
      .send({ scope: 'global', kind: 'flow', body: 'X', lang: 'zh' })).status).toBe(403);
    expect((await request(memberApp).get('/api/assistant/guides')).status).toBe(403);
    expect((await request(memberApp).patch(`/api/assistant/guides/${id}`).send({ enabled: true })).status).toBe(403);
    expect((await request(memberApp).delete(`/api/assistant/guides/${id}`)).status).toBe(403);
  });

  it('POST 校验：scope 缺 projectId → 400；非法 kind/lang → 400', async () => {
    expect((await request(managerApp).post('/api/assistant/guides')
      .send({ scope: 'project', kind: 'flow', body: 'X' })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/guides')
      .send({ scope: 'global', kind: 'nope', body: 'X' })).status).toBe(400);
    expect((await request(managerApp).post('/api/assistant/guides')
      .send({ scope: 'global', kind: 'flow', body: '' })).status).toBe(400);
  });
});
```

- [ ] **Step 10: 改 space-session.test.ts——prompt 断言传 guides fixture**

Modify `apps/api/test/space-session.test.ts` 第 95-112 行的两个 `buildSpaceSystemPrompt` 测试：新签名第三参接管 guides，断言补传入 fixture（en 测试不传即走空 guides，行为不变）：

```ts
  it('buildSpaceSystemPrompt:始终含风格段与需求设计方法;有摘要追加版本空间上下文标题', async () => {
    const { buildSpaceSystemPrompt } = await import('../src/pi/space/session.js');
    const { REQ_DESIGN_METHOD, CASE_AUTHORING_FLOW_ZH } = await import('../src/pi/space/reqDesign.js');
    const guides = [
      { kind: 'flow' as const, body: REQ_DESIGN_METHOD },
      { kind: 'flow' as const, body: CASE_AUTHORING_FLOW_ZH },
    ];
    const base = buildSpaceSystemPrompt(null, undefined, guides);
    expect(base).toContain('输出风格');
    expect(base).toContain('需求→用例设计方法');
    expect(base).toContain('流程指令');
    const out = buildSpaceSystemPrompt('X', undefined, guides);
    expect(out).toContain('X');
    expect(out).toContain('版本空间上下文');
  });
```

- [ ] **Step 11: 跑测试 + typecheck（一次全绿）**

Run（从 `apps/api`）：

```bash
TESTCONTAINERS_RYUK_DISABLED=true pnpm exec vitest run test/space-guides.test.ts test/space-session.test.ts test/space-router.test.ts
```

Expected: 全过。失败时先看 `seedAssistantGuides` 的 `ON CONFLICT` 是否因 SCHEMA_SQL 缺 `assistant_guides` 表（Step 2 漏同步）——那是表未建，不是 seed 逻辑错。

```bash
pnpm typecheck
```

Expected: 0 errors。

- [ ] **Step 12: 提交**

```bash
git add apps/api/src/db/schema.ts apps/api/test/helpers/db.ts apps/api/src/db/seed.ts apps/api/src/db/migrate.ts apps/api/src/pi/space/guides.ts apps/api/src/pi/space/reqDesign.ts apps/api/src/pi/space/session.ts apps/api/src/pi/space/guidesRoute.ts apps/api/src/pi/space/router.ts apps/api/test/space-guides.test.ts apps/api/test/space-session.test.ts
git commit -m "feat(pi): S1 guides——assistant_guides 表+幂等 seed+会话加载+CRUD(requireManager)"
```

**Task 2 完成标志**：seed 幂等 3 行 + scope 优先级排序 + manager/member 鉴权全绿，`buildSpaceSystemPrompt` 行为零变化（fixture 断言覆盖）。

---

## Task 3: MCP DB 加载 + 守卫 + CRUD（spec §MCP 全量）

**Files:**
- Modify: `apps/api/src/pi/space/mcp.ts`（loadEnabledMcpServers / resolveMcpEnv / findExecutable / mcpServerToEntry + loader 默认翻 DB）
- Create: `apps/api/src/pi/space/mcpServersRoute.ts`
- Modify: `apps/api/src/pi/space/router.ts`（挂 `/mcp-servers`）
- Modify: `apps/api/test/assistant-mcp-spike.test.ts`（追加 DB 加载 + 守卫 + env 注入测试）

- [ ] **Step 1: mcp.ts——DB 加载 + 守卫 + loader 默认翻 DB**

Modify `apps/api/src/pi/space/mcp.ts`：

1a. import 块整体替换为：

```ts
import { createMcpExtension } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { McpServerConfig } from '@earendil-works/pi-coding-agent';
import { eq } from 'drizzle-orm';
import { existsSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { db } from '../../db/client.js';
import { assistantMcpServers } from '../../db/schema.js';
import { logger } from '../../logger.js';
```

1b. 在 `AssistantMcpServer` 接口之后追加类型 + 守卫 + 加载：

```ts
type AssistantMcpServerRow = typeof assistantMcpServers.$inferSelect;

const MCP_EXPOSURES = new Set(['codemode', 'deferred', 'direct', 'hidden']);

/** env 值解引用：`env:KEY` 语法从 process.env 取（容器 secrets 统一走宿主机注入，明文不落 DB）。
 *  未定义 key 直接丢弃（不注入空占位）。 */
export function resolveMcpEnv(env?: Record<string, string> | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v !== 'string') continue; // DB 脏值防御：非字符串直接丢弃
    if (v.startsWith('env:')) {
      const real = process.env[v.slice(4)];
      if (real !== undefined) out[k] = real;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** stdio command 可执行性探测：含路径分隔符 → 按绝对/相对路径 exists；否则按 PATH 逐个 scan X_OK。 */
export function findExecutable(cmd: string): boolean {
  if (cmd.includes('/')) return existsSync(cmd);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try { accessSync(path.join(dir, cmd), constants.X_OK); return true; } catch { /* continue */ }
  }
  return false;
}

/** 行 → 可挂载 server；每条坏配置 skip+warn（warn-not-fail：一个坏 server 不拖垮整个助手）。
 *  守卫（spec §MCP）：exposure=oauth/非法 → 拒；kind 未知 → 拒；stdio 缺 command/二进制不可执行 → 拒；
 *  http url 非 http(s) → 拒。返回 null 表示跳过。 */
export function mcpServerToEntry(row: AssistantMcpServerRow): AssistantMcpServer | null {
  if (!MCP_EXPOSURES.has(row.exposure)) {
    logger.warn({ name: row.name, exposure: row.exposure }, 'mcp server exposure 非法（oauth 等均不支持），跳过');
    return null;
  }
  if (row.kind === 'stdio') {
    if (!row.command) { logger.warn({ name: row.name }, 'mcp stdio server 缺少 command，跳过'); return null; }
    if (!findExecutable(row.command)) {
      logger.warn({ name: row.name, command: row.command }, 'mcp stdio server 二进制不可执行，跳过（warn-not-fail）');
      return null;
    }
    return { name: row.name, config: { type: 'stdio', command: row.command, args: row.args ?? [], env: resolveMcpEnv(row.env), exposure: row.exposure } };
  }
  if (row.kind === 'http') {
    if (!row.url || !/^https?:\/\//.test(row.url)) {
      logger.warn({ name: row.name, url: row.url }, 'mcp http server url 非 http(s)，跳过（防 file:// 等本地读取）');
      return null;
    }
    return { name: row.name, config: { type: 'http', url: row.url, headers: resolveMcpEnv(row.env), exposure: row.exposure } };
  }
  logger.warn({ name: row.name, kind: row.kind }, 'mcp server kind 未知，跳过');
  return null;
}

/** 从 assistant_mcp_servers 表加载启用 server（坏配置跳过）。scope 本期全部按 global 加载：
 *  /api/assistant 已被 nginx 钉单副本，所有线程加载全部启用 server；project/version 过滤留作后续。 */
export async function loadEnabledMcpServers(): Promise<AssistantMcpServer[]> {
  const rows = await db.select().from(assistantMcpServers).where(eq(assistantMcpServers.enabled, true));
  const out: AssistantMcpServer[] = [];
  for (const row of rows) {
    const entry = mcpServerToEntry(row);
    if (entry) out.push(entry);
  }
  return out;
}
```

1c. `getMcpServersForThread` 默认 loader 翻 DB（显式 `setMcpServersLoader(null)` 后行为 = DB 加载）：

```ts
/** 线程创建时取 MCP servers。默认 = DB 加载；测试用 setMcpServersLoader 注入桩。 */
export async function getMcpServersForThread(ctx: McpThreadCtx): Promise<AssistantMcpServer[]> {
  const loader: McpServersLoader = serversLoader ?? (async () => loadEnabledMcpServers());
  try {
    return await loader(ctx);
  } catch (e) {
    logger.warn({ err: e, threadId: ctx.threadId }, 'mcp servers load failed; continuing without');
    return [];
  }
}
```

- [ ] **Step 2: mcpServersRoute.ts——CRUD（配置期守卫：oauth 拒绝 + url/command 校验）**

Create `apps/api/src/pi/space/mcpServersRoute.ts`：

```ts
/**
 * assistant_mcp_servers 最小 CRUD（管理端，无 UI；管理 UI 归后续需求）。
 * 挂载于 /api/assistant/mcp-servers，router.ts 处 requireManager 保护。
 * 配置期守卫（spec §MCP）：exposure=oauth 及未知值一律拒绝（服务端无 loopback 回调能力）；
 * kind=stdio 必须 command；kind=http 必须 http(s):// url（防 file:// 等本地读取）。
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assistantMcpServers } from '../../db/schema.js';
import { HttpError } from '../../middleware/errorHandler.js';

export const mcpServersRoute = Router();

const KIND = ['stdio', 'http'] as const;
const EXPOSURE = ['codemode', 'deferred', 'direct', 'hidden'] as const;

mcpServersRoute.get('/', async (req, res) => {
  const q = req.query;
  const conds: SQL[] = [];
  if (typeof q.kind === 'string' && q.kind) conds.push(eq(assistantMcpServers.kind, q.kind));
  if (typeof q.enabled === 'string') conds.push(eq(assistantMcpServers.enabled, q.enabled === 'true'));
  const rows = await db.select().from(assistantMcpServers).where(and(...conds)).orderBy(asc(assistantMcpServers.name));
  res.json(rows);
});

mcpServersRoute.post('/', async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const kind = (b.kind as string) ?? 'stdio';
  if (!KIND.includes(kind as never)) throw new HttpError(400, 'bad_request', 'kind 必须是 stdio|http');
  const exposure = (b.exposure as string) ?? 'codemode';
  if (!EXPOSURE.includes(exposure as never)) {
    throw new HttpError(400, 'bad_request', `exposure 必须是 ${EXPOSURE.join('|')}（oauth 不支持——服务端无 loopback 回调）`);
  }
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : null;
  if (!name) throw new HttpError(400, 'bad_request', 'name 必填');
  if (kind === 'stdio' && (typeof b.command !== 'string' || !b.command.trim())) {
    throw new HttpError(400, 'bad_request', 'kind=stdio 需要 command');
  }
  if (kind === 'http' && (typeof b.url !== 'string' || !/^https?:\/\//.test(b.url))) {
    throw new HttpError(400, 'bad_request', 'kind=http 需要 http(s):// url');
  }
  const rows = await db.insert(assistantMcpServers).values({
    id: randomUUID(),
    name,
    kind,
    command: kind === 'stdio' ? (b.command as string).trim() : null,
    args: kind === 'stdio' ? (Array.isArray(b.args) ? (b.args as string[]) : []) : null,
    url: kind === 'http' ? (b.url as string) : null,
    env: b.env && typeof b.env === 'object' ? (b.env as Record<string, string>) : null,
    exposure,
    scope: (b.scope as string) ?? 'global',
    projectId: typeof b.projectId === 'string' ? b.projectId : null,
    versionId: typeof b.versionId === 'string' ? b.versionId : null,
    enabled: b.enabled === false ? false : true,
  }).returning();
  res.status(201).json(rows[0]);
});

mcpServersRoute.patch('/:id', async (req, res) => {
  const patch: Partial<typeof assistantMcpServers.$inferInsert> = {};
  const p = req.body as Record<string, unknown>;
  if ('name' in p) {
    if (typeof p.name !== 'string' || !p.name.trim()) throw new HttpError(400, 'bad_request', 'name 必填');
    patch.name = p.name.trim();
  }
  if ('kind' in p) {
    const kind = p.kind as string;
    if (!KIND.includes(kind as never)) throw new HttpError(400, 'bad_request', 'kind 必须是 stdio|http');
    patch.kind = kind;
    if (kind === 'stdio' && (typeof p.command !== 'string' || !p.command.trim())) {
      throw new HttpError(400, 'bad_request', 'kind=stdio 需要 command');
    }
    if (kind === 'http' && (typeof p.url !== 'string' || !/^https?:\/\//.test(p.url))) {
      throw new HttpError(400, 'bad_request', 'kind=http 需要 http(s):// url');
    }
  } else {
    if ('command' in p) {
      if (typeof p.command !== 'string' || !p.command.trim()) throw new HttpError(400, 'bad_request', 'command 必填');
      patch.command = p.command.trim();
    }
    if ('url' in p) {
      if (typeof p.url !== 'string' || !/^https?:\/\//.test(p.url)) throw new HttpError(400, 'bad_request', 'kind=http 需要 http(s):// url');
      patch.url = p.url;
    }
  }
  if ('args' in p) patch.args = Array.isArray(p.args) ? (p.args as string[]) : undefined;
  if ('env' in p) patch.env = p.env && typeof p.env === 'object' ? (p.env as Record<string, string>) : undefined;
  if ('exposure' in p) {
    const exp = p.exposure as string;
    if (!EXPOSURE.includes(exp as never)) throw new HttpError(400, 'bad_request', `exposure 必须是 ${EXPOSURE.join('|')}（oauth 不支持）`);
    patch.exposure = exp;
  }
  if ('scope' in p) patch.scope = p.scope as string;
  if ('projectId' in p) patch.projectId = typeof p.projectId === 'string' ? p.projectId : null;
  if ('versionId' in p) patch.versionId = typeof p.versionId === 'string' ? p.versionId : null;
  if ('enabled' in p) patch.enabled = p.enabled === false ? false : true;
  const updated = await db.update(assistantMcpServers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(assistantMcpServers.id, req.params.id))
    .returning();
  if (updated.length === 0) throw new HttpError(404, 'not_found', 'mcp server 不存在');
  res.json(updated[0]);
});

mcpServersRoute.delete('/:id', async (req, res) => {
  const deleted = await db.delete(assistantMcpServers)
    .where(eq(assistantMcpServers.id, req.params.id))
    .returning();
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'mcp server 不存在');
  res.status(204).end();
});
```

- [ ] **Step 3: router.ts 挂 `/mcp-servers`**

Modify `apps/api/src/pi/space/router.ts` 末尾（Task 2 Step 8 之后）：

```ts
spaceRoute.use('/mcp-servers', requireManager, mcpServersRoute);
```

（`requireManager` 已在 Task 2 Step 8 import；追加 `import { mcpServersRoute } from './mcpServersRoute.js';`。）

- [ ] **Step 4: spike 测试追加 DB 加载 + 守卫 + env 注入用例**

Modify `apps/api/test/assistant-mcp-spike.test.ts` 新增一个 describe（复用既有 `pool`/`beforeAll` 的 settings seed）：

```ts
describe('MCP DB 加载 + 守卫（getMcpServersForThread 默认翻 DB）', () => {
  it('loadEnabledMcpServers：启用 server 全加载，oauth/缺失二进制/http 非 http(s) 全 skip', async () => {
    const { loadEnabledMcpServers } = await import('../src/pi/space/mcp.js');
    try {
      await pool.query(`INSERT INTO assistant_mcp_servers (id, name, kind, command, exposure, enabled) VALUES
        ($1, 'echo-db', 'stdio', $2, 'direct', true)`,
        ['00000000-0000-0000-0000-0000000000d1', process.execPath]);
      await pool.query(`INSERT INTO assistant_mcp_servers (id, name, kind, command, exposure, enabled) VALUES
        ($1, 'bad-oauth', 'stdio', 'node', 'oauth', true)`,
        ['00000000-0000-0000-0000-0000000000d2']);
      await pool.query(`INSERT INTO assistant_mcp_servers (id, name, kind, command, exposure, enabled) VALUES
        ($1, 'missing-bin', 'stdio', '/nonexistent/definitely-missing', 'direct', true)`,
        ['00000000-0000-0000-0000-0000000000d3']);
      await pool.query(`INSERT INTO assistant_mcp_servers (id, name, kind, url, exposure, enabled) VALUES
        ($1, 'file-url', 'http', 'file:///etc/passwd', 'direct', true)`,
        ['00000000-0000-0000-0000-0000000000d4']);
      const servers = await loadEnabledMcpServers();
      const names = servers.map((s) => s.name);
      expect(names).toContain('echo-db');
      expect(names).not.toContain('bad-oauth');
      expect(names).not.toContain('missing-bin');
      expect(names).not.toContain('file-url');
      const echo = servers.find((s) => s.name === 'echo-db')!;
      expect(echo.config).toMatchObject({ type: 'stdio', command: process.execPath, exposure: 'direct' });
    } finally {
      await pool.query(`DELETE FROM assistant_mcp_servers`);
    }
  });

  it('resolveMcpEnv：env:KEY 从 process.env 取真实值；未定义跳过', async () => {
    const { resolveMcpEnv } = await import('../src/pi/space/mcp.js');
    process.env.ITEST_MCP_SPIKE_KEY = 'supersecret';
    try {
      expect(resolveMcpEnv({ TOKEN: 'env:ITEST_MCP_SPIKE_KEY', PLAIN: 'hello' }))
        .toEqual({ TOKEN: 'supersecret', PLAIN: 'hello' });
      expect(resolveMcpEnv({ MISSING: 'env:NOPE_NOT_SET' })).toEqual({});
    } finally {
      delete process.env.ITEST_MCP_SPIKE_KEY;
    }
  });

  it('findExecutable：绝对/相对路径按存在性，裸名按 PATH 扫描', async () => {
    const { findExecutable } = await import('../src/pi/space/mcp.js');
    expect(findExecutable(process.execPath)).toBe(true);
    expect(findExecutable('/nonexistent/definitely-missing')).toBe(false);
    expect(findExecutable('node')).toBe(true);
  });
});
```

- [ ] **Step 5: 跑测试 + typecheck**

Run（从 `apps/api`）：

```bash
TESTCONTAINERS_RYUK_DISABLED=true pnpm exec vitest run test/assistant-mcp-spike.test.ts
```

Expected: 全过（原 spike 断言 `mcp__echo__echo` 用例不受影响——Task 3 后 `setMcpServersLoader(null)` 恢复的是 DB 默认，但 spike 测试体内显式注入 loader 且 `finally` 里恢复，顺序无关）。失败时先看是不是 `assistant_mcp_servers` 表没建（SCHEMA_SQL Step 2 漏同步）。

```bash
pnpm typecheck
```

Expected: 0 errors。

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/pi/space/mcp.ts apps/api/src/pi/space/mcpServersRoute.ts apps/api/src/pi/space/router.ts apps/api/test/assistant-mcp-spike.test.ts
git commit -m "feat(pi): MCP DB 加载——assistant_mcp_servers CRUD+配置期守卫(warn-not-fail)+env:KEY 注入,loader 默认翻 DB"
```

**Task 3 完成标志**：`loadEnabledMcpServers` 真实 DB 加载全绿，oauth/缺失二进制/file:// 三类坏配置全部 skip 不炸，配置期 oauth 拒绝。

---

## Task 4: S2 skills——additionalSkillPaths + read_skill 工具 + 自渲染 skills 段

**关键机制**（见计划头部关键事实 §4）：pi 的 skills 段渲染被 `system-prompt.js:99` 的 `skillFileReadTool = ["read","bash"].find(...)` 门住，助手 `noTools:'builtin'` 无这两工具 → skills 段永不渲染，即使 `additionalSkillPaths` 生效。修法 = 在 identity **之前**的 `before_agent_start` handler 里把 `event.systemPromptOptions.sections.skills` 指向自渲染 XML；正文取读靠新增 `read_skill` 工具（补 catalog-only 缺的「取正文」能力）。

**Files:**
- Modify: `apps/api/src/pi/space/tools/context.ts`（`SpaceToolsContext.workspaceDir?: string`）
- Create: `apps/api/src/pi/space/tools/readSkill.ts`
- Modify: `apps/api/src/pi/space/session.ts`（mkdir .pi/skills + loadSkills 自渲染 + extensionFactories 首插 skills 段 + loader additionalSkillPaths + ctx 传 workspaceDir）
- Modify: `apps/api/src/pi/space/tools/index.ts`（装配 `read_skill`）
- Create: `apps/api/test/read-skill.test.ts`

- [ ] **Step 1: context.ts 追加 workspaceDir（可选字段）**

Modify `apps/api/src/pi/space/tools/context.ts` 的 `SpaceToolsContext`（末尾追加；**可选**是为不破坏 8 个测试文件的 `makeCtx` 字面量——真实工厂总传值，read_skill 缺席时回落 cwd）：

```ts
  /** 版本独立工作空间目录（.data/workspaces/v-<versionId>）；read_skill 的 .pi/skills 根。 */
  workspaceDir?: string;
```

- [ ] **Step 2: 写 readSkill.ts**

Create `apps/api/src/pi/space/tools/readSkill.ts`（**不静态 import pi**——session.ts 已动态 import pi，catalog 由它算好传入；本模块只做目录读 + 工具 + 段渲染，保持可单测）：

```ts
/**
 * S2 按需技能（workspace/.pi/skills 目录）：
 *  - readSkillDir：SKILL.md 正文 + scripts 清单（路径双守卫）
 *  - buildReadSkillTool：read_skill 工具（补 catalog-only 缺的「取正文」能力）
 *  - buildSkillsSectionContent：skills 段自渲染 XML（identity 的 forceSystemPrompt 之前必须就位）
 *
 * 双守卫（关键事实 §6）：path.join(root, '/abs/x') 会把第二参当绝对路径丢弃 root →
 * 先拒 path.isAbsolute(skillName)，再 normalize(join(...)) 查 .startsWith(root + path.sep)。缺任一都逃逸。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { SpaceToolsContext } from './context.js';
import type { ToolExecutor } from '../../tools.js';

const SKILL_DIR_NAME = '.pi/skills';
const MAX_BODY_CHARS = 60_000;
const MAX_SCRIPT_LIST = 50;

export function skillsRootOf(workspaceDir: string): string {
  return path.join(workspaceDir, SKILL_DIR_NAME);
}

/** 读 skill 目录 SKILL.md + scripts 清单；目录/文件缺失或越界 → null。 */
export function readSkillDir(root: string, skillName: string): { body: string; scripts: string[] } | null {
  if (path.isAbsolute(skillName)) return null;
  const normalizedRoot = path.normalize(root);
  const skillRoot = path.normalize(path.join(normalizedRoot, skillName));
  if (!skillRoot.startsWith(normalizedRoot + path.sep)) return null;
  const mdPath = path.join(skillRoot, 'SKILL.md');
  if (!fs.existsSync(mdPath)) return null;
  const body = fs.readFileSync(mdPath, 'utf8').slice(0, MAX_BODY_CHARS);
  const scriptsDir = path.join(skillRoot, 'scripts');
  let scripts: string[] = [];
  if (fs.existsSync(scriptsDir)) {
    scripts = fs.readdirSync(scriptsDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .slice(0, MAX_SCRIPT_LIST);
  }
  return { body, scripts };
}

export function buildReadSkillTool(ctx: SpaceToolsContext): ToolExecutor {
  const root = skillsRootOf(ctx.workspaceDir ?? process.cwd());
  return {
    name: 'read_skill',
    description: '读取 .pi/skills 目录下某个 skill 的 SKILL.md 正文与 scripts 清单（按需查阅；只能读当前版本工作空间内 .pi/skills 下的 skill，禁止越界）。',
    parameters: Type.Object({
      skillName: Type.String({ minLength: 1 }),
    }),
    execute: async (input) => {
      const { skillName } = input as { skillName: string };
      const hit = readSkillDir(root, skillName);
      if (!hit) return { ok: false, error: `skill 不存在: ${skillName}（.pi/skills 下没有该目录或越界）` };
      return { ok: true, data: JSON.stringify({ name: skillName, ...hit }) };
    },
  };
}

/** skills 段自渲染（agentskills.io 风格 XML）：name/description/location + read_skill 用法。
 *  只列 catalog 与一句使用说明，不含正文——正文由模型需要时调 read_skill 取（pi 原语义）。 */
export function buildSkillsSectionContent(
  skills: Array<{ name: string; description: string; location: string }>,
): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = skills.map((s) =>
    `  <skill name="${esc(s.name)}" description="${esc(s.description)}" location="${esc(s.location)}" />`,
  );
  return `<available_skills>\n${lines.join('\n')}\n</available_skills>\n\n按需查阅技能内容时调用 read_skill 工具（入参 skillName）；skill 正文不会自动进入本提示词，要靠 read_skill 取。`;
}
```

- [ ] **Step 3: session.ts 装配（mkdir + loadSkills 自渲染 + loader + ctx）**

Modify `apps/api/src/pi/space/session.ts`：

3a. 工厂内 `.pi/skills` 目录（`await fs.mkdir(repoDir...)` 之后、`const rawTools` 之前的合适位置插入，`fs`/`path` 已有 import）：

```ts
  // S2 按需技能目录：版本工作空间下 .pi/skills（发版时宿主挂载；本设计不负责其生命周期，只 mkdir 兜底）。
  const skillsRoot = path.join(workspaceDir, '.pi', 'skills');
  await fs.mkdir(skillsRoot, { recursive: true });
```

3b. pi 动态 import 解构追加 `loadSkills`（第 392 行）：

```ts
  const { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir, loadSkills } = await import('@earendil-works/pi-coding-agent');
```

3c. loader 构造之前（约第 445 行）算好自渲染 catalog：

```ts
  // S2 catalog：与 loader.additionalSkillPaths 同源目录（loadSkills 同步）。Skill.location 取 filePath
  // （Skill = { name, description, filePath, baseDir, sourceInfo, disableModelInvocation }）。
  const skillsFiles = loadSkills({
    cwd: workspaceDir,
    agentDir: getAgentDir(),
    skillPaths: [skillsRoot],
    includeDefaults: false,
  }).skills.map((s) => ({ name: s.name, description: s.description, location: s.filePath }));
```

3d. loader 构造整体替换（第 446-464 行）。`additionalSkillPaths` 挂 workspace 目录；`extensionFactories` 数组**首位**插入 skills 段扩展（Task 1 已定顺序 skills → mcp → identity）：

```ts
  const loader = new DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir: getAgentDir(),
    additionalSkillPaths: [skillsRoot],
    appendSystemPromptOverride: (base) => [...base, buildSpaceSystemPrompt(summaryText, ctx.lang, guides)],
    // 每轮开跑前把 preamble 换成产品身份。见 buildSpacePreamble 的注释：不能走
    // loader.systemPrompt，也不能直接改 systemPromptOptions.customPrompt，那两条路都会
    // 丢掉 rules 段里的工具 promptGuidelines。
    extensionFactories: [
      // S2 skills 段自渲染：必须在 MCP 与 identity 之前——identity 渲染 event.systemPrompt（getter，
      // 从共享 currentOptions 重算）并返回 {systemPrompt}，会冻结后续 section 变更；而 skills 段
      // 因 noTools:'builtin' 永远不会被 pi 自己渲染（system-prompt.js:99 门在 read/bash），只能自渲染。
      {
        name: 'itest-space-skills',
        hidden: true,
        factory: (pi) => {
          pi.on('before_agent_start', (event) => {
            event.systemPromptOptions.sections.skills = buildSkillsSectionContent(skillsFiles);
          });
        },
      },
      // MCP：注册 + hermetic 建连装载。必须在 identity 前（mcp_servers 段要写进被 identity
      // 冻结的 systemPrompt 快照；见计划头部关键事实 §1 与 Task 1 Step 3d）。
      mcpExtensions.register,
      mcpExtensions.connect,
      {
        name: 'itest-space-identity',
        hidden: true,
        factory: (pi) => {
          pi.on('before_agent_start', (event) => {
            const rewritten = rewriteSpacePreamble(event.systemPrompt, aiLangFrom(ctx.lang));
            if (rewritten !== undefined) return { systemPrompt: rewritten };
            return undefined;
          });
        },
      },
    ],
  });
```

3e. `const rawTools: ToolRaw[] = buildSpaceTools(...)`（第 414 行）追加 `workspaceDir`：

```ts
  const rawTools: ToolRaw[] = buildSpaceTools({ ...ctx, workspaceDir, emit: (e) => emitThreadEvent(ctx.threadId, e) }) as ToolRaw[];
```

3f. import 追加：

```ts
import { buildSkillsSectionContent } from './tools/readSkill.js';
```

- [ ] **Step 4: tools/index.ts 装配 read_skill**

Modify `apps/api/src/pi/space/tools/index.ts`：

4a. import 追加：`import { buildReadSkillTool } from './readSkill.js';`

4b. `buildSpaceTools` 内 `tools.push(...buildLoginTools(ctx));` 之后（verify/solidify 之前均可）追加：

```ts
  tools.push(buildReadSkillTool(ctx));
```

- [ ] **Step 5: 写 read-skill.test.ts**

Create `apps/api/test/read-skill.test.ts`（临时目录造 echo skill fixture，无需 DB）：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readSkillDir, buildReadSkillTool, buildSkillsSectionContent, skillsRootOf } from '../src/pi/space/tools/readSkill.js';

let ws: string;

beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'itest-skills-'));
  await fs.mkdir(path.join(ws, '.pi', 'skills', 'echo', 'scripts'), { recursive: true });
  await fs.writeFile(path.join(ws, '.pi', 'skills', 'echo', 'SKILL.md'), '---\nname: echo\ndescription: 回显\n---\n正文EchoBody');
  await fs.writeFile(path.join(ws, '.pi', 'skills', 'echo', 'scripts', 'a.js'), 'console.log(1)');
});

afterAll(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe('read_skill（S2）', () => {
  it('读 SKILL.md 正文 + scripts 清单', () => {
    const hit = readSkillDir(skillsRootOf(ws), 'echo');
    expect(hit?.body).toContain('正文EchoBody');
    expect(hit?.scripts).toEqual(['a.js']);
  });

  it('路径逃逸双守卫：../ 与绝对路径都拒绝', () => {
    expect(readSkillDir(skillsRootOf(ws), '..')).toBeNull();
    expect(readSkillDir(skillsRootOf(ws), '/etc')).toBeNull();
    expect(readSkillDir(skillsRootOf(ws), '../echo')).toBeNull();
    expect(readSkillDir(skillsRootOf(ws), 'echo/../../etc')).toBeNull();
  });

  it('buildReadSkillTool.execute：命中返回正文 JSON；不存在返回错误', async () => {
    const tool = buildReadSkillTool({ workspaceDir: ws } as never);
    const ok = await tool.execute({ skillName: 'echo' });
    expect(ok.ok).toBe(true);
    expect(JSON.parse((ok as { data: string }).data)).toMatchObject({ name: 'echo' });
    const miss = await tool.execute({ skillName: 'nope' });
    expect(miss.ok).toBe(false);
  });

  it('buildSkillsSectionContent：available_skills XML 只含 catalog（无正文）+ read_skill 用法', () => {
    const s = buildSkillsSectionContent([{ name: 'echo', description: '回显', location: '/abs/echo/SKILL.md' }]);
    expect(s).toContain('<available_skills>');
    expect(s).toContain('name="echo"');
    expect(s).toContain('read_skill');
    expect(s).not.toContain('正文EchoBody'); // catalog-only，正文靠 read_skill 取
  });
});
```

- [ ] **Step 6: 跑测试 + typecheck**

Run（从 `apps/api`）：

```bash
TESTCONTAINERS_RYUK_DISABLED=true pnpm exec vitest run test/read-skill.test.ts test/space-tools-basic.test.ts
```

Expected: 全过（space-tools-basic 回归确认 workspaceDir 可选字段不破坏既有 ctx 字面量）。失败时先看 `buildSkillsSectionContent` 的 XML 转义或 `readSkillDir` 的 `startsWith` 边界（`root` 自身不带 `+ path.sep` 时 `rootX/…` 会不会误放行——已用 `normalizedRoot + path.sep` 杜绝）。

```bash
pnpm typecheck
```

Expected: 0 errors。

- [ ] **Step 7: 提交**

```bash
git add apps/api/src/pi/space/tools/context.ts apps/api/src/pi/space/tools/readSkill.ts apps/api/src/pi/space/tools/index.ts apps/api/src/pi/space/session.ts apps/api/test/read-skill.test.ts
git commit -m "feat(pi): S2 skills——workspace .pi/skills 注入+read_skill 工具(双守卫)+skills 段自渲染(identity 前)"
```

**Task 4 完成标志**：read_skill 正文命中 + `../`/绝对路径全部拒绝 + skills 段 XML 只含 catalog；typecheck 全绿。

---

## Task 5: 端到端冒烟（单副本手动；对标 /tmp/assistant-verify.mjs 形态）

多人副本交互验证：spec 要求「起 api + web，经 /api/assistant 发消息，带 MCP 的线程工具调用成功」。此处为**手动验证步骤清单**（自动化 e2e 不在本计划范围——spike 已闭环真实 MCP 链路，这里只做回环真机确认）。

- [ ] **Step 1: 本地起 api + web**

本地 dev 需 `ENCRYPTION_KEY` + `CHROMIUM_PATH`（见 dev_env_required_vars）：

```bash
# 终端 1（apps/api）
ENCRYPTION_KEY=... CHROMIUM_PATH=$(which chromium 2>/dev/null || echo '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') pnpm dev
# 终端 2（apps/web）
pnpm dev
```

Expected: api 54321 / web 5173（或配置端口）起来，migrate/seed 无异常。

- [ ] **Step 2: 造一条 stdio echo MCP 配置**

```bash
curl -s -X POST http://localhost:54321/api/assistant/mcp-servers \
  -H 'Content-Type: application/json' \
  -d '{"name":"echo","kind":"stdio","command":"node","args":["<iTest>/apps/api/test/fixtures/mcp-echo-server.mjs"],"exposure":"direct"}'
```

Expected: 201 返回新 server 行。再试 `exposure=oauth` → 400（配置期守卫）。

- [ ] **Step 3: 建线程发消息，断言 MCP 工具被调用**

经 web 空间页 → AI 助手建线程，发：「列出你的可用工具；如有 mcp echo server 的工具，调它 echo 一下 initTest」。

Expected: 模型回复里出现 `mcp__echo__echo` 调用及回显结果（工具名舍 `-` 变 `_`）。服务端日志应有 mcp echo server 的 `initialize` 建连。

- [ ] **Step 4: 守卫端到端复核**

把上面 echo 行 `PATCH /api/assistant/mcp-servers/:id` 改成 `exposure: "direct"` 且 command 指向不存在二进制 → 重启 api（或新开线程）→ 助手照常可用、MCP 工具不出现、日志出现 warn-not-fail。

**Task 5 完成标志**：真实浏览器会话里 mcp echo 工具被模型调用成功；坏配置不拖垮助手。

---

## 收尾

- [ ] **Step 5: 提交本计划文档**

```bash
git add docs/superpowers/plans/2026-10-18-assistant-skills-mcp.md
git commit -m "docs(pi): Skills+MCP 实施计划（S1 guides / S2 read_skill / MCP 通用通道，spike 先行）"
```