# AI 助手失败教训蒸馏与提示词修正提案（R3.5）设计

日期：2026-11-01 · 状态：已评审（实施计划见 plans/2026-11-01-assistant-failure-lesson-distill.md）
前置：R3 固化管线（assistant_solidify_* + prompt 模块版本链）已落 main 并发 prod228（2026-11-01，65504da 批次）。
定位：R3 的直接扩展（新提案形状 + 新输入面）；同时是 R5「记忆效果反馈回路」中「失败教训」切片的前置落地。

## 1. 背景与定位

### 1.1 R3 的结构性盲区

R3 盘点只能蒸馏「什么有效」——输入是 active 记忆 + active 轨迹（全是成功/有效经验），**结构上发现不了「提示词哪里错了」**。而提示词写得差的最直接后果就是会话失败或变慢，失败会话恰恰不在盘点范围内。

真实事故闭环验证（guide「平台负责登录」误述，2026-10-30）：guide 0002/0003 断言未限定实测范围 → AI 在正式执行中泛化出「自动登录」→ 失败会话暴露问题 → 人工定位到表述 → 手改文案。这条闭环的**起点（失败证据）与终点（改 prompt）都在 R3 范围之外**——若当时有失败教训输入，`prompt_correction` 恰是盘点最该产的提案。

### 1.2 为什么不直接喂原始失败/缓慢会话

1. **归因难**：prod228 26 轮实录（2h39m 零产出）证明大部分失败是平台闸门/SUT 侧造成，不是提示词。固化 LLM 拿原始会话会产出大量「给平台 bug 打提示词补丁」的提案——prompt 是常驻注入（R1 教训：常驻失准先入为主），错误 amendment 的爆炸半径远大于错误记忆。
2. **体量与凭据**：原始会话 JSONL 含页面元素清单/工具正文/凭据，单文件几百 KB；盘点是 180s 超时的一次调用，装不下逐会话判读，凭据暴露面也会再开一层。
3. **提案形状表达不了「修正」**：现行 `prompt_amendment` 是 append-only，修一句错误断言需要 replace/删除语义，append 只能「再贴一条别信上一条」，越贴越厚。

### 1.3 核心决策

**不喂原始会话，加一层「失败教训蒸馏」**：高精度信号 → 结构化教训（带失败层归因）→ 盘点只消费归因为提示词侧的子集 → 新提案形状 `prompt_correction`（全文修正语义）。

## 2. 总体方案

```
S1 prompt 回滚/恢复默认（既有表直查）──┐
S2 负向 ai_assistant_feedback（既有表）─┼─→ 信号蒸馏(LLM call #1) ─→ assistant_failure_lessons
S3 verify nlAiFail 分流信号（新表）  ──┘         （逐条归因：prompt/step_description/
                                                              platform/sut）
                                                          │
R1 记忆(active) ──┐                                       │ 仅 prompt/step_description
R2 轨迹(active) ──┼─→ 资产蒸馏(LLM call #2, R3 既有) ─→ 提案 ─→ 人工审批 ─→ 应用
教训(active,提示词侧) ┘         ↑ kind 扩 prompt_correction        │
                                                                  └→ 教训置 resolved
```

- 信号采集**零 LLM**：S1/S2 查既有表，S3 是既有代码路径上的一行 INSERT。
- 教训蒸馏在**盘点时**执行（维持 R3「人工低频动作、inline fire-and-forget、不引 BullMQ」语义），未被消费的信号幂等去重。
- LLM 只产提案；应用一律经人工批准（R3 闸门不变）。
- **platform/sut 归因的教训只入库不产提案**——它们是平台/SUT 改进素材（R5 面板），严禁变成提示词补丁。

## 3. 数据模型（两张新表 + 一处扩列）

### 3.1 `assistant_failure_signals` —— 原始失败信号（采集层，无 LLM）

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK defaultRandom | |
| type | varchar(20) notNull | v1 仅 `nl_ai_fail`（verify 自然语言步 AI 相失败分流）；后续信号类型同表扩展 |
| threadId | uuid notNull（**无 FK**） | 审计数据惯例（同 ai_assistant_feedback）：不随 version 删除 cascade 消失 |
| productLineId | uuid null FK productLines set null | 信号来源线（教训层不做线隔离，但审批时需要看来源） |
| payload | jsonb notNull | `{caseId, caseTitle, stepOrder, instruction, failureReason, targetUrl, pageUrl}`——快照自包含，线程不可溯时仍可读 |
| createdAt | timestamp defaultNow | |

