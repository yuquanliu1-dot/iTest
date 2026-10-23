# 失败用例根因分析（RCA）设计

日期：2026-10-23
状态：已与用户逐节确认

## 背景与目标

计划运行中的失败用例目前只有规则分类（`failureClassifier` 的 `failureReason`/`humanMessage`）和原始错误信息，无法回答"这个失败是不是产品缺陷、缺陷在哪"。本功能在计划运行结束后自动对失败用例做 AI 根因分析：

- **只深挖系统缺陷**：AI 先对每个失败分类，判定为系统缺陷才结合被测系统代码仓取证出报告；用例自身问题、环境问题等只落一句简短结论，不做代码级分析。
- **skill 驱动**：分析由 AI 助手会话执行，方法论沉淀在新 skill `defect-rca`（借鉴 superpowers systematic-debugging 思路，为 iTest 新写）。
- **计划级开关**：是否启动 RCA 在配置执行计划时打开或关闭。

已确认的需求口径：

1. 触发方式：计划运行结束**自动触发**（开关打开时）。
2. 缺陷判定：**AI 先分类再深挖**，非系统缺陷只落简短结论。
3. 结果载体：随运行存列（`planRunCases.rca` jsonb），在计划运行详情/报告详情页内展示。
4. skill 落地：新写 skill 并 seed 进 `.data/skills`（与 skill-creator 同模式）。
5. 会话模型：**每次计划运行一个助手线程**，串行分析本次全部失败用例，用户在版本空间线程列表可见、可查看过程。

## 方案选型

采用方案 A：后台 RCA 编排 + pi 会话 + skill + `save_rca_result` 工具落库。备选（已否决）：

- 方案 B（纯代码编排、套路式检索）：成本最低但取证深度被套路限死，且偏离"AI 助手 + skill"方向。
- 方案 C（扩展现有 `diagnoseFailure` 到代码仓级）：阻塞执行主流程，与助手/skill 体系不沾边。

## 数据模型

Drizzle schema 均在 `apps/api/src/db/schema.ts`。

| 表 | 变更 | 说明 |
|---|---|---|
| `executionPlans` | 加 `rcaEnabled boolean default false` | 计划级开关（照 `loginPrepareEnabled` 模式） |
| `planRuns` | 加 `rcaEnabled boolean default false` | 运行时快照，改计划不影响已运行的分析 |
| `planRunCases` | 加 `rca jsonb` | 每失败用例一条 RCA 结果 |
| `ai_threads` | 加 `purpose text default 'chat'`；加 `planRunId integer`（nullable） | 线程用途标记，`'rca'` 用于工具准入与前端识别；`planRunId` 建立 RCA 线程与运行的关联（幂等检查与跳转链接用） |

`rca` jsonb 结构：

```json
{
  "status": "analyzed | skipped | timeout | error",
  "category": "system_defect | case_issue | environment | other",
  "confidence": "high | medium | low",
  "summary": "根因/结论描述",
  "evidence": [{ "file": "src/xxx.ts", "lines": "12-34", "note": "说明" }],
  "suggestion": "修复建议（仅系统缺陷）",
  "analyzedAt": "ISO 时间",
  "threadId": 123
}
```

- 系统缺陷：`status=analyzed`、`category=system_defect`，含 evidence 与 suggestion。
- 非系统缺陷：`status=skipped`，`category` + `summary`（一句话结论），evidence/suggestion 留空。
- `status=error`：AI 在报告数据不可得等无法完成分类的场景主动写入，`summary` 说明原因。
- `status=timeout`：仅由 worker 超时兜底批量写入，AI 不使用。

路由：`apps/api/src/routes/plans.ts` 的 CreateBody/PatchBody 放开 `rcaEnabled`；planRun/planRunCases 既有查询随新列自然带出。

## RCA 编排流程

### 触发

`apps/api/src/execute/runPlan.ts` 的 `runPlanAsync` 在统计写库完成后：若快照 `rcaEnabled=true` 且 `failedCases>0` → 投递 BullMQ job。

新增 `rcaQueue`（`apps/api/src/scheduler/`），**全局并发 1**：同一时间只有一个分析线程在跑，不与执行引擎抢浏览器资源。

