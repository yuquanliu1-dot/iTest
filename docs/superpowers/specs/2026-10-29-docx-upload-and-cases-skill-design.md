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
| 上传定位 | **版本级附件**（同版本各线程可用；原定线程级，因预上传时草稿线程尚无 threadId 而放宽，见下方「传输方案」） |
| 消费方式 | 双路：提取文本按需读取（read_thread_attachment）+ 原件落盘给路径 |
| 文件格式 | 仅 .docx（不做 .doc） |
| 传输方案 | **修正方案（2026-10-29 计划期改道）：预上传端点 + adapter.send() 文本部件引用**。原「方案 1：内联 base64」在计划期被源码事实否决：react-pi 的乐观消息按纯文本 key（userContentKey，ThreadController.js:445-455）与 pi 回放消息对账去重，后端把注入块拼进用户消息文本会使两侧 key 不一致 → 乐观消息永不消解 → 运行期间出现重复用户气泡。修正方案下引用标签由前端 adapter 在 send() 时以**文本部件**拼进消息正文（ThreadController 会把附件文本部件拍平进 content），乐观消息 == pi 记录 == 回放逐字一致，零对账问题、零 transport 包装 |

## 第 1 节：上传链路（端到端，修正方案）

```
浏览器                                    API (apps/api)
──────                                    ─────────────
Composer 选文件(.docx)
  └ CompositeAttachmentAdapter
    ├ image/* → SimpleImageAttachmentAdapter（原样不动）
    └ docx → DocxAttachmentAdapter
        add():  ≤10MB 校验 → 立即预上传
                POST /api/assistant/versions/:versionId/attachments
                （octet-stream + X-Filename，仿 /api/cases 附件）
                                          └ PK 魔数 + sha256 落盘
                                            .data/uploads/assistant/<versionId>/<sha>.docx
                                            + mammoth 提取 → <sha>.txt
                                            + 表 ai_assistant_attachments（unique(version,sha) 去重）
                                          ← {name, path, chars, size, extracted}
        send(): 返回 content:[{type:'text',
                text:'<uploaded-file name=… path=… chars=…/>'}]
发送 → ThreadController 把附件文本部件拍平进 input.content
     → POST /threads/:id/messages（docx 不进 input.attachments）
                                          └ parsePromptImages 零改动
                                          → pi 会话记录 == 乐观消息，逐字一致
```

### 关键实现点

- **前端 adapter**（`apps/web/src/features/space-assistant/SpaceWorkspace.tsx:110`）：`SimpleImageAttachmentAdapter` 换成 `CompositeAttachmentAdapter([SimpleImage, Docx])`（assistant-ui 原生组合器，按 accept 分派）。composer 接受范围自动变为 `image/*` + `.docx`
- **DocxAttachmentAdapter**（新文件）：`add()` 选文件即校验 ≤10MB 并发起预上传（versionId 在 SpaceWorkspace 恒有——草稿线程发首条消息前没有 threadId，这就是作用域放宽为版本级的原因）；`send()` await 上传结果，把服务端签发的引用标签作为**文本部件**返回。上传失败 → send 抛错 → 消息不发出、错误可见
- **react-pi 零改动、后端消息路由零改动**：`parsePromptImages` 与 `ASSISTANT_JSON_BODY_LIMIT` 均不动（attachments 里永远不会出现 docx）；`buildPiSendInput`（ThreadController.js:82-94）天然把附件文本部件并入 content
- **引用标签进正文是特性而非妥协**：乐观消息、pi 会话记录、SSE 回放三者逐字一致 → `userContentKey` 对账匹配、无重复气泡；标签随会话持久化，冷线程/跨副本回放天然一致；助手与 skill 从标签拿 path
- **渲染折叠**（`SpaceThreadPane.tsx`）：自定义 Text part 渲染器把 `<uploaded-file …/>` 标签折叠为附件 chip（图标+文件名+字数），其余文本原样——仅显示层变换，不碰消息原文；`ComposerAttachment` 对 docx 附件渲染文档图标卡而非 `<img>`
- **docx 绝不进 `prompt.images`**：docx 只以文本标签形态进对话（避免网关剥图/图片尺寸校验类故障）

## 第 2 节：存储、引用标签与新工具

### 存储

- 目录：`.data/uploads/assistant/<versionId>/<sha256>.docx`（原件）+ `<sha256>.txt`（mammoth 提取文本，上传时算好缓存）
- 新表 `ai_assistant_attachments`（drizzle schema，随 api 容器启动 `drizzle-kit push` 自动应用；本地 dev 需手动 psql 建表）：

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| version_id | uuid | 作用域（预上传时草稿线程无 threadId） |
| name | text | 用户原始文件名（展示用） |
| mime | text | 固定 docx mime |
| size_bytes | integer | 原件大小 |
| sha256 | text | 去重键，**unique(version_id, sha256)** |
| storage_path | text | 原件绝对路径 |
| extracted_path | text | 提取文本绝对路径（提取失败为 null） |
| extracted_chars | integer | 提取文本字符数（标签 chars 属性） |
| created_by_user_id | uuid | 审计 |
| created_at | timestamp | |

- 线程删除**不**清附件（版本级作用域）：已上传但从未发送的文件成为孤儿——10MB 上限 + 版本内 sha256 去重，风险有界，接受
- 新增 mammoth 依赖（apps/api，纯 JS 无原生编译）