- 唯一约束：partial unique `(threadId, caseId, stepOrder) where type='nl_ai_fail'`——同一轮重跑同一步失败不重复落信号（onConflictDoNothing）。
- v1 **不捕获用户答复**（分流 note 让用户答复后，答复只在会话 JSONL 里）：回填答复需触碰核心聊天链路，风险/收益不匹配；审批人可凭 threadId 开线程看上下文。

**写入点**：verifyCase.ts nlAiFail 分支（现 :1494-1538 附近）——emit rdata 后 fire-and-forget INSERT，catch+warn 不打断 verify 主流程。

### 3.2 `assistant_failure_lessons` —— 失败教训（蒸馏层）

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK defaultRandom | |
| status | varchar(16) notNull default `active` | `active` \| `resolved`（修正提案应用后自动置） \| `retired`（人工驳回：误报/过时/不修） |
| attribution | varchar(20) notNull | `prompt` \| `step_description` \| `platform` \| `sut`——LLM 蒸馏时判定（本质是判断题，无法服务端定值；误判由人工审批兜底）。**仅前两类进入提案蒸馏输入** |
| title | varchar(200) notNull | 人话教训名（「guide 断言未限定实测范围导致泛化出自动登录」级颗粒度） |
| lesson | text notNull | 结构化正文：现象 → 根因 → 影响面 → 建议修正方向（蒸馏 prompt 规定段落） |
| signals | jsonb notNull | `[{type, refId, excerpt}]`——证据溯源 + 信号消费幂等的记账依据 |
| resolvedByProposal | uuid null | 置 resolved 时记录 |
| distillModel | varchar(64) notNull | |
| createdAt / updatedAt | timestamp | |

- 线索不做产品线隔离（prompt 模块是全局的，教训天然跨线）；信号 jsonb 内带来源线名供证据展示。
- **信号消费幂等**：盘点喂给教训蒸馏的信号 = 尚未被任何教训（**任意 status**，含 retired/resolved）的 signals 引用的信号——一条信号最多蒸馏进一条教训，不重复喂。教训被 retire/resolved 后其信号不复活：防「retire → 再喂 → 再蒸馏 → 再驳回」循环（实施计划收紧：初稿「active 教训」措辞按此口径执行）。

### 3.3 `assistant_solidify_proposals` 扩列（无损）

- `kind` 枚举扩 `prompt_correction`（varchar 宽松列，无迁移）。
- 新列 `baseSeq integer null`——**仅 prompt_correction 用**：盘点时定格 target 模块的当前 max(seq)。全文修正覆盖写，若盘点→审批之间模块被人工改过（seq 前进），apply 检测 `当前max(seq) != baseSeq` → apply_error「模块已被人工修改，请重新盘点」+ status 回 pending。防静默 clobber 人工修改。
  - skill_revision 有同款陈旧基线风险（R3 既有语义），本期不扩大修改面，单独立 backlog。

## 4. 信号源（v1 三类，按归因精度排序）

| # | 信号 | 采集方式 | 归因精度 | 说明 |
|---|---|---|---|---|
| S1 | **prompt 模块回滚/恢复默认** | 直查 `assistant_prompt_module_versions`（source='rollback'，或 manual_edit 且 value IS NULL） | **最高（零成本）** | 人工回滚=已确认该版文案有问题。子类：被回滚掉的行的 source='solidify_apply' → **R3 自身输出质量反馈**（固化提案→应用→被人工回滚），rationale 必须强调 |
| S2 | **负向 ai_assistant_feedback** | 直查（sentiment='negative'，未被消费） | 高 | Phase 1 只收集不消费的表终于有消费者；messageExcerpt+comment 自带语境，threadId 可溯源 |
| S3 | **verify nlAiFail 分流信号** | 新表 3.1（verifyCase 落行） | 中 | 步骤描述与页面不符——追根是 CASE_AUTHORING_FLOW/guidelines 对「如何写步骤」的引导质量；cc645ec 分流机制的下游闭环 |

