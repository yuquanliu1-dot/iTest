# R3.6 会话质量盘点——历史会话纳入固化盘点 实施计划

日期：2026-11-01 · 状态：待实施
Spec：`docs/superpowers/specs/2026-11-01-assistant-session-quality-design.md`
前置：R3.5 失败教训蒸馏已落 main 并发 prod228（4daddf0 批次）。

## For agentic workers

- 逐任务 TDD：先写失败测试 → 跑红 → 实现 → 跑绿 → 提交。每个任务独立可交付，按序执行（1→7 有依赖）。
- 跑单测：`cd apps/api && npx vitest run test/<file>.test.ts`（testcontainers 首启较慢，超时 60s 已内建）。
- 跑全量：`cd apps/api && npm test`（sendSyslog 基线即红是已知噪声，非回归）。
- Web 校验：`cd apps/web && pnpm verify`（typecheck + build）。
- **收尾必查 `git status`**：api 测试可能污染仓库源码（反引号写进模板字面量），陌生改动先还原（历史教训见 memory）。
- 每个 checkbox 完成后打钩；提交信息已在各任务末尾给出。

## Goal

R3.5 盘点只消费三类「已判定失败」信号，prod 全空 → 秒完无事可做。R3.6 把**近 7 天的历史会话（无论成败）纳入盘点**：LLM 分析会话过程的提示词侧优化空间（冗余绕探/耗时过长/verify 死循环/产出不专业），产出修正提案。

```
ai_threads(chat, 7d, ≤30) → JSONL 现算指标+嫌疑分 → top12
  └→ S4 session 信号（append 在 S1/S2/S3 后）→ 既有 call#1 归因判别
       ├→ platform（均匀长间隔无冗余）→ 只入库不产提案（三道闸）
       └→ prompt/step_description → 既有 call#2 → prompt_correction → 人工审批
```

红线：**零信号行为与 R3.5 等价**（早退条件不变；`solidify-service.test.ts:225` 红线断言不改且保持绿）；**零 schema 改动**（无新表列、归因枚举不变）。

## Tech Stack

- api：Express + drizzle-orm + vitest + testcontainers（postgres:16-alpine）
- 解析：`scheduler/trajectoryParse.ts`（纯函数，零依赖）
- LLM：`completeJson(client, {systemPrompt, userMessage})`（与 R3/R3.5 同一客户端）

## 关键背景（实现前必读）

1. **会话双存储**：`ai_threads` 表（piThreadId 存**完整 JSONL 路径**，purpose='chat'|'rca'，updatedAt）+ 共享卷 JSONL（3 副本同卷；每行 `{type:'message', timestamp, message}`，**行带 ISO 时间戳**→时长可算）。
2. **import 约束**：新模块 `sessionSignals.ts` 只许 import trajectoryParse（纯）+ `pi/repo.ts`（:14 `DATA_DIR`，安全）+ db；**禁止** import `pi/space/session.ts`（重型运行时，SESSIONS_ROOT 在 :42 就地重推导）与 `scheduler/trajectoryWorker.ts`（bullmq）。`findSessionFile` 从 trajectoryWorker.ts:48-62 复制 ~15 行（先直路径后 readdir 兜底）——与 withLlmTimeout 三处复制同为断环先例，注释写明。
3. **消费幂等 refId**：`session#<threadId>#<updatedAtEpochMs>`。同 epoch=同内容=抑制；UPDATE updated_at → 新 epoch → 可重喂。已消费判定在**读文件前**做（省 IO）。记账所有权留在 failureLessons（consumed 集合由它算好传入）。
4. **早退与 summary 零改动**：solidifyService 早退条件 `merged.length===0 && signalBundle.signals.length===0` 不动——会话信号走 signalBundle，早退语义自动兼容。summary 结构 `{memories,trajectories,lessons,signals,proposals,notes}` 不动。
5. **红线**：`solidify-service.test.ts:225`「零信号 → call#1 不发生 + 入参不含【失败教训】」不改原断言（测试库无线程，行为不变）。
6. **cap 优先级**：会话信号 append 在 S1/S2/S3 之后、`slice(0, SIGNAL_CAP=60)` 之前——S1 天然优先；选样本身限 12，挤占风险可控。
7. **JSONL 读取护栏**：`stat` >8MB 跳过并记 note；坏行/缺文件静默跳；候选 30 条、top12 选样，三重上限。
8. **归因判别口径**（call#1 prompt 增补）：提示词侧=可归因到引导文案的重复绕探/verify 死循环/产出不专业（测试专家口径）；平台侧=均匀的单调用长间隔（如每轮 60-90s）而无冗余逻辑、容器/网关停顿 → 必须 'platform'；宁缺毋滥。
9. **timestamp 透传是纯增量**：`parseSessionJsonl` 行类型加 `timestamp?: string`，`ParsedTurn` 加 `timestamp?: number`（NaN 守卫）。既有消费面（findVerifiedLocalIds/compressConversation/trajectoryWorker）零影响。
10. **非目标**：RCA 会话（purpose='rca'）排除；零新表；不做指标持久化；不做自动定期盘点；不加归因枚举值；不做前端信号明细展示。

