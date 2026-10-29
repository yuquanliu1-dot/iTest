-- 计划级数据集行选择（三态覆盖，与 plan_cases.target_override 同为先例）：
-- null = 跟随用例级配置（执行回落 test_cases.dataset_row_indexes）
-- []   = 全部启用行
-- 非空 = 启用行下标子集（0 基，与用例级同一编号空间）。同用例跨组=多行，各行独立。
ALTER TABLE plan_cases ADD COLUMN dataset_row_indexes integer[];
