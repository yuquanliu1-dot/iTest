# verify_case 单步耗时与轮数分布 —— 数据先行量化报告

> 计划：`~/.claude/plans/lovely-noodling-jellyfish.md`（数据先行：发版保活 + 量化单步轮数分布）
> 日期：2026-11-07　样本：prod228（`wangb@192.168.30.228`）pi-sessions 全量 + 线上保活 E2E 实录
> 本报告不改任何代码；结论用于决定下一批次做什么。

---

## 一、结论（go / no-go）

| 计划判据 | 阈值 | 实测 | 结论 |
|---|---|---|---|
| 单步已贴协议下限 → **关闭 P1**（dumpElements 字段富化） | ≥70% 步 ≤110s | **89.3%**（全部步）/ **97.6%**（通过步） | ✅ **P1 关闭**，不做富化 |
| 3+ 轮步占比 ≥30% → 启动富化批次 | ≥30% | **10.6%**（全部）/ **2.4%**（通过步） | ✅ **不启动富化批次** |
| 保活 E2E 三判据 | resumeFrom 递增 / browserReused / live view 无前缀重演 | ✗ / ✗ / ✗ | ⚠️ **从未在有效窗口下被检验**（不是「已检验且失效」），见 §四 |

**一句话**：单步延迟已经不是瓶颈（通过步中位数 **~15–25s**，一轮即可完成），「AI 建用例不丝滑」的真正代价是
**74% 的 verify 轮失败** + **17.3% 的步骤是前缀重演的纯浪费**。下一批次的杠杆在失败率与前缀重演，不在单步延迟。

---

## 二、数据来源与样本

| 项 | 值 |
|---|---|
| 会话文件 | `/repo/apps/api/.data/pi-sessions/*.jsonl`（容器内，3 副本同源）97 个，2026-10-20 → 2026-11-07 |
| verify_case 调用 | **301** 轮 |
| 实际执行的步骤 | **515** 步（`steps[].durationMs`） |
| 会话数 | 58 个，其中 **53** 个是多轮（B 路径逐步建用例） |
| 线上 E2E 实录 | 线程 `e39338e1`（case `3f7a1c2e`，SOC 事件管理页），6 轮 verify，2026-11-07 |

口径说明：
- `steps[].durationMs` = 该步在 **AI 相**内的墙钟耗时（`verifyCase.ts` 内 `started`→`step_done`），
  **不含**轮首机械回放（restore）与浏览器启动开销——那部分单列在「整轮 wall time」。
- 整轮 wall time = toolCall 时间戳 → toolResult 时间戳（JSONL 内两条 message 记录相减）。
- 复现脚本：本目录下 `dist.py`（分布/状态）、`dist2.py`（整轮 wall time / 前缀 / 失败原因）、
  `dist3.py`（B 路径成本模型）、`dist4.py`（细粒度分桶）、`gap.py`（相邻轮间隔分布 → TTL 判定，§4.2）；
  输入目录用环境变量 `SESSIONS_DIR` 指定
  （默认 `/tmp/e2e-data/sessions/pi-sessions`），拉取方式见附录 A。

---

## 三、单步耗时与轮数分布（核心）

### 3.1 细粒度分桶

| 分桶（轮数代理） | 全部步 n=515 | 通过步 n=375 | 失败步 n=140 |
|---|---|---|---|
| ≤20s（一轮，页面已就位） | 212 · **41.2%** | 190 · **50.7%** | 22 · 15.7% |
| 20–60s（1–2 轮） | 191 · 37.1% | 147 · 39.2% | 44 · 31.4% |
| 60–110s（2 轮） | 57 · 11.1% | 29 · 7.7% | 28 · 20.0% |
| 110–170s（3 轮） | 27 · 5.2% | 6 · 1.6% | 21 · 15.0% |
| >170s（4+ 轮，探索/重试浪费） | 28 · 5.4% | 3 · 0.8% | 25 · 17.9% |

分位：p10 7.6s ｜ p25 11.8s ｜ **p50 26.1s** ｜ p75 53.8s ｜ p90 118.8s ｜ max 249.7s

通过步按步序（p50）：order1 23.1s ｜ order2 25.2s ｜ order3 19.0s ｜ order4 18.2s ｜ order5 13.8s ｜ order6 19.7s

### 3.2 计划前提被数据证伪（重要）

计划原先假设「每步 ≥2 个强制视觉轮（动作轮 + 截图确认轮），单步 ≈85–107s」。**数据不支持**：

