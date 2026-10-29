-- 0052: 登录用例数据行选择——plan_case_groups 加 login_dataset_row_indexes 列（三态覆盖）
-- 与 plan_cases.dataset_row_indexes 同语义：
-- null = 跟随用例级配置（执行回落 test_cases.dataset_row_indexes）
-- []   = 全部启用行（覆盖用例级子集）
-- 非空 = 启用行下标子集（0 基，与用例级同一编号空间）。
-- drizzle-kit push 已在 api 容器启动时建列，本文件仅作记录/兜底。
ALTER TABLE plan_case_groups ADD COLUMN IF NOT EXISTS login_dataset_row_indexes integer[];
