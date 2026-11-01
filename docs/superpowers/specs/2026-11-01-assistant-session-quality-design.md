# R3.6 会话质量盘点——历史会话纳入固化盘点（设计）

日期：2026-11-01 · 状态：已批准
前置：R3.5 失败教训蒸馏已发 prod228（4daddf0 批次）。
Spec 关系：本设计**有控解除** R3.5 spec 的非目标「全量失败会话挖掘」（design.md:93/:173）。

## 1. 背景与定位

R3.5 盘点只消费三类高精度失败信号（S1 回滚 / S2 负反馈 / S3 nlAiFail）。这三类的共性是「有人或机制已判定失败」，精度高但覆盖窄——prod 上三类全空，扫描秒完无事可做。而实际会话中大量存在**没有被判定为失败、但过程有优化空间**的情况：

- 提示词引导导致的冗余绕探（反复试错才找到正确路径）；
- verify 死循环（同一断言多轮不过）；
- 会话耗时过长（用户体验差）；
- 产出不够专业（对标专业测试专家的口径）。

用户需求：把**最近的历史会话（无论成败）纳入盘点**，让 LLM 分析提示词侧的优化空间并产出修正提案。

### 1.1 为什么 R3.5 当初列为非目标，现在可以有控解除

R3.5 的三条否决理由与今天的承接方案：

| R3.5 否决理由 | 现在的承接 |
|---|---|
| 归因不可靠（失败可能是平台慢不是提示词错） | 复用既有 4-way 归因判别 + 判别口径写死「均匀长间隔→platform」；platform 教训天然不进提案（三道闸，见 §4） |
| 体量/凭据风险（全量会话太大） | 有界窗口：近 7 天 · 至多读 30 条 JSONL · 按嫌疑分选 12 条；excerpt 走 compressConversation 压缩（2000 字符预算） |
| prod 失败大头是平台侧 | 判别口径明确把平台侧慢排除在提案之外，宁缺毋滥 |

## 2. 总体方案

```
ai_threads(purpose='chat', updatedAt ∈ 近7d, ≤30 条候选)
  └→ 读共享卷 pi-sessions JSONL（>8MB 跳过；坏行/缺文件静默跳）
       └→ parseSessionJsonl（透传行级 timestamp）→ computeSessionMetrics → sessionSuspicionScore
            └→ 按嫌疑分取 top 12 → S4 'session' 信号
                 └→ append 到 S1/S2/S3 之后（SIGNAL_CAP=60 slice 语义不变，S1 优先保留）
                      └→ 既有教训蒸馏 call#1（4-way 归因判别：提示词侧冗余 vs 平台侧慢）
                           └→ prompt/step_description 教训 → 既有资产蒸馏 call#2（prompt_correction 等）
                                └→ 人工审批（既有铁律不变）
```

**零新表**：信号扫描时从 `ai_threads` + pi-sessions JSONL 现算；消费幂等复用 R3.5 的 `lessons.signals[].refId` 记账（一条信号最多蒸馏进一条教训的不变量不变）。

## 3. 数据模型（零改动）

无新表、无新列、无枚举变更：

- `ai_threads`（schema.ts:93-117）：只读查询。`piThreadId` 存完整 JSONL 路径；`purpose='chat'|'rca'`；`updatedAt` 做窗口与 refId 组成。
- `assistant_failure_lessons.signals`（jsonb）：session 信号的记账格式与既有完全同形 `{type:'session', refId, excerpt}`。
- 归因枚举不变（`prompt|step_description|platform|sut`），web 端 `LESSON_ATTRIBUTION_KEY` 已覆盖四值。

## 4. 信号形状与消费幂等

### 4.1 信号形状

```
key / refId = session#<threadId>#<updatedAtEpochMs>
type        = 'session'
time        = ai_threads.updatedAt
line        = 'global'（会话信号不做线隔离，同教训层口径）
title       = 会话 N 轮/Xmin · verify N 次 · 工具错误 N[ · 含负反馈]（时长未知时省略时长段）
excerpt     = 指标头（时长/轮数/verify/工具错误/重复调用计数）+ compressConversation(turns, 2000)
selfSolidify = false
```

### 4.2 消费幂等（epoch 即版本）

- refId 含 `updatedAt` epoch 毫秒：**同 epoch = 同内容 = 正确抑制**；线程有新消息 → updatedAt 前进 → 新 refId → 可再次分析。pg 毫秒精度足够，无碰撞担忧。
- 已消费判定在**读文件之前**做（省 IO）：30 条候选先剔掉 refId 已被任意 status 教训引用的线程。

### 4.3 嫌疑分与选样

`SessionMetrics`（纯函数计算）：`durationMs`（首末轮 timestamp 差；无 timestamp → null）、`turns`、`toolCallsByName`、`toolResultErrors`、`verifyCalls`、`repeatedIdenticalToolCalls`（name+arguments 完全相同的重复调用次数）。

`sessionSuspicionScore(m, ctx)` 权重（ctx = {negativeFeedback, nlAiFailCount}）：

| 维度 | 计分 |
|---|---|
| durationMs ≥30min / ≥10min | +3 / +2 |
| verifyCalls ≥6 / ≥3 | +4 / +2 |
| toolResultErrors | ×2（封顶 4） |
| repeatedIdenticalToolCalls ≥2 | +2 |
| turns ≥20 | +1 |
| 负反馈命中 | +3 |
| nlAiFailCount | ≥1 起 +2，每多 +1（封顶 4） |