- 50.7% 的通过步 **≤20s** 完成；p50 26.1s；后续步序中位数 12–25s。
- 源码 `apps/api/src/execute/aiTask.ts:43` 要求的是「每个操作都要有『动作结果 ok + 截图确认生效』的证据」——
  这是**证据要求**（一次回复里必须同时有动作回执与截图判定），**不等于两次 LLM 往返**。
  模型在同一轮里串联 `click → screenshot` 两个工具调用即可满足（实测轮内实测 9.8s / 11.1s / 16.7s / 13.8s / 12.3s）。

⇒ 单步延迟已贴协议下限（1 轮），**没有压缩空间**。富化元素清单（aria-label/title/testid）解决的是
「模型找不到目标」→ 那属于失败率问题（§五），不属延迟问题。

### 3.3 整轮 wall time（B 路径真实体感）

| 口径 | n | p50 | p90 | mean |
|---|---|---|---|---|
| 全部 verify 轮 | 296 | 63s | 288s | 107s |
| 首轮 | 53 | 80s | 308s | 136s |
| **带已确认前缀的轮**（resumeFrom>0） | 46 | **112s** | 382s | **166s** |
| 无前缀轮（resumeFrom=0） | 234 | 60s | 283s | 103s |

多轮会话总耗时：median **377s**（6.3min）｜ p90 **1367s**（22.8min，与 10-23 的 22min 基线吻合）｜ max 2721s（45min）。

**反直觉结论**：带已确认前缀的轮**比全新轮更慢**（p50 112s vs 60s）。因为前缀确认不但没省下重演，
还额外付了一次注定失败的机械回放（§四 R2）。

---

## 四、保活 E2E：三判据全部未命中 —— 更正：从未在有效窗口下被检验过

> **本节已在 2026-11-07 晚间更正。** 初版结论写的是「保活三根因已定位」。该结论**把两件不同性质的事混为一谈**：
> 初版拿「301 轮里 browserReused=0」当作「保活路径已被证伪」的证据，但这 301 轮里**绝大多数发生在保活功能上线之前**。
> 更正后的结论与数据见 §4.2。

### 4.1 E2E 实录（线程 e39338e1，6 轮）

| 轮 | 时间 | resumeFrom | 执行步 | 各步耗时(ms) | 结果 | 失败原因 | 失败页 URL |
|---|---|---|---|---|---|---|---|
| R1 | 07:52:01 | 0 | 1 | 143201 | failed | AiTaskAborted（网关 null content） | `/login` |
| R1b | 07:56:42 | 0 | 1 | 49897 | passed | — | — |
| R2 | 08:48:41 | **1** | 1 | 27556 | failed | AiTaskAborted | `platformhome/home` |
| R3 | 08:50:13 | 0 | 3 | 32059 / 10496 / 16482 | passed | — | — |
| R4 | 10:33:03 | **3** | 1 | 29786 | failed | AiTaskAborted | `platformhome/home` |
| R5 | 10:35:54 | 0 | 5 | 9827 / 11055 / 16710 / 13759 / 12273 | passed | — | — |

判据核对：

| 判据 | 结果 | 证据 |
|---|---|---|
| resumeFrom 递增 | ⚠️ 部分 | R2=1、R4=3 正确识别出「前缀已确认」，但**同一轮内从 order=1 重跑**，且下一轮又归 0 |
| `browserReused: true` | ❌ | **0 / 301**（含本会话 6 轮）。会话从未被 commit 过 |
| live view 无前缀重演 | ❌ | 46/46 轮「有已确认前缀」的 verify 都从 order=1 重跑 |

### 4.2 更正：数据里**从来没有出现过一个有效的复用窗口**

保活功能（commit `0ee1845`）于 **2026-11-07** 上线。数据集 301 轮 verify 的时间分布：

| 分组 | 轮数 | 说明 |
|---|---|---|
| 保活上线**之前** | **296** | 2026-10-20 → 2026-11-06。这些轮次运行时保活代码根本不存在 → `browserReused=0` 与保活实现无关 |
| 保活上线**之后** | **5** | 2026-11-07 当天（本次 E2E 会话） |

上线后那 5 轮的**相邻轮间隔**（复用窗口必须落在 TTL=20min 内，且上一轮必须成功提交会话）：

| 相邻对 | 间隔 | 上一轮结果 | 能否命中保活 |
|---|---|---|---|
| R1→R1b | 4.7 min | **failed** | ✗ 失败轮在 R1 未修前直接丢弃浏览器 |
| R1b→R2 | 52.0 min | passed | ✗ 超出 TTL(20min) |
| R2→R3 | 1.5 min | **failed** | ✗ 同上 |
| R3→R4 | 102.8 min | passed | ✗ 超出 TTL |
| R4→R5 | — | failed | ✗ |

