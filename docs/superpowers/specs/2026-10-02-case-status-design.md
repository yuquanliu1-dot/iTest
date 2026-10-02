# 用例状态生命周期设计

日期：2026-10-02
状态：已确认（用户逐项审阅通过）

## 背景与问题

`test_cases.status`（schema.ts:40）目前是占位字段：

- varchar(20) 默认 `'draft'`，无任何代码路径 UPDATE 它——用例从创建到删除永远是 draft
- API 的 `CaseBodyBase`（cases.ts:12-24）不含 status，create/patch 都改不了
- UI 各处（GroupsPage.tsx:606、CaseDetail.tsx:490）直接渲染原文，永远显示灰色 "draft" pill，无修改入口

执行结果状态（passed/failed）刻意分离在 reports/planRunCases 表，不受本次影响。

## 目标

1. 用例获得四态生命周期：draft（草稿）→ review（评审中）→ ready（就绪）→ deprecated（废弃），自由切换、无顺序强制
2. 四个入口：详情页 pill 点击切换、列表行内快速切换、列表批量改状态、列表状态筛选
3. 仅 deprecated 参与执行拦截：单例执行弹确认、计划运行自动跳过记 skipped、计划选例页标灰默认不选

## 明确不做

- `requirements.status`（同为占位字段）——需求工作流语义不同，留待后续单独设计
- 服务端流转表 / 审批 / 审计日志（方案 B 演进方向，自由切换下无意义）
- DB CHECK 约束迁移（与 priority 的「zod 枚举 + varchar」既有模式保持一致）
- 录制 / AI 补充 / 步骤编辑自动改状态（流转纯人工）
- 执行状态（reports.passed/failed）与用例状态的任何联动

## 状态模型

| 值 | 中文 | Pill 色调 | 语义 |
|---|---|---|---|
| `draft` | 草稿 | muted 灰 | 编写/迭代中（默认；存量数据全是 draft，零迁移） |
| `review` | 评审中 | warning 黄 | 送评审，等待确认 |
| `ready` | 就绪 | success 绿 | 编写完成，可进发布准入 |
| `deprecated` | 废弃 | muted 灰 | 下架存档；列表行降低透明度与 draft 区分 |

- 自由切换：任意状态可切到任意状态（含 `ready → draft` 回退、`deprecated → ready` 恢复）
- 展示映射：`statusTone()`（StatusPill.tsx:19）增加 `case 'review': return 'warning'`；`deprecated` 落 default 分支已是 muted
- 中文标签：`apps/web/src/lib/format.ts` 增加 `CASE_STATUS_LABELS` + `caseStatusLabel(status)`（与 stepKindLabel 同款纯函数）

## API 设计（apps/api）

### 1. PATCH /cases/:id 增加 status

```ts
// routes/cases.ts — PatchBody 扩展（与 scenarioId 同款 patch-only）
const PatchBody = CaseBodyBase.partial()
  .extend({
    scenarioId: z.string().uuid().nullable().optional(),
    status: z.enum(['draft', 'review', 'ready', 'deprecated']).optional(),
  })
  .superRefine(checkWindowStrategy);
```

- **create 不收 status**：新建用例一律 draft（CaseBodyBase 不动）
- 非法枚举值 → 现有 zod 400 路径（errorHandler 将 ZodError 映射为 400，与全仓一致；设计初稿误写 422）
- patch handler 现有字段透传模式加一个 `status` 即可

### 2. POST /cases/batch-status（新增）

```
POST /cases/batch-status
{ "caseIds": ["uuid", ...], "status": "ready" }
→ { "count": 3 }
```

镜像 batch-delete（cases.ts:308-318）的实现惯例：

- `caseIds` min(1) uuid 数组 + status 枚举，zod parse
- 逐个 `assertCaseVisible`（越权/不存在 → 404，与单删一致）
- `inArray(testCases.id, caseIds)` 批量 `set({ status, updatedAt: new Date() })`
- 返回实际更新条数

