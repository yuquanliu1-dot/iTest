# AI 助手 Skills + MCP 支持设计

## 背景与目标

**现状**：AI 助手（`apps/api/src/pi/space/session.ts`）基于 pi-coding-agent v0.99.2（npm `@earendil-works/pi-coding-agent`）× Claude API。系统提示词结论硬编码在 `buildSpaceSystemPrompt`（REQ_DESIGN_METHOD / CASE_AUTHORING_FLOW_ZH/EN），改流程=改代码=发版。工具集固定，无法按项目/版本差异化。无法连接外部系统。

**目标**（用户口径，2026-10-18 AskUserQuestion 确认）：
- **Skills** = 流程/知识包（procedural knowledge packages），运营侧可改、可热生效、可按项目/版本差异。
- **MCP** = 通用通道优先（先提供 DB 配置 + stdio/HTTP 两种模式的通用通道，不绑定具体外部系统）。
- 不改助手现有核心链路；多副本下**不引入新的容器局部状态**（/api/assistant 已由 nginx 粘性 upstream 钉单副本，见 project_perf_p2_landed_p3_dropped.md 架构约束）。

**非目标**：
- 不做 skills/MCP 的 UI 管理界面（本设计只出后端数据模型 + 端点；管理 UI 归后续需求）。
- 不做 MCP 的 OAuth（loopback 回调不适合服务端，直接禁止）。
- 不做 MCP 到具体外部系统的绑定示例（只做通用通道 + stdio echo 冒烟验证）。
- 不动 `recorder/ws`、`liveView` 等其他容器局部状态。

---

## 方案总览

两个特性共用一套「**DB 配置 + 会话时加载**」模式：

| 特性 | 持久化 | 加载点 | 生效方式 |
|---|---|---|---|
| Skills S1（常驻指令） | `assistant_guides` 表 | `buildSpaceSystemPrompt` | 随 SSE/消息同链，改 DB 即热生效 |
| Skills S2（pi 原生按需技能） | `.pi/skills/` 目录 + `assistant_skills` 白名单（可选） | `DefaultResourceLoader` `additionalSkillPaths` + 新增 `read_skill` 工具 | 新开线程加载 |
| MCP | `assistant_mcp_servers` 表 | 会话加载时 `pi.registerMcpServer()` + `createMcpExtension` | 新开线程加载 |

Skills 拆 S1/S2 的原因（pi 框架约束）：pi 的 skills 是**目录注入（catalog-only）**——`formatSkillsForPrompt` 只把 name/description/location 注入提示词，正文靠模型调 read 工具自行加载；而助手是 `noTools:'builtin'`（无 read 工具）→ 模型取不到正文。因此「常驻约束类流程」必须用 S1（正文直接进系统提示词），「按需查阅类知识」可以用 S2（补一个 `read_skill` 工具补上取正文的缺口）。

---

## Skills

### S1：DB 常驻指令（assistant_guides）

**为什么选 DB 而非目录**：流程指令要热生效、要按项目/版本覆盖、要能被验证和管理。目录虽然不用改代码，但改目录也要进镜像（发版）；DB 改完即生效且天然支持 scope 覆盖。

**表结构** `assistant_guides`：

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid pk | |
| scope | text | `global` / `project`（按 project_id）/ `version`（按 version_id） |
| project_id | uuid null | scope=project 时必填 |
| version_id | uuid null | scope=version 时必填 |
| kind | text | `flow`（流程指令，进 system prompt 正文）/ `reference`（知识/参考，进 S1 同样注入但语义为查阅用） |
| body | text | 内容（中文/英文原文，不翻译） |
| lang | text | `zh` / `en`（关联会话 lang，`any` 匹配全部） |
| sort | int | 排序，小在前 |
| enabled | bool | 停用即不注入 |

**加载逻辑**（改 `buildSpaceSystemPrompt`，现有 `space/reqDesign.ts` 相关注入不变）：
1. 按当前会话 `(lang, project_id, version_id)` 查启用 guides，排序。
2. scope 优先级：`version` > `project` > `global`（同 scope 内按 sort）。同一 kind 可叠加（默认无互斥，除非 body 语义上替代——由运营侧负责，系统不做去重）。
3. 用 `# 流程指令`（kind=flow）与 `# 知识参考`（kind=reference）两节追加到系统提示词末尾。
4. 现 `REQ_DESIGN_METHOD` / `CASE_AUTHORING_FLOW_ZH/EN` 文本**迁移为 seed 数据**（scope=global, lang=zh/en, kind=flow），迁移后行为零变化（同一提示词文本，注入方式由硬编码变 DB）。

