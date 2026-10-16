# 空间助手执行历史查询（query_stats）设计

- 日期:2026-10-16
- 状态:已评审通过(设计对话逐节确认)
- 前置文档:`2026-10-04-version-space-ai-assistant-design.md`(§10 预留 `query_stats` 扩展位)
- 需求澄清结论:查询/分析方向(非触发执行);项目域全量历史+版本标注;失败归因/通过率趋势/自由问答/对话内即时 Markdown 报告

## 1. 背景与目标

空间助手目前无法访问任何执行历史数据(pi/ 目录无工具读 `reports`/`plan_runs`)。用户在 Reports 页只能人工翻记录;失败归因(跨多次执行找失败规律)人工做不了。本设计补上该能力:新增只读工具 `query_stats`,助手可查询当前项目全部执行历史,基于真实数据回答归因/统计类问题、生成测试报告。

## 2. 范围决策(已确认)

| 决策点 | 结论 |
|---|---|
| 数据范围 | **项目域**:当前项目全部执行历史(含无版本计划、其他版本的运行),每条结果标注所属版本 |
| 验收标准 | **场景清单**:归因/趋势/报告三个代表问题在真实数据上答对(§8) |
| 报告形态 | 对话内即时生成 Markdown,固定骨架(§6) |
| 不做 | 触发执行、跨空间、报告保存/导出、定期自动生成 |

## 3. 工具面设计

单工具 `query_stats`,action 判别联合(继承 `manage_*` 家族模式),全部只读、无确认卡:

| action | 参数 | 返回 | 用途 |
|---|---|---|---|
| `overview` | `days?`(默认30)、`versionId?` | 总执行数、通过率、失败 top5、计划运行数 | 自由问答起点 / 报告开篇 |
| `case_stats` | `caseIds?`、`versionId?`、`days?` | 每用例:执行数/通过/失败/自愈/均耗时/最新状态,按失败数排序 | 归因入口"哪个用例老失败" |
| `failures` | `caseId?`、`days?`、`limit?`(默认20,max100) | 失败 report 列表:reportId、用例名、失败步骤 instruction+error 摘录、时间 | 归因下钻原材料 |
| `report_detail` | `reportId` | 单 report 步骤时间线:每步 status/instruction/error(截500字)/visionAssert.reason/耗时 | 深度归因 |
| `plan_runs` | `planId?`、`status?`、`days?`、`limit?` | 计划运行行:状态/通过失败数/耗时/版本标注/触发人/时间 | 计划维度问答 |

关键口径:**`case_stats`/`failures` 聚合包含计划运行成员执行**(归因关注用例本身全历史);与 executions 列表页排除计划成员的口径不同(那是展示口径),显式声明差异,防实现者照抄 `routes/executions.ts:84-96` 的排除逻辑。

## 4. 数据访问与范围

- 新建 `services/executionHistory.service.ts`(现有查询困在 route handler,UI 形状不可复用;聚合查询全新写,可单测)
- 用例报告范围:`reports ⋈ test_cases.groupId → groups.projectId = ctx.projectId`(`test_cases.versionId` 非空,schema.ts:39)
- 计划运行范围:`plan_runs.projectId = ctx.projectId ⋈ execution_plans`(versionId 可空 → 标注"无版本",schema.ts:416)
- 工具只读 `ctx.projectId`,**不接受 projectId 参数**,无越权面(与现有工具一致,线程建立时已鉴权)

## 5. 上下文预算

聚合走 SQL 聚合查询,全量行不进上下文;列表 action 限 limit;`report_detail` 单报告、每步 error 截 500 字。promptGuidelines 写明:先 `overview`/`case_stats` 再按需下钻,禁止把明细全量塞进回答。

## 6. 报告骨架(AI 基于查询结果拼装)

```
# <项目> 测试报告(<时间范围>)
1. 概览:执行数/通过率/环比
2. 失败清单:按失败数排序,含版本标注
3. 计划运行状况
4. 发现与建议(归因结论,须源自数据)
```

