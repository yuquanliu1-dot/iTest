-- ============================================================================
-- 0049 数据回填:db 对象补 dbType + 修正 base-all 的用户名
-- ============================================================================
-- 手写迁移(0033 起 db:generate/db:migrate 不可用)。无 DDL:payload 是 jsonb,表结构不变;
-- api 容器启动的 drizzle-kit push --force 对本次迁移无 diff。所以本文件必须手工 psql 执行
-- (先部署新代码,再跑本迁移;见计划文档)。
--
-- 背景(2026-10-28 prod228 实测):base-all 的 db 对象「SIEM数据库」
-- (b66aa0f0-b635-4c6e-bd7c-efa536b02e0a)payload 里有 url=jdbc:mysql://… 却漏了 dbType,
-- 而旧代码一律「缺省 postgres」→ 对着 3306 的 MySQL 发 PG 协议,报出的
-- `Connection terminated unexpectedly` 完全掩盖真实原因(真实原因是用户名拼错)。
--
-- 做什么:
--   1. 回填:所有 object_type='db' 且缺 dbType、但带 jdbc url 的对象,按 url 前缀补 dbType。
--      补完后「库型判定」不再依赖缺省值,存量数据与新写入走同一套推断逻辑。
--   2. 修正:base-all 该对象的 user 由 taish 改成 taishi(MySQL 实际账号;探针实测
--      taish/TAISH/Taish 全部 ER_ACCESS_DENIED_ERROR,taishi + 同一密码可连)。
--
-- 幂等:两条都是条件 UPDATE,重跑不产生额外变更。
-- ============================================================================

-- 1. 回填 dbType(仅限 jdbc url 可识别的:mysql / postgresql)
UPDATE environment_objects
SET payload = payload || jsonb_build_object('dbType', 'mysql')
WHERE object_type = 'db'
  AND NOT (payload ? 'dbType')
  AND lower(coalesce(payload->>'url', '')) LIKE 'jdbc:mysql://%';

UPDATE environment_objects
SET payload = payload || jsonb_build_object('dbType', 'postgres')
WHERE object_type = 'db'
  AND NOT (payload ? 'dbType')
  AND lower(coalesce(payload->>'url', '')) LIKE 'jdbc:postgresql://%';

-- 2. 修正 base-all 的用户名(MySQL 实际账号是 taishi)
UPDATE environment_objects
SET payload = payload || jsonb_build_object('user', 'taishi')
WHERE id = 'b66aa0f0-b635-4c6e-bd7c-efa536b02e0a'
  AND payload->>'user' = 'taish';
