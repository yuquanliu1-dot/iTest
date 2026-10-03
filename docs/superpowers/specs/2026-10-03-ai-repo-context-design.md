# AI 工作台：源码仓库作为上下文（方案 B · Pi 内置工具 + 沙箱）

日期：2026-10-03
状态：待用户审阅
上游参考：
- `docs/superpowers/specs/2026-10-01-ai-case-creation-design.md`（AI 工作台 / 暂存文档 / 保存事务）
- `docs/superpowers/specs/2026-10-03-ai-step-dual-field-design.md`（compiled 双字段）
- `apps/api/src/services/gitProvider.ts`（仓库 URL 校验 / PAT 校验）
- `apps/api/src/pi/inspectPage.ts`（与抓页面工具对称的形状）

## 背景与目标

现有 AI 工作台让模型在生成用例步骤前调用 `inspect_page(url)` 抓取被测页面，靠真实 DOM 推断元素选择器。但许多需求是「表单 A 提交后页面 B 应展示某条记录」——纯靠抓 URL 看不到前后端交互细节、抓不到内部状态机、抓不到跨页路由；结果就是模型臆造 `navigate` URL、编出未实现的文案断言。

本期目标：项目已配置源码仓库（`projects.repoUrl + defaultBranch + provider + patOverride`）时，把仓库作为「AI 工作台的第二上下文」挂到 Pi AgentSession，让模型能 ls / read / grep 真实代码，看到 `handleSubmit`、`/api/foo`、`Router.push` 之类的真实实现，生成的用例步骤自然贴源码。

用户在发首条消息时显式选择 `参考源码 / 抓取页面 / 自动`，避免每次都要 AI 凭运气挑；上下文偏好持久化进 `ai_workspace_state.doc.contextMode`。

### 本期范围（YAGNI）

**做**：

- 仓库惰性 checkout：每项目一份 `<dataDir>/repos/<projectId>/`，浅克隆 `--depth 1`，branch 用 `projects.defaultBranch`
- 4 个沙箱化工具 `repo_ls / repo_read / repo_grep / repo_run` 暴露给 Pi AgentSession；cwd 强制限定在 checkout 路径
- 用户首条消息选 `contextMode`，存进 `doc.contextMode`，并注入到 AgentSession 的 system message
- `WorkspaceDoc` 新增 `repoContext: { commit, fetchedAt, mode } | null`，右栏展示「已参考源码 v<sha>」chip
- 仓库不可用时静默降级：不挂 repo 工具、system message 引导回 `inspect_page`、chip 显示「源码未配置」
- 命令白名单 + 路径穿越防御（不依赖 OS 级沙箱）

**明确不做**：

- 工作树写操作（rm / mv / 改源码）—— 沙箱只读
- 跨项目共享 checkout —— 每项目一份（你确认过）
- 自动定时 `git fetch` —— 惰性，新会话/分支变更才更新
- 工作树 GUI（diff / blame / 提交视图）
- LLM 自动选 contextMode（让用户先选，再迭代中可随时改）
- 多仓库 / monorepo sub-path 选择

### 设计决策（已与用户确认）

| 议题 | 决策 |
|---|---|
| 触发时机 | 用户在发首条消息时显式选择 `contextMode`，持久化到 doc |
| clone 方式 | 浅克隆 `--depth 1 --branch <branch>` |
| 目录策略 | 每项目一份 checkout：`<dataDir>/repos/<projectId>/` |
| 拉取时机 | 惰性：AI 调用 `inspect_repo_*` 工具时 clone/fetch；不预热 |
| 失败降级 | 克隆失败 / 未配置仓库时仍可用 `inspect_page`，UI 标记「源码不可用」 |
| 是否新增表 | 不新增；项目表已有 `repoUrl/defaultBranch/patOverride/provider`，运行时直读 |
| 沙箱策略 | 工具层 chdir + 路径穿越防御 + 命令白名单；不依赖 OS 沙箱 |
| 仓库 metadata 来源 | 与 iDO 同源（`projects` 表，PAT 明文，未来切 encrypted column） |

## 架构