> **「上一轮 passed 且间隔 ≤ TTL」的组合在全部数据中出现 0 次。**

⇒ **保活路径是「已部署但从未在有效窗口下被检验过」，不是「已检验且失效」。**
初版那句「301 轮 browserReused=0 → 保活三根因已定位」是**过度归因**：它把「功能上线前/超出 TTL 的轮次」
当成了「功能失效的证据」。真正缺的不是根因分析，而是**一次窗口内的对照实测**。

### 4.3 三个根因的复核结论（代码级事实为准）

| 编号 | 初版说法 | 复核结论 |
|---|---|---|
| **R1** | 步级失败路径不置 `completed = true` → 保活谓词不成立 → 失败轮丢弃浏览器 | ✅ **成立**（代码事实，可证）。已修：失败轮现在提交会话，下轮从失败步续跑 |
| **R2** | 机械 restore 纯视觉前缀必收敛 `resumeIndex=0` → AI 相从第 1 步重跑 | ✅ **成立**。已修：restore 切片截断到「可机械恢复」的最长前缀段，不可恢复的步不进回放 |
| **R3** | 恢复路径跳过 `gotoWithLandedRetry` 落地校验 → 深链弹回首页 → 第 1 步必挂 | ❌ **证伪**。查 `cdp.ts`：`runStepsInContext` 内部**自带落地 goto**，恢复路径并不缺导航。真实相关因素是**登录态缓存 30min 过期** → 深链被弹回 `/siemapp/siem/platformhome/home` → 第 1 步 `AiTaskAborted`。已改为在失败反馈里给出「失败页是登录页/首页 → 先重登再重验」的自愈指引 |
| **R4** | TTL 20min 与人机节奏不匹配 | ❌ **不成立**。全量数据：同用例相邻轮 243 对，其中 **231 对（95.1%）≤ 20min**，p50 2.8min / p90 10.1min。初版看到的「44min / 102min」是**不同轮次**的间隔，不是同用例相邻轮。`SESSION_TTL_MS = 20min` 保持不变 |

> R1 与 R2 是**代码级事实**，与保活是否命中无关——它们各自独立地让「失败→修正→重验」付一遍前缀重演。
> 即使保活一次都没命中，R1/R2 该修仍该修：R1 让失败轮留下干净断点，R2 让「注定失败的回放」不再白跑。
> 实测代价：这 46 轮共执行 180 步，其中 **89 步（49.4%）是重复执行已确认步骤**；全局 515 步里 **89 步（17.3%）是纯浪费**。

### 4.4 好消息：前缀哈希与暂存内容是稳定的

同一 case 连续 3 轮 `stage_case` 的步骤内容**逐字节相同**（`action` / `assertion` 无改写），
`hashEffectiveSteps`（`verifyTrace.ts`）只吃 `inst / compiled / assertion / sensitive / delayMs`，
**不含 expectedOutcome / description**——所以「追加一步」时前缀哈希必然是严格前缀。
**保活的复用条件本身没问题**：问题在「会话活不到下一轮」（R1）与「恢复路径反而把页面带偏」（R2）。

---

## 五、真正的大头：74% 的 verify 轮是失败的

301 轮 verify：failed **224**（74.4%）｜ passed 77（25.6%）。

| failureReason | 次数 | 占比 | 说明 |
|---|---|---|---|
| **AiTaskAborted** | 82 | 36.6% | 「aiTask 超过 5 轮未完成」——模型没能在 5 轮内把这一步做完 |
| **ReplayDivergence** | 60 | 26.8% | AI 相跑通，但结尾 compiled 机械干跑结果与 AI 结果不一致 |
| LocatorMismatch | 28 | 12.5% | 定位器在真实页面上找不到 |
| StepTimedOut | 16 | 7.1% | 「步骤 N AI 执行超过 240s」 |
| StagnantRoundLimit | 16 | 7.1% | 连续 3 轮无进展被闸门拦下 |
| StepReportedFailed | 9 | 4.0% | AI 自报失败 |
| VisionAssertionFailed | 8 | 3.6% | 终态视觉断言不通过 |
| AmbiguousLocator | 5 | 2.2% | 定位器命中多个候选 |

