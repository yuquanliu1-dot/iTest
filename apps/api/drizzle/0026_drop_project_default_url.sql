-- 0026: 项目级 default_url 下线，入口域名只归属环境。
-- 项目 default_url → 项目默认环境 base_url（环境已有值不覆盖；无默认环境的项目该数据随之丢弃）。
-- 解析链终态：执行期 用例.url → 分组.default_url → 已解析环境.base_url；
--             录制/展示 用例.url → 分组.default_url → 项目默认环境.base_url。
UPDATE test_environments e SET base_url = p.default_url
FROM projects p
WHERE e.project_id = p.id AND e.is_default = true AND p.default_url IS NOT NULL AND e.base_url IS NULL;

ALTER TABLE projects DROP COLUMN IF EXISTS default_url;
