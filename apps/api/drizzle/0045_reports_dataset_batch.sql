-- 0045: reports.dataset_batch_id 数据集批次 id（报告详情页行切换器分组键）
-- 设计：runCase.ts 数据集分支 / routes/execute.ts preseed 分支生成 randomUUID，同一次执行的 N 行共用；
-- 语义：GET /api/reports/:id/dataset-batch 据此拉同批兄弟行摘要；老报告为 null（切换器不渲染）。
-- drizzle-kit push 已在 api 容器启动时建列建索引（idx_reports_dataset_batch），本文件仅作记录/兜底。
ALTER TABLE reports ADD COLUMN dataset_batch_id uuid;
CREATE INDEX IF NOT EXISTS idx_reports_dataset_batch ON reports(dataset_batch_id);
