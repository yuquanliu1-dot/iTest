-- 0025: 默认域名纳入环境统一管理。
-- 环境 = 部署目标（入口 URL + DB + syslog）；版本级 default_url（0022）下线：
--   有关联环境 → 写入环境 base_url（环境已有值不覆盖）；
--   无关联环境 → 落到项目 default_url（项目已有值不覆盖）。
-- 执行期解析链变为：用例.url → 分组.default_url → 环境.base_url → 项目.default_url。
ALTER TABLE test_environments ADD COLUMN IF NOT EXISTS base_url text;

UPDATE test_environments e SET base_url = v.default_url
FROM project_versions v
WHERE v.environment_id = e.id AND v.default_url IS NOT NULL AND e.base_url IS NULL;

UPDATE projects p SET default_url = v.default_url
FROM project_versions v
WHERE v.project_id = p.id AND v.environment_id IS NULL AND v.default_url IS NOT NULL
  AND p.default_url IS NULL;

ALTER TABLE project_versions DROP COLUMN IF EXISTS default_url;
