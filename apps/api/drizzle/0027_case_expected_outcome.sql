-- 0027: 用例级 expected_outcome（自然语言预期描述）+ step-level assertion 下线
--   - test_cases 加 expected_outcome text 字段（可空；为空时回放不调 vision 判）。
--   - step-level assertion 字段保留以兼容旧数据；
--     normalizeStepAssertion 只接受 specifiedElement + 非空 locator 的真实元素断言，
--     target:'page' + match:'contains' + 空 locator 的「整页模糊文本断言」一律跳过（写回 undefined）。
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS expected_outcome text;
