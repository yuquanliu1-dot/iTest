# AI 助手 Word 上传 + docx-to-cases skill 设计

日期：2026-10-29
状态：已与用户逐节确认（四节全部通过）

## 背景与目标

AI 助手（空间工作台对话线程）目前只接受图片附件，Word 文件在发送链路中被静默丢弃。本设计交付两个能力：

1. **Word 上传能力（通用）**：聊天可上传 .docx，提取文本供助手直接阅读，原件落盘供 skill 脚本使用
2. **`docx-to-cases` skill**：参考用户级 generate-test-cases skill，从上传的 Word 需求文档生成测试用例，**写入平台用例库**（非渲染文档交付）

## 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 用例最终形态 | 平台内测试用例（stage_case → StagePanel 确认 → 落库） |
| 上传定位 | 线程级附件（非空间级文件库） |
| 消费方式 | 双路：提取文本注入对话 + 原件落盘给路径 |
| 文件格式 | 仅 .docx（不做 .doc） |
| 传输方案 | 方案 1：内联 base64 复用现有附件管线 |

## 第 1 节：上传链路（端到端）

```
浏览器                                API (apps/api)
──────                                ─────────────
Composer 选文件(.docx)
  └ SpaceAttachmentAdapter(组合式)
    ├ image/* → 原 SimpleImage 逻辑
    └ docx    → 读成 dataURL 包成 image part
        (mime 保留在 dataURL 前缀)
发送 → POST /threads/:id/messages
       input.attachments 项:
       {type:"image", mimeType:"…wordprocessingml.document", data:base64}
                                      └ parsePromptAttachments(mime 分流)
                                        ├ image/* → 原 parsePromptImages 路径
                                        └ docx → 校验(base64/PK魔数/≤10MB/≤2个)
                                          → sha256 落盘 .data/uploads/threads/<tid>/
                                          → mammoth 提取纯文本 → sidecar .txt
                                          → 表 ai_thread_attachments 记一行
                                          → content 末尾注入 <uploaded-file> 块
                                      → sendSpaceUserMessage(content', images)
```

### 关键实现点