## File Structure

```
apps/api/src/scheduler/trajectoryParse.ts        # 改：行类型+ParsedTurn 透传 timestamp（纯增量）
apps/api/test/trajectory-parse.test.ts           # 改：timestamp 断言（有/缺/坏）
apps/api/src/pi/space/sessionSignals.ts          # 新：findSessionFile+指标+嫌疑分+collectSessionSignals
apps/api/test/session-signals.test.ts            # 新：纯函数（无 DB）
apps/api/test/session-signals-collector.test.ts  # 新：采集器（testcontainers+临时目录 JSONL）
apps/api/src/pi/space/failureLessons.ts          # 改：SignalType+'session'+collectUnconsumedSignals(deps)
apps/api/test/failure-lessons.test.ts            # 改：session 流经蒸馏+merge 顺序/cap
apps/api/src/pi/space/solidifyService.ts         # 改：deps.sessionsRoot+两 prompt 增补
apps/api/test/solidify-service.test.ts           # 改：会话 fixture 用例（红线断言不动）
apps/web/src/i18n/locales/zh-CN/settings.json    # 改：solidifyIntro 文案
apps/web/src/i18n/locales/en-US/settings.json    # 改：solidifyIntro 文案
```

---

## Task 0：文档（spec + 本计划）

- [x] 0.1 新 `docs/superpowers/specs/2026-11-01-assistant-session-quality-design.md`：解除非目标的理由与护栏 / 信号形状 / 嫌疑分权重 / 归因判别口径 / 零 schema 声明 / 测试策略 / 非目标。
- [x] 0.2 新 `docs/superpowers/plans/2026-11-01-assistant-session-quality.md`（本文件）。
- [x] 0.3 提交：

```
docs(specs): R3.6 会话质量盘点设计+实施计划——历史会话纳入固化盘点
```

## Task 1：解析层透传 timestamp

- [x] 1.1 `apps/api/src/scheduler/trajectoryParse.ts`：行类型（:23）加 `timestamp?: string`；`ParsedTurn`（:9-16）加 `timestamp?: number`。三分支（user :33-35 / assistant :36-42 / toolResult :43-52）各带 `Date.parse` + `Number.isNaN` 守卫（`const ts = line.timestamp ? Date.parse(line.timestamp) : NaN;` → `...(Number.isNaN(ts) ? {} : { timestamp: ts })`）。
- [x] 1.2 `apps/api/test/trajectory-parse.test.ts` 新断言（fixture msgLine helper 加 timestamp 参数）：有 timestamp 行 → epoch ms；缺/坏（`"timestamp":"not-a-date"`）→ undefined；user/assistant/toolResult 三分支覆盖。
- [x] 1.3 跑红→绿：`npx vitest run test/trajectory-parse.test.ts`。既有消费面零影响（findVerifiedLocalIds/compressConversation 不读该字段）。
- [x] 1.4 提交：

```
feat(scheduler): R3.6 parseSessionJsonl 透传行级 timestamp
```

## Task 2：纯函数——指标 + 嫌疑分

- [x] 2.1 新 `apps/api/src/pi/space/sessionSignals.ts`：

