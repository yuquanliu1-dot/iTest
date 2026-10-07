# 数据集 v2：行级预期 + AI 助手可用性 设计

> 承接《2026-10-06-replay-dataset-design》。两个增量：
> 1. 用例级预期（expectedOutcome）支持 `{{列名}}`，按数据行替换后交 vision 判定
> 2. AI 助手（space-assistant）能看数据集结构、绑定/解绑、且变量校验不再误报

---

## 1. 行级预期：expectedOutcome 模板

### 现状与缺口

- 步骤级断言已支持按行变化：`fill.value` / `select.value` / `assertText.equals` / `assertJson` / `navigate.url` / `screenshot.name` / `upload.*` / `aiTask.instruction` 回放时均过 `substituteVars`（cdp.ts）。
- 用例级 `expectedOutcome` 原样传入 cdp（runCase.ts execCtx），不做替换 → 所有行共用同一段预期文本，负向数据行（如错误密码期望报错提示）必被 vision 误判失败。

### 设计

- **替换时机**：回放全部步骤结束后、vision 判定调用前，在 cdp 内用当次运行的最终 `vars`（数据集初始变量 + 前置 extract 已物化）对 `expectedOutcome` 做 `substituteVars`。
  - 未绑数据集的用例同样受益：模板引用 extract 变量也能替换。
  - `missing`（未定义变量）不阻断：保留 `{{xx}}` 字面量进 vision 提示，判定大概率失败且报告可见原因 —— 诚实失败优于静默跳过。
- **可观测**：替换后的预期文本随 vision 判定结果落入该行报告（沿用现有 vision 判定展示位），排查「这行到底按什么预期判的」一目了然。落库前对敏感列值打码（与步骤错误信息同口径）；vision LLM 提示仍按 §8.3 走明文。
- **敏感列**：模板引用敏感列会把明文写进 vision LLM 提示（与 aiTask 同一已知出口，见 v1 spec §8.1）。文档约束：**预期列不要标敏感**。
- **同 名覆盖**：extract 变量与数据集列同名时运行时后者（extract）生效 —— 既有 vars 语义，不变。
- **UI**：CaseDetail「用例预期」textarea 下方提示，在绑定数据集时追加一句：可引用数据集列 `{{列名}}`，每行按行值替换后再判定。

### 不做

- 数据集行独立 expected 字段（需迁移、表达力弱于模板）。
- 模板中敏感变量的拦截/打码（合法场景不存在，文档约束即可）。

## 2. AI 助手数据集能力

### 现状与缺口

- `stage_case_op update_case` 的 `UpdateCasePatchShape` 无 `datasetId` → AI 无法绑定/解绑数据集。
- `manage_cases` 看不到数据集（无列表动作；`get` 不返回绑定信息）。
- `buildVariableReport(steps)` 只认 extract 定义 → 绑定数据集后 `{{列名}}` 仍被误报「未定义变量」，Web 变量体检横幅与 AI 校验反馈同源误报。

### 设计

**2.1 manage_cases 新增 `list_datasets`**（只读，结构级）

- 返回：`[{id, name, description, columns: [{name, sensitive}], rowCount, enabledRowCount}]`（复用 `listDatasets` service，去掉 projectId/updatedAt）。
- **敏感值永不出库**：本动作不返回任何行值（非敏感也不返回 —— 用户已确认「仅结构」）。

**2.2 manage_cases `get` 带绑定信息**

- 响应增加：`datasetId` + `dataset: {name, columns: [{name, sensitive}], enabledRowCount} | null`（按 caseRow.datasetId 轻量查询，不取 rows）。
- AI 由此知道该用例有哪些 `{{初始变量}}` 可引用。

**2.3 stage_case_op `update_case` patch 增加 `datasetId`**

- `UpdateCasePatchShape` += `datasetId: z.string().uuid().nullable().optional()`。
- 落库路径复用 HTTP PATCH 同一套校验：数据集不存在/不可见 → 404；跨项目 → `dataset_project_mismatch`（错误在 StagePanel 落库时暴露，与现有 stage 错误展示一致）。
- `stage_case`（新建用例）不带 datasetId —— AI 新建后可立即 update_case 绑定，保持 stage 形状最小。

**2.4 buildVariableReport 认识初始变量**

- 签名：`buildVariableReport(steps, initialVars?: string[])`。初始变量视为「步骤 0 前已定义」：消灭对应 undefined / forwardRefs 误报；不参与 duplicates（extract 覆盖同名数据集列属合法运行时语义，不告警）。
- 接入点：
  - HTTP `PUT /cases/:id/steps`（steps.ts）—— 取该用例绑定数据集的列名传入；未绑定传 undefined。
  - `stage_case_op` 的 update_step / insert_step 响应**新增** variableReport 字段（按该用例全量步骤计算，含绑定数据集列作为初始变量）—— AI 写完 `{{var}}` 立即拿到校验反馈，而不是回放时才发现；该动作此前无变量体检。
- Web 变量体检横幅因此自动消误报，前端无改动。

**2.5 promptGuidelines（manage_cases + stage_case_op）**

- 数据集列名即回放初始变量 `{{列名}}`；行间差异（输入值、断言文本、预期描述）应写成 `{{var}}`，让每行数据驱动出不同验证。
- 看数据集结构用 `manage_cases list_datasets`（敏感值不可见）；看用例可用变量用 `manage_cases get`。
- 绑定/解绑走 `stage_case_op update_case(patch.datasetId)`，跨项目数据集会被拒绝。

## 3. 验收

1. 绑定 2 行数据集（含预期列）的登录用例：行 1（正向）expectedOutcome 按行 1 预期判过；行 2（负向）按行 2 预期判过（v1 下行 2 必失败）。
2. 报告里能看到该行实际使用的预期文本。
3. 未绑数据集、模板引用 extract 变量 → 替换正确。
4. `manage_cases list_datasets` / `get` 返回结构正确，无任何行值。
5. AI 经 `update_case patch.datasetId` 完成绑定与解绑；跨项目绑定在 StagePanel 报 `dataset_project_mismatch`。
6. 绑定后 `{{列名}}` 不再出现在变量体检 undefined/forwardRefs；extract 覆盖同名列不告警。
7. 既有 578+ 用例与数据集套件回归通过（预存失败除外）。

## 8. 已知边界（沿用 v1 §8 并追加）

- **8.3**：expectedOutcome 模板引用敏感列 → 明文进 vision LLM 提示（同 aiTask 出口）；落库的 visionAssert.expected/reason 与步骤错误已按敏感列值打码（2026-10-07 终评补充）。预期列应保持非敏感。
- **8.4**：模板未定义变量保留字面量进 vision 提示 → 判定失败且报告可见；不做拦截。
- **8.5**：（终评留档）POST append 步骤路由的体检只扫 action（新 client 不传 action 时报告恒空）——该路由现无调用方，PUT 是统一写入口；dataset.description 无长度上限（其余字段 200-4000）。
