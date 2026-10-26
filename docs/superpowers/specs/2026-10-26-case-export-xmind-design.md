# 用例导出 XMind 设计文档

日期：2026-10-26
状态：已获用户批准（三轮分节确认）

## 1. 背景与目标

测试团队需要把平台内的用例导出为 XMind 思维导图，用于交付/评审/汇总。参考格式为用户提供的一份真实交付文件（SOC1.23版本zhangjun.xmind），其树形结构为「版本 → 模块 → 用例 → 预置条件/测试步骤/预期结果」。

两个入口：

1. **用例列表页**（GroupsPage）：勾选若干用例导出；无勾选时导出当前筛选结果的全量用例。
2. **AI 助手**：用户一句话要求导出，AI 触发同款导出，前端弹出下载卡。

非目标：不支持从 xmind 导入；不改变用例数据模型；不做 xls/csv 等其他格式。

## 2. 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 树形层级 | 版本 → 分组 → 用例 → 三要素；跨版本时在 root 与分组之间插入版本层 |
| 测试步骤文本 | 每步一个子节点 `N. instruction`；instruction 为空回退渲染 DSL 摘要（stepSummary 同款） |
| 预期结果文本 | 用例级 `expectedOutcome` 优先（拆行编号）；空则逐条列行级断言；都空省略该节点 |
| 导出范围 | 前端始终传显式 caseIds（勾选优先，否则当前筛选结果的全量 id） |
| AI 导出语义 | AI 触发同款导出服务，经 SSE `artifact` 事件推送下载卡 |
| XMind 兼容 | 双格式：zip 内同时含 content.json（2020+/ZEN）与 content.xml（XMind 8） |
| 用例标题前缀 | 不复刻参考文件的「（用例标题）」前缀，title 原文直出 |

## 3. 架构：服务端统一生成，两入口共用

```
apps/api/src/services/xmindExport.service.ts   ← 新增，核心
├─ resolveExportCases(caseIds)     校验可见性 + 批量拉用例/步骤（inArray 两段查询）
├─ buildXmindTree(cases, meta)     树构建（纯函数）
├─ renderXmindWorkbook(tree)       双序列化（纯函数）
├─ zipXmind(parts) → Buffer        archiver 打包（依赖已有）
└─ buildCaseXmindBuffer({caseIds, rootTitle}) → {buffer, filename}
```

单一事实来源：列表页直下二进制，AI 路径生成同一 buffer，两入口格式零偏差；步骤内容不经过 LLM 之手，零幻觉。

### 3.1 树构建规则

```
root: rootTitle（列表页=版本名；AI 可自定；缺省=版本名）
└─ [版本节点]（仅当用例跨多个版本时出现）
   └─ 分组名（同分组用例合并；分组按名称排序）
      └─ 用例标题（按 createdAt 排序）
         ├─ 预置条件
         │  └─ description 原文（空则省略本节点）
         ├─ 测试步骤
         │  ├─ "1. <instruction>"          ← instruction 非空
         │  └─ "2. <DSL 摘要>"             ← instruction 空，按 compiled 渲染
         │                                     （多动作链「a → b → c」，同 stepSummary）
         └─ 预期结果
            └─ "1. …" 拆行编号             ← expectedOutcome 非空按行拆
            └─ 或行级断言逐条编号          ← expectedOutcome 空时兜底；
                                               格式同 stepSummary 的 assertText 摘要
                                               （如「断言文本 等于「成功」」，取 testSteps.assertion）
```

- 无步骤/三要素全空的用例：用例节点照出，缺失的要素节点省略。
- 未编译步骤照导（文档性质，不是可执行产物）。
- 敏感值（fill sensitive）渲染为 `***`，与 stepSummary 的 valueText 对齐。

### 3.2 xmind 文件格式（zip 四件，不含缩略图）

| 文件 | 内容 |
|---|---|
| `content.json` | XMind ZEN/2020+ 格式。单 sheet；root `structureClass: org.xmind.ui.logic.right`（与参考文件一致）；topic 形状 `{id, class:"topic", title, children:{attached:[…]}}` |
| `content.xml` | XMind 8 旧格式同内容：`<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" version="2.0">` → `<sheet>` → `<topic>` → `<title>` + `<children><topics type="attached">`。标题 XML 转义，换行原样保留 |
| `metadata.json` | `{"dataStructureVersion":"2","layoutEngineVersion":"3","creator":{"name":"iTest","version":"1.0"}}` |
| `manifest.json` | `{"file-entries":{"content.json":{},"content.xml":{},"metadata.json":{}}}` |

- topic id 用 `randomUUID()`。
- 文件名：`<版本名>-用例-YYYYMMDD-HHmmss.xmind`；HTTP 头用 RFC 5987 `filename*=UTF-8''…` 编码中文。

