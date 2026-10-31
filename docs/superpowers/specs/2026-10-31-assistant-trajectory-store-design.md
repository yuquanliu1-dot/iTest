# AI 助手轨迹库（产品线级）设计

- 日期：2026-10-31
- 状态：已评审通过，待实施
- 需求编号：R2（自优化体系第二个需求）

## 1. 背景与定位

iTest AI 助手的自优化体系拆为五个需求递进：R1 短期记忆体 → R2 轨迹库 → R3 固化 skill → R4 审核与发布通道 → R5 记忆效果反馈回路。本设计只覆盖 **R2**。

R2 的目标：把 pi-sessions 里「需求 → 建用例 → verify 实测通过 → 用户确认落库」的成功会话轨迹，蒸馏成结构化 exemplar 入库；同产品线后续建用例任务检索 top-k 相似成功例做 few-shot。

与 R1 的分工——两种记忆互补：

| | R1 memories（陈述性） | R2 trajectories（程序性） |
|---|---|---|
| 知识形态 | 「登录前先关公告弹窗」一句话经验 | 「这类任务当时怎么一步步做成的」完整路径 |
| 价值 | 防重复犯错 | 直接抄作业，攻 22min/例生成耗时痛点 |
| 写入 | 模型会话内自写 | 落库钩子 + 后台蒸馏（transcript 是事实源） |

**R2 边界**：只做用例生成轨迹（成功判据最硬、痛点最直接）。蒸馏退役（R3）、审核发布（R4）、命中效果分析（R5）不在本期，schema 预留接口。

## 2. 已确认决策

| 决策点 | 结论 |
|---|---|
| 轨迹范围 | 仅用例生成轨迹（RCA/排计划等全任务类型、plan run 执行轨迹不在首期） |
| 成功判据 | **verify_case 实测通过 + 用例确认落库**，双条件缺一不可——库小而精 |
| 提炼机制 | 落库钩子记事件 + 后台 worker 读 JSONL 用 LLM 蒸馏（蒸馏器读 transcript 事实，非模型自述——禁臆造原则） |
| 检索路径 | system prompt 一行索引 + `search_trajectories` 工具取 top-3 digest（仿 R1 索引行+read_memory 双层） |
| 架构方案 | 方案 A：DB 表 + 线内 ILIKE 关键词检索（pgvector 等 embedding 留作库量起来后的演进，不首期背上） |
| 作用域 | 仅 `product_line`，**无 global**——轨迹含锚点/URL 等线特有细节，跨线泄漏即 SOC class 锚点事故重演 |
| backfill | 不做——test_cases 无线程溯源列（stage 行落库即删），历史无从归因，库从零累积 |

## 3. 存储 schema

新表 `assistant_trajectories`（drizzle 定义，随 drizzle-kit push 流程落地）：

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid pk | |
| product_line_id | uuid not null | FK → product_lines，on delete cascade；无 global 档 |
| task_title | varchar(200) not null | 人话任务指纹（例：「SOC 事件管理列表页——新增按钮被遮蔽的绕行定位」） |
| task_keywords | text not null | 检索面：空格分隔关键词串，蒸馏产出 |
| digest | text not null | 蒸馏正文，固定骨架五段：任务描述 / 环境事实 / 关键决策 / 最终用例形态 / verify 证据 |
| case_title | varchar(200) not null | 最终用例标题 |
| status | varchar(20) not null default 'active' | `'active' \| 'deleted'`；R3 预留 `'retired_solidified'` |
| retired_by_batch | uuid null | R3 预留：固化批次 id，R2 不读不写 |
| source_thread_id | uuid null | 裸列无 FK，同 ai_assistant_feedback 惯例（审计数据不随线程删除级联） |
| source_case_id | uuid null | 判据锚：verify+落库的那条用例 |
| source_project_id | uuid null | 裸列；同线跨项目检索时模型据此判断适用性 |
| source_version_id | uuid null | 裸列 |
| created_by_user_id | uuid null | FK → users，on delete set null（落库操作人） |
| distill_model | varchar(64) not null | 蒸馏模型溯源（R5 效果分析） |
| hit_count | integer not null default 0 | search_trajectories 返回即 +1（R2 埋点，R5 消费） |
| last_hit_at | timestamp null | 同上 |
| created_at / updated_at | timestamp not null | |

索引：

- **partial unique `(source_case_id) where status='active'`** —— 一 case 一轨迹，DB 层防重复蒸馏入库；插入走 onConflictDoNothing。（R1 终审竞态教训直接落地：硬判据业务键上 DB 约束优先于工具层约定。）
- 普通索引 `(product_line_id, status)`。
- 检索字段不打特殊索引——线内量级（几十条）seq scan 够用。

## 4. 写入路径：落库钩子 + 蒸馏 worker

### 4.1 钩子（stageRoute `/stage/save`）

位点：`apps/api/src/pi/space/stageRoute.ts` cases 落库循环完成后。

- 投递 `enqueueTrajectoryDistill({ threadId, versionId, userId, items: Array<{ localId, caseId }> })` —— **localId→caseId 成对传**：transcript 里 verify_case 以 stage localId 为锚，DB 溯源要真实 caseId，映射只在落库瞬间可得（用例标题等形态由 worker 按 caseId 从 DB 读，payload 不冗余）。
- fire-and-forget：try/catch 只 log，**绝不影响落库主流程**。
- env 开关门控（`ASSISTANT_TRAJECTORY_DISTILL`，默认开），对齐 RCA 队列开关模式。