### 引用标签（前端 adapter 在 send() 拼进消息正文）

```
<uploaded-file name="需求规格说明书.docx" path="/…/.data/uploads/assistant/<versionId>/<sha>.docx" chars="48213"/>
```

- 自闭合、无内联预览：2000 字预览挂历史会每轮重放浪费 token，改为助手按需调 read_thread_attachment 取全文
- mammoth 提取失败：chars="unknown"、extracted=false（响应字段）——path 仍有效，skill 的 python 解析器可自行兜底解包

### 新工具 `read_thread_attachment`

- 参数：`path`（引用标签里的 path）。执行时 realpath 后强制约束在**当前版本**的上传目录内 + 表里必须有该版本的记录（双重校验，防跨版本读）
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

不用 python-docx（生产容器可用性不确定），stdlib 解包 `word/document.xml`：段落按样式分级（styles.xml 里 styleId→name 映射，兼容「Heading N/标题 N」两种命名）、表格 → 二维数组。**已核实 read_skill 的文件树排除 `.` 开头目录（skillsStore.ts:110），`.out/` 回读方案不可行**——改用双模式渐进披露，天然绕开 run_skill_script 的 100KB 输出上限：

- 默认 outline 模式：输出顶层章节骨架（标题/段落数/表格形状）+ stats，紧凑小体积
- `--section N [--sub M]`：输出指定章节的完整内容（段落全文 + 表格二维数组）

zip bomb 防护：解压总展开量上限（默认 200MB，环境变量可覆写供测试）+ 条目数上限，超限报错退出。调用方式：`run_skill_script(skillName="docx-to-cases", script="scripts/parse_docx.py", args=["<path>"])`。

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
| 非 image/docx 文件 | composer accept 已过滤；漏网（「所有文件」绕过）由组合 adapter add 抛错拒绝 |
| docx >10MB | 前端 add() 即拒；后端端点 413 兜底 |
| 无 PK 魔数（伪造扩展名） | 后端端点 400 拒绝 |
| 上传失败（网络/4xx） | adapter send() 抛错 → 消息不发出、错误经 ErrorPrimitive 可见 |
| mammoth 提取失败 | 标签 chars="unknown"、extracted=false；原件与 path 仍可用，skill 走 python 兜底 |
| zip bomb | parse_docx.py 展开量上限（默认 200MB，可覆写）+ 条目数上限，超限报错退出 |
| 重复上传同文件 | unique(version_id, sha256) 命中复用（响应 deduped=true），不重写 |
| 同版本孤儿文件 | 接受（版本级作用域的代价，风险有界） |
| 跨副本 | 文件与 pi 会话记录都在 `.data` 共享卷，引用标签随会话重放，天然一致 |
| 重复气泡 | 结构性免疫：乐观消息 == pi 记录 == 回放（这正是改道修正方案的原因） |

### 测试

- **API 单测**（不碰 DB 的纯函数）：PK 魔数校验；路径约束 confinedPath（越界/软链必须拒）；引用标签构造
- **web 测试**：DocxAttachmentAdapter add/send 分派与失败路径（mock api client）；splitUploadedFileTags 纯函数；ComposerAttachment docx 分支
- **parse_docx.py**：vitest 内用 archiver（已有依赖）构造样例 docx（标题层级+表格），spawn python3 断言 outline/section 输出；低阈值环境变量下高压缩比样本断言 zip bomb 报错
- **E2E 手测主路径**：上传真实需求 docx → 「根据文档生成用例」→ parse → 需求清单确认 → stage_case 出现在 StagePanel → 落库 → XMind 导出成功；另验证：发送后无重复气泡、刷新后历史 chip 正常

### 范围外（明确不做）

.doc 老格式、Excel/PDF 上传、空间级文件库、skill 渲染 Word/Excel 交付文档、上传文件在线预览。

## 涉及文件清单（实施时核对）

| 层 | 文件 | 改动 |
|---|---|---|
| web | apps/web/src/features/space-assistant/DocxAttachmentAdapter.ts（新） | 预上传 + 文本部件引用标签 |
| web | apps/web/src/features/space-assistant/SpaceWorkspace.tsx | CompositeAttachmentAdapter 接线 |
| web | apps/web/src/features/space-assistant/SpaceThreadPane.tsx | UserTextPart 标签折叠 chip + ComposerAttachment docx 分支 |
| web | apps/web/src/api/client.ts | assistantAttachments.uploadDocx |
| web | apps/web/src/i18n/locales/{zh-CN,en-US}/assistant.json | 新文案 |
| api | apps/api/src/db/schema.ts | ai_assistant_attachments 表 |
| api | apps/api/src/pi/space/threadAttachments.ts（新） | 存档/提取/去重/读取服务 + 纯函数 |
| api | apps/api/src/pi/space/router.ts | POST /versions/:versionId/attachments |
| api | apps/api/src/pi/space/tools/readThreadAttachment.ts（新） | read_thread_attachment 工具 |
| api | apps/api/src/pi/space/tools/index.ts | 注册工具 |
| api | apps/api/package.json | mammoth 依赖 |
| api | apps/api/scripts/docx-to-cases-content/（新目录） | SKILL.md + parse_docx.py + references |
| api | apps/api/scripts/seed-docx-to-cases-skill.mjs（新） | 种子脚本 |
| infra | infra/docker/deploy.sh | seed 接线（仿 word-test-report，L212-214 旁） |