**明确不进 v1 的信号**（写入非目标）：全量失败会话/缓慢会话挖掘（归因不可靠——prod228 大头是平台侧）、记忆快速退役（无理由字段，信号弱）、plan-run 执行失败、会话内自由文本纠偏挖掘。

## 5. 蒸馏管线（`runSolidifyScan` 扩展为三阶段）

### 5.0 信号采集（查询，无 LLM）

S1/S2/S3 三路查询 + 过滤「已被 active 教训引用的信号」。全零 → 跳过 5.1 直接进 5.2（**红线：零信号时扫描行为与 R3 逐字节一致**）。

### 5.1 教训蒸馏（LLM call #1，条件执行）

输入：信号清单（type/refId/时间/来源线/excerpt；S1 附被回滚文案与回退目标值对照）。输出 zod 逐条宽松校验（单条坏丢弃不炸批次，R3 同款）：

```json
{"lessons":[{"attribution":"prompt","title":"...","lesson":"现象:...根因:...影响面:...建议:...","signalRefs":["..."]}],"notes":["..."]}
```

- 归因判据写死在 system prompt：能指出「某条常驻提示词/引导文案的某表述直接导致误解」→ prompt；「步骤描述写法与页面不符且根源在写法引导」→ step_description；「平台闸门/机制缺陷」→ platform；「SUT 环境问题」→ sut。判定不了 → 不产该条（宁缺毋滥）。
- 单条教训必须引用 ≥1 个 signalRef（引用修剪同 R3 sources：无效引用剔除，剔空丢弃）。
- **call#1 整体失败（LLM 超时/输出不合法）→ 降级不炸批次**：notes 记「教训蒸馏失败（信号保留待下次盘点重试）」，阶段 2 照常执行（教训是增量资产而非批次产出物，失败代价只是这次没蒸馏成）。

### 5.2 资产蒸馏（LLM call #2，R3 既有调用扩展）

输入在 R3 基础上**追加第四节**：

```
【失败教训】（prompt_correction 的证据来源；attribution=prompt/step_description 才会出现）
[n] id=... attribution=... title=... lesson 正文（内含信号计数）
```

- 教训不占 top-200 资产池配额（量少、价值密度高），追加在池外。
- **已被 pending/approved 提案引用的教训不进输入**；被 rejected 提案引用的教训重新进输入但 prompt 注明「曾有提案被驳回，除非有新证据勿重复同案」。

**判据（kind 分治）**：

| kind | 证据判据 | body 语义 |
|---|---|---|
| `prompt_amendment`（R3 既有） | 跨线普适 ≥2 线（不变） | 追加增量 |
| `prompt_correction`（新） | **频次判据**：同一模块同一类误解被 ≥2 个独立信号命中；**或单个人工回滚信号即可**（人工已判定=最强证据）。rationale 必须写明信号数与类型 | **修正后的模块完整正文**（同 skill_revision 的全文语义，可增可删可改） |
| `skill_revision`（R3 既有） | 跨线普适 ≥2 线（不变） | 修订后完整正文 |

- `prompt_correction` 的 target 只能选主 prompt/tool 组模块（group != 'skill'；skill 的修正走 skill_revision）。
- 四判据中「非线内事实」对全部 kind 不变（修正文案本身也禁凭据/URL）。

### 5.3 校验与入库（R3 既有逻辑扩展）

- prompt_correction：target ∈ 注册表且 group != 'skill'；**baseSeq 服务端定值**（盘点时查 target 当前 max(seq) 填入，不信任 LLM）；sources = lesson 引用（type:'lesson'，修剪同 R3）。
- input_summary 扩键：`{memories, trajectories, lessons, signals, proposals, notes}`（前端 batchSummary 对缺失键回 0，向后兼容）。

## 6. 审批与应用