**端点**：不做 UI，提供最小 CRUD：
- `GET /api/assistant/guides?scope=&projectId=&versionId=&lang=` 列表
- `POST /api/assistant/guides` 建
- `PATCH /api/assistant/guides/:id` 改/停用
- `DELETE /api/assistant/guides/:id` 删

### S2：pi 原生 skills（按需知识包）

**用途**：S1 管「常驻约束」，S2 管「按需查阅」——大段知识（如某版本的操作手册、SUT 特性文档）不适合常驻提示词，按任务匹配再加载。

**结构**（pi 原生 skill 格式，`.pi/skills/<name>/SKILL.md` + 可选 `scripts/`）：
```
apps/api/src/pi/space/<workspace 内 .pi>/skills/<skill-name>/
  SKILL.md       # frontmatter: name / description
  scripts/       # 可选，助手可用工具执行（若给工具）
```

**加载**：
- `DefaultResourceLoader` 传 `additionalSkillPaths: [<workspaceDir>/.pi/skills]`（pi 已支持该选项，resource-loader.js:262）。
- `assistant_skills` 白名单表（可选）：默认不设 = 全量注入目录 skill（catalog 只占一行描述，开销小）；设了则只注入白名单内 skill 的 catalog。
- **新增 `read_skill` 自定义工具**：入参 `skillName`，返回该 skill 的 SKILL.md 正文 + scripts 清单。补上 pi catalog-inject 缺的「取正文」能力（助手无 builtin read 工具）。权限：仅 workspace 目录内路径，防 `../` 逃逸。

**边界**：S2 的 `read_skill` 与现有自定义工具的提示词边界——`read_skill` 只在系统提示词「工具说明」区追加一行，不列 skill 文件清单以外内容；模型是否真的去读由 catalog 描述驱动（pi 原语义）。

---

## MCP

### 方案：DB 配置 + registerMcpServer 通用通道

**表结构** `assistant_mcp_servers`：

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid pk | |
| name | text unique | 展示名 + catalog 里的 key |
| kind | text | `stdio` / `http`（HTTP/SSE transport） |
| command | text null | kind=stdio 时的可执行文件 |
| args | text[] null | kind=stdio 参数 |
| url | text null | kind=http 的端点 URL（config.sseUrl / config.url） |
| env | jsonb null | 追加环境变量（值用 `env:KEY` 语法引用容器 secrets，见下） |
| exposure | text | `codemode` / `deferred` / `direct` / `hidden`（pi exposures，默认 `codemode`） |
| scope | text | `global` / `project` / `version`——本期只记字段，**实际全部按 global 加载**（/api/assistant 已钉单副本，所有线程都加载全部启用 server）；project/version 过滤留作后续 |
| enabled | bool | |

**加载**（会话创建处，当前 `session.ts:447-469`）：
1. 查启用 servers → 逐个 `pi.registerMcpServer({ name, config })`。
2. `createAgentSession({ extensions: [...现有 extensionFactories, createMcpExtension()] })`。
3. env 值 `env:KEY` → 从 `process.env[KEY]` 取；需要宿主机 secrets 时统一走 `ENCRYPTION_KEY` 一致的注入方式（与现有 settings 加密一致），**明文不落 DB**。

**守卫与失败语义**：
- **禁止 `exposure=oauth`**（pi 支持 OAuth，但 loopback 回调依赖本地浏览器，服务端没有）——配置时拒绝。
- **stdio 二进制缺失**：`warn-not-fail`——记 `assistant_error` 事件 + 日志，跳过该 server，其余工具照常（否则一个坏配置弄垮整个助手，与 2026-10-18 教训一致）。
- kind=http 的 URL 强校验 `http(s)://`，防 `file://` 等本地读取。
- 坏配置不持久破坏：加载期异常全部 try/catch，抛错则该 server 不挂载，不阻断 loaders。

**端点**（管理用，最小 CRUD）：
- `GET /api/assistant/mcp-servers` 列表
- `POST /api/assistant/mcp-servers` 建
- `PATCH /api/assistant/mcp-servers/:id` 改/停用
- `DELETE /api/assistant/mcp-servers/:id` 删

