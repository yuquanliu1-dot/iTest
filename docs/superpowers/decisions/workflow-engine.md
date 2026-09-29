# 决策：使用自研最小 Workflow 引擎，不直接依赖 pi-agent-core

**日期**：2026-09-30

**结论**：MVP 阶段自研 `Workflow = Steps[]` 引擎（见 `apps/api/src/agent/agentFactory.ts`），不直接 `@earendil-works/pi-agent-core` import。

**原因**：
1. `pi-agent-core` 公共 npm 可访问（v0.87.1 已发布），但实际集成需要把 Workflow 概念（Steps / Tools / Session）映射到 pi-agent-core 的 transport/state/attachment 模型，工作量大
2. MVP 阶段仅需顺序执行若干 LLM 步骤 + SSE 流式输出，自研约 80 行 TS 即可完成，依赖面更可控
3. `WorkflowSpec + runWorkflow + LLMClient` 接口刻意对齐 pi-agent-core 概念，后续如需替换可平滑迁移

**如何应用**：当 LLM provider 接通真实 SDK 后，思考"是否值得替换 Workflow 引擎"。MVP 不阻塞。