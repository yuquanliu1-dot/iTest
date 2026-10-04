-- 0024: 移除"默认版本"概念。
-- 前端所有操作（用例/计划/环境/AI 工作台）均已显式携带 versionId，
-- project_versions.is_default 只剩 API 层隐性回退，徒增用户心智负担，整体下线。
-- 注意：test_environments.is_default / environment_objects.is_default 是"默认环境"特性，不在本次范围。
ALTER TABLE project_versions DROP COLUMN IF EXISTS is_default;
