# AI 助手 Excel(.xlsx) 上传 + xlsx-to-cases skill 设计

日期：2026-11-03
状态：计划经用户确认（与 docx 完全对齐 / 仅 .xlsx）

## 背景与目标

AI 助手聊天附件已支持图片（vision）与 Word（docx）。本设计给 Excel 加同等待遇：

1. **.xlsx 上传能力（通用）**：聊天可上传 .xlsx，提取文本供助手直接阅读，原件落盘供 skill 脚本使用
2. **`xlsx-to-cases` skill**：从上传的 Excel 需求表格生成测试用例，写入平台用例库（stage_case → StagePanel 确认 → 落库）

与 docx 链路**完全对齐**——同一传输方案（预上传 + `<uploaded-file/>` 引用标签）、同一不变量（后端永不改写消息文本）、同一条 read_thread_attachment 工具。仅 .xlsx（老 .xls 是 OLE2 头，天然被 zip 魔数校验拒，400 文案提示另存为 .xlsx）。

## 关键决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 前端 adapter | `DocxAttachmentAdapter` git mv 为 `FileAttachmentAdapter`（单一泛化 adapter） | 不复制第二个 adapter；git mv 保 blame |
| 后端分派 | 按 X-Filename 扩展名白名单 {docx, xlsx}；存储名 `<sha256>.docx\|.xlsx` 固定扩展名 | 不拼用户后缀，收敛注入面 |
| 提取器 | docx→mammoth（原样）；xlsx→exceljs（^4.4.0 已在依赖，29735ba 引入未用，**零新增依赖**） | — |
| skill 形态 | **新独立 skill `xlsx-to-cases`**（不扩 docx-to-cases） | seed 只在目录缺失才铺——改既有 skill 在已部署的 prod228 不生效且漂移；平行结构零风险 |
| skill 解析器 | `parse_xlsx.py` 零依赖（zipfile + xml.etree） | api 容器已装 python3（docx 批次验证），零 pip |
| exceljs 类型坑 | `wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0])` | exceljs d.ts 全局声明 `interface Buffer extends ArrayBuffer` 与 @types/node 泛型 Buffer 打架，直接断言绕过 |

## 上传链路（与 docx 差异点）

```
FileAttachmentAdapter（accept: '.docx,.xlsx' + 两完整 mime，四值——部分环境只认扩展名/部分只认 mime）
  add(): ≤10MB（MAX_ATTACHMENT_BYTES）→ POST /api/assistant/versions/:versionId/attachments
                                          └ zip 魔数（PK\x03\x04，docx/xlsx 同构；.xls OLE2 头被拒）
                                            └ ext 白名单分派：mammoth | xlsxToText
                                            └ 存 <sha>.docx | <sha>.xlsx + <sha>.txt
```

router 400 文案（非白名单扩展名）：`仅支持 .docx / .xlsx 附件（.xls 请先另存为 .xlsx）`——英文文案直接透传前端 error 显示。413 文案 `file exceeds the 10MB limit`。

### xlsxToText 归一化规则（apps/api/src/pi/space/threadAttachments.ts）

- 每 sheet 一段：`## Sheet: 名 (rows=N,cols=M[,hidden])` + 管道 `|` 分隔行
- cell 归一化：string/number/boolean 原样；Date→ISO；richText join；**公式取缓存值（result），无缓存值给 `[formula]`**（exceljs 重读无缓存值公式没有 result 键——判断须 `'result' in o || 'formula' in o || 'sharedFormula' in o`，漏了会落 `[object Object]`）；hyperlink 取 text；错误 cell→`[error:code]`
- 稀疏行：空洞补空串对齐列，尾随空列裁掉；全空行跳过、全空 sheet 不出段
- 护栏：每 sheet 2000 行截断（`XLSX_MAX_ROWS_PER_SHEET`，仅当实际超出才标注）+ 单 cell 200 字符（`XLSX_MAX_CELL_CHARS`）；加密/损坏文件抛错由外层「提取失败不阻断」catch（extractedPath=null→chars="unknown"）
- 去重键只有 (versionId, sha256)：同名不同内容=两附件；同名同内容=复用（与 docx 同语义）

### chars 语义

sidecar 字符数（提取文本长度），前端 `<uploaded-file chars=N/>` 标签与 chip「N 字」共用。xlsx 的提取文本是 sheet 管道行文本，方向正确不误导。