## 7. 错误处理

空历史 → 明确"近 N 天无执行历史"文案;reportId 不存在 → 可操作错误;zod 校验失败 → 现有格式化模式(plans.ts:71)。

## 8. 验收标准(场景清单)

1. 真实数据下问"哪个用例失败最多、为什么":答案的用例名/失败步骤/错误信息与 DB 一致
2. 问"近 7 天通过率":数字与 reports 页/SQL 对账一致
3. 要求"出本周测试报告":输出含 4 节骨架的 Markdown,数字与 DB 一致
4. 多版本项目中结果带版本名;无版本计划的历史可查到
5. 现有助手工具测试全绿(零回归)

## 9. 测试策略

- 单测(vitest + test/helpers/db.ts):service 聚合正确性(多版本/多状态/计划成员含入)、项目隔离(跨项目不可见)、limit
- 工具测试:action 分发、参数校验、错误文案(参照 plans 工具测试风格)
- 前端无 UI 改动,手动冒烟

## 10. 文件清单

| 文件 | 改动 |
|---|---|
| `apps/api/src/services/executionHistory.service.ts` | 新建,聚合查询 |
| `apps/api/src/pi/space/tools/history.ts` | 新建,`buildHistoryTools` |
| `apps/api/src/pi/space/tools/index.ts` | 注册(:67 附近) |

回滚:纯只读新增,revert 即可。工作量:service ~4h + 工具 ~3h + 测试 ~4h(AI 协作一个会话内)。

## 12. 验收记录

- 日期 / 环境：2026-10-16；本地 dev（api tsx watch :54321、web vite :5175、itest-pg）；mycal 项目 652a44a5-ec00-483a-85fc-4f0edc759d7f（版本 v0.1.0=50174ee8-2f5e-4b53-a5e0-92137177d1e2）；回归 849/851（2 失败为既有基线，见 Task 5 记录）
- 场景 1 失败归因：**通过** —— "最近哪个用例失败最多？为什么失败？"→ 返回「登录校验-数据驱动」15 次执行全部失败（v0.1.0），lastAssertion 全为 `count=0 (css)`；排名表与 SQL 基线逐项一致（E2E-数据驱动登录 12/11 `var-missing: {{username}}`、E2E-登录用例 3/3、E2E-自动登录-业务用例 3/3、API-httpRequest-冒烟 2/1）；正确应用"最近→7 天"口径
- 场景 2 通过率对账：**通过** —— "近 7 天通过率多少？和上一周期比呢？"→ 近 7 天 38 执行/一次通过 3/自愈 1/失败 33=10.5%；上一周期（14 天相减）19/8/0/11=42.1%；环比 -31.6pp；数字与 SQL 全对齐；主动给出样本量差异 caveat，并归因 79% 失败集中于两条数据驱动用例
- 场景 3 报告骨架与数字：**通过** —— "出一份本周测试报告"→ 输出 4 节骨架 Markdown（`mycal 测试报告（2026-10-08 ~ 10-14）`）：1 概览（38/3/1/33=10.5%、环比 -31.6pp、计划运行 3 次全失败）；2 失败清单（登录校验-数据驱动 15/45%、E2E-数据驱动登录 11/33%、E2E-登录用例 3、E2E-自动登录-业务用例 3 [compile-missing]、API-httpRequest-冒烟 1，合计=33）；3 计划运行状况（E2E-自动登录计划 3 次全失败，触发人：管理员）；4 发现与建议（三条结论全部源自查询数据，显式标注"结论均来自查询数据"）。渲染截图存本地 docs/acceptance/s3-report.jpeg（*.jpeg 被 gitignore，不入库）
- 场景 4 版本标注：**通过** —— mycal 为单版本项目（v0.1.0），三个场景回答均标注版本（报告头/失败清单"均属 v0.1.0"/计划运行"（v0.1.0）"）；"无版本计划→versionName null"路径由 executionHistory.service.test.ts "planRunList:版本标注(无版本→null)"单测覆盖
