-- ============================================================================
-- 0041 数据搬迁:object_type='login'(登录凭据)并入 'web'(Web 服务)
-- ============================================================================
-- 手写迁移(0033 起 db:generate/db:migrate 不可用;0000–0032 由 drizzle 管理)。
--
-- 背景:登录凭据与 Web 服务一一对应,登录凭据就是该 Web 服务的默认凭证。
-- 删掉独立 login 对象类型,user / loginUrl / secret 内嵌进 web payload:
--   web payload: { name, scheme, host, port, user?, loginUrl?, secret{c,i,t} }。
--
-- 做什么:
--   1. 每环境的 web 对象按 (is_default DESC, created_at, id) 编号 wn;
--      login 对象同序编号 ln —— 与运行时 resolveEnv 的 pick('web') /
--      resolveWebOrigin(空 ref) 选择逻辑对齐(默认 web 服务承载环境级登录凭据)。
--   2. login[ln] 的 user / loginUrl / secret 并入 web[wn=ln](COALESCE 语义:
--      web 上已有 user / loginUrl / 完整 secret 三元组的一律不覆盖)。
--   3. 环境有 login 但无 web 对象:loginUrl 为绝对 http(s) → 由 loginUrl 造默认
--      web 对象承载(首条 is_default=true,其余 false,避开
--      environment_objects_env_type_default_uq 部分唯一索引);非绝对 → 进入丢弃点。
--   4. 丢弃点:RAISE NOTICE(环境名 + user + loginUrl)后统一 DELETE 清场。
--      丢弃仅发生在「有 login、无 web、loginUrl 相对/为空」——这类凭据旧代码
--      仅用于 cdp 机械派发 / verify_case 占位符替换(不依赖 host),NOTICE 是
--      唯一回溯信号,务必留存。
--
-- 无 DDL:object_type 是自由 varchar、payload 是 jsonb,表结构不变;
-- api 容器启动的 drizzle-kit push --force 对本次迁移无 diff。所以本文件
-- 必须手工 psql 执行(先部署新代码,再跑本迁移;见计划文档)。
-- 幂等:所有语句只作用于残余 object_type='login' 行,首遍跑完即归零;TEMP 表
-- IF NOT EXISTS 保证同会话可重跑。
-- ============================================================================

-- 0. 临时表(会话级)
CREATE TEMP TABLE IF NOT EXISTS "_mig_web_targets" AS
SELECT w.id AS web_id, w.environment_id,
       row_number() OVER (PARTITION BY w.environment_id ORDER BY w.is_default DESC, w.created_at, w.id) AS wn
FROM environment_objects w
WHERE w.object_type = 'web';

CREATE TEMP TABLE IF NOT EXISTS "_mig_login_rows" AS
SELECT l.id AS login_id, l.environment_id, l.payload,
       row_number() OVER (PARTITION BY l.environment_id ORDER BY l.is_default DESC, l.created_at, l.id) AS ln,
       l.payload->>'loginUrl' AS login_url,
       (SELECT count(*) FROM environment_objects w2
         WHERE w2.environment_id = l.environment_id AND w2.object_type = 'web') AS web_count
FROM environment_objects l
WHERE l.object_type = 'login';

-- 1. 并入:同序号 web 承载 login 凭据(COALESCE:web 已有字段不覆盖)
UPDATE environment_objects w
SET payload = w.payload
        || CASE WHEN (w.payload -> 'user') IS NULL AND NULLIF(l.payload->>'user','') IS NOT NULL
             THEN jsonb_build_object('user', l.payload->>'user') ELSE '{}'::jsonb END
        || CASE WHEN (w.payload -> 'loginUrl') IS NULL AND NULLIF(l.payload->>'loginUrl','') IS NOT NULL
             THEN jsonb_build_object('loginUrl', l.payload->>'loginUrl') ELSE '{}'::jsonb END
        || CASE
             WHEN NOT (w.payload ? 'secret' AND (w.payload->'secret') ? 'c'
                        AND (w.payload->'secret') ? 'i' AND (w.payload->'secret') ? 't')
              AND (l.payload ? 'secret' AND (l.payload->'secret') ? 'c'
                    AND (l.payload->'secret') ? 'i' AND (l.payload->'secret') ? 't')
             THEN jsonb_build_object('secret', l.payload->'secret')
             ELSE '{}'::jsonb END,
    updated_at = now()
FROM "_mig_login_rows" l
JOIN "_mig_web_targets" t ON t.environment_id = l.environment_id AND t.wn = l.ln
WHERE w.id = t.web_id;

-- 2. 环境无 web:绝对 loginUrl 造默认 web 对象承载(首条 is_default=true,name='web')
INSERT INTO environment_objects (environment_id, object_type, label, payload, is_default)
SELECT l.environment_id, 'web', '默认 Web',
  jsonb_build_object(
    'name', CASE WHEN l.ln = 1 THEN 'web' ELSE NULL END,
    'scheme', CASE WHEN substring(l.login_url from '^https') = 'https' THEN 'https' ELSE 'http' END,
    'host', (regexp_match(l.login_url, '^https?://([^:/]+)'))[1],
    'port', NULLIF((regexp_match(l.login_url, '^https?://[^:/]+:(\d+)'))[1], '')::int
  )
  || CASE WHEN NULLIF(l.payload->>'user','') IS NOT NULL THEN jsonb_build_object('user', l.payload->>'user') ELSE '{}'::jsonb END
  || CASE WHEN NULLIF(l.payload->>'loginUrl','') IS NOT NULL THEN jsonb_build_object('loginUrl', l.payload->>'loginUrl') ELSE '{}'::jsonb END
  || CASE WHEN l.payload ? 'secret' AND (l.payload->'secret') ? 'c' AND (l.payload->'secret') ? 'i' AND (l.payload->'secret') ? 't'
       THEN jsonb_build_object('secret', l.payload->'secret') ELSE '{}'::jsonb END,
  (l.ln = 1)
FROM "_mig_login_rows" l
WHERE l.web_count = 0
  AND l.login_url ~ '^https?://'
  AND (regexp_match(l.login_url, '^https?://([^:/]+)'))[1] IS NOT NULL;

-- 3. 丢弃警告:未能并入(比 web 多)且未能造 web(无 web + 非绝对 loginUrl)的行
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT e.name AS env_name, d.login_url
    FROM "_mig_login_rows" d
    JOIN test_environments e ON e.id = d.environment_id
    WHERE NOT (d.ln <= d.web_count)
      AND NOT (d.web_count = 0 AND d.login_url ~ '^https?://'
               AND (regexp_match(d.login_url, '^https?://([^:/]+)'))[1] IS NOT NULL)
  LOOP
    RAISE NOTICE '0041:环境「%」的登录凭据无法并入任何 web 服务(loginUrl=%),已删除——如仍需该凭据请人工迁移', r.env_name, COALESCE(r.login_url, '(空)');
  END LOOP;
END $$;

-- 4. 清场:删除全部 login 行(已并入/已造 web 的连同丢弃的一起清掉)
DELETE FROM environment_objects WHERE object_type = 'login';