### worker（`apps/api/src/scheduler/rcaWorker.ts` 新增）

1. 幂等检查：同一 planRun 已存在 `purpose='rca'` 且未结束（超时兜底未触发）的线程则跳过。
2. 建 `ai_threads(purpose='rca', versionId=计划.versionId)`，标题 `根因分析 · <计划名> · run#<id>`。
3. `ensureSpaceRecord` 起会话（repo 后台检出照常触发）。
4. `sendSpaceUserMessage` 注入任务 prompt：失败用例清单（caseId/名称、reportId、`planRunCases.error`、失败步骤 `failureReason`/`humanMessage`、截图路径）、repo 当前状态、产出格式与收尾要求。
5. AI 会话自动加载 `defect-rca` skill（现有 `loadSkills` 机制），按 skill 工作流逐用例分析。

### 超时护栏

worker 侧整体超时（默认 30min）：到时向会话 steer「请立即收尾已分析部分」；再超时则把未分析用例批量写 `rca.status='timeout'`，线程结束。

## defect-rca skill

- 内容源码：`apps/api/scripts/defect-rca-content/`；seed 接入现有 deploy 脚本，**缺失才铺**（与 skill-creator 同策略；后续改 skill 文案需手动重铺，同 assistant_guides seed 的坑）。
- SKILL.md 工作流：
  1. 对每个失败用例：`query_stats(report_detail)` 取步骤级数据（failureReason/error/截图引用）。
  2. **分类判定**：`系统缺陷 / 用例自身问题（错定位器、断言写错、步骤冗余）/ 环境问题（服务不可达、登录态失效）/ 其他`，给出依据。
  3. 非系统缺陷 → `save_rca_result(status=skipped, 简短结论)`，处理下一个。
  4. 系统缺陷 → 结合 repo 读代码取证：从报错信息/失败步骤涉及的功能定位模块 → grep/读文件追调用链 → 找到可疑根因，收集 file:line 证据 → `save_rca_result` 完整落库。
  5. repo 不可用时降级为仅基于执行数据的分类，`evidence` 留空并注明。
  6. 全部完成后发一条结案总结消息（SSE 可见）。

## save_rca_result 工具

- `buildSpaceTools` 仅在 `purpose='rca'` 的线程注册。
- 参数：`planRunCaseId` + rca 结构各字段（TypeBox 校验），写入 `planRunCases.rca`。
- promptGuidelines：每用例必须调用一次，分析收尾前不得遗漏。

## 前端

- `apps/web/src/pages/PlanDetail.tsx`：配置区（登录准备旁）加「失败根因分析」开关。
- `apps/web/src/pages/PlanRunDetail.tsx`：失败行加 RCA 展示——分类徽章（系统缺陷红/用例问题灰/环境黄）、根因摘要、证据 file:line 列表（可复制）、修复建议、「查看分析线程」跳转。
- `apps/web/src/pages/ReportDetail.tsx`：报告属于某 planRun 且用例有 `rca` 时展示同款区块。
- 线程列表：`purpose='rca'` 线程 title 加徽章前缀以示区分。

## 错误处理

- repo 未检出/检出失败：不阻塞，skill 降级路径 + 任务 prompt 如实带 repo 状态。
- `save_rca_result` 参数校验失败：工具返回错误信息，AI 自行修正重试。
- worker 崩溃/超时：未落库用例统一兜底 `status='timeout'`，不留悬空状态。

## 测试策略

- **单测**：`rcaEnabled` 路由透传；`save_rca_result` 落库与非 rca 线程准入拒绝；worker 编排逻辑（mock 会话）与超时兜底；快照字段传递。
- **seed 校验**：defect-rca seed 后元数据在库、SKILL.md 可读（同 skill-creator 的 quick_validate 方式）。
- **手动链路（dev）**：造含必败用例的计划跑一遍，验证线程创建 → 分类 → 落库 → 页面展示全链路。

## 明确不做（YAGNI）

- 不做缺陷趋势统计/跨运行 RCA 历史聚合（独立 RCA 表方案已否决）。
- 不做 bug 单对接或自动创建工单。
- 不做并发多线程分析；单线程串行已满足当前规模。
