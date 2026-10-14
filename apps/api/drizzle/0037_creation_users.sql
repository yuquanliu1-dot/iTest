-- 0037: 核心对象创建人跟踪（列表/详情页展示创建者）
-- 设计：apps/api/src/db/schema.ts + lib/creator.ts；各创建路径从 req.user.userId 落列。
-- 口径：项目 / 环境 / 数据集 / 用例 / 执行计划 / 执行报告 / AI 线程统一 created_by_user_id
--   （对齐 plan_schedules.created_by_user_id 约定）。报告创建人 = 触发执行的人
--   （单用例 = 请求用户；计划运行沿用 plan_runs.triggered_by_user_id）。
-- 存量数据无法追溯，置 NULL（前端显示 —）；用户删除后 ON DELETE SET NULL 不牵连业务行。
ALTER TABLE projects          ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE test_environments ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE datasets          ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE test_cases        ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE execution_plans   ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE reports           ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ai_threads        ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;