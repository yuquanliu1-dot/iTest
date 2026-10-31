# AI 助手固化 skill / prompt 可编辑化（R3）设计

日期：2026-10-31 · 状态：已评审（brainstorming 逐节通过 + 「不新增 skill」修正）
前置：R1 短期记忆体（assistant_memories）、R2 轨迹库（assistant_trajectories）均已落 main。

## 1. 背景与定位

R1/R2 已积累两类经验：记忆（陈述性）与轨迹（程序性），均可为泛化经验或产品线业务经验。两者注入时都按产品线隔离，跨线不复用。

R3 要解决的是**上浮**：把其中**非业务的泛化经验和优化内容**固化到**全局现有资产**——系统提示词模块与现有 skill——提升跨产线的助手能力。业务事实（URL/账号/锚点/产品名）不上浮，留在 R1/R2 线内。

同时暴露一个前置缺口：多数提示词文案硬编码在代码里（主 prompt 风格段、工作台段、每个工具的 description/promptGuidelines），改一个字要发版。**硬编码 prompt 可编辑化**本身就是独立交付价值（免发版修改 + 版本回滚），也是固化管线的落地面之一。

**红线（用户明确纠正）**：R3 只改现有资产——优化现有提示词模块、修订现有 skill 的正文。**不新增 skill**（新 skill 走既有 skill-creator 人工流程）；不新建独立提示词资产。

### 两条独立可交付的工作流

- **A. prompt 可编辑化基建**：模块注册表 + DB 值存储 + 版本链 + 渲染覆盖。单独交付即有价值。
- **B. 固化管线**：人工发起盘点 → LLM 蒸馏产提案 → 逐条人工审批 → 应用（改 prompt 模块值 / 修订 skill 正文）+ 源退役。

A 先行，B 依赖 A 的 prompt 模块落点（skill 修订落点不依赖 A）。

## 2. 总体方案

```
R1 记忆(active) ─┐
                 ├─→ 盘点批次(LLM 蒸馏,泛化判据) ─→ 提案 ─→ 逐条人工审批 ─┬─→ prompt 模块: 追加版本行
R2 轨迹(active) ─┘   （无落点 → 只记提示,不产提案）                      ├─→ skill 正文: 修订+版本行
                                                                          └─→ 源退役(记忆默认退役/轨迹默认保留)

人工直改通道（不经盘点）: 设置页直接编辑 prompt 模块值 / 回滚 / 恢复默认
```

- LLM 只产**提案**，不直接改任何资产；应用一律经人工批准。
- 盘点是人工低频动作：fire-and-forget inline 执行（R2 trajectoryQueue inline 同款），不引 BullMQ。

## 3. 数据模型（三张新表）

### 3.1 `assistant_prompt_module_versions` —— prompt 模块值存储（append-only 版本链）

**存储模型：代码是模块注册表，DB 是值存储。**

- 无行 = 用代码默认值（新装/清库即回出厂，无需 seed）。
- `value = NULL` 的行 = 「跟随代码默认」——用户显式恢复默认后，值随发版演进，不钉死旧文案。
- 当前值 = 每 module_key 取 seq 最大的行。
- 回滚 = 把历史行的 value 复制追加为新行（回滚本身也留痕，可再回滚）。

| 列 | 类型 | 说明 |
|---|---|---|
| seq | bigserial PK | 单调递增，版本链锚点 |
| module_key | varchar(100) notNull | 见 §4.1 键位清单 |
| value | text null | NULL=跟随代码默认 |
| source | varchar(20) notNull | `manual_edit` \| `rollback` \| `baseline` \| `solidify_apply` |
| source_ref | uuid null | 幂等锚：固化应用时=proposal id。partial unique `where source_ref is not null`（同一提案重复应用只落一行） |
| created_by_user_id | uuid FK users set null | |
| created_at | timestamp defaultNow | |

索引：`(module_key, seq desc)` —— 当前值解析主路径。

恢复默认 = 追加 `value=NULL, source='manual_edit'` 行（不需要独立 source 枚举）。

