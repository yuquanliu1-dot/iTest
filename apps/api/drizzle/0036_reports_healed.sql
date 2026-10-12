-- 0036: reports.healed 自愈标记（双通过率）
-- 设计：apps/api/src/execute/cdp.ts aiTask 分支 + runCase.ts 最终 update
-- 语义：aiTask 步骤缓存条目存在但机械重放分叉、AI 自愈后用例通过 → healed=true。
--   口径：passed && !healed = 一次通过；passed && healed = 自愈通过；failed 恒 false。
ALTER TABLE reports ADD COLUMN healed boolean NOT NULL DEFAULT false;
