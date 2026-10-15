-- 0038: 移除需求级工作台遗留表（ai_workspace_state / ai_scenarios / ai_cases）
--
-- 背景：需求级用例生成链路从未实现完成——这三张表自 0015 立项起就没有任何生产代码
--   读写它们（schema.ts 里有定义，pi/space 一律按 version 线程走 ai_stage_* 暂存表）。
--   ai-web 的 ai-workspace 目录也不存在、零引用。它们长期以「看起来能用」的形态留在
--   schema 里，误导后续开发以为存在需求级生成链路。
--
-- 口径：需求输入维持现状——用户在「AI 创建用例」弹窗或版本空间助手里直接输入，
--   不读 requirements 表。所以本迁移不涉及任何在用数据流。
--
-- 生产库核对（2026-10-15，prod228）：三张表均 0 行；requirements 0 行；ai_threads 87 行
--   全为 kind='version'。删除无数据损失。
--
-- 不动 requirements / ai_threads：requirements 仍被 test_cases.requirement_id、
--   scenarios.requirement_id 等外键引用；ai_threads 仍是版本空间助手线程表。
--   ai_threads.kind 的 'requirement' 取值保留列定义（存量 87 行均为 version，
--   改默认值无收益却增加读代码者的困惑），仅更新注释说明只有 'version' 在用。
--
-- 执行方式：prod 由 api 容器启动时 `drizzle-kit push --force` 按 schema.ts 声明式 diff
--   应用（push 不会自动 DROP 代码里已不存在的表，故本文件供 dev 库手工 psql 与留档）。

DO $$ BEGIN
  DROP TABLE IF EXISTS ai_workspace_state;
  DROP TABLE IF EXISTS ai_scenarios;
  DROP TABLE IF EXISTS ai_cases;
END $$;
