# iTest 平台 skill 写作规范

本平台（iTest）上运行的 skill 与通用 skill 有一层额外约定。用 skill-creator 为 iTest 写新 skill、或改进平台既有 skill（xlsx-to-cases、docx-to-cases、defect-rca 等）时，**先读本文件再动笔**。既有 skill 就是最好的参照样例——写之前先读一个同类样例。

## 1. 渐进披露三层（平台运行时强制）

iTest 的 skill 运行时就是按三层加载的，写的时候要主动顺着这个结构：

1. **frontmatter description** —— 唯一常驻上下文的部分，是触发的全部依据。描述要「pushy」：写清做什么 + 列出用户会说什么话时触发（含不同说法），否则会欠触发。平台内触发还常依赖消息里的 `<uploaded-file …/>` 标签，有此依赖要写进 description（参照 xlsx-to-cases 的写法）。
2. **read_skill 读 references/** —— 重负载内容（字段映射表、设计原则、checklist）全部下沉到 references/，SKILL.md 里只留一句「必读 `references/xxx.md`」+ 何时读。读取方式是 `read_skill(skillName="…", file="references/xxx.md")`。
3. **run_skill_script 跑脚本** —— 确定性工作（解析 Excel/Word、生成文档）写成 scripts/ 下的脚本，SKILL.md 只给调用签名和参数示例。

## 2. 脚本黑盒 + 上下文保护

- **SKILL.md 不贴脚本内容**，只给 `run_skill_script(skillName="…", script="scripts/xxx.py", args=[…])` 形态的调用示例。脚本对模型是黑盒，这正是目的——省上下文。
- **大输出必须分段取**：run_skill_script 有 100KB 输出上限、60s 超时，超限直接终止。脚本要设计成支持分段（如 `--sheet N --rows A:B`），SKILL.md 里明确写「大文件分段取行」。
- **失败即停**：脚本返回 `ok=false` 时把 error 告诉用户并停在那里，不要臆测内容继续往下走。
- **产物回传**：脚本生成文件（Word/Excel 报告）时写到技能 `.out/` 目录并在 stdout 打 `__ITEST_ARTIFACTS__ [{"name":"…","path":".out/…"}]` 一行，平台会变成下载卡。

## 3. 决策树引导（步骤流水线写法）

iTest skill 的正文用「第 0 步…第 N 步」线性流水线，每步三要素：

- **动作**明确到工具调用形态（不是泛泛「解析表格」）；
- **分支跳转**写明（「需求矩阵才需要本步，用例矩阵直接跳到第 5 步」）；
- **失败出口**写明（「没有 uploaded-file 标签 → 请用户上传后重说，不要凭空开做」）。

需要分类判断的（如 defect-rca 的根因分类），把分类标准和各类特征写全，并给「证据不足怎么办」的降级路径——分类决策树比自由发挥可靠得多。

## 4. 平台机制速查

| 机制 | 约定 |
|---|---|
| 输入定位 | 用户消息里的 `<uploaded-file name="…" path="…" chars="…"/>` 标签；没有标签就请用户上传，禁止凭空猜路径 |
| 用例落库 | 终点是 `stage_case` **暂存**，用户在暂存面板确认后才真正入库——SKILL.md 里要把这个终点写明，别把 stage_case 说成「入库」 |
| 多条暂存 | >20 条时串行分批（每批 ≤10 条），不要一轮塞全部 |
| 防臆造 | 拿不准的内容标 `[需确认]` / `[假设]`，宁可停下来问；脚本 ok=false 即停 |
| 发布 | skill 内容以**文件系统为真源**，seed 脚本「缺失才铺」——改了 `*-content/` 目录必须手动重铺（删远端 `.data/skills/<name>` 目录后重跑对应 seed 脚本），发版不会自动覆盖 |

## 5. 篇幅纪律

- SKILL.md 控制在 **~100 行内**（平台既有 skill 38–74 行）；超过就是重负载没下沉的信号。
- 每个 skill 自足：单文件能讲清的（defect-rca 38 行）不要拆 references；真正重的（字段映射、设计原则）才下沉。
- 结尾给「收尾/禁止」段：收尾写明总结输出形态（如 defect-rca 的 ≤10 行结案总结），禁止段列出已踩过的坑（如「一条用例调用多次 save_rca_result」）。

## 参照样例

- `xlsx-to-cases`：三层结构完整版（决策树 + 脚本黑盒分段取数 + references 下沉 + stage_case 分批）。
- `defect-rca`：单文件自足版（分类决策树 + 降级路径 + 禁止段），适合无脚本依赖的纯推理型 skill。
