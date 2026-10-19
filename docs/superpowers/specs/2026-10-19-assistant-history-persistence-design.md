# AI 助手历史会话持久化 + 列表按时间分组 — 设计

日期：2026-10-19
范围：`apps/api`（pi space 会话层）、`apps/web`（助手线程列表）

## 背景与问题

助手的线程元数据存在 Postgres `ai_threads` 表，但**消息内容全部在内存**：

- `apps/api/src/pi/space/session.ts:569` 用 `SessionManager.inMemory()` 建会话，pi 的 JSONL 文件持久化被完全关闭。
- 进程重启后所有对话内容消失。
- `GET /threads`（`router.ts:94`）过滤 `messageCount>0`，而 `messageCount` 取自内存快照（`snapshotOf`），重启后全为 0 → **历史列表整片变空**。

用户诉求：历史会话持久化、列表按时间分类（参考 DeepSeek 的分段模式）。

已确认口径：消息也要持久化；重启后可继续对话；五段式分桶（今天 / 昨天 / 7 天内 / 30 天内 / 更早，按 `updatedAt` 的本地日期）。

## 方案选型

| 方案 | 做法 | 结论 |
|---|---|---|
| **A. 复用 pi 文件持久化** | `SessionManager.inMemory()` → `create(cwd, sessionDir)`，按 `aiThreads.piThreadId` open/create | **采纳** |
| B. 自建 Postgres 消息表 | 消息逐条入库，自实现 transcript↔消息双向序列化 | 否决：重复 pi 序列化逻辑，pi 升级时持续追改 |
| C. A + DB 冗余消息行 | 文件为主、DB 存摘要，双写 | 否决：双写一致性成本，当前规模（limit 20）撑不起 |

选 A 的依据：pi 的 `SessionManager` 自带 JSONL 追加式树持久化（`create` / `open` / `setSessionFile`）；`session.ts:588` 已经把 `session.sessionFile` 写进 `aiThreads.piThreadId`——重载句柄现成。改动集中在构造点，不新增表。

## 设计

### 1. 持久化路径与恢复流程

**落盘位置**：`SessionManager.create(workspaceDir, SESSIONS_ROOT)`，
`SESSIONS_ROOT = path.join(DATA_DIR, 'pi-sessions')`。
`DATA_DIR = process.env.PI_DATA_DIR ?? path.resolve(process.cwd(), '.data')`，定义在 `apps/api/src/pi/repo.ts:14`（当前 `DATA_DIR` 未导出，需加 export）。该目录落共享卷，prod228 三副本可见。

pi 行为确认（`session-manager.js`）：
- 构造时 `mkdirSync(sessionDir, { recursive: true })`，无需预建。
- 文件**仅在首条 user/assistant 消息落盘时创建**（`_hasConversation()` + `flushed` 标志，见 `session-manager.js:791-812`）。未发过消息的线程不产垃圾文件。

**恢复流程**（`buildSpaceRecord`，`session.ts:131`）按 `aiThreads.piThreadId` 分叉：

```
piThreadId 为空 或 文件不在  →  SessionManager.create(workspaceDir, SESSIONS_ROOT)
piThreadId 有值 且 文件存在   →  SessionManager.open(piThreadId, SESSIONS_ROOT, workspaceDir)
```

`open` 读 JSONL、重建消息树，`createAgentSession` 拿到的 session 直接带历史消息——`snapshotOf` 读 `rec.session.messages` 即可，续聊与快照回填无需额外代码。恢复后 `session.sessionFile` 与库中一致，`session.ts:588` 的回写成为幂等 no-op。

**旧线程兼容**：`piThreadId` 为空串的 inMemory 老线程走新建分支，显示为无消息线程，可正常删除，不报错。

**草稿线程的路径分配**：`piThreadId` 非空**不等于**有历史消息——见 2 节的判据说明。恢复分支的「文件不在 → create」正是靠文件存在性分流，故草稿线程被再次打开时得到的是一个新的空会话（其 `sessionFile` 路径被复用为同一条记录的下一条文件路径），行为正确。

**多副本前提**：nginx `infra/docker/web.nginx.conf:1-14` 已用 `upstream assistant_api { ip_hash; }` + `proxy_next_upstream off` 把 `/api/assistant` 粘到固定副本；`.data` 卷跨副本共享。跨副本 `open` 同一文件只读加载安全。并发写风险（两副本同时 open 同一文件各自 append）由粘性路由规避，**不加文件锁**。

### 2. 列表接口调整

**过滤口径**：`GET /threads`（`router.ts:94`）的过滤从
`(snapshotOfThread(row.id)?.metadata.messageCount ?? 0) > 0`
换成 **`sessionFile 存在性判定`**——`row.piThreadId !== '' && fs.existsSync(row.piThreadId)`。

**判据必须是文件存在性，不能是 `piThreadId !== ''`**（易错点）：
pi 的 `newSession()` 在 `persist=true` 时**立即**给 `sessionFile` 赋路径（`session-manager.js:713`），只有**文件落盘**才是延迟的（`_persist` 的 `_hasConversation()` 门）。因此改用 `create()` 后，`session.ts:588` 会给**从未发过消息的草稿线程**也写进非空 `piThreadId`——`piThreadId !== ''` 会把草稿全放进历史列表，正是原过滤想避免的。