```
浏览器 apps/web
└── AiWorkspacePage
    ├── 顶部 Segmented「参考源码 / 抓取页面 / 自动」 ← 新组件（用现有 Segmented.tsx）
    │      选择即写 doc.contextMode，并随首条 message 传给后端
    └── 发消息 →  POST /api/pi/threads/:id/messages  body: { text, metadata: { contextMode } }

服务端 apps/api
└── src/pi/repo.ts   ← 新模块
    ├── checkoutRepo(projectId)   浅克隆 / fetch / reset，记录 commit SHA
    ├── assertInCwd(target)        路径穿越防御
    └── buildRepoSandboxTools(cwd) 4 个白名单工具定义
└── src/pi/session.ts（改动小）
    ├── createAgentSession({ cwd, customTools, ... })
    ├── customTools: [buildWorkspaceTools(reqId), ...buildRepoSandboxTools(cwd)]
    └── 在 system message 注入本轮 contextMode 指令
└── src/pi/workspace.ts（小改）
    ├── WorkspaceDoc.contextMode + repoContext
    └── recordContextMode / recordRepoCheckout
└── src/pi/tools.ts
    └── buildWorkspaceTools promptGuidelines：contextMode=源码 → 优先 repo_*；=page → 优先 inspect_page

持久化：
  ai_workspace_state.doc 增加：
    {
      contextMode: 'repo' | 'page' | 'auto',
      repoContext: { commit, fetchedAt, mode } | null,
      pageContext: { url, fetchedAt } | null   ← 已有
    }
  无新增表 / 无迁移（jsonb 已有字段缺失按 null 处理）。
```

## 服务端设计

### `apps/api/src/pi/repo.ts`（新）

```ts
export const REPOS_ROOT = path.join(DATA_DIR, 'repos');
export class RepoUnavailableError extends Error {
  constructor(public reason: 'no_repo' | 'clone_failed' | 'auth_failed' | 'dirty', msg: string) { super(msg); }
}
export class SandboxViolationError extends Error {}

/** 读 projects 表 → 浅克隆 / fetch → 写 .itest-sandbox.json → 返回 cwd。 */
export async function checkoutRepo(projectId: string): Promise<string>;

/** 工具定义四个白名单工具，全部 chdir 到 cwd + 子进程封装。 */
export function buildRepoSandboxTools(cwd: string): ToolExecutor[];
```

**checkoutRepo 行为**：

1. 读 `projects.repoUrl/defaultBranch/provider/patOverride`；任一缺失抛 `RepoUnavailableError('no_repo')`
2. 路径 = `<REPOS_ROOT>/<projectId>/`；父目录不存在 → mkdir recursive
3. 锁：`proper-lockfile` 文件锁 `<REPOS_ROOT>/<projectId>/.lock`；最长等 5s；超时抛 `LockTimeoutError`
4. 目录内 `.git` 不存在 → `git clone --depth 1 --branch <branch> <authedUrl> <path>`
5. 存在 → `git fetch origin <branch> --depth 1` → `git reset --hard origin/<branch>`
6. dirty（本地有 tracked 修改或 untracked）→ `git stash --include-untracked` 写到 `<path>/.stash-<ts>`，记到 `.itest-sandbox.json.stashRef`
7. PAT 走 URL 注入：`<scheme>://x-access-token:<PAT>@<host>/<path>`（GitHub）；Gitee 用 `oauth2:<PAT>`；GitLab 自建走 `gitlabUrlOverride` 否则原 URL + `oauth2:<PAT>`；PAT 缺省走匿名
8. 写 `<path>/.itest-sandbox.json`：`{ provider, branch, commit, fetchedAt, stashRef? }`
9. 返回 `<path>`

**buildRepoSandboxTools(cwd)** 四个工具：

