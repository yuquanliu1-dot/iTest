# 录制增强二期：录制模式 + 多标签页 + 组件识别 + 密码加密 + 上传回放

日期：2026-09-30
状态：已获批
上游参考：`docs/superpowers/specs/2026-09-30-recorder-phase1-ops-design.md`（已落地）；CueCast 录制功能文档（用户提供的完整功能说明）

## 背景与目标

Phase 1（已合并）补齐了操作类型全集与步骤维护，但 CueCast 文档要求的其它能力尚未落地：录制模式（全新 / 追加 / 从这里开始 / 无痕）、多标签页录制、组件库识别与动态属性过滤、密码加密、上传文件真回放。本设计把这四期一次性补齐，让录制真正成为「沉淀测试资产」的入口。

### 五期路线图（全景）

| 期 | 内容 | 状态 |
|---|---|---|
| P1 | 操作类型全覆盖 + 步骤维护 | ✅ 已合并 |
| **P2（本期）** | 录制模式：全新/追加/从这里开始/无痕；面板辅助完善 | 本期 |
| **P3（本期）** | 多标签页录制与切换步骤 | 本期 |
| **P4（本期）** | 组件识别：AntD/Element/iView Select、Tree；动态属性过滤增强 | 本期 |
| **P5（本期）** | 密码加密存储与解密回放；上传文件上传 + 真回放 | 本期 |

### 本期范围

**做**：

- 录制模式：fresh（全新，覆盖旧步骤）/ append（追加，保留旧步骤）/ resume（从指定 order 继续录制，可选前置步骤回放）/ incognito（无痕录制）。
- 多标签页录制：background 维护 opener 派生的 tab 集合，content 步骤上送附 tabRef；落库与回放都按 tab 顺序展开。
- 组件识别：selector-core 静态嗅探 AntD/Element/iView 的 select / tree / tree-select；语义 locator 优先；命中时给步骤加 `meta.componentKind`（落库到 `test_steps.component_kind`，回放时不强制走 select，仅辅助定位）。
- 动态属性过滤：selector-core 输出 css/xpath 前对运行时 id / 状态 class / 运行时 aria 做清洗；保留稳定业务标识优先。
- 密码加密：`fill` 步骤新增 `sensitive: true`，明文一次写入后加密落库；UI 与报告永远只见掩码；扩展走专用授权接口拿一次性解密值。
- 上传文件真回放：上传步骤从「只记文件名」升级为「绑定 fileId → 后端按 sha256 存文件 → 执行器真传文件给 input[type=file]」。
- 步骤编辑页（StepEditModal）增加密码模式切换与上传文件绑定 UI。
- 录制面板增强：新增模式入口展示、tab 上下文预览、组件识别提示。

**明确不做**：

- iframe 上下文切换（CueCast 文档明示 P3 边界外）。
- 多文件 / 拖拽上传（CueCast 文档明示限制）。
- 跨浏览器（仅 Chrome MV3）。
- 组件识别对非 AntD/Element/iView 控件的智能识别（CueCast 文档未要求）。
- 加密密钥轮换与迁移工具（本期不引入自动化迁移脚本；密钥由部署方一次性提供）。

## DSL 扩展（packages/shared）

P1 已落地的 14 种 action 不变。**新增**：

```ts
// 切换标签页（P3）
SwitchTabAction = { kind: 'switchTab', tabRef: string }
//   tabRef = `${sessionId}|tab#${n}`，录制期背景生成；落库即存
//   executor 按 session 维护的 tabIndex→真实 tabId 映射查找目标 tab

// 上传文件（P5 改造 upload）
UploadAction = { kind: 'upload', locator, fileId: string }
//   fileId = test_attachments.id；不再有可选 fileName（文件名随 attachment 携带）