文件存在性是精确判据：发过消息 → 首条 user/assistant 落盘 → 文件存在；没发过 → 路径已分配但磁盘无文件 → 不进列表。inMemory 老线程 `piThreadId` 为空串，自然被排除。

判据需在过滤前 `Promise.all` 批量 `fs.access` 收集，避免逐行串行 IO（≤20 行，影响可忽略，但写成批量更干净）。

排序（`updatedAt desc`）与 limit 20 **不动**。响应字段不新增 `messageCount`——前端分组用 `updatedAt`，保持最小改动。

**`updatedAt` 刷新**（分桶正确性的必要条件）：当前 `updatedAt` 只在建 session（`:588`）和首条消息落标题（`:330`）时更新，纯追加消息不更新。若不刷新，分桶会按建会话时间而非最后活跃时间，与 DeepSeek 语义不符。
在 `sendSpaceUserMessage` 成功 `rec.session.prompt(...)` 之后补一次 `updatedAt` 更新。

### 3. 前端分组渲染

**库层约束**：`ThreadListPrimitive.Items` 内部是 `threadIds.map(...)` 死平铺（`@assistant-ui/core/dist/react/primitives/threadList/ThreadListItems.js:39`），不接受分组结构、无法插入组标题。DeepSeek 式分段不能靠 Items 的用法实现。

**选定路线**：`ThreadListPrimitive.ItemByIndex` 接受 `{ index, components: { ThreadListItem } }`，在其组件内自行排版——按分组顺序渲染「组标题 + 组内行」。保留 primitives 全部能力（`switchTo` / `rename` / `delete` / `isRunning` 仍在 item scope 内），仅重排顺序。

不采用"完全绕开 primitives"（`useAui().threads.switchToThread` + `threadItems`）：那要把 rename / delete / isRunning 全部手写重做。

**时间数据通道**（关键约束，已否决 `custom` 方案）：
`ThreadListItemState` 有 `lastMessageAt?: Date` 字段，但 react-pi 的 `mapThreadMetadata`（`@assistant-ui/react-pi/dist/runtime/usePiRuntime.js:292-303`）只白名单透传 `status` / `remoteId` / `externalId` / `title` / `custom`，把 `createdAt` / `updatedAt` 整个丢弃 → store 里 `lastMessageAt` 恒为 undefined。react-pi 在 node_modules，不可改。

**`custom` 通道不可用**：`mapThreadMetadata` 并非透传 `metadata.custom`，而是**从零重建**该对象：

```js
custom: {
  status: metadata.status,
  ...metadata.workspacePath !== void 0 ? { workspacePath: metadata.workspacePath } : {},
  ...metadata.sessionFile !== void 0 ? { sessionFile: metadata.sessionFile } : {},
  ...metadata.parentSessionPath !== void 0 ? { parentSessionPath: metadata.parentSessionPath } : {}
}
```

后端在响应里塞的任何 `custom` 字段都会被无声丢弃。唯一被白名单放行的自由字符串是 `sessionFile`，但 pi 的文件名规则是 `${timestamp}_${sessionId}.jsonl`（timestamp 为 ISO 串），解析文件名来分组既脆弱又是「文件创建时间」而非「最后活跃时间」——否决。

**选定方案：前端自持时间表**。
`GET /threads` 响应**已经**返回 `updatedAt`（`router.ts:100`），后端无需为分组新增任何字段。前端在列表挂载时直接调一次 `GET /threads?workspacePath=<versionId>`（走既有 `request()` 鉴权封装），建 `Map<threadId, updatedAt>`，渲染时按 `item.remoteId`（即我们的线程 id）join 取时间。

刷新时机：列表挂载、**一轮对话结束（settle）后**、改名后、删除后。
「一轮对话结束」是必须的——发消息会让服务端 `updatedAt` 前进，但前端时间表是挂载时拉的快照，不刷新则刚聊过的线程会停留在旧桶里。复用现有 settle 回调时机（与既有的 reload 刷标题同一处），不新增轮询。

代价：多一次列表请求（≤20 项，DB 单表查询，可忽略）。收益：不依赖任何库内部行为，react-pi 升级也不受影响。

**五段分桶**（已确认口径）：按 `updatedAt` 的**本地日期**与「今天」的自然日差值 `d` 分桶，桶内 `updatedAt` 降序，桶间顺序如下（边界已消歧）：

| 段 | 条件 |
|---|---|
| 今天 | `d = 0` |
| 昨天 | `d = 1` |
| 7 天内 | `2 ≤ d ≤ 7` |
| 30 天内 | `8 ≤ d ≤ 30` |
| 更早 | `d > 30` 或 `updatedAt` 缺失 |

`d` 按本地日历日计算（不按 24 小时滚动），与 DeepSeek 的「昨天」语义一致。

**新建按钮**：`ThreadListPrimitive.New` 留在顶部不动；草稿态高亮逻辑不变（`activeRemoteId === undefined`）。

