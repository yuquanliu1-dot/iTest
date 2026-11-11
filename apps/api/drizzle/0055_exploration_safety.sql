-- 0055: 探索会话安全与可运维三列（drizzle-kit push 已在 api 容器启动时加列，本文件仅作记录/兜底）
-- allow_destructive: 破坏性操作授权位（默认拒）——用户在建会话时显式勾选才允许点删除/支付/发送
-- heartbeat_at: 执行器心跳（每轮对话前刷新）——看门狗据此判死僵死的 running 会话
--   用 timestamptz：这一列要与 cutoff 比较，必须是无歧义的绝对时刻。普通 timestamp 存墙钟，
--   drizzle 写 UTC 墙钟、原生 SQL 写本地墙钟，混写会让比较整体偏掉一个时区差（判死条件永不成立）。
-- excluded_ledger: 负面结果账本（模型申报的「已排除的假设 + 依据」，只存排除项不存信念）
ALTER TABLE exploration_sessions ADD COLUMN IF NOT EXISTS allow_destructive boolean NOT NULL DEFAULT false;
ALTER TABLE exploration_sessions ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE exploration_sessions ADD COLUMN IF NOT EXISTS excluded_ledger jsonb;