// 密码敏感输入（P5 fill 升级）
FillAction = { kind: 'fill', locator, value: string | ValueGenerator, sensitive?: true }
//   当 sensitive=true 时，库内对应字段只存 ciphertext/iv/tag；列表与编辑弹窗永不显示明文
```

`StepAction` 增加 `SwitchTabAction`；`UploadAction.fileName` 字段移除，`FillAction.sensitive` 加 optional 字段。

`UploadAction` 的 locator 仍要求 `input[type=file]` 至少一个候选；`FillAction.sensitive` 为 true 时 value 字段在持久化层必走加密。

**核心原则**：

- DSL 永远不存明文密码，UI 永远不见明文；执行期解密值仅由 executor 通过专用授权接口取出。
- DSL 不存浏览器实时 tabId；tabRef 是 case 内稳定的派生 tab 序号。
- componentKind 是元数据，executor 不强制走 select 分支（AntD select 选项点击序列依然能工作，但语义 locator 优先）。

## 后端契约（apps/api）

### 数据库迁移

- `test_steps`：
  - 新增 `tab_ref varchar(64)`（P3 switch tab 步骤；fresh 步骤为 NULL）。
  - 新增 `sensitive boolean not null default false`（P5）。
  - 新增 `component_kind varchar(32)`（P4：`'select' | 'tree' | 'treeSelect' | null`）。
  - 新增 `secret_ciphertext bytea`、`secret_iv bytea`、`secret_tag bytea`（P5，sensitive=true 时填）。
- 新表 `test_attachments`：
  ```sql
  id uuid pk, case_id uuid fk not null, step_id uuid fk null,
  original_name text not null, mime text, size bigint not null,
  sha256 char(64) not null unique, stored_path text not null,
  created_at timestamptz not null default now()
  ```
  `sha256` 唯一：同一文件重复上传直接复用记录，幂等。
- 新表 `test_session_tabs`（P3）：
  ```sql
  session_id uuid pk fk, tabs jsonb not null
  // tabs: [{tabRef:'session:...|tab#n', title, openedAt, closedAt?}]
  ```
- 新表 `test_sessions` 扩展字段：`mode varchar(16) not null default 'fresh'`、`incognito boolean not null default false`、`resume_from_order integer null`。

### 新增 / 改动端点

- `POST /api/cases/:id/attachments`（multipart，单文件）：
  - 计算 sha256；若已存在 → 返回既有 `{ id, sha256, originalName }`（200）。
  - 否则落盘 + 写记录 → 返回新记录。
  - 超过 `UPLOAD_MAX_BYTES`（默认 50MB）→ 413。
- `PUT /api/cases/:id/steps`：
  - upload 步骤必须带 `fileId` 且对应 attachment 存在；否则 422。
  - fill + `sensitive=true` 步骤：接收 `value` 明文一次，落库前加密；落库后从响应移除明文，只回 `{ secret: true }` 标记。
  - 新增步骤的 `tabRef` / `componentKind` 直接落库。
- `GET /api/cases/:id/steps/secrets/:stepId`（扩展专用）：
  - 鉴权用 recorder ws token（与 `recorder/sessions` 一致来源）；非扩展调用 → 403。
  - 返回 `{ value: string }`，一次性使用（不写日志、不进缓存层）。
- `POST /api/recorder/sessions`：
  - body 新增 `mode: 'fresh' | 'append' | 'resume' | 'incognito'`、`resumeFromOrder?: number`、`incognito?: boolean`。
  - resume 模式：服务端校验 `caseId` + 现有 steps，按 order 取前 `resumeFromOrder` 步；若步骤里含 upload 且 fileId 未绑定 → 409 拒绝启动。
  - incognito：要求扩展已允许无痕；服务端只做记录，不直接调用浏览器。
- `POST /api/recorder/sessions/:id/finish`：
  - resume 模式启动后，先用同一 session 内的 ws 连接回放前置步骤（不写新报告，沿用 session 内的状态）；前置回放失败 → 409，前端走「仅录制新增部分」分支。
  - 落库时 `tabRef` 与 `componentKind` 写入对应 step。
- `POST /api/recorder/sessions/:id/tab-events`（P3，扩展上报）：
  - body：`{ events: Array<{ kind:'opened'|'closed', tabRef, title, url }> }`。
  - 写入 `test_session_tabs`，供 executor 回放时构建 tab 上下文。

### 执行器（apps/api/src/execute/cdp.ts）

- 新增 `switchTab` 分支：
  - 由当前 session 维护 `tabIndex → Playwright Page` 的映射；按 `tabRef` 找到对应 Page；调用 `page.bringToFront()`。
  - 找不到对应 Page → 步骤失败，错误信息 `tab-missing: <tabRef>`。
- `upload` 分支（P5）：
  - 通过 fileId 查 `test_attachments`，定位 `stored_path`；用 `setInputFiles` 传文件绝对路径。
  - 找不到附件 → 步骤失败 `attachment-missing: <fileId>`。
- `fill` + `sensitive` 分支：
  - 走与 P1 相同的 `materializeValue`；但执行前向 `GET /steps/secrets/:stepId`（或 executor 内部调用同一模块）取明文；记录一次性取用日志。
  - 取不到明文（步骤未被授权 / 步骤非 sensitive）→ 步骤失败 `secret-missing`。
- 整体步骤结果结构 `ExecStepResult` 增加 `tabIndex` 字段（前端报告可按 tab 分组展示）。

### 加密 / 解密模块（apps/api/src/lib/secret-crypto.ts）

- 算法：AES-256-GCM；key = base64 解码 `ENCRYPTION_KEY`（32 字节）。
- 接口：`encrypt(plaintext: string): { ciphertext, iv, tag }`；`decrypt(cipher: { ciphertext, iv, tag }): string`。
- 错误：key 缺失 → 启动时 fail-fast；解密失败 → throw `DecryptError`（不写明文到日志）。

### 错误处理

| 场景 | 处理 |
|---|---|
| 附件 sha256 已存在 | 200，复用既有 |
| 附件 > 50MB | 413 |
| 上传步骤缺 fileId | 422 + 「请先在步骤编辑页绑定文件」 |
| 密码步骤落库前明文未加密 | API 拒绝（422） |
| 扩展拿密码时 token 无效 | 403 |
| resume 前置回放失败 | 409 + 前端弹「仅录制新增部分」 |
| tabRef 找不到对应 Page | 步骤失败 `tab-missing` |
| 附件找不到 | 步骤失败 `attachment-missing` |

## 录制扩展（apps/recorder）

### Background service worker（apps/recorder/background.js）

- 会话状态机：
  - `mode` 由 `start` 消息携带；ws 协议新增 `mode` / `resumeFromOrder` / `incognito` 字段。
  - resume 模式：`ws.onopen` 后由服务端先驱动前置步骤回放，扩展这边只在「回放完成」后接收业务 step；为简化，resume 启动仍由服务端在 `POST /recorder/sessions` 完成后下发 `{ type: 'begin-capture', resumeFromOrder }` 给 extension。
- tab 路由：
  - 监听 `chrome.tabs.onCreated`：过滤 `openerTabId === recordingTabId` → 加入 `recordingTabs: Set<number>`，分配 `tabIndex = recordingTabs.size`；上报 `tab-events` 给服务端。
  - `chrome.tabs.onRemoved` → 移除 + 上报 `closed`。
- ws 协议：
  - step 信封：`{ type:'step', step:{ action, url, tabRef, componentKind? } }`。
  - 新增 `{ type:'begin-capture', resumeFromOrder }`：resume 模式服务端前置回放完成后通知 extension 进入采集。
  - 新增 `{ type:'switch-tab', tabRef }`：录制期间切到某 tab 用于继续操作（由面板驱动）。
- incognito：`chrome.windows.create({ url: msg.targetUrl, incognito: true })`；扩展需要在 chrome://extensions 允许，否则 `chrome.windows.create` 失败 → 回 400 给 web。

### Content scripts（apps/recorder/content/recorder.js）

- 保留 `ita-web` window message 入口（兼容中台手动触发）；继续由 background 显式 `{ type:'start' }` 启动新 tab。
- 拾取模式扩展：picker.start 回调里若命中组件类容器（ant/element/iview），返回 `{ result, componentHint }`，由 panel 提示「这是组件库下拉/树…」。

### 录制面板（apps/recorder/popup）

- popup 头部新增模式显示（从 `chrome.runtime.getState` → `mode: 'fresh' | 'append' | ...`）。
- panel 新增 tab 上下文预览：每个接管到的 tab 渲染一行 `tab #n: <title>`，点击触发 `{ type:'switch-tab', tabRef }` 切到该 tab。
- AI / 变量 / 断言 / 悬浮现有逻辑保留。