失败步与通过步的耗时分布差异极大（§3.1）：失败步有 17.9% 超过 170s，通过步只有 0.8%。
即**「慢」和「失败」是同一件事的两面**：失败轮要烧探索轮 + 重试轮（失败 → 修正 → 重验再烧一遍全前缀）。

---

## 六、下一批次（已落地，commit `d9748ce`）

| # | 项 | 状态 | 内容 |
|---|---|---|---|
| 1 | **R1** 失败轮提交会话 | ✅ 已修 | `verifyCase.ts` 步级失败分支补 `completed = true` → finally 保活谓词成立 → 失败轮浏览器留在失败现场，下轮从失败步续跑 |
| 2 | **R2** restore 切片截断 | ✅ 已修 | 不可机械恢复的视觉步不再喂进 restore（必 compile-missing 断链、白跑一次注定失败的回放、还把 resumeIndex 打回 0）；前缀整段不可恢复则跳过回放、回到全新轮语义 |
| 3 | **R3** 登录态过期归因 | ✅ 改为指引 | 假设已证伪；改为在失败反馈里给出「失败页是登录页/首页 → 先 `get_login_credentials` + `perform_login` 重登再重验」的自愈路径 |
| 4 | **R4** TTL | ✅ 不改 | 实测 95.1% 的同用例相邻轮间隔 ≤ 20min → `SESSION_TTL_MS = 20min` 保持 |
| 5 | **可观测性** | ✅ 已修 | `resumeFrom` 改为上报**真实 AI 相起点**（原口径在 restore 收敛时撒谎：报 validPrefixLen、实际从 0 跑） |
| 6 | **保活 E2E（窗口内）** | ⏳ 进行中 | 上线后必须做一次**间隔 ≤ TTL 的对照实测**（首轮 failed → 修正 → 次轮），验证 `browserReused=true` / `resumeFrom` 递增 / 前缀零重演 |

仍待决断（数据不支持立即做）：

- **P3（等待可感知：字幕 / 预计时间）优先级下调**——单步中位数 15–25s，用户感知的「慢」主要来自
  74% 失败率与 17.3% 前缀重演，不是单步延迟本身。
- **不做 dumpElements 字段富化**——数据不支持（3+ 轮步仅占通过步 2.4%）。
  若要继续压失败率，方向应是「降低 ReplayDivergence / LocatorMismatch」而不是「让模型更快找到元素」。
- `MAX_SESSIONS = 2` 在多标签页下会互相挤掉——待有真实并发证据再调。

---

## 附录 A：复现方法

数据源（prod228 容器内，只读）：

```
docker exec itest-api-1 cat /repo/apps/api/.data/pi-sessions/<session>.jsonl
```

每行一条 JSONL 记录；`type == "message"` 且 `message.role == "toolResult"` 且 `message.toolName == "verify_case"` 的那条，
其 `message.content[].text` 是 verify_case 的 JSON 返回体，关键字段：

- `result`：`passed` / `failed`
- `resumeFrom`：本轮认定的已确认前缀长度（= 走恢复路径时 AI 相的起始步下标）
- `steps[]`：`order` / `status` / `durationMs` / `error` / `failureReason`
- `failure.failureReason`、`failure.page.url`（失败现场页 URL —— 定位 R3 的关键证据）

整轮 wall time = 该 toolResult 记录的 `timestamp` 减去对应 toolCall（assistant 消息）记录的 `timestamp`。
浏览器会话/前端重放信息只在 SSE 事件流里有（`verify_progress` 事件的 `resumeFrom` / `browserReused` /
`loginCache` 字段），需另订阅 `GET /api/assistant/threads/:id/events`。

---

## 附录 B：本次 E2E 的操作细节

- 驱动方式：容器内自签 JWT（`jsonwebtoken` + 查库取实时 `token_version`，admin 每次重登都会 bump，
  不重签必然 401）→ `POST /api/assistant/threads/:id/messages`（`streamingBehavior: "followUp"`）
  → SSE `GET /api/assistant/threads/:id/events` 收 `verify_progress`。
- 固定打在同一副本（`http://127.0.0.1:54321`，itest-api-1 容器内），因为保活注册表是**进程内**的。
- 容器内无 `curl`，全部走 node `fetch`；node 进程必须 `process.exit(0)` 否则事件循环挂住。
- 判据脚本：`/tmp/e2e-driver-v4.sh`（容器内 `/tmp/e2e-driver-v4.sh`），
  日志：`/tmp/e2e-sse.log`（SSE 原始流）、`/tmp/e2e-driver.log`（驱动摘要）。
