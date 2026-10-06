-- 0030: 彻底删除 test_steps.action 列。
--   instruction + compiled 双列已稳定运行(0029),dispatcher/UI/录制全量改读 compiled;
--   老 action 列(2026-10-06 起作废)再无读写方,DROP。
ALTER TABLE test_steps DROP COLUMN IF EXISTS action;