```ts
export const DEFAULT_SESSIONS_ROOT = path.join(DATA_DIR, 'pi-sessions'); // session.ts:42 同源；禁止 import session.ts/trajectoryWorker
export function findSessionFile(sessionsRoot: string, piThreadId: string): Promise<string | null>; // trajectoryWorker.ts:48-62 同款复制（断环先例）
export interface SessionMetrics {
  durationMs: number | null;
  turns: number;
  toolCallsByName: Record<string, number>;
  toolResultErrors: number;
  verifyCalls: number;
  repeatedIdenticalToolCalls: number; // name+JSON.stringify(arguments) 重复出现计数
}
export function computeSessionMetrics(turns: ParsedTurn[]): SessionMetrics;
export function sessionSuspicionScore(m: SessionMetrics, ctx: { negativeFeedback: boolean; nlAiFailCount: number }): number;
```

权重：时长 ≥30min +3 / ≥10min +2；verifyCalls ≥6 +4 / ≥3 +2；toolResultErrors ×2 封顶 4；repeatedIdentical ≥2 +2；turns ≥20 +1；负反馈 +3；nlAiFailCount ≥1 起 +2 每多 +1 封顶 4。
- [x] 2.2 新 `apps/api/test/session-signals.test.ts`（无 DB，fixture turns）：各权重断言 + 排序（score desc → updatedAt desc 的比较器若在此层导出则一并测）+ duration null（无 timestamp）。
- [x] 2.3 跑红→绿：`npx vitest run test/session-signals.test.ts`。
- [x] 2.4 提交：

```
feat(space): R3.6 会话指标+嫌疑分纯函数——时长/verify/工具错误/重复调用加权选样
```

## Task 3：采集器（DB+fs）

- [x] 3.1 `sessionSignals.ts` 追加 `collectSessionSignals({ consumedRefIds, sessionsRoot?, now? })`：
  1. 查 `ai_threads`：`purpose='chat' AND updatedAt >= now()-7d AND piThreadId <> ''` order by updatedAt desc limit 30；
  2. refId（`${id}#${updatedAt.getTime()}`）已消费的**读文件前剔除**；
  3. 辅助映射：负反馈 threadId 集合（ai_assistant_feedback sentiment='negative'）、nl_ai_fail 按 thread_id 计数（assistant_failure_signals）；
  4. 读文件（stat >8MB 跳过记 note；坏行/缺文件静默跳）→ parseSessionJsonl → computeSessionMetrics → 打分 → top 12；
  5. 产出 CollectedSignal：`key/refId = session#<threadId>#<epoch>`、`type:'session'`、`title`（`会话 N 轮/Xmin · verify N 次 · 工具错误 N[ · 含负反馈]`，时长未知省略时长段）、`excerpt` = 指标头 + `compressConversation(turns, 2000)`、`line:'global'`、`time=updatedAt ISO`、`selfSolidify:false`。返回 `{ signals, notes }`。
- [x] 3.2 新 `apps/api/test/session-signals-collector.test.ts`（testcontainers + 临时目录 fixture JSONL，复用 trajectory-parse 的 msgLine 造行法）：窗口内 chat → 1 信号 + key 格式 + excerpt 含指标头与首条用户消息；消费幂等（同 epoch 抑制 / UPDATE updated_at → 新 epoch 重喂）；rca 排除；8 天前排除；>30 条候选截断；top-12 选样；坏文件跳过不炸批；缺文件静默；>8MB 跳过记 note。
- [x] 3.3 跑红→绿。
- [x] 3.4 提交：

```
feat(space): R3.6 会话信号采集器——7d/30候选/8MB/12选样四重护栏+epoch 消费幂等
```

## Task 4：并入 failureLessons

- [x] 4.1 `apps/api/src/pi/space/failureLessons.ts`：`SignalType` 加 `'session'`；`collectUnconsumedSignals(deps?: { sessionsRoot?: string })` 在 S1/S2/S3 之后 merge `collectSessionSignals({ consumedRefIds: [...consumed], sessionsRoot: deps?.sessionsRoot })`（后 append → SIGNAL_CAP=60 slice 保 S1 优先）；采集器 notes 合并进返回值（供上层 summary）。
- [x] 4.2 `apps/api/test/failure-lessons.test.ts` 新增：session 信号流经 distillLessons（signalRefs `session#...` 接受入库，lesson.signals 记 `{type:'session', refId, excerpt}`）；merge 顺序与 cap 优先级（S1+70 条 nl_ai_fail 时 S1 保留、session 被 slice 截掉的边界按 append 序断言）。
- [x] 4.3 跑绿：`npx vitest run test/failure-lessons.test.ts`。
- [x] 4.4 提交：