### 模块拆分

- `selector-core.ts`：增加 `detectComponent(el)` 与 `filterUnstableAttrs(cssPath)`；`generateLocators` 内部调用。
- `selector-filter.ts`（新）：动态属性过滤规则（id hash、状态 class、运行时 aria）。
- `component-detector.ts`（新）：AntD / Element / iView 静态嗅探。
- `recorder-manager.ts`：
  - `onChange` 命中 `<select>` 时查父链组件类 → 若命中，步骤带 `componentKind: 'select'`。
  - `onInput` 命中 `type=password` 或 `[name*="password" i]` → 步骤带 `sensitive: true`。
  - `onChange` 命中 `type=file` → emit `upload` 但 `fileId` 留空（占位）；落库前由 web 端绑定。

### 动态属性过滤规则（apps/recorder/modules/selector-filter.ts）

过滤 `css` 路径中：

- id 匹配 `/(?:^|[_-])(?:el|ant|ivu|bv)?[_-]?[a-f0-9]{6,}$/i`、`/__BV_[a-z0-9_]+/i`、纯数字 id。
- class 命中已知状态白名单：`active / selected / disabled / hover / focus / loading / open / show / checked / expanded / collapsed / current`。
- aria 属性：`aria-controls` / `aria-describedby` / `aria-activedescendant` 从 css 路径中清掉（不影响 role 候选）。

