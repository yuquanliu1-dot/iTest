-- 0051: 计划级数据集行选择——plan_cases 加 dataset_row_indexes 列（三态覆盖）
-- 计划级数据集行选择（三态覆盖，与 plan_cases.target_override 同为先例）：
-- null = 跟随用例级配置（执行回落 test_cases.dataset_row_indexes）
-- []   = 全部启用行
-- 非空 = 启用行下标子集（0 基，与用例级同一编号空间）。同用例跨组=多行，各行独立。
-- drizzle-kit push 已在 api 容器启动时建列，本文件仅作记录/兜底。
ALTER TABLE plan_cases ADD COLUMN IF NOT EXISTS dataset_row_indexes integer[];