排序 `score desc → updatedAt desc`，取前 12 条进蒸馏输入。选样在采集器内完成，**不挤占 SIGNAL_CAP**（append 在最后再 slice(0,60)，S1 优先保留）。

## 5. 归因判别口径（本设计的核心判断题）

LESSON 蒸馏 prompt（call#1）对 session 信号增补判别标准：

- **提示词侧（prompt / step_description）**：过程模式可归因到引导文案——重复绕探（同目标反复试不同路径）、verify 死循环（同一断言多轮不过）、产出不够专业（不符合专业测试专家口径：步骤粒度、断言写法、报告表述等）。
- **平台侧（必须判 platform）**：均匀的单调用长间隔（如每轮 60-90s）而**无冗余逻辑**、容器/网关停顿、元素清单截断等平台机制。这类**严禁**变成提示词补丁——platform 归因教训由 `listProposalInputLessons`（只取 prompt/step_description）天然挡在提案之外。

三道闸：① call#1 判别口径写死；② platform 不进 call#2 输入（既有）；③ 人工审批兜底（既有）。

## 6. 管线接线（改动面）

| 模块 | 改动 |
|---|---|
| `scheduler/trajectoryParse.ts` | `parseSessionJsonl` 行类型加 `timestamp?: string`，`ParsedTurn` 加 `timestamp?: number`（`Date.parse` + NaN 守卫）。纯增量，既有消费面（findVerifiedLocalIds / compressConversation / trajectoryWorker）零影响。 |
| `pi/space/sessionSignals.ts`（新） | 纯指标/打分函数 + `collectSessionSignals`（DB+fs 采集器）。import 只允许 trajectoryParse（纯）+ pi/repo.ts（DATA_DIR）+ db；**禁止** import pi/space/session.ts（重型运行时）与 scheduler/trajectoryWorker.ts（bullmq）。`findSessionFile` 从 trajectoryWorker 复制 ~15 行（与 withLlmTimeout 三处复制同为断环先例）。 |
| `pi/space/failureLessons.ts` | `SignalType` 加 `'session'`；`collectUnconsumedSignals(deps?: { sessionsRoot? })` 在 S1/S2/S3 之后 merge 会话信号；consumed 集合传入采集器（记账所有权留在 failureLessons）。 |
| `pi/space/solidifyService.ts` | `SolidifyRunDeps` 加 `sessionsRoot?: string`（测试 DI）；LESSON/SOLIDIFY prompt 增补（§5 与判据 4 措辞「（含 session 会话证据教训）」）；早退条件与 summary 结构**零改动**（会话信号走 signalBundle）。 |
| web | 仅 `solidifyIntro` 文案（zh/en）补「/近期会话质量」语义。 |

红线：`solidify-service.test.ts` 的「零信号 → call#1 不发生 + 无【失败教训】节」断言保持原样全绿（测试库无会话线程，行为不变）。

## 7. RCA 会话排除

`purpose='rca'`（RCA 复盘会话）v1 **不纳入**：RCA 自身有独立的复盘链路，且 RCA 会话内容是归因分析而非执行过程，混入会稀释嫌疑分语义。后续如需纳入单独评估。

## 8. 测试策略

- **trajectory-parse.test.ts**：有 timestamp 行 → ParsedTurn.epoch ms；缺/坏 → undefined（三分支 user/assistant/toolResult）。
- **session-signals.test.ts**（新，无 DB，fixture turns）：各权重断言 + 排序 + duration null 路径。
- **采集器测试**（testcontainers + 临时目录 fixture JSONL）：窗口内 chat 产 1 信号 + key 格式 + excerpt 含指标头与首条用户消息；消费幂等（同 epoch 抑制 / UPDATE updated_at → 新 epoch 重喂）；rca 排除；8 天前排除；>30 条候选截断；top-12 选样；坏文件跳过不炸批；缺文件静默；>8MB 跳过记 note。
- **failure-lessons.test.ts**：session 信号流经 distillLessons（signalRefs `session#...` 接受入库）；merge 顺序与 cap 优先级。
- **solidify-service.test.ts**：无线程 → 既有红线绿（不改原断言）；可疑会话 fixture → call#1 输入含 type=session；LLM 归 platform → 教训入库但不出现在 call#2 输入；归 prompt → prompt_correction 提案 sources 引用会话教训。

## 9. 非目标（YAGNI）

- 不做 RCA 会话纳入（§7）。
- 不做会话指标持久化（零新表，扫描时现算）。
- 不做自动定期盘点（沿 R3.5，人工触发）。
- 不做会话信号的产品线隔离（line='global'）。
- 不加新归因枚举值（复用 4-way）。
- 不做前端会话信号明细展示（信号类型仅计数渲染——批次 summary 的 signals 计数已覆盖）。
- 不做用户答复回填、教训聚类去重（沿 R3.5 非目标）。

## 10. R5 接口预留

会话级证据（指标 + 嫌疑分 + 归因教训）为 R5 自优化的「盘点→印证」层提供会话维度底座：`assistant_failure_lessons` 已是 R5 接口，本设计只是给它的输入端增加一类信号源，R5 侧无需感知。