## xlsx-to-cases skill（apps/api/scripts/xlsx-to-cases-content/）

七步流程对齐 docx-to-cases（0 找标签+校验 path 扩展名 → 1 parse_xlsx.py 渐进解析 → 2 需求清单确认 → 3 测试类型 → 4 references → 5 逐条 stage_case 分批≤10 → 6 收尾）。特有纪律：

- **日期列可能是 Excel 序列值（1900 纪元数字）**：parse_xlsx.py 不换算，SKILL.md 提示模型原样引用
- **合并单元格只有左上有值**：outline 报 merged 数，模型读矩阵时注意列错位
- references/case-mapping.md 补「用例矩阵列名模糊映射」节：标题→title、步骤→steps[].action、预期→assertion、优先级列→priority、需求编号列→requirementNo（sheet 已是用例矩阵时跳过需求清单确认分支）

### parse_xlsx.py 关键设计

- **sheet 顺序必须经 `xl/_rels/workbook.xml.rels` 的 rId 解析**——不能假设 sheetN.xml 文件名与声明序一致；rels 缺条目 fail（`not found in rels`）
- 三模式：outline（sheet 清单/行列数/隐藏标注/表头预览 12 cell/合并数）→ `--sheet N`（数据行带 Excel 行号 `rows[].r`）→ `--sheet N --rows A:B`（按 Excel 行号窗口，分段取内容避开 run_skill_script 100KB 上限）
- cell 类型：sharedStrings（含富文本 run）/inlineStr/数字/布尔（TRUE/FALSE）/公式缓存值（无缓存给 `[formula]`）/错误（#N/A 原样）
- zip bomb 防护：条目数（`XLSX_MAX_ENTRIES`，默认 2000）+ 总展开量（`XLSX_MAX_TOTAL_BYTES`，默认 200MB），读前按 infolist 声明值判断；环境变量可覆写（测试收紧用）
- stdout 单行紧凑 JSON；`ok:false` 时 `sys.exit(1)`（promisified execFile 会 reject，错误对象带 stdout 供测试解析——parseXlsxScript.test.ts 的 `.catch(e => e)` 范式）

## 测试

- `threadAttachments.test.ts`：assertZipMagic + xlsxToText（exceljs 现造 workbook：多 sheet/richText/公式缓存值/日期/稀疏行/截断/坏文件）
- `parseXlsxScript.test.ts`（新）：常规结构 exceljs writeBuffer；边角 archiver 手拼 zip（乱序 rId、sharedStrings 富文本、布尔/公式/错误 cell、护栏、坏 XML、参数校验）
  - **手拼 XML 的命名空间陷阱**：无前缀子元素（`<row>`）不继承带前缀父元素（`<s:worksheet>`）的命名空间——所有元素必须带 `s:` 前缀（真实 xlsx 用默认 xmlns，前缀形式等价）
  - **exceljs mergeCells 陷阱**：mergeCells 清空被合并的 slave cell——fixture 不能合并表头行
- `FileAttachmentAdapter.test.ts`：accept 四值、xlsx mime 缺失按扩展名补全、图片回归

## 发现并顺手修复的既有 bug（超出本任务范围的披露）

`apps/api/src/routes/overview.ts` aiUsage 日桶时区平移：`db.execute` 走 drizzle rawSQL 解析器（timestamp 原样回字符串，不经列映射），无时区字符串直接 `new Date()` 按进程本地时区解析——UTC 容器写入的 UTC 墙钟在 +08 机器被平移 8h，桶落「昨天」。trend 路径（drizzle select）走列映射 `new Date(value + '+0000')`（timestamp.cjs mapFromDriverValue）口径正确，两路径不一致。prod228 容器 TZ=UTC 不受影响；本地 dev/测试在 00:00–08:00 之间 overview.test.ts 必挂。修复：raw 路径补 `+0000` 与列映射同口径。

## 明确不动

- artifacts.ts MIME_TABLE（已含 xlsx）、runSkillScript 产物协议、api.Dockerfile（python3 已装）、preamble（session.ts 无 docx/xlsx 硬编码）、schema 列结构（仅注释泛化）、`UploadedFileChip`「N 字」文案
- .xls 支持（OLE2 头，exceljs 不读；用户群体明确要求另存为 .xlsx）