---

## 数据迁移

- 新表 `assistant_guides`、`assistant_mcp_servers`：进 `apps/api/src/db/schema.ts`，由现有 `drizzle-kit push --force` 链路应用（prod 迁移方式不变，见 project_prod_migration_drizzle_push）。
- **seed**：`assistant_guides` 插入 REQ_DESIGN_METHOD / CASE_AUTHORING_FLOW_ZH/EN（scope=global）。seed 放 migrate 入口（`node dist/db/migrate.js` 同款）幂等（ON CONFLICT DO NOTHING），不破坏二次启动。

---

## 多副本与发版

- `/api/assistant` 已钉单副本（nginx sticky upstream，项目已部署），新特性不加任何新容器局部状态：S1/MCP 全 DB 驱动、S2 目录在 workspace（写入方=发版时宿主挂载，本设计不动其生命周期）。
- 新表经 push 自动应用；`docker compose`/deploy.sh 不变。
- 每个新线程的 catalog/扩展在会话创建时**即时**读取（无缓存），DB 改动对**新开线程**热生效；**已开线程不受影响**（会话内系统提示词已固定）——此点为明确语义，非缺陷。

---

## 测试

### S1
- 单测：`buildSpaceSystemPrompt` 注入——建 guides(global/project/version 各一)，断言输出按 scope 优先级 + sort 排序，lang 过滤正确，stop 不注入。
- 迁移幂等：seed 跑两遍，`assistant_guides` 表只有 4 行（REQ_DESIGN_METHOD + CASE_AUTHORING_FLOW × zh/en，全部 kind=flow、scope=global）。

### S2
- `read_skill` 工具测试：spike 建 1 个 `.pi/skills/echo/` skill，工具返回正文；`../` 路径注入返回拒绝。
- catalog 注入断言：loader 的 system prompt 含 skill 的 name/description，不含正文。

### MCP（**必须从头一个 spike 起**——createMcpExtension 在 headless 无自动测试覆盖，2026-10-18 exec worker ESM require 崩溃正是这盲区）
- **spike**：本地起一个 `stdio echo` MCP server（几行 node，读 stdin JSON-RPC 回显 tool 调用），走真实 `registerMcpServer` + `createMcpExtension`，断言会话里工具可被调用。
- 守卫单测：`exposure=oauth` 拒绝、stdio 二进制不存在时 warn-not-fail、http URL 非 http(s) 拒绝。
- 全链路冒烟：起 api + web，经 `/api/assistant` 发消息，带 MCP 的线程工具调用成功（对标 `/tmp/assistant-verify.mjs` 的验证形态，单副本可跑）。

---

## 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| createMcpExtension 在 headless 的表现（无自动测试覆盖，堪比 exec worker ESM require 盲区） | 实现先 spike stdio echo MCP 验证 | 断掉 MCP server 的 DB 行/停用即可，会话回落到纯 pi |
| S2 `read_skill` 与现有工具提示词边界混 | 系统提示词工具区只加一行说明，不展开 skill 正文 | 不加 S2 只上 S1（S2 独立可弃） |
| 坏 MCP 配置弄垮整个助手 | 加载期全 try/catch + warn-not-fail + 加载期失败不持久破坏 | 停用配置行 |
| guides 注入过长撑爆 context | 运营侧负责长度（本期不设上限）；S2 目录知识不进常驻提示词 | 停用相关 guide |
| seed 与既有 push 冲突 | seed 幂等 ON CONFLICT DO NOTHING，migrate 入口跑，不阻塞启动 | 删 seed 块重发 |

## 实施顺序

1. **Spike（先做）**：stdio echo MCP server + registerMcpServer/createMcpExtension 真实链路，验证可行性，落测试。
2. **S1 guides**：schema + seed + 加载 + CRUD 端点 + 测试。
3. **MCP**：schema + 守卫 + registerMcpServer 加载 + CRUD + 测试。
4. **S2 skills**：additionalSkillPaths + `read_skill` 工具 +（可选白名单）+ 测试。
5. 端到端冒烟（单副本，`/api/assistant` 粘性下自然成立）。

各步独立可交付、可单独取舍；S1/S2/MCP 互不阻塞。