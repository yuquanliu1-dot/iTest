-- 0053: 提示词模块版本行加基线指纹列（drift 告警判据）
-- base_hash = 写入该行时「代码默认基线」的 sha256。
-- 覆盖行（value 非 NULL）的 base_hash 与当前代码默认指纹不等 → 基线已变更、覆盖值未同步。
-- NULL = 旧版本写入的行，无指纹 → 状态 unknown（提示但不判漂移）。
-- drizzle-kit push 已在 api 容器启动时建列，本文件仅作记录/兜底。
ALTER TABLE assistant_prompt_module_versions ADD COLUMN IF NOT EXISTS base_hash text;
