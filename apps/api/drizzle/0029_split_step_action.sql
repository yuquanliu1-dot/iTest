-- 0029: 拆分 test_steps.action 为 instruction + compiled 两列。
--   - instruction (text):行级自然语言,人看/给 LLM 起手用,回放不读。
--   - compiled   (jsonb):可执行 DSL 数组 StepAction[];回放唯一依据。
-- 老 action 列保留作废一段时间;新代码不再读写(只保留约束满足)。
ALTER TABLE test_steps ADD COLUMN IF NOT EXISTS instruction text;
ALTER TABLE test_steps ADD COLUMN IF NOT EXISTS compiled jsonb;
