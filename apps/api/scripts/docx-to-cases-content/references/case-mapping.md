# 需求字段 → stage_case 参数映射（docx-to-cases）

## 映射表

| 需求侧信息 | stage_case 参数 | 规则 |
|---|---|---|
| （每例生成） | `localId` | 每条用例新生成一个 UUID v4，绝不复用 |
| 需求点 + 场景 | `title` | 「模块-需求点-场景」动宾短语，≤200 字，不用句号结尾 |
| 需求描述/背景 | `description` | ≤4000 字；来源段落压缩，保留验收标准原文 |
| 优先级（文档标注） | `priority` | 文档写「高/严重」→ P0/P1，「中」→ P2，「低」→ P3；未标 → P2 |
| 登录页/入口 URL（文档明确给出时） | `url` | 原样；没给就不填，不要编 |
| 操作步骤 | `steps[].action` | 自然语言一步一做事，≤2000 字/步，最多 30 步；具体性见 design-principles |
| 预期结果 | `steps[].assertion` 或 `expectedOutcome` | 步内可判的写 assertion；整例终态写 expectedOutcome |
| 需求编号 | `requirementNo` | 原样带入（≤64 字），多条需求合成一例时取主需求编号 |
| 测试类型（第 3 步确认的范围） | `coverageTypes` | 仅当用户明确选择了测试类型才填；默认不填 |

## 不要填的参数

- `compiled`：固化由平台后续流程处理，本技能不产出 DSL
- `defaultEnvId` / `datasetLocalId`：环境与数据集由用户在界面配置

## 硬校验（stage_case 会拒绝的）

- `localId` 不是 36 位 UUID → 调用失败
- `title` 空或 >200 字 → 调用失败
- `steps` >30 条 → 调用失败

一批 stage_case 连续失败时：读返回的 error 修正参数重试同一条，不要跳过也不静默丢。