```
feat(space): R3.6 S4 session 信号并入信号聚合——append 末位保 S1 优先,记账所有权不外移
```

## Task 5：solidifyService 接线 + 提示词

- [x] 5.1 `apps/api/src/pi/space/solidifyService.ts`：
  - `SolidifyRunDeps` 加 `sessionsRoot?: string`，透传 `collectUnconsumedSignals({ sessionsRoot: deps.sessionsRoot })`；早退/summary 结构零改动。
  - `LESSON_SYSTEM_PROMPT` 增补：session 信号语义（近 7 天 chat 会话压缩流+量化指标头）；归因判别口径（关键背景 8 全文）。
  - `SOLIDIFY_SYSTEM_PROMPT` 判据 4 的 prompt_correction 频次措辞扩「（含 session 会话证据教训）」；rationale 要求引用会话信号数。
- [x] 5.2 `apps/api/test/solidify-service.test.ts` 新增（红线断言 **不动**）：
  - 无线程 → 既有红线绿；
  - 可疑会话 fixture（deps.sessionsRoot 指向临时目录）→ call#1 输入含 `type=session`；
  - LLM 归 platform → 教训入库但不出现在 call#2 输入；
  - 归 prompt → prompt_correction 提案 sources 引用会话教训。
- [x] 5.3 跑绿：`npx vitest run test/solidify-service.test.ts`（R3/R3.5 既有用例必须全绿）。
- [x] 5.4 提交：

```
feat(space): R3.6 盘点接线——会话信号进蒸馏输入+提示词侧/平台侧归因判别口径
```

## Task 6：Web 文案

- [x] 6.1 zh `solidifyIntro`：「从助手记忆、轨迹与近期会话质量蒸馏跨产品线的泛化经验产出提案——LLM 只产提案，应用一律经人工批准。」en 对应补 `/ recent session quality` 语义。
- [x] 6.2 `cd apps/web && pnpm verify`。
- [x] 6.3 提交：

```
feat(web): R3.6 固化盘点文案纳入近期会话质量语义
```

## Task 7：回归收尾

- [x] 7.1 api 全量：`cd apps/api && npm test`（sendSyslog 基线红为既有噪声）；trajectory-parse / trajectory-worker / space-session 相关套件绿。
- [x] 7.2 `git status` 核对无源码污染（历史教训：测试把反引号写进模板字面量）。
- [x] 7.3 dev 冒烟：dev 库插一条 chat ai_threads 行 + 手写 JSONL 到 dev 容器 pi-sessions → UI 发起盘点 → 批次 summary 出会话信号计数 → 教训块渲染（网关慢则按设计降级，信号保留）。
- [x] 7.4 发版 prod228 + 锚点记录：api dist grep `sessionSignals`/`computeSessionMetrics`/归因判别措辞；web bundle 含新 intro 文案。

---

## 风险与回退

| 风险 | 缓解 |
|---|---|
| fs IO 拖慢扫描（共享卷 30 文件） | 8MB / 12 条选样 / 30 候选三重上限；已消费线程读前剔除 |
| LLM 把平台慢误归 prompt → 错误补丁 | LESSON 判别口径 + platform 不进提案（既有闸门） + 人工审批——三道闸 |
| refId epoch 碰撞 | 同 epoch=同内容=正确抑制；pg 毫秒精度足够 |
| 会话信号挤占 cap 60 挤掉 S1 | append 在最后再 slice；选样本就限 12 |
| import 环/重型依赖漂移 | 新模块只 import trajectoryParse(纯)+repo.ts(DATA_DIR)+db；注释禁令 |
| 回退 | 全部增量（一个纯增量字段+一个新模块+merge/prompt 增补+文案）；零 schema 改动，revert 提交即可回退 |
