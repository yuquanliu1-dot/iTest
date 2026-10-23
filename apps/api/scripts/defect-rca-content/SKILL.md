---
name: defect-rca
description: 对失败测试用例做根因分析：先分类（系统缺陷/用例自身问题/环境问题），仅对系统缺陷结合被测系统代码仓取证，产出根因描述、代码证据与修复建议，并通过 save_rca_result 工具落库。
---

# 缺陷根因分析（defect-rca）

对计划运行产出的失败用例做根因分析。核心纪律：**先分类，后深挖；系统缺陷必须落到代码仓证据（file:line）；每个失败用例恰好调用一次 save_rca_result。**

## 输入

用户消息里有失败用例清单，每条含 `planRunCaseId`（落库主键，原样回传）、caseTitle、reportId、运行级 error、失败步骤摘要。

## 工作流（逐用例执行）

1. **取数据**：用 `query_stats`（action=report_detail，reportId 来自清单）看完整步骤时间线；步骤摘要缺失或需要更多上下文时必须补取。截图路径仅作参考，你无法读图，以文本证据为准。
2. **分类判定**（给出依据后再下结论）：
   - `case_issue` 用例自身问题：定位器失效但页面功能正常、断言条件写错、步骤顺序/前置数据不成立、用例依赖了偶现时序。特征：换一个正确选择器/断言就能过，产品行为无异常。
   - `environment` 环境问题：服务不可达、超时、登录态失效、配置缺失、依赖三方故障。特征：错误集中在连接/超时/401/403/5xx 网关层，与具体业务功能无关。
   - `system_defect` 系统缺陷：按用例描述的操作走完，产品实际行为与需求不符（功能缺失、计算错误、状态不流转、数据丢失、权限漏洞、UI 展示错误等）。
   - `other`：证据不足无法归类（用 status=error 如实说明缺什么证据）。
3. **非系统缺陷**：直接 `save_rca_result(status=skipped, category=..., confidence=..., summary=一句话结论)`。不深挖、不写 evidence。有把握才给 high 置信；拿不准在 summary 里写明不确定点。
4. **系统缺陷深挖**（结合代码仓 `./repo`，用 repo_ls / repo_read / repo_grep）：
   a. 从失败步骤的报错信息、断言内容、操作目标定位涉及的**功能模块**（不要 grep 原始报错字符串了事——先想清楚这个失败意味着什么用户可见行为，再找实现该行为的代码）。
   b. 追调用链：入口 → 服务层 → 数据层，找到**产生错误行为的具体位置**。前端问题定位组件与状态逻辑；接口问题定位 handler 与校验；数据问题定位 SQL/迁移。
   c. 证据要求：1-5 条 `{file, lines, note}`，note 说明这行代码为什么构成根因。找不到确凿位置时降低 confidence 并在 summary 说明已排查路径。
   d. `save_rca_result(status=analyzed, category=system_defect, evidence=[...], suggestion=修复建议)`。suggestion 写修复方向（改哪里、怎么改），不写完整代码。
5. **降级**：repo 工具报「未就绪/不可用」时，先用清单+报告数据完成分类；系统缺陷证据不足的，evidence 留空、confidence=low、summary 注明「代码仓不可用，仅基于执行数据判定」。**不要因为 repo 不可用就停止处理剩余用例。**

## 收尾

全部用例处理完后发一条结案总结（≤10 行）：总数、各类数量、系统缺陷清单（一句话根因）、低置信项提醒。

## 禁止

- 一条用例调用多次 save_rca_result（写错了等工具返回错误后重调用是可以的）。
- 使用 status=timeout（系统保留）。
- 把整个文件内容贴进 summary——summary 只写根因描述，细节放 evidence.note。