兜底：所有过滤都会保留至少一份「最稳定的 raw 路径」作为 fallback。

## Web 中台（apps/web）

### CaseDetail 用例详情

- 录制按钮升级为下拉：全新 / 追加 / 从这里开始 / 无痕。
- 「从这里开始」步骤行操作按钮：弹窗询问"是否先回放前置步骤"（是 / 否），确认 → 调 `POST /api/recorder/sessions` 传 `mode:'resume', resumeFromOrder: <order+1>`。
- 「无痕模式」勾选位于 case 编辑表单：用例开启后所有录制入口默认 incognito=true（也可在录制时临时覆盖）。
- 步骤行展示：`tabRef` 显示为「tab #n」；`componentKind` 显示为组件库标签。

### StepEditModal（apps/web/src/components/StepEditModal.tsx）

- fill步骤新增「敏感值」开关：
  - 开启后输入框变为 type=password；保存时明文一次性写入 → API 加密落库；UI 状态变成「已加密 · 需修改请重新输入」。
- upload 步骤新增「选择文件」按钮：
  - 调 `POST /api/cases/:id/attachments`；返回后写入 `fileId`。
  - 支持「查看已上传文件」侧栏：列出当前 case 所有 attachment（按 sha256）。

### ReportDetail

- 步骤展示按 `tabIndex` 分组（「主 tab」、「tab #1」、「tab #2」…）。
- 密码步骤显示 `密码 · 已加密`（不显示掩码长度）。
- 上传步骤显示附件名与 sha256 前 8 位。

### 错误处理

- 上传 > 50MB：前端预拦截 + 后端 413 双层保护。
- 上传步骤缺 fileId 保存：API 422 → 前端 toast。
- resume 前置回放失败：409 → 弹窗「前置步骤失败，是否仅录制新增部分」二次确认（仅新增模式 = append）。

### 录制面板（apps/web/src/pages/CaseDetail.tsx 的「录制辅助」区）

- 显示当前会话状态（mode / tab 列表 / paused）— 由新 WS 子协议 `state-broadcast` 推送。

## 测试

### 单元测试

| 层级 | 必测 |
|---|---|
| shared | `SwitchTabAction` / `UploadAction` / `FillAction.sensitive` schema；key encrypt/decrypt roundtrip；deepEqual 已有 |
| api | encrypt / decrypt 模块；attachment 幂等（同 sha256 二次上传）；敏感字段落库后不返回明文；resume 409 路径；tab-events 落库 |
| recorder | 组件类嗅探（antd/element/iview 各一 + 负例）；动态属性过滤（id hash / 状态 class / 运行时 aria）；密码 input 标记 sensitive；upload 不上送 fileId；ws 信封模式分支；多 tab 上送 tabRef 拼接；resume 同步起点正确 |
| web | StepEditModal 敏感值切换（playwright）；上传绑定交互；录制模式按钮显示条件 |

### 手动 E2E

1. 起全栈 `pnpm dev`，重新加载扩展。
2. 全新录制一条含 checkbox + select + tree 的页面（用 AntD / Element 官方 demo 页面）。
3. 中途触发新 tab（`window.open`），在新 tab 操作后切回；停止录制 → 步骤里出现 `switchTab`。
4. 从这里开始：在已有用例的第 3 步后选「从这里开始」→ 选「是」回放前置 → 弹窗显示「前置步骤回放完成」 → 继续操作 → 仅第 3 步后出现新步骤。
5. 无痕录制：勾选用例的「无痕模式」→ 发起录制 → 浏览器新开无痕窗口。
6. 密码步骤：录一个 password 输入框 → StepEditModal 显示「敏感值」开关 → 保存 → DB 仅存密文 → 报告步骤显示「密码 · 已加密」→ 报告执行步骤成功（解密回放）。
7. 上传步骤：录一个 file input → StepEditModal 选文件上传 → 后端 sha256 落盘 → 报告执行步骤成功，screenshot 正常。

### 已知边界（README 同步）

- iframe 容器与代码切换暂未支持（CueCast 文档明示 P3 边界外）。
- 多文件 / 拖拽上传不支持（CueCast 文档明示限制）。
- 组件识别仅覆盖 AntD / Element / iView 三家；其他库走通用回放。
- 加密密钥不自动轮换；密钥丢失意味着密码不可恢复（需手动重新录入）。
- tabRef 是 case 内稳定序号；录制端真实 tabId 不入库。

## 配置

- `ENCRYPTION_KEY`：base64 32 字节，必填（启动时 fail-fast 校验）。
- `UPLOAD_DIR`：默认 `.data/uploads`，可指向持久化存储。
- `UPLOAD_MAX_BYTES`：默认 52428800（50MB）。