### 4.2 worker（rcaQueue 同构：BullMQ Queue + Worker + 动态 import 防环）

`apps/api/src/scheduler/trajectoryQueue.ts`，处理流程：

1. **定位素材**：thread 行 → piThreadId → `SESSIONS_ROOT/*_<piThreadId>.jsonl`。
2. **判据核实（LLM 之前执行）**：解析 JSONL 记录流（user 文本 / assistant thinking+text / tool_use / 工具结果），对每个 item 找 `verify_case(localId)` 调用且结果为通过——找不到即**丢弃该 item**（用户没跑 verify 就确认的用例不入库）。
3. **蒸馏**：LLM 走 modelBridge 既有配置（RCA worker 同款）；输入 = 对话流压缩（user 消息全文 + assistant 决策文本 + 工具调用名与关键参数，截预算防超长）+ 最终用例形态（按 caseId 从 DB 读 case+steps）；输出 JSON `{ task_title, task_keywords, digest }`，zod 形状校验。
4. **入库**：product_line_id 由 versionId→project→product_line 解析（复用 R1 `resolveProductLineId`）；onConflictDoNothing；`distill_model` 记实际 modelId。

失败语义：LLM 超时/输出不合法/文件缺失/项目未归线（解析不出 product_line）→ 该 item 丢弃 + warn log，**不重试不阻塞**（transcript 仍在卷上，R3 可重蒸）。每 case 一条轨迹（检索粒度 = 任务）。

## 5. 检索与注入

### 5.1 `search_trajectories` 工具

注册进 buildSpaceTools（chat / rca 线程均可用），参数 `query: string`。

- 匹配：线内 active 轨迹，`task_title / task_keywords / case_title` 三字段 ILIKE OR 命中，按命中字段数打分（同分按 updatedAt 降序），**top-3 返回 digest 全文**。
- 埋点：被返回行 `hit_count` SQL 原子 `+1`（`sql\`${col} + 1\``，3 副本安全，R1 同款）。
- miss：返回线内可用 task_title 清单（read_memory 模式）。
- 返回脚注硬约束：**「参考轨迹取其决策思路与用例形态；锚点、URL、账号等线内事实必须以当前应用实测为准，禁止照抄」**。

### 5.2 system prompt 注入

`buildSpaceSystemPrompt` 增第 5 参 `trajectoriesSection = ''`（默认空保旧调用零 diff）。

- 工厂段：guides → memories → **trajectories** → workspace 四段序；try/catch 容错（memories 同款）。
- 内容：一行指引（建用例前先 search_trajectories 检索相似任务）+ task_title 清单；预算 ~1500 字符，截完整行。
- 零轨迹 → 空串，**零 diff 红线测试**（既有 prompt 逐字节相等）。
- 快照语义同 R1：线程冷构建时算一次；会话内新轨迹靠工具实时查库。

## 6. 管理与边界

- **路由** `/assistant/trajectories`（requireManager）：GET（status 默认 active、productLineId 筛选；**可见性条件下推 SQL 后再 limit 500**——R1 终审教训）+ DELETE 软删（404 / 跨线校验 / status='deleted'）。LEFT JOIN product_lines 带 productLineName。
- **Web**：设置页新 `TrajectoriesSection`（MemoriesSection 同构：只读+软删+线筛选，默认 active）；**带 error 分支**（localizeApiError，R1 终审教训）；i18n zh/en 对齐。
- **容量**：库不设上限（硬判据天然限流——每确认用例至多一条）；注入清单预算裁剪；膨胀治理归 R3 退役机制。
- **R3 接口**：`retired_by_batch` + status 枚举扩展位；高频命中轨迹（hit_count 埋点）是 R3 固化 skill 的输入素材。
- **明确不做**：embedding 检索（演进项）、backfill、跨线 global、plan run 执行轨迹（step_locator_cache 已半覆盖）。

## 7. 测试与验收

| 层 | 覆盖 |
|---|---|
| 服务 `src/pi/space/trajectories.ts` | loadActive（线隔离/updatedAt 降序/上限）；打分检索（命中排序/miss/跨线不泄漏）；buildSection（空串红线/预算截断） |
| 判据核实 | JSONL fixture 三态：verify 通过→产轨迹；verify 失败/无 verify 记录→丢弃 |
| 工具 `tools/trajectories.ts` | search 命中返回 digest+埋点 +1；miss 返回清单 |
| 注入 | 零轨迹零 diff 红线；四段位置序 guides→memories→trajectories→workspace |
| 路由 | GET 可见性+筛选+?status=deleted 审计；DELETE 软删+member 403 |
| worker | fixture + mock LLM 端到端（落库→入队→蒸馏→入库）；onConflictDoNothing 幂等；钩子抛错不影响落库 |
| E2E 手动 | 建用例→verify 通过→确认落库→worker 蒸馏入库→设置页见轨迹→新会话 search 检索引用 |

**验收标准**：① 无 verify 证据的确认用例绝不产生轨迹；② 新会话对同类任务能检索到并引用；③ R1 全量回归绿。
