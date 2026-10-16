-- 0039: test_cases.web_service_ref 用例绑定环境 web 服务
-- 设计：「环境多 Web 服务与相对 URL」第一步——用例只存相对 url，执行时由环境
--   web 服务对象（environment_objects objectType='web'）拼绝对地址。
-- 语义：本列存 web 服务对象标识（payload.name）；空 = 用环境默认 web 服务。
--   本迁移只加列，消费逻辑（resolve-url / 执行链）由后续任务实现。
-- 注：与 0033 起惯例一致为手工迁移（journal/meta 停在 0032）；
--   prod 由 api 容器启动 drizzle-kit push --force 按 schema.ts 声明式应用。
ALTER TABLE "test_cases" ADD COLUMN "web_service_ref" varchar(64);