## 4. 入口一：用例列表页

### 4.1 后端

`POST /api/cases/export-xmind`（`routes/cases.ts`）：

```jsonc
// body
{ "caseIds": ["uuid", …], "rootTitle": "可选" }
```

- 可见性：越权/已删除的 caseId 静默过滤；过滤后为空 → 404。
- 响应：`application/zip` + `Content-Disposition: attachment`（参考 recorder.ts extension.zip 先例）。
- 路由注册放在 `GET /:id` 等动态段之前（与 `/solidify-batches` 同款注释警告）。

### 4.2 前端

- `api.cases.exportXmind(caseIds, rootTitle?)` → fetch → blob → `<a download>`（复用 `downloadExtensionZip` 先例）。
- `GroupsPage.tsx` 的 `selection.actions` 增加「导出 XMind」按钮（与批量复制/加入计划并列）：
  - 点击：`selection.count > 0 ? selection.ids : rows.map(r => r.id)`；
  - `rows` 为空时 disabled；
  - 导出中 loading 态。

status/tag/关键词是前端本地筛，传显式 id 集合即天然继承筛选口径，后端无需复刻。

## 5. 入口二：AI 助手 + artifact 文件通道

### 5.1 新工具 `export_cases_xmind`

`pi/space/tools/exportCasesXmind.ts`（新文件，注册进 `buildSpaceTools`）：

- 参数：`{ caseIds?: uuid[], groupId?: uuid, keyword?: string(≤200), title?: string(≤200) }`（至少一种范围）。
- 解析：在 `ctx.versionId` 作用域内解析用例集合（复用 `searchCasesInVersion`；caseIds 显式给定时校验归属当前版本）。0 匹配 → 返回 error 文本让 AI 向用户解释，不产文件。
- 执行：`buildCaseXmindBuffer` → 写 `.data/exports/<token>.xmind` → 内存登记 token（30 分钟 TTL）→ `ctx.emit({ type:'artifact', token, name, size })` → 返回「已生成 xxx.xmind（N 条用例），下载卡已推送」。
- promptGuidelines：说明适用场景（用户要交付文档/评审材料时主动使用）与范围参数语义。

### 5.2 artifact 下载通道（通用能力，可复用）

- 下载路由：`GET /api/assistant/threads/:id/artifacts/:token`（`pi/space/router.ts`）。
  - 鉴权：`assertSpaceThreadVisible`（线程可见即可下载该线程产物）。
  - 过期 → 410；不存在 → 404。
  - 流式返回 + `Content-Disposition: attachment`（RFC 5987）。
- token 登记：内存 `Map<token, {path, name, expiresAt}>`；每次登记时惰性清扫过期项。进程重启后内存清空，孤儿文件由下次登记时的磁盘 mtime 扫描清理（`mkdir recursive` 创建目录）。

### 5.3 前端

- `spaceEventsStore`：新增 `artifactsByThread: Map<threadId, ArtifactItem[]>`；`ingest` 增加 `artifact` 分支——自动享受既有 seq 去重与断线重放（60 分钟内重连不丢下载卡）。
- `SpaceThreadPane`：渲染下载卡（文件名 + 大小 + 下载按钮），与 verify/solidify 进度卡同区；点击走 `api.assistant.downloadArtifact(threadId, token)` blob 下载。

这条 SSE `artifact` 通道建成后续任何「AI 产出文件」需求可直接复用。

## 6. 边界与错误处理

| 场景 | 行为 |
|---|---|
| 列表页 rows 为空 | 按钮 disabled，不发请求 |
| caseIds 含越权/已删用例 | 静默过滤，只导可见的；全不可见 → 404 |
| AI 工具 0 匹配 | 工具 error 文本，AI 解释，不产文件 |
| 用例无步骤/要素缺失 | 用例节点照出，缺失要素节点省略 |
| 标题含 XML 特殊字符/换行 | XML 转义；换行保留 |
| 中文文件名 | RFC 5987 `filename*` |
| token 过期 / 线程不可见 | 410 / 404 |
| `.data/exports` 不存在 | `mkdir recursive` |
| 数百用例量级 | 纯文本树内存构建 + archiver 内存打包，量级无忧 |

## 7. 测试

- **单测**（`xmindExport.service.test.ts`）：
  - 树构建：分组排序、跨版本插层、空字段省略、instruction 回退 DSL、断言兜底、敏感值掩码；
  - 双序列化：content.json 可解析且结构与参考一致、content.xml well-formed 且转义正确；
  - zip：可解包、entries 齐全。
- **API 测试**：200 + Content-Type/Disposition 正确；越权 404；空集 404。
- **真机验证**：导出文件用 XMind（新/旧版本各一）打开核对层级与内容；AI 对话「导出当前版本所有用例」→ 下载卡出现 → 下载打开正常。
