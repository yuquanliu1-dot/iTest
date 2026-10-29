# 计划级数据集行选择（含用例级配置模式简化）设计

日期：2026-10-29
状态：已评审通过（用户逐节确认）

## 背景

用例级数据集行选择已实现（工作区在途改动）：`test_cases.dataset_row_indexes`（0046 迁移，`[]`=全部启用行，非空=启用行下标子集），UI 为 Segmented 三档（全部/一条/多条）+ `DatasetRowPickerDialog`。

执行计划目前对数据集无感知：`runPlan` 调 `runCase` 不传行选择，全部回落用例级配置。

## 目标

1. 计划中对组内用例可设置数据子集；**同一计划两个分组中的同一用例可各选不同子集**。
2. 选择交互简化：不分「全部/单行/多行」模式，统一一个「选择数据」入口 → 多选弹窗 → 显示条数。
3. 用例详情页现有三档配置模式同样简化为上述交互。

## 非目标

- 登录准备用例的计划级行选择（保持走用例级配置）。
- AI 工具（case-ops-tools）暴露计划级选行。
- plan_runs 快照记录选择（选择是"当前配置"，执行时实时读 `plan_cases`，与组配置读取语义不同——后者是启动定格快照）。

## 已定决策

| 决策点 | 结论 |
|---|---|
| 计划级未设置时的执行语义 | **跟随用例级配置**（对齐 `targetOverride` 的 null=沿用例值先例；存量计划零行为变化） |
| 「回到跟随用例」交互位置 | **弹窗内**「跟随用例」按钮（计划级专用，用例级不渲染）；不加在组内用例行上（行已很挤） |
| 存储位置 | **`plan_cases` 加列**（照 `targetOverride` 先例；同用例跨组=两行，天然支持各行独立） |

## 数据模型

`plan_cases` 加列 `dataset_row_indexes integer[] NULL`（无默认值）：

- `null` = 跟随用例级配置
- `[]` = 全部启用行
- 非空 = 子集（0 基启用行下标，与 `test_cases.dataset_row_indexes` 同一编号空间）

存量行为 `null` = 行为不变，零回迁。迁移编号 **0051**（0046-0050 已被占用；若开工时 0051 已存在则顺延）。prod 随 api 容器启动 `drizzle-kit push --force` 自动应用。

## 后端 API

**新端点** `PATCH /plans/:planId/plan-cases/:planCaseId`，body `{ datasetRowIndexes: number[] | null }`：

- 按 `plan_cases.id` 定位——**不复用**现有 `PATCH /:id/cases/:caseId`（它按 caseId + limit(1) 定位，跨组重复用例有歧义）
- 校验（与用例级同款口径，抽公共函数供 `cases.service` / `plans.service` 共用）：
  - `null` 放行（清覆盖）；`[]` 放行（全部行）
  - 非空数组：整数 ≥ 0、上限 500；用例未绑数据集 → 400；下标越界 → 400（文案含越界行号与启用行总数）

**`getPlanDetail` 回带**：`group.cases` 每行增加 `datasetId` / `datasetName` / `datasetEnabledRowCount` / `caseRowIndexes`（用例级选择）/ `planRowIndexes`（计划行覆盖三态）。

## 执行链路

`runCase` 本体零改动（`opts?.datasetRowIndexes ?? caseRow.datasetRowIndexes ?? []` 已实现回落，`??` 仅对 null/undefined 回落、`[]` 是合法覆盖值）。

`runPlan.ts` 两处：

1. pcs 查询（实时读 `plan_cases`）select 加 `datasetRowIndexes`
2. 业务用例 `runCase` 调用处传 `datasetRowIndexes: c.datasetRowIndexes ?? undefined`
   - `null` → undefined → 回落用例级；`[]` → 照传 → 全部行（覆盖用例级子集）；非空 → 子集

登录准备用例不传（保持用例级）。执行期越界与用例级选择走同一条 `loadDatasetForRun` 路径，行为天然一致。

## 前端 UI

**`DatasetRowPickerDialog` 简化（两处共用）**

- 删 `mode: 'one' | 'many'` prop，统一多选 + 表头全选勾选框
- 确认口径：勾满全部启用行 → 存 `[]`；部分勾选 → 存下标；未勾 → 确认禁用（「回到全部」唯一入口=全选）
- 新增可选 prop `onFollowCase`：传了才显示「跟随用例」按钮（点击回调+关弹窗）

**用例详情页**（替换 `CaseDetail.tsx` Segmented 三档）：

```
数据行范围    [选择数据]  全部 5 行 / 已选 2 行（行 2、4）
```

删 `datasetRowScope` 派生与 `datasetPickerMode`；保存仍随整单 PATCH 带 `datasetRowIndexes`。

**计划组内用例行**（`PlanGroupCard`，仅用例绑了数据集才显示入口）：

- 行内状态文字三态：`跟随用例 · N 行`（N=用例级生效条数）/ `全部 N 行` / `已选 M 行`
- 点击开弹窗：value = 生效下标（覆盖值；未覆盖则用例级生效值）；`planRowIndexes !== null` 时弹窗带「跟随用例」→ PATCH 新端点 → invalidate `['plan', id]`
- 跨项目/跨版本共享用例：弹窗拉数据集用**用例的 projectId**（`c.projectId ?? plan.projectId`）

**i18n**：`plans.json` 加入口/跟随按钮/三态文案；`cases.json` 的 `datasetRowScopeOne/Many` 退役。

## 联动清空

下标空间属于特定数据集，数据集变更后旧选择即垃圾值：

| 触发 | 处理 |
|---|---|
| 数据集删除 | `deleteDataset` 清用例级选择的位置（`datasets.service`），同一处追加一条：按 caseId 反联 `test_cases.dataset_id` 清空 `plan_cases.dataset_row_indexes`（置 null）。行编辑不触发清空（用例级现状：越界选择留到执行时报 DatasetConfigError），计划级对齐该口径 |
| 用例换数据集/解绑 | cases.service 清用例级选择处，连带清该用例在所有计划里的行级覆盖 |
| 用例删除 | `plan_cases.caseId` 外键 CASCADE，无需处理 |

## 测试

- **API**（plans 路由集成测试）：落库 / `null` 清覆盖 / `[]` 全部 / 越界 400 / 未绑数据集 400 / 跨组重复用例两行各自独立（核心断言）
- **执行**（照 `plan-run-datasets.test.ts` 模式）：计划级子集覆盖用例级 / null 回落用例级 / `[]` 覆盖为全部行
- **联动**：数据集行变更 → 计划行覆盖被清空
- **Web**：现有 `CaseDetail.test.tsx` 适配新 UI（保存仍带 `datasetRowIndexes`）；PlanGroupCard 弹窗交互以浏览器实测验收