### 3.2 `assistant_solidify_batches` —— 盘点批次

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK defaultRandom | |
| status | varchar(16) notNull | `running` \| `done` \| `failed`（running 时再发起 → 409 防重入） |
| input_summary | text null | 输入概览：各源条数、LLM 返回的无落点提示等 |
| error | text null | failed 时原因 |
| created_by | uuid FK users | |
| created_at / updated_at | timestamp | |

### 3.3 `assistant_solidify_proposals` —— 固化提案

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK defaultRandom | |
| batch_id | uuid FK batches cascade | |
| kind | varchar(20) notNull | `prompt_amendment` \| `skill_revision` |
| target | varchar(100) notNull | prompt 模块 key 或 skill slug |
| title | varchar(200) notNull | 人话提案名（审批列表用） |
| body | text notNull ≤20k | prompt_amendment：追加进模块值的增量文案；skill_revision：**修订后的完整正文** |
| rationale | text notNull | 为什么值得固化（含跨线证据） |
| sources | jsonb notNull | `[{type:'memory'\|'trajectory', id, title, retireRecommended:bool}]` |
| status | varchar(16) notNull default `pending` | `pending` \| `approved` \| `rejected` |
| reviewed_by / reviewed_at | uuid FK / timestamp | |
| applied_at | timestamp null | 应用动作完成时刻 |
| apply_error | text null | 应用失败信息；部分失败时提案回 pending 可重试 |
| distill_model | varchar(64) notNull | |
| created_by / created_at | | |

### 3.4 现有表的无损改动

- 无 schema 改动。`assistant_memories.retired_by_batch` / `assistant_trajectories.retired_by_batch`（R2 已预留列）终于有写入者：审批时的退役动作。
- 退役状态值统一用 `retired_solidified`（status varchar 宽松列，无枚举迁移）。

## 4. 工作流 A：prompt 可编辑化

### 4.1 模块注册表（新文件 `apps/api/src/pi/space/promptModules.ts`）

代码侧只登记「有哪些模块、默认值是什么、如何取默认值」：

| module_key | 默认值来源 |
|---|---|
| `space.style.zh` / `space.style.en` | session.ts 现硬编码风格段文本 |
| `space.workspace` | session.ts 现硬编码工作台段（禁侦察段） |
| `tool.<name>.description` | buildSpaceTools 各工具 description（运行时枚举生成） |
| `tool.<name>.guidelines` | 各工具 promptGuidelines（string[]，覆盖值按 `\n` join） |
| `skill.<slug>` | 磁盘 SKILL.md 正文（去 frontmatter）——**只读组**：UI 展示+回滚，不提供直接编辑（skill 修订走管线或 skill-creator） |

接口：

```ts
// 注册表：key → { group, label, defaultValue(): Promise<string> }
resolvePromptModules(): Promise<Map<string, PromptModuleState>>
// 单次 SELECT 各 key 的 max(seq) 行 join 注册表；查询失败 → 全部回落代码默认（guides 同款容错，
// prompt 可用性不能拖垮会话）
```

### 4.2 渲染改造（session.ts）

- `buildSpaceSystemPrompt(...)` 增加第 6 参 overrides（可选），style/workspace 段先查覆盖，无覆盖用现常量。
- 工具注册循环（session.ts:756 附近 rawTools → defineTool）：description / promptGuidelines 查覆盖替换。
- **渲染红线：DB 零版本数据时，system prompt 与工具文案与现状逐字节一致**（R1/R2 同款回归测试锚点）。
- 覆盖生效面：chat 线程与 RCA 线程共用 buildSpaceTools/buildSpaceSystemPrompt 的全部路径。注入时机与 R1 记忆段相同——线程冷构建时快照，线程内不热更。

### 4.3 语义边界

- 代码默认值随发版变化时：无行/NULL 行的模块自动跟进新默认；有值的模块保持用户值（这正是 desired）。
- 模块键位变更（工具改名等）：旧键行成孤儿——注册表查不到即不渲染，无副作用；YAGNI 不做迁移。

