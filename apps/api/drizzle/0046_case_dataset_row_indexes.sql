-- 0046: 用例级数据集行选择（启用行下标数组）
-- 语义：[] = 所有启用行（= 旧行为，存量行无需回填）；非空 = 只跑这些启用行下标。
-- 下标空间 = 剔除 disabled 行后重新编号（0 基），与 loadDatasetForRun 的 rowIndex 同空间。
-- drizzle-kit push 已在 api 容器启动时建列，本文件仅作记录/兜底。
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS dataset_row_indexes integer[] NOT NULL DEFAULT '{}';
