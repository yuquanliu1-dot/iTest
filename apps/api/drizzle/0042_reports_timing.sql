-- 0042: reports 增执行起止时刻列（报告详情页展示「执行开始/执行结束」）
-- 设计：apps/api/src/execute/runCase.ts 落库；apps/api/src/routes/reports.ts 出参
-- 语义：started_at = 真正开始跑步骤的时刻（环境/URL 解析之后，与 duration_ms 同基线）；
--   finished_at = 终态落库时刻。两列均可空，老报告不回填。
--   注意与 created_at 区分：created_at 是报告行插入时刻，含排队 + 环境解析 + 数据集解密耗时。
-- 幂等：可重复执行（drizzle-kit push 已在容器启动时建列，本文件仅作记录/兜底）。
DO $$ BEGIN
 ALTER TABLE reports ADD COLUMN started_at timestamp;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE reports ADD COLUMN finished_at timestamp;
EXCEPTION WHEN duplicate_column THEN null;
END $$;