## 5. 工作流 B：固化管线

### 5.1 发起与执行

- `POST /assistant/solidify/scan`（requireManager）：存在 `status='running'` 批次 → 409。否则建批次（running），**inline fire-and-forget**（请求立即返回批次 id；R2 inline 蒸馏实测 ~2min 量级，可接受）。
- LLM 未配置 → 批次直接 failed + error 说明（不发请求体也能发起的管理动作，错误在批次上可见）。

### 5.2 蒸馏输入与判据

输入 = 全库 `active` 记忆 + `active` 轨迹（>200 条时按 `hit_count` desc 取 top 200——高频被引用者优先，顺带防 prompt 爆炸）+ 现有 skill 清单（slug+name+description，供去碎片化比对）。

LLM 蒸馏判据（system prompt 明示，输出 per-proposal zod 校验，单条不合法丢弃该条不炸批次）：

1. **跨线普适**：≥2 条产品线来源支撑（来源计数写进 rationale）；单线孤证不固化。
2. **非线内事实**：不得含 URL、账号、data-testid/锚点、产品名、凭据（凭据禁令同 R2 蒸馏：出现在任何输出字段即违规）。
3. **可操作**：能落成提示词增量文案或 skill 正文修订，不是空泛建议。
4. **去碎片化**：先匹配现有 skill 覆盖面——有落点才产 `skill_revision` 提案；泛化经验没有现成 skill 落点时**不产提案**，只在批次 `input_summary` 记一条提示（「建议人工用 skill-creator 新建：…」）。锚定对标文章的「并入优先于新建」。

**退役建议口径**：每条 source 带 retireRecommended——记忆被固化后线内注入即冗余 → 默认 `true`；轨迹兼有线内 few-shot 价值（R2 语义）→ 默认 `false`。人工在审批时逐条改。

### 5.3 审批与应用

- `POST /proposals/:id/approve {retireIds: uuid[]}`：乐观锁 `UPDATE ... SET status='approved', reviewed_by, reviewed_at WHERE id=? AND status='pending' RETURNING`，0 行 → 409。
- 应用（乐观锁成功后执行，失败不吞）：
  - **prompt_amendment**：校验 target 是注册表键；把 body 追加到当前值尾部（当前为 NULL/无行时先追加 baseline 行固化代码默认，再追加增量）；写 `source='solidify_apply', source_ref=proposal.id`。source_ref unique 兜底：重放只落一行。
  - **skill_revision**：校验 skill 存在（磁盘目录+DB enabled）；该 skill 首次被固化时先记 `baseline` 行（磁盘现正文去 frontmatter）供 diff/回滚起点；**先写文件再记版本行**——body 是完整正文（不含 frontmatter），写文件时 frontmatter 从 DB 的 name/description 重新拼回（防文件/DB 元数据漂移）；重放无害（同值幂等写）。重试时若 source_ref 行已存在则跳过写文件。
  - **退役**：`UPDATE ... SET status='retired_solidified', retired_by_batch=<batch_id> WHERE id IN (retireIds) AND status='active'`——active 守卫防重复退役/复活已删条目。
  - 部分失败：apply_error 记原因，status 回 `pending`（可再次 approve 重试；幂等三件套保证重试安全）。
- `POST /proposals/:id/reject`：同样乐观锁置 rejected，不碰任何资产。

## 6. REST 路由（新文件，挂 router.ts `/api/assistant` 下 requireManager，memoriesRoute 同款）

