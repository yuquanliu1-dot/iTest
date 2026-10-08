-- 版本空间 AI 助手「数据集暂存表」(thread-scoped):AI 用 stage_dataset 工具把
-- 生成的数据集(列定义 + 行数据)写这里,用户在 StagePanel 勾选 → /stage/save
-- 走 createDataset 落正式表。PK = (thread_id, local_id),与 0028 的 ai_stage_* 一致。
-- 注意:rows 是明文草稿(AI 生成、用户预览可见);敏感格只在落库时由
-- datasets.service normalizeDataset 加密,stage 表不存密文。
-- 修改已有数据集 v1 不支持(敏感值对 AI 不可见,整表覆盖语义复杂)。
CREATE TABLE ai_stage_datasets (
  local_id        TEXT NOT NULL,
  thread_id       TEXT NOT NULL,
  version_id      UUID NOT NULL,
  name            VARCHAR(120) NOT NULL,
  description     TEXT,
  columns         JSONB NOT NULL DEFAULT '[]',
  rows            JSONB NOT NULL DEFAULT '[]',
  staged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, local_id)
);
CREATE INDEX ai_stage_datasets_version_idx ON ai_stage_datasets(version_id);

-- stage_case 配套绑定:同一批暂存的用例引用同批数据集的 localId,
-- save 时数据集先落库,真实 datasetId 回填到用例。
ALTER TABLE ai_stage_cases ADD COLUMN dataset_local_id TEXT;