### 3. GET 不变

case detail / groups 用例列表已返回 status 字段，无需改动。

## 执行拦截（仅 deprecated）

### 单例执行（纯前端拦截）

CaseDetail.tsx 执行按钮（:492-499）：点击时 `status === 'deprecated'` → `window.confirm('用例已废弃，仍要执行？')`，确认才 `execute.mutate()`。项目已有 confirm 惯例（录制前回放确认 :775）。API 不拦。

### 计划运行（服务端跳过）

`apps/api/src/execute/runPlan.ts` 业务用例循环（:187 前后）：

- 执行前查该用例 status，`deprecated` → 不调用 runCase
- planRunCases 照常插入记录但 `status: 'skipped'`、durationMs 记 0
- publish 事件复用 `plan_run_case_complete`（status: 'skipped'），前端 SSE 面板天然显示
- `skippedCases` 计数 +1；不影响 failed/passed 统计与 planRun 最终状态判定

### 计划选例页（PlanDetail）

deprecated 用例行：pill 之外整行降低透明度；「全选」默认排除 deprecated；仍可手动勾选（不硬禁）。

## Web 入口设计

### 共享组件 `CaseStatusMenu`

新建 `apps/web/src/components/CaseStatusMenu.tsx`：

- 包装 StatusPill 为可点击触发器，点击弹出 popover（复用 `.popover-in` + portal 模式，参考 CaseDetail 标签选择器 tagPicker）
- 菜单 4 项：中文标签 + 当前项勾选标记；点击 → `api.cases.patch(id, { status })` → invalidate 用例详情与所在列表的相关 query（具体 key 实现计划中核实）+ toast
- props：`caseId`、`status`、`onChanged?`（批量/行内场景刷新列表）
- 详情页头部（CaseDetail.tsx:490）与列表行内（GroupsPage.tsx:606）复用

### 列表批量改状态（GroupsPage）

多选工具条（批量删除旁）加「改状态」下拉按钮：选目标状态 → `POST /cases/batch-status` → toast「已更新 N 条」→ invalidate + 清空多选。

### 列表状态筛选（GroupsPage）

标签筛选旁加单选下拉：全部 / 草稿 / 评审中 / 就绪 / 废弃。进 `filteredCases` useMemo（:236-239）客户端过滤，与标签筛选取交集；分页本就在客户端，无 API 改动。

## 数据流

```
pill/行内点击 ──► PATCH /cases/:id {status} ──► invalidate ['case'] + ['groups'] ──► pill 刷新
批量选择 ──────► POST /cases/batch-status ────► invalidate ['groups'] ──► 列表刷新 + 清多选
计划运行 ──────► runPlan 查 status ──► deprecated? 跳过记 skipped ──► SSE 事件 + skippedCases
```

## 错误处理

- patch/batch-status 失败：toast 错误信息（现有 useMutation onError 模式）
- 并发覆盖：状态是单字段最后写入胜出，无乐观锁（与 title/priority 等字段现状一致）
- 非法 status 值：zod 400（前端枚举下拉不会产生，仅 API 直接调用可触发）

## 测试策略

单元/路由测试（vitest，apps/api 现有 route 测试模式）：

- PATCH /cases/:id：合法 status 更新成功；非法枚举 422；越权 404
- POST /cases/batch-status：批量更新 count 正确；含不可见用例 404；空数组 422
- runPlan：deprecated 用例记 skipped、skippedCases 计数、不影响 finalStatus

Web 纯函数单测：

- `caseStatusLabel`：4 态映射 + 未知值回退原文
- `statusTone`：review → warning、deprecated → muted

组件不新增测试基建（与步骤编辑项目一致）；浏览器手动 QA：四个入口、deprecated 执行确认、计划跳过、筛选组合。

## 回归点

- 存量用例（全 draft）列表渲染与现状一致
- 单例执行非 deprecated 路径零变化
- plan run 非 deprecated 用例执行路径零变化
- 复制用例（copyOneCase）新用例重置为 draft
