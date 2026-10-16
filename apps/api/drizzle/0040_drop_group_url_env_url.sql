-- ============================================================================
-- 0040 数据搬迁:base_url / default_url → 默认 web 服务对象,并删除两列
-- ============================================================================
-- 手写迁移(0033 起 db:generate/db:migrate 不可用;0000–0032 由 drizzle 管理)。
--
-- 做什么:
--   1. 每环境(base_url 或该环境 login 对象 loginUrl 存在)插一个默认 web 服务对象,
--      承载旧"部署入口 URL";项目 → (origin, name) 落临时表供 case/step 相对化。
--   2. test_cases.url 尽力剥离为本项目任一 web origin 的绝对前缀 → 相对路径 + web_service_ref;
--      外站保留绝对 URL(web_service_ref 置空)。
--   3. test_steps.compiled 内 kind='navigate' 的 url 同法尽力剥离。
--   4. 删除 groups.default_url 与 test_environments.base_url。
--
-- ⚠ 运行方式(顺序必须先做搬迁,MUST hand-run with psql):
--   生产 DDL 由 api 容器启动 drizzle-kit push --force 自动应用,但 push 只跑 DDL,
--   不执行本文件的 INSERT/UPDATE(数据搬迁段)。故:
--     ① 先手工 psql 执行"数据搬迁段"(本文件中 DROP TABLE _mig_web_origins 之前的部分),
--        在旧列仍存在时完成 base_url/loginUrl → web 对象 且 case/step url 相对化;
--        _mig_web_origins 是 TEMP(会话级),搬迁段收尾自动消失,不会在库里留孤儿表;
--     ② 再放行 api 容器启动的 push(或与搬迁一起 psql 执行下方 DDL,
--        DROP COLUMN IF EXISTS 幂等,即使先 push 也安全)。
--     若先 push 后搬迁,迁移 SQL 会因列已删除而报错——因此务必先搬迁后 push/DDL。
-- ============================================================================

-- 0. 临时表:项目 → web origin/name
CREATE TEMP TABLE "_mig_web_origins" ("project_id" uuid, "origin" text, "name" text);

-- 1. 每环境插默认 web 对象:base_url 优先,空则取 login 对象 loginUrl 的 origin
INSERT INTO "environment_objects" ("environment_id", "object_type", "label", "payload", "is_default")
SELECT e.id, 'web', '默认 Web',
  jsonb_build_object(
    'name', 'web',
    'scheme', CASE WHEN substring(src.u from '^https') = 'https' THEN 'https' ELSE 'http' END,
    'host', (regexp_match(src.u, '^https?://([^:/]+)'))[1],
    'port', NULLIF((regexp_match(src.u, '^https?://[^:/]+:(\d+)'))[1], '')::int
  ), true
FROM "test_environments" e
CROSS JOIN LATERAL (
  SELECT COALESCE(
    e.base_url,
    (SELECT (lo.payload->>'loginUrl') FROM environment_objects lo
      WHERE lo.environment_id = e.id AND lo.object_type = 'login'
        AND lo.payload->>'loginUrl' ~ '^https?://' LIMIT 1)
  ) AS u
) src
WHERE src.u ~ '^https?://'
  AND NOT EXISTS (SELECT 1 FROM environment_objects o
    WHERE o.environment_id = e.id AND o.object_type = 'web');

INSERT INTO "_mig_web_origins" ("project_id", "origin", "name")
SELECT DISTINCT e.project_id,
  (ob.payload->>'scheme') || '://' || (ob.payload->>'host')
    || CASE WHEN ob.payload->>'port' IS NULL THEN '' ELSE ':' || (ob.payload->>'port') END,
  COALESCE(NULLIF(ob.payload->>'name', ''), 'web')
FROM environment_objects ob
JOIN test_environments e ON e.id = ob.environment_id
WHERE ob.object_type = 'web' AND ob.payload->>'host' IS NOT NULL;

-- 2. case.url 尽力剥离(命中项目任一 web origin);外站保留绝对
UPDATE test_cases tc SET
  url = NULLIF(regexp_replace(tc.url, '^https?://[^/]+', ''), ''),
  web_service_ref = wo.name
FROM "groups" g, _mig_web_origins wo
WHERE g.id = tc.group_id AND wo.project_id = g.project_id
  AND tc.url ~ '^https?://[^/]+'
  AND (tc.url = wo.origin OR tc.url LIKE wo.origin || '/%');

-- 3. 步骤内 navigate 尽力剥离
UPDATE test_steps ts SET compiled = (
  SELECT jsonb_agg(
    CASE WHEN el->>'kind' = 'navigate' AND (el->>'url') ~ '^https?://[^/]+'
              AND EXISTS (
                SELECT 1 FROM test_cases tc2
                JOIN "groups" g2 ON g2.id = tc2.group_id
                JOIN _mig_web_origins wo ON wo.project_id = g2.project_id
                WHERE tc2.id = ts.case_id
                  AND (el->>'url' = wo.origin OR el->>'url' LIKE wo.origin || '/%')
              )
         THEN jsonb_set(el, '{url}', to_jsonb(NULLIF(regexp_replace(el->>'url', '^https?://[^/]+', ''), '')))
         ELSE el END
    ORDER BY ord)
  FROM jsonb_array_elements(ts.compiled) WITH ORDINALITY AS t(el, ord)
)
WHERE ts.compiled IS NOT NULL AND jsonb_typeof(ts.compiled) = 'array';

DROP TABLE IF EXISTS "_mig_web_origins";

-- DDL:由 api 容器 push --force 应用(或与搬迁一起 psql 执行;IF EXISTS 幂等)
ALTER TABLE "groups" DROP COLUMN IF EXISTS "default_url";
ALTER TABLE "test_environments" DROP COLUMN IF EXISTS "base_url";