- **前端 adapter**（`apps/web/src/features/space-assistant/SpaceWorkspace.tsx:110`）：单一 `SimpleImageAttachmentAdapter` 换成组合式 `SpaceAttachmentAdapter`——按 `file.type`/扩展名分派：image/* 走原逻辑；docx mime（`application/vnd.openxmlformats-officedocument.wordprocessingml.document`）或 `.docx` 扩展名 → 读成 dataURL 包成 image part。composer 接受范围变为 `image/*` + `.docx`
- **react-pi 零改动**：`toImageContent`（node_modules/@assistant-ui/react-pi/dist/runtime/ThreadController.js:66-80）解析 dataURL 时原样保留 mime，docx 以 `{type:"image", mimeType:<docx mime>, data}` 进入 `input.attachments`，后端按 mime 分流兜住
- **后端分流**（`apps/api/src/pi/space/router.ts`）：`parsePromptImages`（L274-288）改造/旁路为 `parsePromptAttachments`——image/* 项原样进 images；docx 项做 base64 合法性、PK 魔数（`PK\x03\x04`）、≤10MB、≤2 个/条校验。docx 处理（落盘/提取/注入）在异步 dispatch 段完成后再调 `sendSpaceUserMessage`
- **docx 绝不进 `prompt.images`**：只把 image/* 传给 LLM，docx 走文本注入（避免网关剥图/图片尺寸校验类故障）
- **body limit**：`ASSISTANT_JSON_BODY_LIMIT`（router.ts:291）按最坏 4 图（21.3MB）+ 2 docx（26.7MB）重算为 ~52mb
- **用户气泡渲染**（`SpaceThreadPane.tsx` UserMessage）：注入块拼在用户消息文本里、会随会话回放——渲染器识别 `<uploaded-file …>…</uploaded-file>` 块并折叠为 chip（文件名+大小），正文只显示用户原话；`UserImagePart` 对 dataURL 为 docx mime 的 part 渲染为文件 chip 而非 `<img>`
- **被拒附件不静默**：docx 被拒（超限/坏魔数/超出数量）时在 content 注入一行「附件 xxx.docx 未被接受（原因）」；非法图片项维持原静默丢弃哲学

## 第 2 节：存储、注入格式与新工具

### 存储

- 目录：`.data/uploads/threads/<threadId>/<sha256>.docx`（原件）+ `<sha256>.txt`（mammoth 提取文本，上传时算好缓存）
- 新表 `ai_thread_attachments`（drizzle schema，随 api 容器启动 `drizzle-kit push` 自动应用）：

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| thread_id | uuid | 关联 ai_threads，级联删 |
| name | text | 用户原始文件名（展示用） |
| mime | text | docx mime |
| size_bytes | integer | 原件大小 |
| sha256 | text | 去重键，**unique(thread_id, sha256)** |
| storage_path | text | 原件绝对路径 |
| extracted_path | text | 提取文本绝对路径 |
| created_at | timestamp | |

- 线程删除（router.ts:225-231 现有逻辑旁）：顺带删 `uploads/threads/<tid>/` 目录与表行，失败 warn 不阻塞（与 session 文件删除同哲学）

### 注入格式

拼在用户消息文字末尾，随 pi 会话记录持久化（跨副本/冷线程回放一致）：

```
<uploaded-file name="需求规格说明书.docx" path="/…/.data/uploads/threads/<tid>/<sha>.docx" chars="48213" truncated="no">
（前 2000 字符预览…）
</uploaded-file>
```

- 预览截断 2000 字符：气泡渲染会折叠，目的只是让助手第一眼知道文档存在与大致内容；全文按需获取
- mammoth 提取失败（文件损坏）：块内标注 `extracted="failed"`，path 仍有效——skill 的 python 解析器可自行兜底解包
- 新增 mammoth 依赖（apps/api，纯 JS 无原生编译）

### 新工具 `read_thread_attachment`

- 参数：`path`（注入块里的 path）。执行时 realpath 后强制约束在**当前线程**的 uploads 目录内 + 表里必须有该线程的记录（双重校验，防跨线程读）
- 返回：sidecar 全文（上限 ~80k 字符，超出标 truncated）
- 用途：一般问答（总结/追问文档内容）；skill 深度解析不走它——表格结构只有原件里有，skill 脚本直接读原件

## 第 3 节：新 skill `docx-to-cases`

### 目录结构

落在 `apps/api/scripts/docx-to-cases-content/`，仿 word-test-report 的 seed 模式（deploy.sh 缺失才铺）：

```
docx-to-cases/
├── SKILL.md                      # 流程主文档
├── scripts/
│   └── parse_docx.py             # 纯 stdlib 解析器（zipfile + xml.etree）
└── references/
    ├── design-principles.md      # 从 generate-test-cases 移植精简（场景占比/设计原则）
    └── case-mapping.md           # 需求字段 → stage_case 字段映射 + iTest 用例形状规范
```

### parse_docx.py：零第三方依赖

不用 python-docx（生产容器可用性不确定），stdlib 解包 `word/document.xml`：段落按样式分级（Heading1/2/3 → 层级树）、表格 → 二维数组。输出紧凑 JSON 到 stdout；超 90KB 时写 `.out/parse_<sha8>.json` 并打印路径（绕开 run_skill_script 的 100KB 输出上限，assistant 再 read_skill 读回；实施时需验证 read_skill 的文件树不排除 `.out/`，若排除则改为脚本分段打印）。zip bomb 防护：解压总展开量上限 + 条目数上限。调用方式：`run_skill_script(skillName="docx-to-cases", script="scripts/parse_docx.py", args=["<path>"])`。

### SKILL.md 流程（generate-test-cases 8 步移植为 7 步）

| 步骤 | 内容 | 取舍 |
|---|---|---|
| 1 定位输入 | 从消息 `<uploaded-file>` 块取 path；没有则请用户先上传 | 新增（替代「Glob 找需求文档」为确定性路径） |
| 2 结构化解析 | parse_docx.py → sections/tables JSON | 替代原 .md 扫描 |
| 3 需求提取确认 | 从编号段落/表格行识别需求条目（编号/模块/优先级/验收标准），列清单请用户确认范围 | 保留；聊天内确认（iTest 无 AskUserQuestion 工具） |
| 4 测试类型建议 | 关键词扫描（性能/安全/集成/可靠性/可服务性），默认功能测试，用户可调 | 精简移植智能分析 |
| 5 设计用例 | 按 design-principles.md 场景占比（正常30/异常40/边界20/安全10） | 原样移植 |
| 6 生成入库 | 逐条 `stage_case` 暂存 → StagePanel 用户勾选 → 落库 | **替代原「渲染 Word/Excel」**——用例进平台库是终点 |
| 7 收尾 | 汇总数量/模块分布，可提示 export_cases_xmind 导出 | 新增 |

**明确不移植**：

- 分批并行子代理（iTest 运行时无 Agent/TaskOutput 工具）→ 改为 SKILL.md 指示「需求 >20 条时串行分批，每批 stage_case 后继续」，防单轮超长
- Word/Excel 渲染脚本与模板（与「入平台库」目标冲突；平台已有 XMind 导出）

**质量约束原样保留**：禁臆造、步骤必须具体（按钮名/输入值）、结果必须可验证、`[需确认]`/`[假设]` 标记。

## 第 4 节：错误处理、边界与测试

### 错误处理与边界

| 场景 | 行为 |
|---|---|
| 非 image/docx 文件 | 前端 adapter 选文件时即拒（toast 提示），不进发送 |
| docx >10MB | 前端拒；漏网到后端则丢该项 + content 注入拒绝说明 |
| base64 非法 / 无 PK 魔数 | 后端丢该项 + 注入拒绝说明（防伪造扩展名） |
| 同一消息 >2 个 docx | 只取前 2 个，多的注入拒绝说明 |
| mammoth 提取失败 | 注入块标 `extracted="failed"`，原件与 path 仍可用 |
| zip bomb | parse_docx.py 展开量上限（~200MB）+ 条目数上限，超限报错退出 |
| 重复上传同文件 | unique(thread_id, sha256) 命中复用，不重写 |
| 线程删除 | 删 uploads/threads/<tid>/ + 表行，失败 warn 不阻塞 |
| 跨副本 | 文件与 pi 会话记录都在 `.data` 共享卷，注入块随会话重放，天然一致 |

### 测试

- **API 单测**：parsePromptAttachments 分流（合法/非法 mime、魔数、超限、多文件混排）；docx 落盘+sha256 去重；注入块格式（含拒绝说明/failed 标注）；线程删除清理；read_thread_attachment 目录约束（跨线程路径必须报错）
- **web 测试**：组合 adapter 按文件类型分派；UserMessage 的 `<uploaded-file>` 折叠 chip 渲染
- **parse_docx.py**：小样例 docx（标题层级+表格）node spawn 子进程断言（与 run_skill_script 同路径）；zip bomb 样例（高压缩比伪 docx）断言报错
- **E2E 手测主路径**：上传真实需求 docx → 「根据文档生成用例」→ parse → 需求清单确认 → stage_case 出现在 StagePanel → 落库 → XMind 导出成功

### 范围外（明确不做）

.doc 老格式、Excel/PDF 上传、空间级文件库、skill 渲染 Word/Excel 交付文档、上传文件在线预览。

## 涉及文件清单（实施时核对）

| 层 | 文件 | 改动 |
|---|---|---|
| web | apps/web/src/features/space-assistant/SpaceWorkspace.tsx | 组合式 adapter |
| web | apps/web/src/features/space-assistant/SpaceThreadPane.tsx | chip 渲染 + accept 范围 |
| web | apps/web/src/i18n/locales/*（assistant 命名空间） | 新文案 |
| api | apps/api/src/pi/space/router.ts | 分流 + docx 处理 + body limit |
| api | apps/api/src/pi/space/tools/readThreadAttachment.ts（新） | 新工具 |
| api | apps/api/src/pi/space/tools/index.ts | 注册工具 |
| api | apps/api/src/pi/space/router.ts（dispatch 段） | 注入拼接在 router 层 dispatch 内、调 sendSpaceUserMessage 之前完成；session.ts 签名不变（content 直传） |
| api | packages/shared（或 apps/api）/schema | ai_thread_attachments 表 |
| api | apps/api/package.json | mammoth 依赖 |
| api | apps/api/scripts/docx-to-cases-content/（新目录） | skill 内容 + seed 脚本 |