### 4. 错误处理与边界

| 情形 | 处理 |
|---|---|
| session 文件损坏（非空但解析不出合法 session，`open` throw） | try/catch 降级为新建空 session + `logger.warn` 记路径。不阻断列表接口 |
| `piThreadId` 有值但文件不存在 | 同上降级新建。内容已不可恢复（无处副本），仅 warn 日志，**不加 UI 提示** |
| 磁盘写满 / 权限 | pi 的 `_persist` 是同步 `appendFileSync`，异常冒泡到发消息路径，由既有 `sendSpaceUserMessage` 错误链路推 `assistant_error` 事件。**无需新增处理** |
| 旧 inMemory 线程迁移 | **不做**。内容已随进程消失，无任何副本，只能当空线程 |
| 同进程并发 open 同一线程 | `ensureSpaceRecord` 的 `inflight` Map 已保证共享同一次 build，不重复 open |
| 跨副本并发 open | 由 nginx `ip_hash` 粘性规避，不加锁 |
| `updatedAt` 为 null 的脏数据行 | 分桶时归入「更早」，不报错 |

**DELETE 清理**（`router.ts:123`）：事务删完六张 `ai_stage_*` 与 `aiThreads` 行、`dropSpaceRecord` 之后，补 `fs.unlink(sessionFile)`；文件不存在则静默忽略。
文件删除必须在**事务外**——删除失败不应让 DB 回滚成"线程还在但文件没了"。

### 5. 测试与验收

**api 测试**（`apps/api/test/space-router.test.ts`）

现有测试用 `setSpaceSessionFactory` 注入假 factory，不走真 pi。持久化逻辑需真 factory 覆盖：

- **重启恢复**（核心验收）：真 factory 建线程发一条消息 → 断言 `aiThreads.piThreadId` 非空且文件存在于 `SESSIONS_ROOT` → `resetSpaceSessions()` 清内存模拟重启 → 重新 `ensureSpaceRecord` → 断言快照消息数恢复。
- **损坏文件降级**：往 sessionFile 写一行非 JSON → 断言 `ensureSpaceRecord` 不抛，快照为空。
- **`piThreadId` 空串走新建**：用假 factory + 直接改库的 `piThreadId`，断言 open 分支未触达。
- **DELETE 清文件**：建带消息线程 → DELETE → 断言文件不存在、`aiThreads` 行已删。
- **列表过滤口径**：断言草稿线程（`piThreadId` 非空但文件不存在）**不**进列表、`piThreadId` 为空的**不**进列表、真有文件的**进**列表。用假 factory + 直接改库 `piThreadId` 与建临时文件即可，无需真 pi。
- **`updatedAt` 刷新**：发消息后断言 `updatedAt` 前进（容忍同毫秒相等，用 `>=` 或先 sleep）。

**web 测试**

分桶逻辑抽成纯函数 `bucketOf(date, now): string` 单独测：今天 / 昨天 / 跨周 / 跨月 / 跨年边界各一例。渲染本身手工验证（现有 web 测试体系无助手列表组件先例）。

**手工验收（dev 环境）**
1. 助手聊两句 → 重启 api dev server → 左侧列表仍在 → 点进去历史消息完整、能接着聊
2. 列表出现五段标题，新对话在最新段
3. 改名后该线程移到「今天」段
4. 删除线程 → 列表消失、`SESSIONS_ROOT` 下文件被清
5. 造几条不同 `updatedAt` 的线程，确认分桶顺序正确
6. **回归点**：只点「新对话」但不发消息就退出 → 该草稿线程**不**出现在历史列表（这是原 `messageCount>0` 过滤的意图，改判据后必须仍然成立）

**不测**：跨副本 open（粘性路由已是既有前提，单测无法模拟）、磁盘写满。

## 改动清单

**api**
- `apps/api/src/pi/repo.ts` — 导出 `DATA_DIR`
- `apps/api/src/pi/space/session.ts` — 新增 `SESSIONS_ROOT`；`session.ts:569` `inMemory()` → `create/open`；`buildSpaceRecord` 恢复分叉 + 损坏降级；`sendSpaceUserMessage` 成功后刷 `updatedAt`
- `apps/api/src/pi/space/router.ts` — `GET /threads` 过滤改文件存在性判据（不加时间字段）；DELETE 事务外 unlink
- `apps/api/test/space-router.test.ts` — 上列 6 条用例

**web**
- `SpaceThreadList.tsx` — `ItemByIndex` 分组渲染 + 段标题 + 自持 `updatedAt` 时间表（`GET /threads` 拉取）
- 新增纯函数 `bucketOf`（建议置于 space-assistant 目录）
- `i18n/locales/{zh-CN,en-US}/assistant.json` — 5 个段标题键

## 实现注意事项

- 工作区存在另一条「对话建议」工作流的未提交改动，与本需求在 `router.ts` / `session.ts` / `assistant.json` 有交叉。实现时须只暂存本需求改动的行/文件。
- `packages/shared` 编译产物坑：不涉及本需求（无 schema 改动）。