- 审批流/乐观锁/驳回全部复用 R3（proposals UI 不分 kind 分叉，除 diff 展示）。
- **prompt_correction 应用**：校验 target ∈ 注册表且 group != 'skill'；校验当前 max(seq) == baseSeq（不等 → apply_error「模块已被人工修改，请重新盘点」，status 回 pending，人工可驳回或重新盘点）；写版本行 `value=body, source='solidify_apply', sourceRef=proposal.id`（sourceRef partial unique 幂等，R3 既有）；**将该提案 sources 内的 lesson 置 resolved**（resolvedByProposal=proposal.id）。
- skill_revision / prompt_amendment 应用与退役语义不变（retireIds 只对 memory/trajectory 来源有效；lesson 来源不走退役——应用即 resolved）。
- 教训人工退役：`POST /assistant/failure-lessons/:id/retire`（误报/决定不修）。

## 7. REST 路由（挂 `/api/assistant` 下 requireManager）

| 方法与路径 | 用途 |
|---|---|
| GET `/assistant/failure-lessons?status=` | 教训列表（审批详情的来源展示复用） |
| POST `/assistant/failure-lessons/:id/retire` | 人工退役 |
| （其余全部复用 R3 路由，proposals 的 kind/baseSeq 随现有端点透出） | |

`assistant_failure_signals` 不暴露路由（内部采集层）。

## 8. Web 界面（设置页）

1. **固化盘点 Section** 加「失败教训」块：active 教训列表（attribution badge / title / 信号数 / 时间），行内 retire 按钮。resolved/retired 默认折叠（count 显示）。
2. **提案详情**：kind badge 扩 `prompt_correction`；diff 展示复用 skill_revision 的「当前值 vs 提案正文」全文 diff；来源清单 lesson 行显示 title + attribution + 信号摘录（signals.excerpt）。
3. 批次行 summary 格式扩 lessons 计数（`solidifyBatchSummary` 文案加「教训 {{lessons}}」，batchSummary 解析器加键）。

## 9. 测试策略

- **信号落库**：nlAiFail 失败 → 信号行落库（payload 字段断言）；同 (threadId, caseId, stepOrder) 第二轮 → 不重复；INSERT 失败不影响 verify 返回（fire-and-forget）。
- **教训蒸馏**：stub LLM——零信号跳过 call#1 且批次行为与 R3 全量一致（红线断言）；platform 归因教训入库但不进 call#2 输入；单条 zod 失败丢弃；已消费信号不重复喂；signalRef 剔空丢弃。
- **提案与应用**：prompt_correction 全链路（盘点→审批→版本行 value=body + sourceRef 幂等 + lesson 置 resolved）；baseSeq 冲突路径（scan 后人工改模块 → approve → apply_error + 回 pending）；target=skill.* 拒绝；频次判据由 prompt 约束（测试只锚定服务端校验，不测 LLM 判据本身）。
- **幂等与回归**：R3 既有测试（promptModules / solidify / 渲染红线）全绿；零信号红线的可测试口径=call#1 不发生 + call#2 输入不含【失败教训】节（R3 节构成不变）；input_summary 按 §5.3 统一扩 lessons/signals 键（零信号时为 0，前端缺失键回 0 兼容老批次）；R1/R2 注入回归不受影响。

## 10. 非目标（YAGNI）

- **不做**全量失败会话/缓慢会话挖掘——归因不可靠（prod228 实证大头在平台侧），等教训层证明价值后再评估带归因辅助的受控扩展。
- **不做**会话内自由文本纠偏挖掘（用户纠偏走 S2 反馈按钮这条结构化通道）。
- **不做**信号的用户答复回填（触碰核心聊天链路；审批人开线程看）。
- **不做**教训相似聚类去重（LLM 判据内完成 + 人工审批兜底）。
- **不做**自动定期盘点/信号阈值触发（R5 范围）。
- **不做** platform/sut 归因教训的消费面板（数据已留，R5 做）。
- **不做** skill_revision 的 baseSeq 防护（同款陈旧基线风险已知，独立 backlog，避免本期扩大 R3 修改面）。

## 11. R5 接口预留

- lessons 表即 R5「有效性印证」底座：correction 应用后，同类 nlAiFail 信号增速下降 = 修正生效证据（信号表按 type/caseId 可聚合）。
- platform 归因教训沉淀 = 平台改进 backlog 素材（prod228 那批闸门/导航问题的自动化发现通道）。
- 批次 input_summary 的 lessons/signals 时序 = R5 盘点面板的天然曲线数据。
