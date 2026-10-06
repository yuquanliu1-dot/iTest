# 用例回放测试数据集支持 设计文档

- 日期：2026-10-06
- 状态：已评审通过（待实现）
- 范围：apps/api（数据集 CRUD + 回放迭代 + 计划执行适配）、apps/web（数据集管理页 + 用例绑定 + 报告展示）、DB 迁移

## 1. 背景与目标

iTest 的用例回放目前只能以固定值执行：步骤值里虽有 `{{var}}` 模板机制（`packages/shared/src/variable.ts`），但变量唯一来源是执行中 `extract` 动作，无法在执行前批量注入外部数据。

本设计引入**测试数据集**，实现数据驱动回放：

- 数据集 = 一组带列名的数据行（如多组账号），**项目级共享**，多个用例可引用
- 用例绑定数据集后，**每次回放自动逐行迭代**：N 行 = N 次回放，每行列值以 `{列名: 值}` 作为初始 vars 注入，步骤中 `{{列名}}` 直接引用
- 每行产生一条独立 report（含完整 stepResults + 截图），报告如实记录当次所用数据行

非目标（YAGNI）：

- 数据集行级/列级的复杂权限管理
- 执行时动态选行（用「禁用行」替代）
- 数据集版本历史
- 行级 env / URL 覆盖

## 2. 数据模型

### 2.1 新表 `datasets`（项目级）

```
datasets
├─ id (uuid pk)
├─ projectId (fk → projects, not null)
├─ name (text, 项目内唯一)
├─ description (text, 可空)
├─ columns  (jsonb)  ColumnDef[]
├─ rows     (jsonb)  DatasetRow[]
└─ createdAt / updatedAt
```

```ts
type ColumnDef = { name: string; sensitive: boolean };
type DatasetRow = { disabled: boolean; cells: Record<string, string | EncCell> };
type EncCell = { c: string; iv: string; tag: string }; // AES-256-GCM，复用 lib/secret-crypto.ts
```

约束与校验：

- 列名即变量名，须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`，列内去重
- 上限：30 列 / 500 行，超出报错
- 敏感列的每个单元格加密为 `EncCell` 内嵌 cells；非敏感列为明文 string
- `disabled: true` 的行回放时跳过（单行调试场景：临时禁用其余行）

### 2.2 关联表变更

| 表 | 变更 | 说明 |
|---|---|---|
| `testCases` | + `datasetId` (uuid, nullable, FK ON DELETE SET NULL) | 数据集删除后用例自动退回单次回放 |
| `reports` | + `datasetRowIndex` (int, nullable)、`datasetSnapshot` (jsonb, nullable) | 快照 = `{rowIndex, totalRows, values}`；敏感值固定存 `******`，保证数据集事后被改/删时报告仍如实展示当次数据 |
| `planRunCases` | + `reportIds` (jsonb uuid[], nullable) | 存该用例全部行产生的 report；原 `reportId` 保留指向第一条，兼容现有读取 |

## 3. API

全部走现有 auth 中间件。

| 路由 | 说明 |
|---|---|
| `GET /projects/:id/datasets` | 列表：id、name、description、columns、rowCount、enabledRowCount、updatedAt（不含 rows 明细） |
| `POST /projects/:id/datasets` | 新建（校验列名/上限） |
| `GET /projects/:id/datasets/:dsId` | 详情；敏感格返回 `{ __masked: true }` 占位符 |
| `PUT /projects/:id/datasets/:dsId` | 整文档更新；`__masked` 占位符原样回传时服务端保留原密文（密码框语义） |
| `DELETE /projects/:id/datasets/:dsId` | 删除；引用用例 datasetId 置空 |

用例绑定复用现有用例更新接口，接受 `datasetId` 字段（null 解绑）。**执行接口零变化**——绑定即迭代。

## 4. 回放执行流程

### 4.1 单用例回放（`runCase.ts`）

1. 加载用例 → 若绑定数据集：加载数据集、解密敏感列、过滤 `disabled` 行
2. 前置校验失败直接 4xx、不建 report：数据集无启用行 / 列名非法 → 明确错误信息（配置错误不产生垃圾报告）
3. 逐行**顺序**执行，每行独立浏览器上下文（与现状一致）：
   - 建 report（status=running，带 `datasetRowIndex` + `datasetSnapshot`）
   - 以 `{列名: 解密值}` 作为初始 vars 调现有执行器
   - **行失败不中断**：任何单行错误（断言失败、执行异常、浏览器上下文启动失败）一律记为该行 report failed，继续下一行（每行是独立验证）
4. 未绑定数据集的用例：完全走现有路径，零行为变化

### 4.2 执行器改动（刻意最小化）

`cdp.ts` 的 `runStepsInContext` 新增两个参数：

- `initialVars: Record<string, string>` —— 现有 `vars: {}` 初始化处改为 `vars: { ...initialVars }`
- `sensitiveVarKeys: Set<string>` —— 数据集敏感列名集合

语义细节：

- 步骤执行中 `extract` 写入同名变量时**覆盖**数据集初始值（执行顺序即优先级）
- **报告侧脱敏闭环**：fill 等值经 `{{password}}` 物化后，写 stepResults 时对 sensitiveVarKeys 中变量的值打码——否则列级加密在报告侧漏成明文（与 recorder 敏感处理对齐）

### 4.3 计划执行（`runPlan.ts`）

- 复用 runCase 迭代逻辑：绑数据集的用例在计划中同样产生 N 条 report
- `planRunCases.reportIds` 存全部；聚合语义：**N 行全 pass 该用例才算 pass**，任一行 fail 则该用例 fail

### 4.4 敏感值边界

解密只发生在 API 进程内存（执行前瞬间），vars 池不落库；datasetSnapshot 敏感值固定 `******`。

## 5. 前端

### 5.1 数据集管理页（项目级新入口）

- 项目导航加「数据集」：列表页（名称、列数、行数/启用数、更新时间）+ 新建/编辑
- 编辑器 = 表格：
  - 列头：改名、加/删列、勾选「敏感」
  - 行：加/删行、勾选「禁用」
  - 单元格内联编辑；支持从 Excel 粘贴（TSV 解析批量填充）
  - 敏感格密码框样式；未改动回传 `__masked` 占位符保留原密文
- 删除需确认，提示「N 个用例将解绑」

### 5.2 用例侧（CaseDetail）

- 设置区新增「数据集」下拉（绑定/解绑），绑定后提示「回放将按启用行数逐行执行」
- `FillValueEditor` 变量下拉合并两个来源并标注：`数据集列` / `前置 extract`

### 5.3 报告侧

- ReportDetail 顶部显示「数据行 i/N」+ 当次行值快照（敏感列 `******`）
- PlanRunDetail 按用例分组，显示行通过率（如「3/5 行通过」）
- reports 列表 N 条自然出现，无需改

## 6. 测试策略

- API 集成测试：
  - dataset CRUD：校验规则、敏感加密往返、`__masked` 占位符保留
  - runCase 迭代（mock 执行器）：N 条 report、rowIndex 正确、单行 fail 不中断、敏感打码、0 启用行报 4xx
- 手动 E2E：2 行账号（一行正确、一行错误密码）绑登录用例 → 回放 → 验证 2 条 report（1 pass 1 fail）+ 脱敏展示
- 回归：未绑定用例回放行为零变化

## 7. 迁移

1 新表 + 3 列变更，按项目惯例手动 `pnpm db:migrate`（dev 库用 drizzle-kit push）。
