# AI 助手短期记忆体（产品线级）设计

- 日期：2026-10-31
- 状态：已评审通过，待实施
- 需求编号：R1（自优化体系第一个需求）

## 1. 背景与定位

iTest AI 助手的自优化体系拆为五个需求递进：R1 短期记忆体 → R2 轨迹库（并行可行）→ R3 固化 skill → R4 审核与发布通道 → R5 记忆效果反馈回路。本设计只覆盖 **R1**。

R1 的目标：为助手建立类似 Claude Code auto-memory 的短期记忆机制——会话中模型自行判断值得沉淀的经验（用户明示、验证过的踩坑结论、产品线环境事实），写入产品线级共享记忆；同线后续任何线程的 system prompt 常驻记忆索引，正文按需读取。

**R1 边界**：只做记忆的存、读、注、管（最小管理界面）。提炼/退役/固化（R3）、审核发布（R4）、命中分析（R5）不在本期，但 schema 与语义为其预留接口。

## 2. 已确认决策

| 决策点 | 结论 |
|---|---|
| 写入主体与时机 | 纯模型自写（save_memory 工具 + 写入门禁），无后台提取；线程长活无「会话结束」事件，漏记由 R3 兜底 |
| 注入策略 | 仿 Claude Code auto-memory：索引行常驻 system prompt，正文由 read_memory 按需读取 |
| 共享范围 | 产品线内全用户共享（A 踩的坑 B 不再踩），带 createdByUserId 溯源 |
| 存储落点 | DB 表 `assistant_memories`（方案 A）。机制抄 Claude Code，存储走 iTest 既有 DB 驱动模式（同 assistant_guides / assistant_mcp_servers 先例） |
| UI 范围 | 最小只读 + 删除（软删），挂在系统设置页；编辑/审核留给 R4 |
| 作用域 | `product_line`（默认）/ `global` 两档 |

## 3. 存储 schema

新表 `assistant_memories`（drizzle 定义，随既有 drizzle-kit push 流程落地）：

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid pk | |
| scope | varchar(16) not null | `'product_line' \| 'global'` |
| product_line_id | uuid null | FK → product_lines，on delete cascade；scope=global 时为 NULL |
| title | varchar(120) not null | 索引行标题，upsert 匹配键 |
| hook | varchar(200) not null | 索引行一句话（含「未验证」前缀约定，见 §4） |
| body | text null | 正文；NULL = 索引行即全部（短记忆零额外读取） |
| provenance | varchar(16) not null | `'user_stated' \| 'ai_inferred'` |
| status | varchar(20) not null default 'active' | `'active' \| 'retired_solidified' \| 'retired_stale' \| 'deleted'` |
| retired_by_batch | uuid null | R3 预留：固化批次 id，由 R3 写入，R1 不读不写 |
| source_thread_id | uuid null | 溯源线程（无 FK，同 ai_assistant_feedback 先例：审计数据不随线程删除级联） |
| created_by_user_id | uuid null | FK → users，on delete set null |
| hit_count | integer not null default 0 | read_memory 命中 +1（R1 埋点写入并在管理页展示，R5 消费） |
| last_hit_at | timestamp null | 同上，R5 消费 |
| created_at / updated_at | timestamp not null | |

索引：`(scope, product_line_id, status)`。

设计要点：

- **无 title 唯一约束**——去重由工具层 upsert 负责（同 scope 同 title 的 active 条目存在则更新）；写入口只有工具，DB 约束属冗余保险。global 行 product_line_id 为 NULL，PG 唯一索引对 NULL 不去重，工具层约束是唯一可靠机制。
- **软删保审计**：管理页删除 = `status='deleted'`；固化退役 = `retired_solidified`。所有读路径统一过滤 `status='active'`，退役即不可见，无需清理任务。
- R3/R5 预留列在 R1 期内：hit_count / last_hit_at 埋点写入并在管理页展示但不受任何决策消费；retired_by_batch 完全不触碰。

## 4. 写入路径：save_memory 工具

注册进 buildSpaceTools，chat / rca 线程均可用（rca 线程发现的坑同样值得记；溯源靠 source_thread_id）。

**参数**：

| 参数 | 必填 | 说明 |
|---|---|---|
| title | 是 | ≤120 字符 |
| hook | 是 | ≤200 字符，索引行文案 |
| body | 否 | 正文，长经验才需要 |
| provenance | 是 | `user_stated`（用户明说）/ `ai_inferred`（AI 从会话推断） |
| scope | 否 | 默认 `product_line`；`global` 仅限跨线普适的事实（如平台自身行为） |

