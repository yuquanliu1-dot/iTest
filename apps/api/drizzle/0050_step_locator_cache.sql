-- 0050: 机械步骤 locator 修复记忆
-- 设计：apps/api/src/execute/locatorCache.ts + cdp.ts（AI 降级块写入 / tryFirstMatch 消费）
-- 语义：机械步骤 locator 候选全败且 AI 降级（ai_fallback_locator_failed 开关）整步重做成功后，
--   把 AI 动作解析回的稳定 selector（mapSelectorStrict 净化：拒专有语法/激活态 class/裸标签）
--   按 step_id + action_kind 缓存；后续回放把缓存 locator 追加进候选链末位参与探测——
--   零 LLM 命中即过；缓存也失灵则照旧 AI 降级并覆写缓存（自愈协议）。
--   对用例定义零侵入（test_steps.compiled 不变）。
-- 生命周期：步骤删除级联清缓存；缓存失灵由覆写自愈，无显式过期。
CREATE TABLE step_locator_cache (
  step_id     uuid PRIMARY KEY REFERENCES test_steps(id) ON DELETE CASCADE,
  action_kind varchar(16) NOT NULL,
  locator     jsonb NOT NULL,
  hits        integer NOT NULL DEFAULT 0,
  created_at  timestamp NOT NULL DEFAULT now(),
  updated_at  timestamp NOT NULL DEFAULT now()
);