| 方法与路径 | 用途 |
|---|---|
| GET `/assistant/prompt-modules` | 分组列表：key/label/group/当前值/来源/是否默认 |
| GET `/assistant/prompt-modules/:key/versions` | 版本链（seq desc） |
| POST `/assistant/prompt-modules/:key/value` | `{value?: string\|null, fromSeq?: number}`；fromSeq→rollback（校验该行存在，复制其 value），否则 manual_edit；key 须在注册表，skill.* 拒绝直接写 |
| POST `/assistant/solidify/scan` | 发盘点（409 防重入），返回批次 id |
| GET `/assistant/solidify/batches` | 批次历史（含 running 供前端轮询） |
| GET `/assistant/solidify/proposals?batchId=&status=` | 提案列表 |
| GET `/assistant/solidify/proposals/:id` | 详情（含 sources 完整标题/来源线，供 diff 与退役勾选） |
| POST `/assistant/solidify/proposals/:id/approve` | `{retireIds}` 应用+退役 |
| POST `/assistant/solidify/proposals/:id/reject` | 驳回 |

## 7. Web 界面（设置页，requireManager 可见；i18n zh/en）

两个 Section：

1. **系统提示词**：模块分组列表（主 prompt / 工具 / skill 只读组），当前值来源 badge（默认/手工/回滚/固化/基线）；编辑抽屉（大文本域；skill 组只读）；版本历史抽屉（值 diff、回滚按钮、恢复默认按钮——恢复默认对 skill 组也可用=回滚到 baseline）。
2. **固化盘点**：「发起盘点」按钮（running 409 → 提示进行中）；批次历史；提案列表 → 详情页：kind badge、target、rationale、**全文 diff**（prompt_amendment 显示增量文案与叠加预览；skill_revision 显示 baseline vs 修订正文）、来源清单（标题/类型/来源线 + 退役勾选，预填建议值）；批准（带勾选退役）/驳回。

错误路径全部 localizeApiError 分支处理（R1 教训：409/404/校验错误各自有文案，不落「未知错误」）。前端轮询 running 批次 → done/failed 后刷新提案列表。

## 8. 测试策略

- **promptModules 单测**：无行→默认；值行→覆盖；NULL 行→默认（语义=跟随代码）；回滚追加复制；source_ref 幂等；resolve 查询失败→全默认不抛。
- **渲染红线**：零版本数据下 buildSpaceSystemPrompt 与工具注册产物逐字节等于现状（快照断言）。
- **session 集成**：覆盖生效（改 style 段后 prompt 含新值）；DB 查询失败→会话照常（默认值）。
- **盘点 worker**：LLM stub 全路径（产 0/1/N 提案）；防重入 409；单条 zod 失败丢弃不炸批次；LLM 未配置→failed；超时→丢弃。
- **审批执行**：乐观锁（并发 approve 单胜）；prompt 幂等（重放单行）；skill 先写文件后记行+重放跳过；退役 active 守卫；部分失败回 pending 可重试。
- **E2E 手动**：浏览器发盘点→轮询→改退役勾选→批准→验证 prompt 模块值/skill 文件已改+版本行+源退役。
- **回归**：R1 记忆注入、R2 轨迹注入测试全绿（红线保证互不干扰）。

## 9. 非目标（YAGNI）

- 不做自动定期盘点 / 命中率统计触发（R5 反馈回路范围）。
- 不做 embedding 聚类去重——LLM 判据内完成，人工审批兜底。
- 不做蒸馏输入凭据 regex 打码（R2 backlog，独立修）。
- 不做新 skill 创建提案（无落点只记提示，人工走 skill-creator）。
- skill 提案只修订 SKILL.md 主文件，不提案其他附属文件。
- 工具 parameters JSON Schema 不纳入可编辑面（只 description/guidelines）。
- RCA/codemode 专用 prompt 若为独立硬编码段，本期不纳入可编辑面（仅枚举 buildSpaceTools 的工具 + 主 prompt 三段；后续按需扩注册表）。

## 10. R4/R5 接口预留

- 版本链 + sources 溯源 + applied_at 即 R4 证据链审核界面的数据底座（R4 在其上做发布通道/重审批）。
- 批次 input_summary 的「零命中/高频」观察数据是 R5 盘点面板素材；hit_count 已在 R1/R2 落地。
- apply_error + pending 可重试语义给 R4 的「审核后再发布」留了天然两步。