**行为**：

1. 解析产品线：`ctx.projectId → projects.productLineId`（项目必归线，2026-10 产品线收敛后的结构不变式；解析失败返回错误）。
2. Upsert：查同 `(scope, productLineId, title)` 的 active 条目——存在则更新 hook/body/provenance/updated_at，不存在则插入（带 source_thread_id、created_by_user_id）。
3. 返回值明确区分「新建记忆」与「更新了已有记忆」，给模型防重复写的反馈回路。

**写入门禁**（放工具 description + promptGuidelines）：

| 该记 | 不该记 |
|---|---|
| 用户显式说「记住 X」 | 能从代码/DB/guides 推导的信息 |
| verify_case / 执行结果证实的踩坑结论 | 会话临时状态（当前进度） |
| 产品线环境事实（账号怪癖、环境特殊行为） | 未经验证的 AI 归因——确要记须 provenance=ai_inferred 且 hook 以「未验证」开头 |
| — | 与现有 active 记忆重复——先读后写，更新优先于新建 |

## 5. 注入与读取路径

### 5.1 索引段（system prompt）

`buildSpaceSystemPrompt` 新增一节，位置在 guides 段之后、workspace 段之前：

```
# 产品线记忆（历史会话沉淀的经验）
- [登录页特殊行为] 必须先关掉公告弹窗才能点登录按钮
- [测试账号怪癖] 未验证：admin 账号连续失败 3 次锁 10 分钟
需要完整内容时调用 read_memory；用户要求记住的事实用 save_memory。
```

- **加载**：`loadActiveMemories(productLineId)` —— `(scope='global' OR (scope='product_line' AND product_line_id=本线)) AND status='active'`，`ORDER BY updated_at DESC`。
- **预算**：硬编码常量（不做配置项）——条数上限 50、索引段总字符 ~4000；超限截到最近完整行（近期更新优先可见）。
- **容错**：与 guides 同款——加载失败 log warn，继续无记忆段，不拖垮会话工厂。
- **热生效**：与 guides 同轨，每轮 builderSystemPrompt 重算，DB 改动对同线所有线程下一轮生效。

### 5.2 read_memory 工具

- 参数：`title`（模糊匹配当前线 + global 的 active 条目）。
- 返回：title / hook / body / provenance / updated_at。
- 副作用：`hit_count+1`、`last_hit_at=now`（R5 埋点顺手做）。
- 找不到：返回可用 title 清单让模型重试。

## 6. 管理界面

系统设置页新增「助手记忆」入口（与 skills 管理同区）。

- 表格列：title / hook / 产品线 / provenance / status / hit_count / 更新时间 / 创建人；产品线筛选。
- 操作：删除（软删 `status='deleted'`），无编辑。
- 路由（guidesRoute 同款模式）：`GET /assistant/memories`（支持 productLineId / status 筛选）、`DELETE /assistant/memories/:id`。权限同设置页其他入口。

## 7. R3 接口预留（本期不实现）

- **退役**：`UPDATE status='retired_solidified', retired_by_batch=<批次id>`，一次 SQL；源记忆退役即从注入与工具可见性消失。
- **固化分析输入**：按线查 active 条目 + hit_count 排序，SQL 现成。
- R3 的提炼器只需产出上述 UPDATE 与修正案，无需理解注入链路。

## 8. 测试

- **单测**（`space-memories.test.ts`，仿 space-guides.test.ts）：
  - loadActiveMemories：作用域隔离（他线不泄漏、global 可见）、status 过滤（退役/删除不可见）、updated_at 排序与预算截断；
  - save_memory：upsert（同 title 更新不重复插）、provenance 必填校验、产品线解析失败错误形状；
  - read_memory：模糊匹配、命中计数递增、找不到时返回 title 清单；
  - 渲染快照：有/无记忆两种 system prompt 形状。
- **回归红线**：零记忆数据时 system prompt 与现状 diff 为零（guides「seed 后零变化」先例）。
- **E2E 手工验证**：对话中说「记住 X」→ 同线新线程索引行出现 → read_memory 取到正文 → 管理页删除后新线程不再可见。

## 9. 明确不做（YAGNI）

- 不做后台异步提取、会话末钩子（无线程结束语义；R3 兜底）。
- 不做记忆编辑 UI、审核流（R4）。
- 不做命中分析/修剪建议（R5，仅埋点）。
- 不做 lang 分列（记忆为事实性短条目，索引行以用户语言书写即可，无 guides 式多语言版本需求）。
- 不做预算配置项（常量硬编码，膨胀先靠 R3 退役治理）。