| 工具 | 参数 | 实现 |
|---|---|---|
| `repo_ls` | `{ path?: string }`（相对 cwd） | `fs.readdir(realpath(<cwd>/<path>))`；realpath 必须 startsWith cwd；最多 500 项；返回 `{ entries: [{ name, kind: 'dir'\|'file' }] }` |
| `repo_read` | `{ path: string, offset?: number, maxLines?: number }` | 读文本文件；realpath 校验；offset 默认 0；maxLines 默认 200 / 上限 500；>30k 字符截断；二进制（首 512 字节含 NUL）返 `ok:false` |
| `repo_grep` | `{ pattern: string, glob?: string, maxMatches?: number }` | 子进程 `rg --no-heading -n -S --max-count=<maxMatches or 200> <pattern> --glob=<glob?> .`（cwd）；输出截断到 `MAX_OUTPUT_CHARS = 30000`（与 inspect_page 对齐） |
| `repo_run` | `{ command: string }`（白名单单命令，禁 `&&` `;` `\|`） | 解析 command + args；whitelist：子命令 `ls` `cat` `tree` `find` `head` `tail` `wc` `grep` `rg` `git`（仅 `git log/show/diff/ls-files/grep/status` 子命令二次白名单）；其他拒；进程 cwd=cwd；超时 30s |

**沙箱一致性**：所有工具 `execute` 入口先 `assertInCwd(target)`，realpath 后必须 startsWith cwd。`assertInCwd` 用 `fs.realpath`；遇到 `..`、符号链接逃逸、绝对路径越过 cwd 一律抛 `SandboxViolationError`，执行器捕获后返回 `{ ok: false, error: ... }`。

### `apps/api/src/pi/session.ts`（小改动）

- `createAgentSession` 调用前：
  ```ts
  let cwd: string | null = null;
  try { cwd = await checkoutRepo(projectId); }
  catch (e) { /* RepoUnavailableError → 不挂 repo 工具，记录 doc.repoContext=null */ }
  ```
- 构造：
  ```ts
  const customTools = [...buildWorkspaceTools(reqId), ...(cwd ? buildRepoSandboxTools(cwd) : [])];
  const session = await factory({
    customTools,
    cwd: cwd ?? undefined,           // Pi AgentSession 自身支持的 cwd（如果不支持则用 promptGuidelines 强约束）
    system: buildSystemMessage({ contextMode, repoAvailable: !!cwd }),
  });
  ```
- `cwd` 字段存在性：先看 `@earendil-works/pi-coding-agent` 的 `createAgentSession` options 是否含 `cwd`；若没有，则靠沙箱工具 + promptGuidelines「禁止使用绝对路径、禁止跳出 repo 目录」兜底（本计划先验证；不支持则降级为不传 cwd，但工具仍然只读 cwd 内）

### `apps/api/src/pi/workspace.ts`（小改动）

```ts
export interface RepoContext { commit: string; fetchedAt: string; mode: 'repo' | 'auto'; }
export interface WorkspaceDoc {
  plan: { scenarios: number; cases: number } | null;
  contextMode: 'repo' | 'page' | 'auto';   // 新增，默认 'auto'
  pageContext: { url: string; fetchedAt: string } | null;
  repoContext: RepoContext | null;          // 新增
  scenarios: StagedScenario[];
  looseCases: StagedCase[];
}
```

- `emptyDoc()` 默认 `contextMode: 'auto', repoContext: null`
- `recordContextMode(reqId, mode)`：merge 到 doc，写 `contextMode`
- `recordRepoCheckout(reqId, ctx)`：merge 写 `repoContext`
- `recordPageInspection(reqId, url)`：保留

### `apps/api/src/pi/tools.ts`（`buildWorkspaceTools` promptGuidelines 增段）

```
如果 contextMode=repo 且仓库可用：
  - 生成用例前必须先调用 repo_ls 列目录、repo_read 读关键文件、repo_grep 找关键实现，
    再决定 navigate URL / locator / assertion。
  - locator 必须基于真实源码中存在的元素（className / data-testid / role）。
如果 contextMode=page：
  - 沿用旧规则：先生成 inspect_page，再生成用例。
如果 contextMode=auto：
  - 若需求含明确被测页面 URL，先 inspect_page；若同时暗示内部行为（接口、状态机、表单提交后跳转），
    再 repo_*；两者都跑，哪个先到用哪个。
如果仓库不可用：
  - 跳过 repo_*，走 inspect_page；不要因为仓库不可用而拒绝生成。
```

### 路由层

- `POST /api/pi/threads/:id/messages`：body 增加 `metadata.contextMode`，落到 `recordContextMode`
- `GET /api/requirements/:id/ai-workspace`：返回 `WorkspaceDoc` 完整形（含 `contextMode/repoContext`）
- 不新增端点

## 前端设计

- `apps/web/src/features/ai-workspace/ContextModeSelector.tsx`：用现有 `Segmented.tsx`，三选项 `参考源码 / 抓取页面 / 自动`
- 放在 `WorkspacePanel` 顶部，进页面默认恢复 `doc.contextMode`
- 切换 contextMode → `POST /api/requirements/:id/ai-workspace/context-mode`（小端点，只写 doc）
- 右栏 chip：「已参考源码 v<sha> · 分支 <branch>」或「已抓取页面 <url>」或「源码未配置 / 页面未抓取」
- 发消息：`POST /api/pi/threads/:id/messages` body 增加 `metadata: { contextMode }`
- 仓库 metadata 缺失时禁用 `参考源码` 选项（disabled + tooltip「请先到项目设置配置仓库」）

## 错误处理

| 场景 | 行为 |
|---|---|
| `projects.repoUrl` 缺失 | `RepoUnavailableError('no_repo')` → session 不挂 repo 工具；system message 引导用 `inspect_page`；chip「源码未配置」 |
| PAT 401 / 403 | `RepoUnavailableError('auth_failed')` → 同上；chip「凭证失效」 |
| 网络错误 / clone 超时 | `RepoUnavailableError('clone_failed')` → 同上；chip「仓库不可达」 |
| 工作树 dirty | stash 后 reset；stashRef 写入 `.itest-sandbox.json`，UI 不暴露 |
| 路径穿越 / 黑名单命令 | `SandboxViolationError` → 工具返回 `{ ok: false, error }`；模型可自纠；不抛断 session |
| 并发 fetch 锁等 >5s | `LockTimeoutError` → 工具返回错误；模型可重试或跳过 |
| 工具调用超时（>30s） | 子进程 kill；工具返回错误；模型自纠 |
| LLM 在 repo 工具下乱跑 `curl` / `rm` | 白名单拒；模型拿到明确错误 |

## 测试

- **API**
  - `repo.ts`：
    - mock `child_process.spawn` 模拟 `git clone` / `git fetch` / `git reset`；验证 lockfile、`.itest-sandbox.json`、`stash` 写入
    - 路径穿越：`path=../../etc/passwd`、`path=/etc/passwd` → `SandboxViolationError`
    - 命令白名单：`rm -rf /`、`curl http://evil`、`git push` → `ok:false`
    - 大文件读取：offset/maxLines 边界；非文本文件 ok:false
    - `rg` 找不到匹配：返回空数组；输出超 30k 截断
  - `workspace.ts`：
    - `recordContextMode` / `recordRepoCheckout` merge 正确（不覆盖既有 `pageContext`）
  - `session.ts`：
    - mock `checkoutRepo` 成功 → 工具组含 `repo_*`
    - mock `checkoutRepo` 抛 `RepoUnavailableError` → 工具组只剩 workspace，session 仍能创建
  - 端到端：mock LLM 脚本化调用 `repo_ls → repo_read → upsert_case` 全链路；doc.repoContext 落库；右栏缓存刷新
  - 回归：ai-workspace 测试套件全量（已知 plans.test 1 个 pre-existing）
- **Web**
  - `ContextModeSelector` unit：切换 → 接口调用、按钮 disabled 逻辑
  - 仓库 metadata 缺失时禁用选项的渲染分支
  - 手动金路径：项目已配仓库 → 选「参考源码」→ mock 模型读源码 → 看到 chip

## 后续（YAGNI 已划掉）

- 工作树 GUI / blame / history viewer
- 自动定时 fetch
- 多仓库 / monorepo sub-path
- 工作树写操作 + 提交
- 把 repo_* 工具迁移到 Pi 内置 Read/Bash/Grep 工具（如 Pi 暴露了且沙箱可控）

---

待你审阅这一稿。如果 OK，我会在你确认后转入实现计划（writing-plans）。
